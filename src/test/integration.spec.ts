import * as assert from 'assert';
import { Readable } from 'stream';
import { RarExtractor } from '../js/RarExtractor';
import { UnrarError } from '../js/types';

describe('Integration', function () {
  this.timeout(10_000);

  it('returns metadata before iterating files', async () => {
    const extractor = await RarExtractor.fromFile('./testFiles/FolderTest.rar');
    const result = await extractor.extract();

    assert.ok(result.arcHeader);
    assert.ok(result.fileHeaders.length > 0);
    assert.strictEqual(result.fileCount, result.fileHeaders.length);
    assert.strictEqual(
      result.totalSize,
      result.fileHeaders.reduce((s, fh) => s + fh.unpSize, 0),
    );

    extractor.close();
  });

  it('streams file content via Readable', async () => {
    const extractor = await RarExtractor.fromFile('./testFiles/WithComment.rar');
    const { files } = await extractor.extract();

    for await (const { fileHeader, extraction } of files) {
      assert.ok(fileHeader.name);
      if (extraction) {
        assert.ok(extraction instanceof Readable);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of extraction) {
          // drain
        }
      }
    }
  });

  it('filters files by name array', async () => {
    const extractor = await RarExtractor.fromFile('./testFiles/FolderTest.rar');
    const { files } = await extractor.extract({
      files: ['Folder1/Folder Space/long.txt'],
    });

    const list: string[] = [];
    for await (const { fileHeader, extraction } of files) {
      list.push(fileHeader.name);
      if (extraction) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of extraction) {
          /* drain */
        }
      }
    }

    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0], 'Folder1/Folder Space/long.txt');
  });

  it('filters files by callback', async () => {
    const extractor = await RarExtractor.fromFile('./testFiles/FolderTest.rar');
    const { files } = await extractor.extract({
      files: (fh) => !fh.flags.directory,
    });

    const list: string[] = [];
    for await (const { fileHeader, extraction } of files) {
      list.push(fileHeader.name);
      if (extraction) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of extraction) {
          /* drain */
        }
      }
    }

    assert.ok(list.length > 0);
    assert.ok(list.every((name) => !name.endsWith('/')));
  });

  it('handles password-protected archives', async () => {
    const extractor = await RarExtractor.fromFile('./testFiles/HeaderEnc1234.rar', {
      password: '1234',
    });
    const { arcHeader } = await extractor.extract();
    assert.strictEqual(arcHeader.flags.headerEncrypted, true);
    assert.strictEqual(arcHeader.comment, 'Hello, world');
    extractor.close();
  });

  it('throws UnrarError for encrypted archive without password', async () => {
    const extractor = await RarExtractor.fromFile('./testFiles/HeaderEnc1234.rar');
    await assert.rejects(() => extractor.extract(), {
      message: 'Password for encrypted file or header is not specified',
    });
  });

  it('does not block the event loop', async () => {
    const extractor = await RarExtractor.fromFile('./testFiles/FolderTest.rar');
    const { files } = await extractor.extract();

    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 1);

    for await (const { extraction } of files) {
      if (extraction) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of extraction) {
          /* drain */
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
    clearTimeout(timer);
    assert.strictEqual(timerFired, true);
  });
});
