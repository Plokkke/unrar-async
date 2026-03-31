import { SeekMethod } from './types';

export class DataFile {
  private index: number = 0;

  constructor(private readonly data: Uint8Array) {}

  public read(size: number): Uint8Array | null {
    const len = Math.min(size, this.data.byteLength - this.index);
    return len ? this.data.slice(this.index, (this.index += len)) : null;
  }

  public get position(): number {
    return this.index;
  }

  public seek(pos: number, method: SeekMethod): boolean {
    let newPos = this.index;
    if (method === 'SET') {
      newPos = pos;
    } else if (method === 'CUR') {
      newPos += pos;
    } else {
      newPos = this.data.byteLength - pos;
    }
    if (newPos < 0 || newPos > this.data.byteLength) {
      return false;
    }
    this.index = newPos;
    return true;
  }
}
