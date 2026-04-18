# unrar-async

[![npm version](https://badge.fury.io/js/unrar-async.svg)](https://badge.fury.io/js/unrar-async)
[![MIT License](https://badges.frapsoft.com/os/mit/mit.svg?v=103)](https://opensource.org/licenses/mit-license.php)
[![TypeScript](https://badges.frapsoft.com/typescript/code/typescript.svg?v=101)](https://www.typescriptlang.org/)

Async RAR archive extractor for Node.js. Extraction runs in a **Worker Thread** so the main event loop is never blocked. Files are streamed as `Readable` streams. Sources can be a file path, a buffer, or any custom **async `Seekable`** (HTTP Range, S3, …).

Powered by the official [unrar C++ library](http://www.rarlab.com/rar_add.htm) compiled to WebAssembly via [Emscripten](http://emscripten.org/).

> Forked from [node-unrar-js](https://github.com/YuJianrong/node-unrar.js) by Jianrong Yu.

## Installation

```bash
npm install unrar-async
```

## Quick Start

```typescript
import { RARExtractor } from "unrar-async";

const extractor = await RARExtractor.fromFile("./archive.rar");
const { arcHeader, fileHeaders, fileCount, totalSize, files } =
  await extractor.extract();

console.log(`${fileCount} files, ${totalSize} bytes`);

for await (const { fileHeader, extraction } of files) {
  if (extraction) {
    // extraction is a Readable stream — pipe it anywhere
    extraction.pipe(process.stdout);
  }
}
```

## API

### Creating an extractor

```typescript
// From a file path — recommended for large archives, streams bytes from disk.
const extractor = await RARExtractor.fromFile("./archive.rar");
const extractor = await RARExtractor.fromFile("./archive.rar", {
  password: "1234",
});

// From a buffer held in memory.
const extractor = await RARExtractor.fromBuffer(arrayBuffer);
const extractor = await RARExtractor.fromBuffer(uint8Array);

// From any custom async source (HTTP Range, S3, memory-mapped file, …).
const extractor = await RARExtractor.fromSeekable(mySeekable);
```

> **Why no `fromStream`?** RAR archives are not sequentially decodable — the decoder needs to seek to arbitrary offsets (trailing headers, recovery records, …). A plain `Readable` does not support seeking. Either save the stream to disk first and use `fromFile`, or buffer it in memory and use `fromBuffer`, or implement a `Seekable` backed by something that supports random access and use `fromSeekable`.

### The `Seekable` interface

Implement `Seekable` to plug your own backend. All methods are async: the extractor runs in a worker thread and blocks on `Atomics.wait` while your implementation (in the main thread) resolves each call — the Node event loop stays free the whole time.

```typescript
interface Seekable {
  read(size: number): Promise<Uint8Array | null>; // null = EOF
  seek(pos: number, method: "SET" | "CUR" | "END"): Promise<boolean>;
  tell(): Promise<number>;
  size(): Promise<number>;
  close?(): Promise<void>;
}
```

Example — an HTTP Range backed `Seekable` (assuming the remote server returns `206 Partial Content` on `Range:` requests):

```typescript
class HTTPRangeSeekable implements Seekable {
  private pos = 0;
  private cachedSize: number | null = null;

  constructor(private readonly url: string) {}

  async read(size: number): Promise<Uint8Array | null> {
    const total = await this.size();
    if (this.pos >= total) return null;
    const end = Math.min(this.pos + size, total) - 1;
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${this.pos}-${end}` },
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    this.pos += buf.byteLength;
    return buf;
  }

  async seek(pos: number, method: "SET" | "CUR" | "END"): Promise<boolean> {
    const total = await this.size();
    const next =
      method === "SET" ? pos : method === "CUR" ? this.pos + pos : total - pos;
    if (next < 0 || next > total) return false;
    this.pos = next;
    return true;
  }

  async tell(): Promise<number> {
    return this.pos;
  }

  async size(): Promise<number> {
    if (this.cachedSize !== null) return this.cachedSize;
    const head = await fetch(this.url, { method: "HEAD" });
    this.cachedSize = parseInt(head.headers.get("content-length") ?? "0", 10);
    return this.cachedSize;
  }
}

const extractor = await RARExtractor.fromSeekable(new HTTPRangeSeekable(url));
```

For good throughput, add buffering / LRU caching inside your `Seekable` so that small back-to-back reads from the decoder (header parsing often issues `read(7)` then `read(12)`) do not each become a network round-trip.

### Extracting

```typescript
const result = await extractor.extract();
// Or with a file filter:
const result = await extractor.extract({ files: ["specific-file.txt"] });
const result = await extractor.extract({ files: (fh) => !fh.flags.encrypted });
```

`extract()` returns an `ExtractResult<Readable>`:

```typescript
interface ExtractResult<T> {
  arcHeader: ArcHeader; // Archive metadata
  fileHeaders: FileHeader[]; // All file headers (available immediately)
  fileCount: number; // Total number of entries
  totalSize: number; // Total uncompressed size in bytes
  files: AsyncGenerator<ArcFile<T>>; // Lazy file extraction
}
```

### Iterating files

```typescript
for await (const { fileHeader, extraction } of result.files) {
  console.log(fileHeader.name, fileHeader.unpSize);

  if (fileHeader.flags.directory) continue; // directory entry — no extraction stream

  const writeStream = fs.createWriteStream(`out/${fileHeader.name}`);
  await pipeline(extraction, writeStream);
}
```

### Extractor options

```typescript
const extractor = await RARExtractor.fromFile("./archive.rar", {
  password: "1234",
  idleTimeoutMs: 60_000, // Kill the worker if it stops emitting progress (default: 5 min)
  outputSizeLimitFactor: 2, // Per-file cap = unpSize * factor (default: 2). Defends against corrupt headers.
  debug: true, // Emit verbose [unrar …] / [unrar-worker …] logs on stderr
});
```

### Cleanup

```typescript
extractor.close(); // Terminates the worker thread; safe to call multiple times
```

## Types

### FileHeader

```typescript
interface FileHeader {
  name: string;
  flags: { encrypted: boolean; solid: boolean; directory: boolean };
  packSize: number;
  unpSize: number;
  crc: number;
  time: string; // ISO 8601
  unpVer: string;
  method: CompressMethod;
  comment: string;
}
```

### ArcHeader

```typescript
interface ArcHeader {
  comment: string;
  flags: {
    volume: boolean;
    lock: boolean;
    solid: boolean;
    authInfo: boolean;
    recoveryRecord: boolean;
    headerEncrypted: boolean;
  };
}
```

### UnRARError

```typescript
class UnRARError extends Error {
  reason: FailReason;
  file?: string;
}
```

| FailReason            | Message                                                    |
| --------------------- | ---------------------------------------------------------- |
| ERAR_NO_MEMORY        | Not enough memory                                          |
| ERAR_BAD_DATA         | Archive header or data are damaged                         |
| ERAR_BAD_ARCHIVE      | File is not RAR archive                                    |
| ERAR_UNKNOWN_FORMAT   | Unknown archive format                                     |
| ERAR_EOPEN            | File open error                                            |
| ERAR_ECREATE          | File create error                                          |
| ERAR_ECLOSE           | File close error                                           |
| ERAR_EREAD            | File read error                                            |
| ERAR_EWRITE           | File write error                                           |
| ERAR_SMALL_BUF        | Buffer for archive comment is too small, comment truncated |
| ERAR_UNKNOWN          | Unknown error                                              |
| ERAR_MISSING_PASSWORD | Password for encrypted file or header is not specified     |
| ERAR_EREFERENCE       | Cannot open file source for reference record               |
| ERAR_BAD_PASSWORD     | Wrong password is specified                                |

## Architecture

Extraction runs in a Worker Thread. The WASM decompression never blocks the main event loop.

```
Main thread                                Worker thread
───────────                                ─────────────
RARExtractor                               ExtractorWorker
  │                                          │
  ├── fromFile  ──── filepath ────▶          SeekableFile (fs.readSync)
  ├── fromBuffer ─── ArrayBuffer ─▶          SeekableBuffer (in-memory)
  └── fromSeekable ─ SharedArrayBuffer ─▶    SeekableBridgeClient
        │                                      │   ▲
        ▼                                      ▼   │ Atomics.wait
    SeekableBridgeHost ◀── postMessage ─── bridge request
        │                                      │   │
        ▼                                      │   │
    user's async Seekable                      │   │
        │                                      │   │
        └── Atomics.notify ──────────────────▶ │   │
                                               ▼   │
                                           WasmExtractor
                                               │
                                               ▼
                                           unrar.wasm
```

- `fromFile` / `fromBuffer` : zero bridge overhead, the worker reads locally.
- `fromSeekable` : the async `Seekable` lives in the main thread. Each sync WASM I/O call becomes a **worker-side `Atomics.wait`** (blocks the worker thread only) + an async round-trip to the host, which resolves the call and wakes the worker via `Atomics.notify` and `SharedArrayBuffer`.
- Extracted bytes are pushed through the worker as zero-copy `postMessage(chunk, transferList)` and surface on the main thread as `Readable` streams.

### Safeguards against damaged archives

- `idleTimeoutMs` watchdog — terminate the worker if it stops emitting progress.
- `outputSizeLimitFactor` — per-file cap (× declared `unpSize`) to defend against corrupt headers that lie about size and make the decoder spin producing junk.
- `UnRARError` with `reason` is thrown when the underlying library reports an error.

## Development

```bash
# Install dependencies
npm install

# Download unrar C++ source
npm run downloadUnrarSrc

# Build (requires Docker for Emscripten)
npm run build:release

# Test
npm test
```

## License

MIT. See [LICENSE.md](LICENSE.md).
