# Changelog

## 3.0.0 (2026-03-31)

Forked from [node-unrar-js](https://github.com/YuJianrong/node-unrar.js) by Jianrong Yu.

### Breaking Changes

- Entirely new async API: `RarExtractor.fromFile()`, `.fromBuffer()`, `.fromStream()`
- Extraction runs in a Worker Thread — event loop is never blocked
- Files are extracted as `Readable` streams (live streaming, not buffered)
- `extract()` is now async and returns metadata (fileHeaders, fileCount, totalSize) before iteration
- File iteration uses `for await...of` (AsyncGenerator) instead of sync generators
- Password is set at extractor creation, not per-extraction
- Minimum Node.js version raised to 18

### New Features

- `RarExtractor.fromStream()` — extract from any Readable (HTTP response, S3, etc.)
- File metadata (count, total size, headers) available before extraction starts
- Non-blocking extraction via Worker Threads
- Streaming output per file via PassThrough streams
- Typed WASM bridge — no more `any` in the module interface

### Architecture

- `WasmExtractor` — concrete class bridging WASM with typed callbacks
- `ExtractorWorker` — worker thread message handler
- `RarExtractor` — main thread orchestrator with async generator
- `DataFile` — simplified in-memory file abstraction (read-only archive access)
