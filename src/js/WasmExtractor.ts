import { DataFile } from './DataFile';
import {
  ArcFile,
  ArcHeader,
  ArcList,
  CompressMethod,
  ExtractOptions,
  FileHeader,
  SeekMethod,
  UnrarError,
} from './types';
import type { RarArchive, UnrarModule, WasmFileIO } from './unrar';
import { getUnrar } from './unrar.singleton';

export interface WasmExtractorCallbacks {
  onCreate(fileHeader: FileHeader): void;
  onDirectory(fileHeader: FileHeader): void;
  onWrite(data: Uint8Array): void;
  onClose(): void;
}

const ARCHIVE_FD = 1;
const MIN_FILE_FD = 100;
const VIRTUAL_ARCHIVE_PATH = '_defaultUnrarJS_.rar';

export class WasmExtractor implements WasmFileIO {
  private _archive: RarArchive | null = null;

  private rarFile: DataFile;
  private _nextFileNumber = 100;

  constructor(
    private readonly unrar: UnrarModule,
    data: ArrayBuffer,
    private readonly password: string,
    private readonly callbacks: WasmExtractorCallbacks,
  ) {
    unrar.extractor = this;
    this.rarFile = new DataFile(new Uint8Array(data));
  }

  static async create(
    data: ArrayBuffer,
    password: string,
    callbacks: WasmExtractorCallbacks,
  ): Promise<WasmExtractor> {
    return new WasmExtractor(await getUnrar(), data, password, callbacks);
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
    return filename === VIRTUAL_ARCHIVE_PATH ? 1 : -1;
  }

  public create(): number {
    return this.nextFileNumber;
  }

  public close(fd: number): void {
    if (fd === ARCHIVE_FD) {
      this.rarFile.seek(0, 'SET');
    } else {
      this.callbacks.onClose();
    }
  }

  public read(fd: number, index: number, size: number): number {
    if (fd !== ARCHIVE_FD) return -1;
    const data = this.rarFile.read(size);
    if (data === null) return -1;
    this.unrar.HEAPU8.set(data, index);
    return data.byteLength;
  }

  public write(fd: number, index: number, size: number): boolean {
    if (fd < MIN_FILE_FD) {
      return false;
    }
    const chunk = this.unrar.HEAPU8.slice(index, index + size);
    this.callbacks.onWrite(chunk);
    return true;
  }

  public tell(fd: number): number {
    return fd === ARCHIVE_FD ? this.rarFile.position : -1;
  }

  public seek(fd: number, pos: number, method: SeekMethod): boolean {
    return fd === ARCHIVE_FD ? this.rarFile.seek(pos, method) : false;
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

    if (arcFileHeader.state.errCode === 10) return 'ERAR_END_ARCHIVE';

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
    if (!skip) {
      if (fileHeader.flags.directory) {
        this.callbacks.onDirectory(fileHeader);
      } else {
        this.callbacks.onCreate(fileHeader);
      }
    }

    const fileState = this._archive!.readFile(skip);
    if (fileState.errCode !== 0) {
      throw this.getFailException(fileState.errCode, fileState.errType, fileHeader.name);
    }

    return { fileHeader, extraction: skip ? 'skipped' : 'extracted' };
  }

  private closeArc(): void {
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
    return new UnrarError(reason as never, ERROR_MSG[reason] ?? 'Unknown error', file);
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
