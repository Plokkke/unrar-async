import { parentPort } from 'node:worker_threads';

import { SeekMethod } from '../types';

import { Seekable, SyncSeekable } from './Seekable';

/**
 * Shared layout for the sync ↔ async bridge between the worker and the
 * main thread. The worker writes a request into the control slots, calls
 * `parentPort.postMessage('bridge-request')`, then blocks on
 * `Atomics.wait(control, STATE, PENDING)`. The main thread handles the
 * message asynchronously, writes the response into the same shared
 * buffer, and wakes the worker via `Atomics.notify`.
 */

export const CONTROL_SLOTS = 8;
export const PAYLOAD_BYTES = 1 << 20; // 1 MiB — dwarfs typical RAR reads (< 64 KiB)

// control[STATE] values
export const STATE_PENDING = 0;
export const STATE_DONE = 1;
export const STATE_ERROR = 2;

// control indices
export const CTRL_STATE = 0;
export const CTRL_OPCODE = 1;
export const CTRL_ARG0_LO = 2;
export const CTRL_ARG0_HI = 3;
export const CTRL_ARG1 = 4;
export const CTRL_RESP_LO = 5;
export const CTRL_RESP_HI = 6;
// slot 7 reserved

// opcodes
export const OP_READ = 0;
export const OP_SEEK = 1;
export const OP_TELL = 2;
export const OP_BYTE_LENGTH = 3;
export const OP_CLOSE = 4;

// seek method encoding
export const SEEK_SET = 0;
export const SEEK_CUR = 1;
export const SEEK_END = 2;

export interface BridgeSharedBuffers {
  control: SharedArrayBuffer;
  payload: SharedArrayBuffer;
}

function pack64(value: number): { lo: number; hi: number } {
  // Positions can exceed 2^32 on large archives.
  // We cannot use BigInt directly in Int32Array slots, so we split.
  const lo = value | 0;
  const hi = Math.floor(value / 0x1_0000_0000) | 0;
  return { lo, hi };
}

function unpack64(lo: number, hi: number): number {
  return hi * 0x1_0000_0000 + (lo >>> 0);
}

abstract class SeekableBridge {
  protected readonly control: Int32Array;
  protected readonly payload: Uint8Array;

  constructor(sabs: BridgeSharedBuffers) {
    this.control = new Int32Array(sabs.control);
    this.payload = new Uint8Array(sabs.payload);
  }
}

/**
 * Worker-side sync proxy that forwards each operation to the main thread
 * (where the user's async `Seekable` lives). Blocks the worker thread on
 * `Atomics.wait` until the main thread publishes the response into the
 * shared buffer.
 *
 * The main thread's event loop stays free the whole time — this is what
 * lets the host application keep serving other traffic during extraction.
 */
export class SeekableBridgeClient extends SeekableBridge implements SyncSeekable {
  private _size: number | null = null;
  private _position: number = 0;

  constructor(sabs: BridgeSharedBuffers) {
    super(sabs);
  }

  public get size(): number {
    if (this._size === null) {
      this.requestSync(OP_BYTE_LENGTH, 0, 0);
      this._size = unpack64(this.control[CTRL_RESP_LO], this.control[CTRL_RESP_HI]);
    }
    return this._size;
  }

  public get position(): number {
    return this._position;
  }

  public read(size: number): Uint8Array | null {
    this.requestSync(OP_READ, size, 0);
    const len = this.control[CTRL_RESP_LO];
    if (len < 0) return null; // sentinel for null/EOF
    this._position += len;
    return this.payload.slice(0, len);
  }

  public seek(pos: number, method: SeekMethod): boolean {
    const methodCode = method === 'SET' ? SEEK_SET : method === 'CUR' ? SEEK_CUR : SEEK_END;
    this.requestSync(OP_SEEK, pos, methodCode);
    const ok = this.control[CTRL_RESP_LO] === 1;
    if (ok) this.syncPositionFromHost();
    return ok;
  }

  public close(): void {
    this.requestSync(OP_CLOSE, 0, 0);
  }

  private syncPositionFromHost(): void {
    this.requestSync(OP_TELL, 0, 0);
    this._position = unpack64(this.control[CTRL_RESP_LO], this.control[CTRL_RESP_HI]);
  }

