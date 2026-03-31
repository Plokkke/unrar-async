import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Worker } from 'worker_threads';

import type { WorkerMessage, WorkerResponse } from './ExtractorWorker';
import { WorkerMessageType, WorkerResponseType } from './ExtractorWorker';
import { ArcFile, ExtractOptions, ExtractResult, FileHeader, UnrarError } from './types';

async function readableToArrayBuffer(stream: Readable): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    if (chunk instanceof Uint8Array) {
      chunks.push(new Uint8Array(chunk));
    } else if (typeof chunk === 'string') {
      chunks.push(new TextEncoder().encode(chunk));
    } else {
      throw new TypeError(
        `Unexpected stream chunk type: ${typeof chunk}. Expected Buffer, Uint8Array, or string.`,
      );
    }
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer as ArrayBuffer;
}

export interface ExtractorOptions {
  password?: string;
}

/**
 * Orchestrates WASM extraction in a worker thread.
 *
 * Messages flow: worker posts file/chunk/fileEnd/directory/done/error.
 * Chunks are pushed directly into the active PassThrough stream by the
 * message handler (not the generator), avoiding deadlocks.
 * The generator yields completed or actively-streaming ArcFile items
 * via a queue that the message handler populates.
 */
export class RarExtractor {
  private worker: Worker;
  private terminated = false;

  private constructor(
    data: ArrayBuffer,
    private readonly options: ExtractorOptions,
  ) {
    const workerPath = path.join(__dirname, 'ExtractorWorker.js');
    this.worker = new Worker(workerPath, {
      workerData: { data, password: options.password ?? '' },
      transferList: [data],
    });
    // Prevent unhandled 'error' events from crashing the process.
    // Errors are handled via the message protocol (WorkerResponseType.Error).
    this.worker.on('error', () => {});
  }

  static async fromBuffer(
    data: ArrayBuffer,
    options: ExtractorOptions = {},
  ): Promise<RarExtractor> {
    return new RarExtractor(data, options);
  }

  static async fromStream(stream: Readable, options: ExtractorOptions = {}): Promise<RarExtractor> {
    return new RarExtractor(await readableToArrayBuffer(stream), options);
  }

  static async fromFile(filepath: string, options: ExtractorOptions = {}): Promise<RarExtractor> {
    const data = await fs.readFile(filepath);
    return new RarExtractor(<ArrayBuffer>data.buffer, options);
  }

  public async extract(options: ExtractOptions = {}): Promise<ExtractResult<Readable>> {
    const fileFilter = options.files;

    // --- Message infrastructure ---
    // fileQueue: completed ArcFile items ready to be yielded
    // resolveFile: when the generator needs the next file, it awaits this
    const fileQueue: (ArcFile<Readable> | 'done' | UnrarError)[] = [];
    let resolveFile: ((v: ArcFile<Readable> | 'done' | UnrarError) => void) | null = null;

    const enqueueFile = (item: ArcFile<Readable> | 'done' | UnrarError) => {
      if (resolveFile) {
        const resolve = resolveFile;
        resolveFile = null;
        resolve(item);
      } else {
        fileQueue.push(item);
      }
    };

    const waitForFile = (): Promise<ArcFile<Readable> | 'done' | UnrarError> => {
      const queued = fileQueue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => {
        resolveFile = resolve;
      });
    };

    // Phase 1 uses a simple message queue (only fileList or error expected)
    let phase1Resolve: ((msg: WorkerResponse) => void) | null = null;
    const phase1Queue: WorkerResponse[] = [];

    let activeStream: PassThrough | null = null;
    let activeFileHeader: FileHeader | null = null;
    let phase = 1;

    this.worker.on('message', (msg: WorkerResponse) => {
      if (phase === 1) {
        if (phase1Resolve) {
          const resolve = phase1Resolve;
          phase1Resolve = null;
          resolve(msg);
        } else {
          phase1Queue.push(msg);
        }
        return;
      }

      // Phase 2: route messages
      switch (msg.type) {
        case WorkerResponseType.File:
          activeStream = new PassThrough();
          // Prevent uncaught 'error' if destroy(err) is called before consumer attaches
          activeStream.on('error', () => {});
          activeFileHeader = msg.fileHeader;
          enqueueFile({
            fileHeader: msg.fileHeader,
            extraction: activeStream,
          });
          break;

        case WorkerResponseType.Chunk:
          activeStream?.push(msg.data);
          break;

        case WorkerResponseType.FileEnd:
          if (activeStream) {
            activeStream.push(null);
            activeStream = null;
            activeFileHeader = null;
          }
          break;

        case WorkerResponseType.Directory:
          enqueueFile({ fileHeader: msg.fileHeader });
          break;

        case WorkerResponseType.Done:
          if (activeStream) {
            activeStream.push(null);
            activeStream = null;
          }
          this.terminate();
          enqueueFile('done');
          break;

        case WorkerResponseType.Error: {
          if (activeStream) {
            activeStream.destroy();
            activeStream = null;
          }
          this.terminate();
          enqueueFile(new UnrarError(msg.reason as never, msg.message, msg.file));
          break;
        }

        case WorkerResponseType.FileList:
          this.terminate();
          enqueueFile(
            new UnrarError('ERAR_UNKNOWN' as never, 'Unexpected FileList during extraction'),
          );
          break;
      }
    });

    // Worker errors are handled via message protocol. The base 'error'
    // handler in the constructor prevents uncaught exceptions.

    // --- Phase 1: get file list ---
    this.worker.postMessage({ type: WorkerMessageType.GetFileList } satisfies WorkerMessage);

    const waitPhase1 = (): Promise<WorkerResponse> => {
      const queued = phase1Queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => {
        phase1Resolve = resolve;
      });
    };

    const fileListMsg = await waitPhase1();
    if (fileListMsg.type === WorkerResponseType.Error) {
      this.terminate();
      throw new UnrarError(fileListMsg.reason as never, fileListMsg.message, fileListMsg.file);
    }
    if (fileListMsg.type !== WorkerResponseType.FileList) {
      this.terminate();
      throw new Error(`Unexpected message type: ${fileListMsg.type}`);
    }

    const { arcHeader, fileHeaders } = fileListMsg;
    const fileCount = fileHeaders.length;
    const totalSize = fileHeaders.reduce((sum, fh) => sum + fh.unpSize, 0);

    // Resolve callback filter → name list
    let fileNames: string[] | undefined;
    if (fileFilter) {
      if (Array.isArray(fileFilter)) {
        fileNames = fileFilter;
      } else {
        fileNames = fileHeaders.filter((fh) => fileFilter(fh)).map((fh) => fh.name);
      }
    }

    // --- Phase 2: extract files ---
    phase = 2;
    this.worker.postMessage({
      type: WorkerMessageType.Extract,
      fileNames,
    } satisfies WorkerMessage);

    async function* getFiles(): AsyncGenerator<ArcFile<Readable>> {
      for (;;) {
        const item = await waitForFile();
        if (item === 'done') return;
        if (item instanceof UnrarError) throw item;
        yield item;
      }
    }

    return { arcHeader, fileHeaders, fileCount, totalSize, files: getFiles() };
  }

  public close(): void {
    this.terminate();
  }

  private terminate(): void {
    if (!this.terminated) {
      this.terminated = true;
      this.worker.terminate();
    }
  }
}
