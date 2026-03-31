export type SeekMethod = 'CUR' | 'SET' | 'END';

export type FailReason =
  | 'ERAR_NO_MEMORY'
  | 'ERAR_BAD_DATA'
  | 'ERAR_BAD_ARCHIVE'
  | 'ERAR_UNKNOWN_FORMAT'
  | 'ERAR_EOPEN'
  | 'ERAR_ECREATE'
  | 'ERAR_ECLOSE'
  | 'ERAR_EREAD'
  | 'ERAR_EWRITE'
  | 'ERAR_SMALL_BUF'
  | 'ERAR_UNKNOWN'
  | 'ERAR_MISSING_PASSWORD'
  | 'ERAR_EREFERENCE'
  | 'ERAR_BAD_PASSWORD';

export class UnrarError extends Error {
  constructor(
    public reason: FailReason,
    message: string,
    public file?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, UnrarError.prototype);
  }
}

export type CompressMethod =
  | 'Storing'
  | 'Fastest'
  | 'Fast'
  | 'Normal'
  | 'Good'
  | 'Best'
  | 'Unknown';

export interface FileHeader {
  name: string;
  flags: {
    encrypted: boolean;
    solid: boolean;
    directory: boolean;
  };
  packSize: number;
  unpSize: number;
  crc: number;
  time: string;
  unpVer: string;
  method: CompressMethod;
  comment: string;
}

export interface ArcHeader {
  comment: string;
  flags: {
    volume: boolean;
    lock: boolean;
    solid: boolean;
    authInfo: boolean;
    recoveryRecord: boolean;
    headerEncrypted: boolean;
  };
}

export interface ArcList {
  arcHeader: ArcHeader;
  fileHeaders: Generator<FileHeader>;
}

export type ArcFile<withContent = never> = {
  fileHeader: FileHeader;
  extraction?: withContent;
};

export interface ExtractResult<withContent = never> {
  arcHeader: ArcHeader;
  fileHeaders: FileHeader[];
  fileCount: number;
  totalSize: number;
  files: AsyncGenerator<ArcFile<withContent>>;
}

export interface FileListResult {
  arcHeader: ArcHeader;
  fileHeaders: FileHeader[];
  fileCount: number;
  totalSize: number;
}

export interface ExtractOptions {
  files?: string[] | ((fileHeader: FileHeader) => boolean);
}