  private requestSync(opcode: number, arg0: number, arg1: number): void {
    const { lo, hi } = pack64(arg0);
    Atomics.store(this.control, CTRL_OPCODE, opcode);
    Atomics.store(this.control, CTRL_ARG0_LO, lo);
    Atomics.store(this.control, CTRL_ARG0_HI, hi);
    Atomics.store(this.control, CTRL_ARG1, arg1);
    Atomics.store(this.control, CTRL_RESP_LO, 0);
    Atomics.store(this.control, CTRL_RESP_HI, 0);
    Atomics.store(this.control, CTRL_STATE, STATE_PENDING);

    parentPort!.postMessage({ __bridge: true });

    const waitResult = Atomics.wait(this.control, CTRL_STATE, STATE_PENDING);
    if (waitResult === 'timed-out') {
      throw new Error('Bridge wait timed out');
    }
    const finalState = Atomics.load(this.control, CTRL_STATE);
    if (finalState === STATE_ERROR) {
      const len = this.control[CTRL_RESP_LO];
      const msg = new TextDecoder().decode(this.payload.slice(0, len));
      throw new Error(`Seekable error: ${msg}`);
    }
    if (finalState !== STATE_DONE) {
      throw new Error(`Bridge protocol error: unexpected state ${finalState}`);
    }
  }
}

export class SeekableBridgeHost extends SeekableBridge {
  public readonly sharedBuffers;

  constructor(private readonly seekable: Seekable) {
    const sharedBuffers = {
      control: new SharedArrayBuffer(CONTROL_SLOTS * Int32Array.BYTES_PER_ELEMENT),
      payload: new SharedArrayBuffer(PAYLOAD_BYTES),
    };
    super(sharedBuffers);
    this.sharedBuffers = sharedBuffers;
  }

  public onMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object' || (msg as { __bridge?: boolean }).__bridge !== true) {
      return;
    }
    void this.handle();
  }

  private async handle(): Promise<void> {
    const opcode = this.control[CTRL_OPCODE];
    const arg0 = unpack64(this.control[CTRL_ARG0_LO], this.control[CTRL_ARG0_HI]);
    const arg1 = this.control[CTRL_ARG1];
    try {
      switch (opcode) {
        case OP_READ: {
          const result = await this.seekable.read(arg0);
          if (result === null) {
            this.control[CTRL_RESP_LO] = -1;
            this.control[CTRL_RESP_HI] = 0;
          } else {
            const len = Math.min(result.byteLength, PAYLOAD_BYTES);
            this.payload.set(result.subarray(0, len), 0);
            this.control[CTRL_RESP_LO] = len;
            this.control[CTRL_RESP_HI] = 0;
          }
          break;
        }
        case OP_SEEK: {
          const method: SeekMethod = arg1 === SEEK_SET ? 'SET' : arg1 === SEEK_CUR ? 'CUR' : 'END';
          // JS numbers are 2^53-safe; arg0 was reconstructed from lo/hi.
          const ok = await this.seekable.seek(arg0, method);
          this.control[CTRL_RESP_LO] = ok ? 1 : 0;
          this.control[CTRL_RESP_HI] = 0;
          break;
        }
        case OP_TELL: {
          const pos = await this.seekable.tell();
          const { lo, hi } = pack64(pos);
          this.control[CTRL_RESP_LO] = lo;
          this.control[CTRL_RESP_HI] = hi;
          break;
        }
        case OP_BYTE_LENGTH: {
          const size = await this.seekable.size();
          const { lo, hi } = pack64(size);
          this.control[CTRL_RESP_LO] = lo;
          this.control[CTRL_RESP_HI] = hi;
          break;
        }
        case OP_CLOSE: {
          await this.seekable.close?.();
          this.control[CTRL_RESP_LO] = 0;
          this.control[CTRL_RESP_HI] = 0;
          break;
        }
        default:
          throw new Error(`Unknown bridge opcode: ${opcode}`);
      }
      Atomics.store(this.control, CTRL_STATE, STATE_DONE);
      Atomics.notify(this.control, CTRL_STATE, 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const bytes = new TextEncoder().encode(message).subarray(0, PAYLOAD_BYTES);
      this.payload.set(bytes, 0);
      this.control[CTRL_RESP_LO] = bytes.byteLength;
      this.control[CTRL_RESP_HI] = 0;
      Atomics.store(this.control, CTRL_STATE, STATE_ERROR);
      Atomics.notify(this.control, CTRL_STATE, 1);
    }
  }
}
