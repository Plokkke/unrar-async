import * as assert from 'assert';
import * as fs from 'fs';

import { RARExtractor } from '../js/RARExtractor';
import { Seekable } from '../js/seekables/Seekable';
import { SeekMethod } from '../js/types';

class BufferSeekable implements Seekable {
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}
  async read(size: number): Promise<Uint8Array | null> {
    const len = Math.min(size, this.data.byteLength - this.pos);
    if (len <= 0) return null;
    return this.data.slice(this.pos, (this.pos += len));
  }
  async seek(pos: number, method: SeekMethod): Promise<boolean> {
    let next = this.pos;
    if (method === 'SET') next = pos;
    else if (method === 'CUR') next += pos;
    else next = this.data.byteLength - pos;
    if (next < 0 || next > this.data.byteLength) return false;
    this.pos = next;
    return true;
  }
  async tell(): Promise<number> {
    return this.pos;
  }
  async size(): Promise<number> {
    return this.data.byteLength;
  }
}

describe('RARExtractor', () => {
  describe('fromBuffer', () => {
    it('creates an extractor from ArrayBuffer', async () => {
      const buf = fs.readFileSync('./testFiles/WithComment.rar');
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const extractor = await RARExtractor.fromBuffer(<ArrayBuffer>data);
      assert.ok(extractor instanceof RARExtractor);
      extractor.close();
    });

    it('creates an extractor from Uint8Array', async () => {
      const buf = fs.readFileSync('./testFiles/WithComment.rar');
      const extractor = await RARExtractor.fromBuffer(new Uint8Array(buf));
      assert.ok(extractor instanceof RARExtractor);
      extractor.close();
    });
  });

  describe('fromFile', () => {
    it('creates an extractor from file path', async () => {
      const extractor = await RARExtractor.fromFile('./testFiles/WithComment.rar');
      assert.ok(extractor instanceof RARExtractor);
      extractor.close();
    });
  });

  describe('fromSeekable', () => {
    it('creates an extractor from a custom async Seekable', async () => {
      const buf = fs.readFileSync('./testFiles/WithComment.rar');
      const seekable = new BufferSeekable(new Uint8Array(buf));
      const extractor = await RARExtractor.fromSeekable(seekable);
      assert.ok(extractor instanceof RARExtractor);
      const result = await extractor.extract();
      for await (const { extraction } of result.files) {
        if (extraction) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of extraction) {
            /* drain */
          }
        }
      }
      extractor.close();
    });
  });

  describe('close', () => {
    it('terminates without error', async () => {
      const extractor = await RARExtractor.fromFile('./testFiles/FolderTest.rar');
      extractor.close();
    });

    it('can be called multiple times safely', async () => {
      const extractor = await RARExtractor.fromFile('./testFiles/FolderTest.rar');
      extractor.close();
      extractor.close();
    });
  });
});
