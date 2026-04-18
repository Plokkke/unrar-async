import { SeekMethod } from '../types';

/**
 * Public contract for a random-access data source. Implement this to plug
 * your own backend (HTTP range, S3, memory-mapped file, …) into
 * `RarExtractor.fromSeekable(...)`.
 *
 * All methods are async on purpose: the extraction runs in a worker thread
 * and the user's implementation may do network / async I/O. The worker
 * blocks on its own thread (via `Atomics.wait`) while the main thread
 * resolves each call, so the Node event loop stays free.
 */
export interface Seekable {
  read(size: number): Promise<Uint8Array | null>;
  seek(pos: number, method: SeekMethod): Promise<boolean>;
  tell(): Promise<number>;
  size(): Promise<number>;
  close?(): Promise<void>;
}

/**
 * Internal synchronous contract used on the worker side to talk to the
 * WASM decompressor. Not exported from the package.
 */
export interface SyncSeekable {
  read(size: number): Uint8Array | null;
  seek(pos: number, method: SeekMethod): boolean;
  readonly position: number;
  readonly size: number;
  close?(): void;
}
