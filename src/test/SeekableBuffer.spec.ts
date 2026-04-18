import * as assert from 'assert';
import { SeekableBuffer } from '../js/seekables/SeekableBuffer';

describe('SeekableBuffer', () => {
  const testData = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  describe('read', () => {
    it('reads requested bytes and advances position', () => {
      const file = new SeekableBuffer(testData);
      const chunk = file.read(4);
      assert.deepStrictEqual(chunk, new Uint8Array([0, 1, 2, 3]));
      assert.strictEqual(file.position, 4);
    });

    it('reads remaining bytes when requesting more than available', () => {
      const file = new SeekableBuffer(testData);
      file.seek(8, 'SET');
      const chunk = file.read(100);
      assert.deepStrictEqual(chunk, new Uint8Array([8, 9]));
      assert.strictEqual(file.position, 10);
    });

    it('returns null when at end of data', () => {
      const file = new SeekableBuffer(testData);
      file.seek(0, 'END');
      assert.strictEqual(file.read(1), null);
    });

    it('reads sequentially across multiple calls', () => {
      const file = new SeekableBuffer(testData);
      assert.deepStrictEqual(file.read(3), new Uint8Array([0, 1, 2]));
      assert.deepStrictEqual(file.read(3), new Uint8Array([3, 4, 5]));
      assert.deepStrictEqual(file.read(3), new Uint8Array([6, 7, 8]));
      assert.deepStrictEqual(file.read(3), new Uint8Array([9]));
      assert.strictEqual(file.read(1), null);
    });

    it('handles empty data', () => {
      const file = new SeekableBuffer(new Uint8Array(0));
      assert.strictEqual(file.read(1), null);
    });
  });

  describe('position', () => {
    it('starts at 0', () => {
      const file = new SeekableBuffer(testData);
      assert.strictEqual(file.position, 0);
    });

    it('updates after read', () => {
      const file = new SeekableBuffer(testData);
      file.read(5);
      assert.strictEqual(file.position, 5);
    });
  });

  describe('seek', () => {
    it('seeks to absolute position with SET', () => {
      const file = new SeekableBuffer(testData);
      assert.strictEqual(file.seek(5, 'SET'), true);
      assert.strictEqual(file.position, 5);
    });

    it('seeks relative to current position with CUR', () => {
      const file = new SeekableBuffer(testData);
      file.seek(3, 'SET');
      assert.strictEqual(file.seek(4, 'CUR'), true);
      assert.strictEqual(file.position, 7);
    });

    it('seeks relative to end with END', () => {
      const file = new SeekableBuffer(testData);
      assert.strictEqual(file.seek(3, 'END'), true);
      assert.strictEqual(file.position, 7);
    });

    it('returns false for out-of-range positions', () => {
      const file = new SeekableBuffer(testData);
      assert.strictEqual(file.seek(-1, 'SET'), false);
      assert.strictEqual(file.seek(11, 'SET'), false);
    });

    it('allows seeking to exact end', () => {
      const file = new SeekableBuffer(testData);
      assert.strictEqual(file.seek(10, 'SET'), true);
      assert.strictEqual(file.position, 10);
    });
  });
});
