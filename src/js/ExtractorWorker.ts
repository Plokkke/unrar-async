import { parentPort, workerData } from 'node:worker_threads';

import { SyncSeekable } from './seekables/Seekable';
import { SeekableBridgeClient, BridgeSharedBuffers } from './seekables/SeekableBridge';
import { SeekableBuffer } from './seekables/SeekableBuffer';
import { SeekableFile } from './seekables/SeekableFile';
import { ArcHeader, FileHeader } from './types';
import { WasmExtractor, WasmExtractorOptions } from './WasmExtractor';

const WORKER_DEBUG = Boolean(process.env?.UNRAR_DEBUG);
function dbg(msg: string): void {
  if (!WORKER_DEBUG) return;
  // eslint-disable-next-line no-console
  console.error(`[unrar-worker ${new Date().toISOString()}] ${msg}`);
}

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

export type WorkerInitData = {
  password: string;
  extractorOptions?: WasmExtractorOptions;
} & (
  | { mode: 'file'; filepath: string }
  | { mode: 'buffer'; buffer: ArrayBuffer }
  | { mode: 'seekable'; sabs: BridgeSharedBuffers }
);

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

function buildReader(init: WorkerInitData): SyncSeekable {
  switch (init.mode) {
    case 'file':
      return new SeekableFile(init.filepath);
    case 'buffer':
      return new SeekableBuffer(new Uint8Array(init.buffer));
    case 'seekable':
      return new SeekableBridgeClient(init.sabs);
  }
}

async function run() {
  const init = workerData as WorkerInitData;
  const { password, extractorOptions, mode } = init;

  dbg(`worker start mode=${mode} extractorOptions=${JSON.stringify(extractorOptions ?? {})}`);

  const reader = buildReader(init);

  const extractor = await WasmExtractor.create(
    reader,
    password,
    {
      onDirectory: (fileHeader) => {
        dbg(`onDirectory name="${fileHeader.name}"`);
        post({ type: WorkerResponseType.Directory, fileHeader });
      },
      onCreate: (fileHeader) => {
        dbg(`onCreate name="${fileHeader.name}" unpSize=${fileHeader.unpSize}`);
        post({ type: WorkerResponseType.File, fileHeader });
      },
      onWrite: (chunk) =>
        post({ type: WorkerResponseType.Chunk, data: chunk }, [chunk.buffer as ArrayBuffer]),
      onClose: () => {
        dbg('onClose');
        post({ type: WorkerResponseType.FileEnd });
      },
    },
    extractorOptions,
  );

  parentPort!.on('message', (msg: WorkerMessage) => {
    try {
      if (msg.type === WorkerMessageType.GetFileList) {
        dbg('GetFileList');
        const { arcHeader, fileHeaders: headerGen } = extractor.getFileList();
        const headers = [...headerGen];
        dbg(`GetFileList done count=${headers.length}`);
        post({ type: WorkerResponseType.FileList, arcHeader, fileHeaders: headers });
      } else if (msg.type === WorkerMessageType.Extract) {
        dbg(`Extract start fileNames=${msg.fileNames ? JSON.stringify(msg.fileNames) : 'ALL'}`);
        const { files } = extractor.extract({ files: msg.fileNames });

        let count = 0;
        let result: IteratorResult<{ fileHeader: FileHeader }>;
        do {
          result = files.next();
          if (!result.done) count++;
        } while (!result.done);

        dbg(`Extract done filesYielded=${count}`);
        post({ type: WorkerResponseType.Done });
      }
    } catch (err) {
      dbg(`Extract error ${err instanceof Error ? err.message : String(err)}`);
      postError(err);
    }
  });
}

// Only run when loaded as a worker thread (workerData is null in main thread / test imports)
if (workerData) {
  run();
}
