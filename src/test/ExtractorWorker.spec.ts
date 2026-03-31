import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { WorkerMessage, WorkerResponse } from '../js/ExtractorWorker';
import { WorkerMessageType, WorkerResponseType } from '../js/ExtractorWorker';

function readTestFile(fileName: string): ArrayBuffer {
  const buf = fs.readFileSync(`./testFiles/${fileName}`);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function createWorker(fileName: string, password = ''): Worker {
  const data = readTestFile(fileName);
  const workerPath = path.join(__dirname, '..', 'js', 'ExtractorWorker.js');
  return new Worker(workerPath, {
    workerData: { data, password },
    transferList: [data],
  });
}

function collectMessages(worker: Worker): Promise<WorkerResponse[]> {
  return new Promise((resolve, reject) => {
    const messages: WorkerResponse[] = [];
    worker.on('message', (msg: WorkerResponse) => messages.push(msg));
    worker.on('error', reject);
    worker.on('exit', () => resolve(messages));
  });
}

function sendAndCollect(worker: Worker, ...msgs: WorkerMessage[]): Promise<WorkerResponse[]> {
  const promise = collectMessages(worker);
  for (const msg of msgs) {
    worker.postMessage(msg);
  }
  // Terminate after messages are processed
  setTimeout(() => worker.terminate(), 500);
  return promise;
}

describe('ExtractorWorker', () => {
  describe('GetFileList', () => {
    it('responds with FileList containing headers', async () => {
      const worker = createWorker('WithComment.rar');
      const messages = await sendAndCollect(worker, {
        type: WorkerMessageType.GetFileList,
      });

      const fileListMsg = messages.find((m) => m.type === WorkerResponseType.FileList);
      assert.ok(fileListMsg);
      assert.ok('arcHeader' in fileListMsg);
      assert.ok('fileHeaders' in fileListMsg);
      assert.strictEqual(fileListMsg.fileHeaders.length, 2);
      assert.strictEqual(fileListMsg.fileHeaders[0].name, '1File.txt');
    });

    it('responds with Error for encrypted archive without password', async () => {
      const worker = createWorker('HeaderEnc1234.rar');
      const messages = await sendAndCollect(worker, {
        type: WorkerMessageType.GetFileList,
      });

      const errorMsg = messages.find((m) => m.type === WorkerResponseType.Error);
      assert.ok(errorMsg);
      assert.ok('message' in errorMsg);
      assert.ok(errorMsg.message.includes('Password'));
    });
  });

  describe('Extract', () => {
    it('sends File, Chunk, FileEnd, Done messages in order', async () => {
      const worker = createWorker('WithComment.rar');
      const messages = await sendAndCollect(
        worker,
        { type: WorkerMessageType.GetFileList },
        { type: WorkerMessageType.Extract },
      );

      // Skip the FileList message
      const extractMsgs = messages.filter((m) => m.type !== WorkerResponseType.FileList);
      const types = extractMsgs.map((m) => m.type);

      // Should have File/FileEnd pairs then Done
      assert.ok(types.includes(WorkerResponseType.File));
      assert.ok(types.includes(WorkerResponseType.FileEnd));
      assert.strictEqual(types[types.length - 1], WorkerResponseType.Done);
    });

    it('filters files by name', async () => {
      const worker = createWorker('FolderTest.rar');
      const messages = await sendAndCollect(
        worker,
        { type: WorkerMessageType.GetFileList },
        {
          type: WorkerMessageType.Extract,
          fileNames: ['Folder1/Folder Space/long.txt'],
        },
      );

      const fileMsgs = messages.filter((m) => m.type === WorkerResponseType.File);
      assert.strictEqual(fileMsgs.length, 1);
    });

    it('sends Directory messages for directory entries', async () => {
      const worker = createWorker('FolderTest.rar');
      const messages = await sendAndCollect(
        worker,
        { type: WorkerMessageType.GetFileList },
        { type: WorkerMessageType.Extract },
      );

      const dirMsgs = messages.filter((m) => m.type === WorkerResponseType.Directory);
      assert.ok(dirMsgs.length > 0);
    });

    it('sends chunks with data', async () => {
      const worker = createWorker('WithComment.rar');
      const messages = await sendAndCollect(
        worker,
        { type: WorkerMessageType.GetFileList },
        { type: WorkerMessageType.Extract },
      );

      // WithComment.rar has empty files (0 bytes), so no chunks expected
      // Use FolderTest for actual chunk data
      worker.terminate();

      const worker2 = createWorker('FolderTest.rar');
      const messages2 = await sendAndCollect(
        worker2,
        { type: WorkerMessageType.GetFileList },
        {
          type: WorkerMessageType.Extract,
          fileNames: ['Folder1/Folder Space/long.txt'],
        },
      );

      const chunkMsgs = messages2.filter((m) => m.type === WorkerResponseType.Chunk);
      assert.ok(chunkMsgs.length > 0);
      assert.ok('data' in chunkMsgs[0]);
      assert.ok(chunkMsgs[0].data instanceof Uint8Array);
    });

    it('sends Error for encrypted files without password', async () => {
      const worker = createWorker('FileEncByName.rar');
      const messages = await sendAndCollect(
        worker,
        { type: WorkerMessageType.GetFileList },
        { type: WorkerMessageType.Extract },
      );

      // First file is not encrypted, second is — should get an error
      const errorMsg = messages.find((m) => m.type === WorkerResponseType.Error);
      assert.ok(errorMsg);
    });
  });
});
