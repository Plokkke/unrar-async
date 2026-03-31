# unrar-async

[![npm version](https://badge.fury.io/js/unrar-async.svg)](https://badge.fury.io/js/unrar-async)
[![MIT License](https://badges.frapsoft.com/os/mit/mit.svg?v=103)](https://opensource.org/licenses/mit-license.php)
[![TypeScript](https://badges.frapsoft.com/typescript/code/typescript.svg?v=101)](https://www.typescriptlang.org/)

Async RAR archive extractor for Node.js. Extraction runs in a **Worker Thread** so the event loop is never blocked. Files are streamed as `Readable` streams.

Powered by the official [unrar C++ library](http://www.rarlab.com/rar_add.htm) compiled to WebAssembly via [Emscripten](http://emscripten.org/).

> Forked from [node-unrar-js](https://github.com/YuJianrong/node-unrar.js) by Jianrong Yu.

## Installation

```bash
npm install unrar-async
```

## Quick Start

```typescript
import { RarExtractor } from "unrar-async";

const extractor = await RarExtractor.fromFile("./archive.rar");
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
// From a file path
const extractor = await RarExtractor.fromFile("./archive.rar");
const extractor = await RarExtractor.fromFile("./archive.rar", {
  password: "1234",
});

// From an ArrayBuffer
const extractor = await RarExtractor.fromBuffer(arrayBuffer);

// From a Readable stream (HTTP response, S3, etc.)
const extractor = await RarExtractor.fromStream(response.body);
```

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

  if (fileHeader.flags.directory) {
    // Directory entry — no extraction stream
    continue;
  }

  // extraction is a Readable stream
  const writeStream = fs.createWriteStream(`out/${fileHeader.name}`);
  await pipeline(extraction, writeStream);
}
```

### Cleanup

```typescript
extractor.close(); // Terminates the worker thread
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

### UnrarError

```typescript
class UnrarError extends Error {
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
RarExtractor (main thread)
  |
  |-- Worker Thread
  |     |-- WasmExtractor (WASM bridge + callbacks)
  |     |     |-- unrar.wasm (official C++ unrar library)
  |     |
  |     |-- ExtractorWorker (message routing)
  |
  |-- PassThrough streams (one per extracted file)
```

1. `extract()` sends a `GetFileList` message to the worker
2. Worker scans archive headers (no decompression) and returns metadata
3. Main thread sends `Extract` message with optional file filter
4. Worker decompresses files, streaming chunks via `postMessage` (zero-copy transfer)
5. Main thread pushes chunks into PassThrough streams, yielded as `ArcFile<Readable>`

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
