import { SyncSeekable } from './seekables/Seekable';
import {
  ArcFile,
  ArcHeader,
  ArcList,
  CompressMethod,
  ExtractOptions,
  FileHeader,
  SeekMethod,
  UnRARError,
} from './types';
import type { RarArchive, UnrarModule, WasmFileIO } from './unrar';
import { getUnrar } from './unrar.singleton';

export interface WasmExtractorCallbacks {
  onCreate(fileHeader: FileHeader): void;
  onDirectory(fileHeader: FileHeader): void;
  onWrite(data: Uint8Array): void;
  onClose(): void;
}

export interface WasmExtractorOptions {
  /**
   * Hard cap on per-file extracted bytes, expressed as a multiple of the
   * declared `unpSize` from the file header. Defends against damaged archives
   * whose corrupt header lies about the uncompressed size, causing the WASM
   * decoder to run in an unbounded CPU-bound loop producing junk output.
   * Set to 0 or `Infinity` to disable. Default: 2.
   */
  outputSizeLimitFactor?: number;
  /**
   * Emit verbose tracing logs on every WASM<->JS boundary call. Useful to
   * diagnose hangs on damaged archives. Defaults to the truthiness of
   * `process.env.UNRAR_DEBUG`.
   */
  debug?: boolean;
}

const ARCHIVE_FD = 1;
const MIN_FILE_FD = 100;
const VIRTUAL_ARCHIVE_PATH = '_defaultUnrarJS_.rar';
const DEFAULT_OUTPUT_SIZE_LIMIT_FACTOR = 2;
const ABSOLUTE_MIN_FILE_BYTES = 4096;

interface ActiveFile {
  header: FileHeader;
  writtenBytes: number;
  writeCalls: number;
  startedAt: number;
  limit: number;
  overflowed: boolean;
}

function debugEnabled(opt?: boolean): boolean {
  if (opt !== undefined) return opt;
  return Boolean(process.env?.UNRAR_DEBUG);
}

function logPrefix(): string {
  return `[unrar ${new Date().toISOString()}]`;
}

export class WasmExtractor implements WasmFileIO {
  private _archive: RarArchive | null = null;

  private rarFile: SyncSeekable;
  private _nextFileNumber = 100;

  private readonly limitFactor: number;
  private readonly debug: boolean;

  // Per-file state. Set by processNextFile before invoking readFile.
  private activeFile: ActiveFile | null = null;
  // Archive-level abort flag. Once set, read/write short-circuit so the
  // WASM decoder unwinds as fast as possible.
  private aborted: boolean = false;
  // Archive-level I/O counters (debug visibility into hot-loop patterns).
  private readStats = { calls: 0, bytes: 0, eofs: 0 };
  private writeStats = { calls: 0, bytes: 0 };

