import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';

import type { WorkerInitData, WorkerMessage, WorkerResponse } from './ExtractorWorker';
import { WorkerMessageType, WorkerResponseType } from './ExtractorWorker';
import { Seekable } from './seekables/Seekable';
import {
  SeekableBridgeHost,
  BridgeSharedBuffers as BridgeSharedBuffers,
} from './seekables/SeekableBridge';
import { ArcFile, ExtractOptions, ExtractResult, FileHeader, UnRARError } from './types';

export interface ExtractorOptions {
  password?: string;
  /**
   * Hard cap on inactivity (no worker message received) before the extraction
   * is considered hung. Defends against any WASM-side infinite loop on damaged
   * archives that ALSO stops producing worker messages. Default: 5 minutes.
   */
  idleTimeoutMs?: number;
  /**
   * Per-file output cap expressed as a multiple of the declared `unpSize`.
   * Defends against damaged archives whose corrupt header lies about the
   * uncompressed size, making the decoder emit chunks indefinitely (which
   * would reset the idle watchdog and burn CPU at 100%). Set to 0 or
   * `Infinity` to disable. Default: 2.
   */
  outputSizeLimitFactor?: number;
  /**
   * Emit verbose tracing logs from both the worker and the WASM<->JS boundary.
   * Defaults to the truthiness of `process.env.UNRAR_DEBUG` in the worker.
   */
  debug?: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Orchestrates WASM extraction in a worker thread.
 *
 * Messages flow: worker posts file/chunk/fileEnd/directory/done/error.
 * Chunks are pushed directly into the active PassThrough stream by the
 * message handler (not the generator), avoiding deadlocks.
 * The generator yields completed or actively-streaming ArcFile items
 * via a queue that the message handler populates.
 */
export class RARExtractor {
  private terminated = false;

  private constructor(
    private worker: Worker,
    private readonly options: ExtractorOptions,
  ) {
    this.worker.on('error', () => {});
  }

  private static buildWorker(mode: 'file', payload: string, options: ExtractorOptions): Worker;
  private static buildWorker(
    mode: 'buffer',
    payload: ArrayBuffer,
    options: ExtractorOptions,
  ): Worker;
  private static buildWorker(
    mode: 'seekable',
    payload: BridgeSharedBuffers,
    options: ExtractorOptions,
  ): Worker;
  private static buildWorker(
    mode: 'file' | 'buffer' | 'seekable',
    payload: string | ArrayBuffer | BridgeSharedBuffers,
    options: ExtractorOptions,
  ): Worker {
    const workerPath = path.join(__dirname, 'ExtractorWorker.js');
    const worker = new Worker(workerPath, {
      workerData: {
        mode,
        filepath: mode === 'file' ? payload : undefined,
        buffer: mode === 'buffer' ? payload : undefined,
        sabs: mode === 'seekable' ? payload : undefined,
        password: options.password ?? '',
        extractorOptions: {
          outputSizeLimitFactor: options.outputSizeLimitFactor,
          debug: options.debug,
        },
      },
      transferList: payload instanceof ArrayBuffer ? [payload] : undefined,
    });

    return worker;
  }

  static async fromFile(filepath: string, options: ExtractorOptions = {}): Promise<RARExtractor> {
    await fs.access(filepath);
    return new RARExtractor(RARExtractor.buildWorker('file', filepath, options), options);
  }

  static async fromBuffer(
    data: ArrayBuffer | Uint8Array,
    options: ExtractorOptions = {},
  ): Promise<RARExtractor> {
    const buffer =
      data instanceof Uint8Array
        ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
        : data;

    return new RARExtractor(RARExtractor.buildWorker('buffer', buffer, options), options);
  }

  static async fromSeekable(
    seekable: Seekable,
    options: ExtractorOptions = {},
  ): Promise<RARExtractor> {
    const bridge = new SeekableBridgeHost(seekable);
    const worker = RARExtractor.buildWorker('seekable', bridge.sharedBuffers, options);
    worker.on('message', (msg: unknown) => bridge.onMessage(msg));

    return new RARExtractor(worker, options);
  }

  public async extract(options: ExtractOptions = {}): Promise<ExtractResult<Readable>> {
    const fileFilter = options.files;
    const idleTimeoutMs = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    const fileQueue: (ArcFile<Readable> | 'done' | UnRARError)[] = [];
    let resolveFile: ((v: ArcFile<Readable> | 'done' | UnRARError) => void) | null = null;

    let idleTimer: NodeJS.Timeout | null = null;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        this.terminate();
        enqueueFile(
          new UnRARError(
            'ERAR_UNKNOWN' as never,
            `Extraction stalled: no activity from worker in ${idleTimeoutMs}ms`,
          ),
        );
      }, idleTimeoutMs);
      idleTimer.unref();
    };
    const disarmIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const enqueueFile = (item: ArcFile<Readable> | 'done' | UnRARError) => {
      if (resolveFile) {
        const resolve = resolveFile;
        resolveFile = null;
        resolve(item);
      } else {
        fileQueue.push(item);
      }
    };

    const waitForFile = (): Promise<ArcFile<Readable> | 'done' | UnRARError> => {
      const queued = fileQueue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => {
        resolveFile = resolve;
      });
    };

    let phase1Resolve: ((msg: WorkerResponse) => void) | null = null;
    const phase1Queue: WorkerResponse[] = [];

    let activeStream: PassThrough | null = null;
    let activeFileHeader: FileHeader | null = null;
    let phase = 1;

    this.worker.on('message', (msg: WorkerResponse) => {
      // Bridge requests must not be interpreted as protocol messages.
      if ((msg as unknown as { __bridge?: boolean }).__bridge === true) return;
      armIdleTimer();
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

      switch (msg.type) {
        case WorkerResponseType.File:
          activeStream = new PassThrough();
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
          disarmIdleTimer();
          this.terminate();
          enqueueFile('done');
          break;

        case WorkerResponseType.Error: {
          if (activeStream) {
            activeStream.destroy();
            activeStream = null;
          }
          disarmIdleTimer();
          this.terminate();
          enqueueFile(new UnRARError(msg.reason as never, msg.message, msg.file));
          break;
        }

        case WorkerResponseType.FileList:
          disarmIdleTimer();
          this.terminate();
          enqueueFile(
            new UnRARError('ERAR_UNKNOWN' as never, 'Unexpected FileList during extraction'),
          );
          break;
      }
    });

    armIdleTimer();

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
      throw new UnRARError(fileListMsg.reason as never, fileListMsg.message, fileListMsg.file);
    }
    if (fileListMsg.type !== WorkerResponseType.FileList) {
      this.terminate();
      throw new Error(`Unexpected message type: ${fileListMsg.type}`);
    }

    const { arcHeader, fileHeaders } = fileListMsg;
    const fileCount = fileHeaders.length;
    const totalSize = fileHeaders.reduce((sum, fh) => sum + fh.unpSize, 0);

    let fileNames: string[] | undefined;
    if (fileFilter) {
      if (Array.isArray(fileFilter)) {
        fileNames = fileFilter;
      } else {
        fileNames = fileHeaders.filter((fh) => fileFilter(fh)).map((fh) => fh.name);
      }
    }

    phase = 2;
    this.worker.postMessage({
      type: WorkerMessageType.Extract,
      fileNames,
    } satisfies WorkerMessage);

    async function* getFiles(): AsyncGenerator<ArcFile<Readable>> {
      for (;;) {
        const item = await waitForFile();
        if (item === 'done') return;
        if (item instanceof UnRARError) throw item;
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
