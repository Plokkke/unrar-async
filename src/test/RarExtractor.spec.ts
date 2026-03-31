import * as assert from 'assert';
import * as fs from 'fs';
import { Readable } from 'stream';
import { RarExtractor } from '../js/RarExtractor';

describe('RarExtractor', () => {
  describe('fromBuffer', () => {
    it('creates an extractor from ArrayBuffer', async () => {
      const buf = fs.readFileSync('./testFiles/WithComment.rar');
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const extractor = await RarExtractor.fromBuffer(<ArrayBuffer>data);
      assert.ok(extractor instanceof RarExtractor);
      extractor.close();
    });
  });

  describe('fromFile', () => {
    it('creates an extractor from file path', async () => {
      const extractor = await RarExtractor.fromFile('./testFiles/WithComment.rar');
      assert.ok(extractor instanceof RarExtractor);
      extractor.close();
    });
  });

  describe('fromStream', () => {
    it('creates an extractor from Readable stream', async () => {
      const stream = fs.createReadStream('./testFiles/WithComment.rar');
      const extractor = await RarExtractor.fromStream(stream);
      assert.ok(extractor instanceof RarExtractor);
      extractor.close();
    });

    it('creates an extractor from Readable.from()', async () => {
      const buf = fs.readFileSync('./testFiles/WithComment.rar');
      const extractor = await RarExtractor.fromStream(Readable.from(buf));
      assert.ok(extractor instanceof RarExtractor);
      extractor.close();
    });

    it('rejects streams with unexpected chunk types', async () => {
      const stream = new Readable({
        objectMode: true,
        read() {
          this.push(42); // not Uint8Array or string
          this.push(null);
        },
      });
      await assert.rejects(
        () => RarExtractor.fromStream(stream),
        (err: Error) => err instanceof TypeError && err.message.includes('Unexpected stream chunk'),
      );
    });
  });

  describe('close', () => {
    it('terminates without error', async () => {
      const extractor = await RarExtractor.fromFile('./testFiles/FolderTest.rar');
      extractor.close();
    });

    it('can be called multiple times safely', async () => {
      const extractor = await RarExtractor.fromFile('./testFiles/FolderTest.rar');
      extractor.close();
      extractor.close();
    });
  });
});