  constructor(
    private readonly unrar: UnrarModule,
    reader: SyncSeekable,
    private readonly password: string,
    private readonly callbacks: WasmExtractorCallbacks,
    options: WasmExtractorOptions = {},
  ) {
    unrar.extractor = this;
    this.rarFile = reader;
    const factor = options.outputSizeLimitFactor ?? DEFAULT_OUTPUT_SIZE_LIMIT_FACTOR;
    this.limitFactor = factor > 0 ? factor : Infinity;
    this.debug = debugEnabled(options.debug);
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.error(
        `${logPrefix()} WasmExtractor init archiveBytes=${this.rarFile.size} ` +
          `limitFactor=${this.limitFactor}`,
      );
    }
  }

  static async create(
    reader: SyncSeekable,
    password: string,
    callbacks: WasmExtractorCallbacks,
    options: WasmExtractorOptions = {},
  ): Promise<WasmExtractor> {
    return new WasmExtractor(await getUnrar(), reader, password, callbacks, options);
  }

  private get nextFileNumber(): number {
    const next = this._nextFileNumber;
    this._nextFileNumber += 1;
    return next;
  }

  public getFileList(): ArcList {
    const arcHeader = this.openArc(true);
    const processNext = (skip: (fh: FileHeader) => boolean) => this.processNextFile(skip);
    const closeArc = () => this.closeArc();

    function* getFileHeaders(): Generator<FileHeader> {
      for (;;) {
        const arcFile = processNext(() => true);
        if (arcFile === 'ERAR_END_ARCHIVE') break;
        yield arcFile.fileHeader;
      }
      closeArc();
    }

    return { arcHeader, fileHeaders: getFileHeaders() };
  }

  public extract({ files }: ExtractOptions = {}): {
    arcHeader: ArcHeader;
    files: Generator<ArcFile<never>>;
  } {
    const arcHeader = this.openArc(false);
    const processNext = (skip: (fh: FileHeader) => boolean) => this.processNextFile(skip);
    const closeArc = () => this.closeArc();

    function* getFiles(): Generator<ArcFile<never>> {
      let count = 0;
      for (;;) {
        let shouldSkip: (fh: FileHeader) => boolean = () => false;
        if (Array.isArray(files)) {
          if (count === files.length) break;
          shouldSkip = ({ name }: FileHeader) => !files.includes(name);
        } else if (files) {
          shouldSkip = (fh) => !files(fh);
        }
        const arcFile = processNext(shouldSkip);
        if (arcFile === 'ERAR_END_ARCHIVE') break;
        if (arcFile.extraction === 'skipped') continue;
        count++;
        yield { fileHeader: arcFile.fileHeader } as ArcFile<never>;
      }
      closeArc();
    }

    return { arcHeader, files: getFiles() };
  }

  // --- WASM I/O callbacks (called by the C++ bridge via unrar.extractor) ---

  public open(filename: string): number {
    const fd = filename === VIRTUAL_ARCHIVE_PATH ? 1 : -1;
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.error(`${logPrefix()} open("${filename}") -> fd=${fd}`);
    }
    return fd;
  }

  public create(): number {
    const fd = this.nextFileNumber;
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.error(
        `${logPrefix()} create() -> fd=${fd} file="${this.activeFile?.header.name ?? '<unknown>'}"`,
      );
    }
    return fd;
  }

  public close(fd: number): void {
    if (fd === ARCHIVE_FD) {
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.error(`${logPrefix()} close(archive) readStats=${JSON.stringify(this.readStats)}`);
      }
      this.rarFile.seek(0, 'SET');
    } else {
      if (this.debug && this.activeFile) {
        const f = this.activeFile;
        const duration = Date.now() - f.startedAt;
        // eslint-disable-next-line no-console
        console.error(
          `${logPrefix()} close(fd=${fd}) file="${f.header.name}" ` +
            `written=${f.writtenBytes}/${f.header.unpSize} ` +
            `writeCalls=${f.writeCalls} durationMs=${duration} ` +
            `overflowed=${f.overflowed}`,
        );
      }
      this.callbacks.onClose();
    }
  }

  public read(fd: number, index: number, size: number): number {
    if (fd !== ARCHIVE_FD) {
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.error(`${logPrefix()} read(fd=${fd}, size=${size}) non-archive fd -> -1`);
      }
      return -1;
    }
    // Once the archive-level abort is raised, synthesize EOF so the decoder
    // unwinds. This is our escape hatch from corrupt-header hangs where the
    // C++ unpack loop keeps requesting more data indefinitely.
    if (this.aborted) {
      this.readStats.eofs++;
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.error(`${logPrefix()} read(archive, size=${size}) aborted -> 0 (synthetic EOF)`);
      }
      return 0;
    }
    const posBefore = this.rarFile.position;
    const data = this.rarFile.read(size);
    this.readStats.calls++;
    if (data === null) {
      this.readStats.eofs++;
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.error(`${logPrefix()} read(archive, size=${size}) pos=${posBefore} -> 0 (EOF)`);
      }
      // POSIX read() convention: return 0 at EOF, -1 only on actual I/O errors.
      // Returning -1 at EOF makes the unrar C++ core enter its read-error branch
      // which ultimately calls fgetws(stdin) — unbounded blocking in a WASM
      // worker with no stdin, freezing the process on truncated/damaged archives.
      return 0;
    }
    this.readStats.bytes += data.byteLength;
    this.unrar.HEAPU8.set(data, index);
    if (this.debug && (this.readStats.calls <= 20 || this.readStats.calls % 1000 === 0)) {
      // eslint-disable-next-line no-console
      console.error(
        `${logPrefix()} read(archive, size=${size}) pos=${posBefore} -> ${data.byteLength} ` +
          `calls=${this.readStats.calls} totalBytes=${this.readStats.bytes}`,
      );
    }
    return data.byteLength;
  }

  public write(fd: number, index: number, size: number): boolean {
    if (fd < MIN_FILE_FD) {
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.error(`${logPrefix()} write(fd=${fd}, size=${size}) non-file fd -> false`);
      }
      return false;
    }
    if (this.aborted) {
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.error(`${logPrefix()} write(fd=${fd}, size=${size}) aborted -> false`);
      }
      return false;
    }
    const active = this.activeFile;
    if (active) {
      active.writtenBytes += size;
      active.writeCalls++;
      this.writeStats.calls++;
      this.writeStats.bytes += size;
      if (!active.overflowed && active.writtenBytes > active.limit) {
        active.overflowed = true;
        this.aborted = true;
        // eslint-disable-next-line no-console
        console.error(
          `${logPrefix()} OUTPUT SIZE CAP HIT file="${active.header.name}" ` +
            `written=${active.writtenBytes} limit=${active.limit} ` +
            `declaredUnpSize=${active.header.unpSize} factor=${this.limitFactor} ` +
            `-> aborting extraction (likely corrupt header)`,
        );
        return false;
      }
      if (this.debug && (active.writeCalls <= 20 || active.writeCalls % 1000 === 0)) {
        // eslint-disable-next-line no-console
        console.error(
          `${logPrefix()} write(fd=${fd}, size=${size}) file="${active.header.name}" ` +
            `written=${active.writtenBytes}/${active.header.unpSize} ` +
            `calls=${active.writeCalls}`,
        );
      }
    } else if (this.debug) {
      // eslint-disable-next-line no-console
      console.error(
        `${logPrefix()} write(fd=${fd}, size=${size}) without activeFile — ` +
          `probably a service/header stream`,
      );
    }
    const chunk = this.unrar.HEAPU8.slice(index, index + size);
    this.callbacks.onWrite(chunk);
    return true;
  }

  public tell(fd: number): number {
    const pos = fd === ARCHIVE_FD ? this.rarFile.position : -1;
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.error(`${logPrefix()} tell(fd=${fd}) -> ${pos}`);
    }
    return pos;
  }

  public seek(fd: number, pos: number, method: SeekMethod): boolean {
    const ok = fd === ARCHIVE_FD ? this.rarFile.seek(pos, method) : false;
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.error(
        `${logPrefix()} seek(fd=${fd}, pos=${pos}, method=${method}) -> ${ok} ` +
          `newPos=${this.rarFile.position}`,
      );
    }
    return ok;
  }

  // --- Private ---

  private openArc(listOnly: boolean, password?: string): ArcHeader {
    this._archive = new this.unrar.RarArchive();
    const header = this._archive.open(VIRTUAL_ARCHIVE_PATH, password ?? this.password, listOnly);
    if (header.state.errCode !== 0) {
      throw this.getFailException(header.state.errCode, header.state.errType);
    }
    return {
      comment: header.comment,
      flags: {
        volume: (header.flags & 0x0001) !== 0,
        lock: (header.flags & 0x0004) !== 0,
        solid: (header.flags & 0x0008) !== 0,
        authInfo: (header.flags & 0x0020) !== 0,
        recoveryRecord: (header.flags & 0x0040) !== 0,
        headerEncrypted: (header.flags & 0x0080) !== 0,
      },
    };
  }

  private processNextFile(
    shouldSkip: (fh: FileHeader) => boolean,
  ): ArcFile<'skipped' | 'extracted'> | 'ERAR_END_ARCHIVE' {
    const arcFileHeader = this._archive!.getFileHeader();

    if (arcFileHeader.state.errCode === 10) {
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.error(`${logPrefix()} processNextFile: ERAR_END_ARCHIVE`);
      }
      return 'ERAR_END_ARCHIVE';
    }

    if (arcFileHeader.state.errCode !== 0) {
      throw this.getFailException(arcFileHeader.state.errCode, arcFileHeader.state.errType);
    }

    const fileHeader: FileHeader = {
      name: arcFileHeader.name,
      flags: {
        encrypted: (arcFileHeader.flags & 0x04) !== 0,
        solid: (arcFileHeader.flags & 0x10) !== 0,
        directory: (arcFileHeader.flags & 0x20) !== 0,
      },
      packSize: arcFileHeader.packSize,
      unpSize: arcFileHeader.unpSize,
      crc: arcFileHeader.crc,
      time: getDateString(arcFileHeader.time),
      unpVer: `${Math.floor(arcFileHeader.unpVer / 10)}.${arcFileHeader.unpVer % 10}`,
      method: getMethod(arcFileHeader.method),
      comment: arcFileHeader.comment,
    };

    const skip = shouldSkip(fileHeader);
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.error(
        `${logPrefix()} processNextFile header name="${fileHeader.name}" ` +
          `packSize=${fileHeader.packSize} unpSize=${fileHeader.unpSize} ` +
          `method=${fileHeader.method} dir=${fileHeader.flags.directory} ` +
          `encrypted=${fileHeader.flags.encrypted} solid=${fileHeader.flags.solid} ` +
          `skip=${skip}`,
      );
    }
    if (!skip) {
      if (fileHeader.flags.directory) {
        this.callbacks.onDirectory(fileHeader);
      } else {
        this.callbacks.onCreate(fileHeader);
        // Arm per-file output cap. A cap of Infinity disables enforcement but
        // we still track counters to feed debug logs.
        const limit =
          this.limitFactor === Infinity
            ? Infinity
            : Math.max(fileHeader.unpSize * this.limitFactor, ABSOLUTE_MIN_FILE_BYTES);
        this.activeFile = {
          header: fileHeader,
          writtenBytes: 0,
          writeCalls: 0,
          startedAt: Date.now(),
          limit,
          overflowed: false,
        };
      }
    }

    const fileState = this._archive!.readFile(skip);
    const active = this.activeFile;
    this.activeFile = null;

    if (active?.overflowed) {
      throw new UnRARError(
        'ERAR_BAD_DATA',
        `Extraction aborted: "${active.header.name}" produced ${active.writtenBytes} bytes ` +
          `beyond cap ${active.limit} (declared unpSize=${active.header.unpSize}). ` +
          `Likely corrupt header.`,
        active.header.name,
      );
    }

    if (fileState.errCode !== 0) {
      throw this.getFailException(fileState.errCode, fileState.errType, fileHeader.name);
    }

    return { fileHeader, extraction: skip ? 'skipped' : 'extracted' };
  }

  private closeArc(): void {
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.error(
        `${logPrefix()} closeArc readStats=${JSON.stringify(this.readStats)} ` +
          `writeStats=${JSON.stringify(this.writeStats)} aborted=${this.aborted}`,
      );
    }
    this._archive?.delete();
    this._archive = null;
  }

  private getFailException(errCode: number, _errType: string, file?: string) {
    const ERROR_CODE: { [k: number]: string } = {
      11: 'ERAR_NO_MEMORY',
      12: 'ERAR_BAD_DATA',
      13: 'ERAR_BAD_ARCHIVE',
      14: 'ERAR_UNKNOWN_FORMAT',
      15: 'ERAR_EOPEN',
      16: 'ERAR_ECREATE',
      17: 'ERAR_ECLOSE',
      18: 'ERAR_EREAD',
      19: 'ERAR_EWRITE',
      20: 'ERAR_SMALL_BUF',
      21: 'ERAR_UNKNOWN',
      22: 'ERAR_MISSING_PASSWORD',
      23: 'ERAR_EREFERENCE',
      24: 'ERAR_BAD_PASSWORD',
    };
    const ERROR_MSG: { [k: string]: string } = {
      ERAR_NO_MEMORY: 'Not enough memory',
      ERAR_BAD_DATA: 'Archive header or data are damaged',
      ERAR_BAD_ARCHIVE: 'File is not RAR archive',
      ERAR_UNKNOWN_FORMAT: 'Unknown archive format',
      ERAR_EOPEN: 'File open error',
      ERAR_ECREATE: 'File create error',
      ERAR_ECLOSE: 'File close error',
      ERAR_EREAD: 'File read error',
      ERAR_EWRITE: 'File write error',
      ERAR_SMALL_BUF: 'Buffer for archive comment is too small, comment truncated',
      ERAR_UNKNOWN: 'Unknown error',
      ERAR_MISSING_PASSWORD: 'Password for encrypted file or header is not specified',
      ERAR_EREFERENCE: 'Cannot open file source for reference record',
      ERAR_BAD_PASSWORD: 'Wrong password is specified',
    };
    const reason = ERROR_CODE[errCode] ?? 'ERAR_UNKNOWN';
    this.closeArc();
    return new UnRARError(reason as never, ERROR_MSG[reason] ?? 'Unknown error', file);
  }
}

function getDateString(dosTime: number): string {
  const bitLen = [5, 6, 5, 5, 4, 7];
  const parts: number[] = [];
  for (const len of bitLen) {
    parts.push(dosTime & ((1 << len) - 1));
    dosTime >>= len;
  }
  parts.reverse();
  const pad = (num: number): string => (num < 10 ? '0' + num : '' + num);
  return (
    `${1980 + parts[0]}-${pad(parts[1])}-${pad(parts[2])}` +
    `T${pad(parts[3])}:${pad(parts[4])}:${pad(parts[5] * 2)}.000`
  );
}

function getMethod(method: number): CompressMethod {
  const methodMap: { [index: number]: CompressMethod } = {
    0x30: 'Storing',
    0x31: 'Fastest',
    0x32: 'Fast',
    0x33: 'Normal',
    0x34: 'Good',
    0x35: 'Best',
  };
  return methodMap[method] || 'Unknown';
}
