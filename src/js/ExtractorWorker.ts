import { parentPort, workerData } from 'worker_threads';
import { ArcHeader, FileHeader } from './types';
import { WasmExtractor } from './WasmExtractor';

export enum WorkerMessageType {
  GetFileList = 'getFileList',
  Extract = 'extract',
}

export enum WorkerResponseType {
  FileList = 'fileList',
  File = 'file',
  Directory = 'directory',
  Chunk = 'chunk',
  FileEnd = 'fileEnd',
  Done = 'done',
  Error = 'error',
}

export type WorkerMessage =
  | { type: WorkerMessageType.GetFileList }
  | { type: WorkerMessageType.Extract; fileNames?: string[] };

export type WorkerResponse =
  | { type: WorkerResponseType.FileList; arcHeader: ArcHeader; fileHeaders: FileHeader[] }
  | { type: WorkerResponseType.File; fileHeader: FileHeader }
  | { type: WorkerResponseType.Directory; fileHeader: FileHeader }
  | { type: WorkerResponseType.Chunk; data: Uint8Array }
  | { type: WorkerResponseType.FileEnd }
  | { type: WorkerResponseType.Done }
  | {
      type: WorkerResponseType.Error;
      message: string;
      reason?: string;
      file?: string;
    };

function post(msg: WorkerResponse, transfer?: ArrayBuffer[]) {
  parentPort!.postMessage(msg, transfer ?? []);
}

function postError(err: unknown) {
  post({
    type: WorkerResponseType.Error,
    message: err instanceof Error ? err.message : String(err),
    reason: (err as { reason?: string }).reason,
    file: (err as { file?: string }).file,
  });
}

async function run() {
  const { data, password } = workerData as { data: ArrayBuffer; password: string };

  const extractor = await WasmExtractor.create(data, password, {
    onDirectory: (fileHeader) => post({ type: WorkerResponseType.Directory, fileHeader }),
    onCreate: (fileHeader) => post({ type: WorkerResponseType.File, fileHeader }),
    onWrite: (chunk) =>
      post({ type: WorkerResponseType.Chunk, data: chunk }, [chunk.buffer as ArrayBuffer]),
    onClose: () => post({ type: WorkerResponseType.FileEnd }),
  });

  parentPort!.on('message', (msg: WorkerMessage) => {
    try {
      if (msg.type === WorkerMessageType.GetFileList) {
        const { arcHeader, fileHeaders: headerGen } = extractor.getFileList();
        post({ type: WorkerResponseType.FileList, arcHeader, fileHeaders: [...headerGen] });
      } else if (msg.type === WorkerMessageType.Extract) {
        const { files } = extractor.extract({ files: msg.fileNames });

        let result: IteratorResult<{ fileHeader: FileHeader }>;
        do {
          result = files.next();
        } while (!result.done);

        post({ type: WorkerResponseType.Done });
      }
    } catch (err) {
      postError(err);
    }
  });
}

// Only run when loaded as a worker thread (workerData is null in main thread / test imports)
if (workerData) {
  run();
}
