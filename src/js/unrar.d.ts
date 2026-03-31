import { SeekMethod } from './types';

/** Return value from RarArchive C++ methods — maps to `struct State` in bridge.cpp */
export interface WasmState {
  /** 0 = success, 10 = end of archive, 11+ = error codes */
  errCode: number;
  errType: string;
}

/** Returned by RarArchive.open() — maps to `struct ArcHeader` in bridge.cpp */
export interface WasmArcHeader {
  state: WasmState;
  comment: string;
  /** Bitmask: volume=0x01, lock=0x04, solid=0x08, authInfo=0x20, recovery=0x40, headerEnc=0x80 */
  flags: number;
}

/** Returned by RarArchive.getFileHeader() — maps to `struct ArcFileHeader` in bridge.cpp */
export interface WasmArcFileHeader {
  state: WasmState;
  name: string;
  comment: string;
  /** Bitmask: encrypted=0x04, solid=0x10, directory=0x20 */
  flags: number;
  /** Packed (compressed) size in bytes — double in C++ to support >4GB */
  packSize: number;
  /** Unpacked (original) size in bytes */
  unpSize: number;
  hostOS: number;
  crc: number;
  /** DOS time format */
  time: number;
  unpVer: number;
  method: number;
  fileAttr: number;
}

/** C++ RarArchive class exposed to JS via EMSCRIPTEN_BINDINGS in bridge.cpp */
export interface RarArchive {
  open(filepath: string, password: string, forList: boolean): WasmArcHeader;
  getFileHeader(): WasmArcFileHeader;
  readFile(skip: boolean): WasmState;
  /** Calls C++ destructor — must be called to free memory */
  delete(): void;
}

export interface RarArchiveConstructor {
  new (): RarArchive;
}

/**
 * File I/O interface that bridge.js calls via Module.extractor.
 *
 * When C++ code calls jsOpen/jsRead/jsWrite/etc. in file.cpp,
 * bridge.js forwards those calls to Module.extractor methods.
 * WasmExtractor implements this interface.
 */
export interface WasmFileIO {
  open(filename: string): number;
  create(filename: string): number;
  close(fd: number): void;
  read(fd: number, buf: number, size: number): number;
  write(fd: number, buf: number, size: number): boolean;
  tell(fd: number): number;
  seek(fd: number, pos: number, method: SeekMethod): boolean;
}

/** The Emscripten module returned by the unrar factory function */
export interface UnrarModule {
  /** C++ RarArchive class constructor */
  RarArchive: RarArchiveConstructor;
  /** Typed view of WASM linear memory — used to copy data between JS and WASM */
  HEAPU8: Uint8Array;
  /**
   * File I/O implementation — set by WasmExtractor constructor.
   * bridge.js calls these methods when C++ performs file operations.
   */
  extractor: WasmFileIO;
}

export default function unrar(options?: { wasmBinary?: ArrayBuffer }): Promise<UnrarModule>;
