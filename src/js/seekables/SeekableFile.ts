import * as fs from 'node:fs';

import { SeekMethod } from '../types';

import { SyncSeekable } from './Seekable';

/**
 * Internal fd-backed `SyncReader`. Used by `RarExtractor.fromFile`:
 * the main thread sends the filepath to the worker, the worker opens
 * the fd locally and reads on demand — no need to materialize the whole
 * archive in memory.
 */
export class SeekableFile implements SyncSeekable {
  private readonly fd: number;
  private readonly _size: number;
  private readonly buffer: Buffer;
  private index: number = 0;
  private closed: boolean = false;

  constructor(filepath: string, bufferSize: number = 1 << 20) {
    this.fd = fs.openSync(filepath, 'r');
    this._size = fs.fstatSync(this.fd).size;
    this.buffer = Buffer.allocUnsafe(bufferSize);
  }

  public get size(): number {
    return this._size;
  }

  public get position(): number {
    return this.index;
  }

  public read(size: number): Uint8Array | null {
    if (this.closed) return null;
    const remaining = this._size - this.index;
    if (remaining <= 0) return null;
    const len = Math.min(size, remaining, this.buffer.byteLength);
    const read = fs.readSync(this.fd, this.buffer, 0, len, this.index);
    if (read <= 0) return null;
    this.index += read;
    return new Uint8Array(this.buffer.buffer, this.buffer.byteOffset, read).slice();
  }

  public seek(pos: number, method: SeekMethod): boolean {
    let newPos = this.index;
    if (method === 'SET') {
      newPos = pos;
    } else if (method === 'CUR') {
      newPos += pos;
    } else {
      newPos = this._size - pos;
    }
    if (newPos < 0 || newPos > this._size) {
      return false;
    }
    this.index = newPos;
    return true;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* best-effort */
    }
  }
}
