import * as assert from 'assert';
import { WasmExtractor, WasmExtractorCallbacks } from '../js/WasmExtractor';
import { FileHeader } from '../js/types';
import type {
  UnrarModule,
  RarArchive,
  WasmState,
  WasmArcHeader,
  WasmArcFileHeader,
} from '../js/unrar';

function makeWasmState(errCode = 0, errType = ''): WasmState {
  return { errCode, errType };
}

function makeWasmArcHeader(overrides: Partial<WasmArcHeader> = {}): WasmArcHeader {
  return { state: makeWasmState(), comment: '', flags: 0, ...overrides };
}

function makeWasmFileHeader(
  name: string,
  overrides: Partial<WasmArcFileHeader> = {},
): WasmArcFileHeader {
  return {
    state: makeWasmState(),
    name,
    comment: '',
    flags: 0,
    packSize: 0,
    unpSize: 0,
    hostOS: 0,
    crc: 0,
    time: 0x4e620000, // 2019-03-02T00:00:00
    unpVer: 29,
    method: 0x33, // Normal
    fileAttr: 0,
    ...overrides,
  };
}

function makeMockRarArchive(fileHeaders: WasmArcFileHeader[]): RarArchive {
  let headerIndex = 0;
  return {
    open: () => makeWasmArcHeader(),
    getFileHeader: () => {
      if (headerIndex >= fileHeaders.length) {
        return { ...makeWasmFileHeader(''), state: makeWasmState(10) }; // ERAR_END_ARCHIVE
      }
      return fileHeaders[headerIndex++];
    },
    readFile: () => makeWasmState(),
    delete: () => {},
  };
}

function makeMockUnrar(archive: RarArchive): UnrarModule {
  const heapu8 = new Uint8Array(1024);
  return {
    RarArchive: class {
      // eslint-disable-line @typescript-eslint/no-extraneous-class
      open = archive.open;
      getFileHeader = archive.getFileHeader;
      readFile = archive.readFile;
      delete = archive.delete;
    } as unknown as UnrarModule['RarArchive'],
    HEAPU8: heapu8,
    extractor: null as unknown as UnrarModule['extractor'],
  };
}

function makeCallbackTracker() {
  const calls: { method: string; args: unknown[] }[] = [];
  const callbacks: WasmExtractorCallbacks = {
    onCreate: (fh) => calls.push({ method: 'onCreate', args: [fh] }),
    onDirectory: (fh) => calls.push({ method: 'onDirectory', args: [fh] }),
    onWrite: (data) => calls.push({ method: 'onWrite', args: [data] }),
    onClose: () => calls.push({ method: 'onClose', args: [] }),
  };
  return { calls, callbacks };
}

describe('WasmExtractor', () => {
  describe('constructor', () => {
    it('wires itself as unrar.extractor', () => {
      const archive = makeMockRarArchive([]);
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);
      assert.strictEqual(unrar.extractor, extractor);
    });
  });

  describe('getFileList', () => {
    it('returns all file headers', () => {
      const headers = [makeWasmFileHeader('file1.txt'), makeWasmFileHeader('file2.txt')];
      const archive = makeMockRarArchive(headers);
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const { fileHeaders } = extractor.getFileList();
      const list = [...fileHeaders];

      assert.strictEqual(list.length, 2);
      assert.strictEqual(list[0].name, 'file1.txt');
      assert.strictEqual(list[1].name, 'file2.txt');
    });

    it('returns empty list for empty archive', () => {
      const archive = makeMockRarArchive([]);
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const { fileHeaders } = extractor.getFileList();
      assert.deepStrictEqual([...fileHeaders], []);
    });

    it('returns arc header with parsed flags', () => {
      const archive = makeMockRarArchive([]);
      archive.open = () => makeWasmArcHeader({ comment: 'test', flags: 0x0089 }); // volume + solid + headerEncrypted
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const { arcHeader } = extractor.getFileList();
      assert.strictEqual(arcHeader.comment, 'test');
      assert.strictEqual(arcHeader.flags.volume, true);
      assert.strictEqual(arcHeader.flags.solid, true);
      assert.strictEqual(arcHeader.flags.headerEncrypted, true);
      assert.strictEqual(arcHeader.flags.lock, false);
    });
  });

  describe('extract', () => {
    it('calls onCreate callback for files', () => {
      const headers = [makeWasmFileHeader('file.txt')];
      const archive = makeMockRarArchive(headers);
      const unrar = makeMockUnrar(archive);
      const { calls, callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const { files } = extractor.extract();
      [...files]; // consume generator

      assert.ok(calls.some((c) => c.method === 'onCreate'));
      const createCall = calls.find((c) => c.method === 'onCreate')!;
      assert.strictEqual((createCall.args[0] as FileHeader).name, 'file.txt');
    });

    it('calls onDirectory callback for directories', () => {
      const headers = [makeWasmFileHeader('dir/', { flags: 0x20 })]; // directory flag
      const archive = makeMockRarArchive(headers);
      const unrar = makeMockUnrar(archive);
      const { calls, callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const { files } = extractor.extract();
      [...files];

      assert.ok(calls.some((c) => c.method === 'onDirectory'));
    });

    it('filters files by name array', () => {
      const headers = [
        makeWasmFileHeader('a.txt'),
        makeWasmFileHeader('b.txt'),
        makeWasmFileHeader('c.txt'),
      ];
      const archive = makeMockRarArchive(headers);
      const unrar = makeMockUnrar(archive);
      const { calls, callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const { files } = extractor.extract({ files: ['a.txt', 'c.txt'] });
      const list = [...files];

      assert.strictEqual(list.length, 2);
      assert.strictEqual(list[0].fileHeader.name, 'a.txt');
      assert.strictEqual(list[1].fileHeader.name, 'c.txt');
    });

    it('filters files by callback', () => {
      const headers = [
        makeWasmFileHeader('a.txt'),
        makeWasmFileHeader('b.jpg'),
        makeWasmFileHeader('c.txt'),
      ];
      const archive = makeMockRarArchive(headers);
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const { files } = extractor.extract({
        files: (fh) => fh.name.endsWith('.txt'),
      });
      const list = [...files];

      assert.strictEqual(list.length, 2);
      assert.strictEqual(list[0].fileHeader.name, 'a.txt');
      assert.strictEqual(list[1].fileHeader.name, 'c.txt');
    });

    it('does not call callbacks for skipped files', () => {
      const headers = [makeWasmFileHeader('a.txt'), makeWasmFileHeader('b.txt')];
      const archive = makeMockRarArchive(headers);
      const unrar = makeMockUnrar(archive);
      const { calls, callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const { files } = extractor.extract({ files: ['a.txt'] });
      [...files];

      const createCalls = calls.filter((c) => c.method === 'onCreate');
      assert.strictEqual(createCalls.length, 1);
      assert.strictEqual((createCalls[0].args[0] as FileHeader).name, 'a.txt');
    });
  });

  describe('WASM I/O', () => {
    it('open returns archive fd for known path', () => {
      const archive = makeMockRarArchive([]);
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(10), '', callbacks);

      assert.ok(extractor.open('_defaultUnrarJS_.rar') > 0);
    });

    it('open returns -1 for unknown path', () => {
      const archive = makeMockRarArchive([]);
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(10), '', callbacks);

      assert.strictEqual(extractor.open('unknown.rar'), -1);
    });

    it('create returns incrementing file descriptors', () => {
      const archive = makeMockRarArchive([]);
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const fd1 = extractor.create();
      const fd2 = extractor.create();
      assert.ok(fd1 > 0);
      assert.ok(fd2 > fd1);
    });

    it('close on extracted fd calls onClose callback', () => {
      const archive = makeMockRarArchive([]);
      const unrar = makeMockUnrar(archive);
      const { calls, callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const fd = extractor.create();
      extractor.close(fd);

      assert.ok(calls.some((c) => c.method === 'onClose'));
    });

    it('write on extracted fd calls onWrite callback', () => {
      const archive = makeMockRarArchive([]);
      const heapu8 = new Uint8Array(1024);
      heapu8.set([10, 20, 30], 0);
      const unrar = makeMockUnrar(archive);
      unrar.HEAPU8 = heapu8;
      const { calls, callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const fd = extractor.create();
      const result = extractor.write(fd, 0, 3);

      assert.strictEqual(result, true);
      const writeCall = calls.find((c) => c.method === 'onWrite')!;
      assert.deepStrictEqual(writeCall.args[0], new Uint8Array([10, 20, 30]));
    });

    it('write on archive fd returns false', () => {
      const archive = makeMockRarArchive([]);
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(10), '', callbacks);

      const archiveFd = extractor.open('_defaultUnrarJS_.rar');
      assert.strictEqual(extractor.write(archiveFd, 0, 1), false);
    });

    it('read from archive fd reads from DataFile', () => {
      const archive = makeMockRarArchive([]);
      const data = new Uint8Array([42, 43, 44]).buffer;
      const heapu8 = new Uint8Array(1024);
      const unrar = makeMockUnrar(archive);
      unrar.HEAPU8 = heapu8;
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, data, '', callbacks);

      const archiveFd = extractor.open('_defaultUnrarJS_.rar');
      const bytesRead = extractor.read(archiveFd, 100, 3);

      assert.strictEqual(bytesRead, 3);
      assert.deepStrictEqual(heapu8.slice(100, 103), new Uint8Array([42, 43, 44]));
    });

    it('tell returns position on archive fd', () => {
      const archive = makeMockRarArchive([]);
      const data = new Uint8Array([1, 2, 3, 4, 5]).buffer;
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, data, '', callbacks);

      const fd = extractor.open('_defaultUnrarJS_.rar');
      assert.strictEqual(extractor.tell(fd), 0);
      extractor.read(fd, 0, 3);
      assert.strictEqual(extractor.tell(fd), 3);
    });

    it('seek works on archive fd', () => {
      const archive = makeMockRarArchive([]);
      const data = new Uint8Array(10).buffer;
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, data, '', callbacks);

      const fd = extractor.open('_defaultUnrarJS_.rar');
      assert.strictEqual(extractor.seek(fd, 5, 'SET'), true);
      assert.strictEqual(extractor.tell(fd), 5);
    });

    it('read/tell/seek return error values for non-archive fd', () => {
      const archive = makeMockRarArchive([]);
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const fd = extractor.create();
      assert.strictEqual(extractor.read(fd, 0, 1), -1);
      assert.strictEqual(extractor.tell(fd), -1);
      assert.strictEqual(extractor.seek(fd, 0, 'SET'), false);
    });
  });

  describe('error handling', () => {
    it('throws UnrarError on open failure', () => {
      const archive = makeMockRarArchive([]);
      archive.open = () => makeWasmArcHeader({ state: makeWasmState(22, 'ERR_OPEN') });
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      assert.throws(
        () => extractor.getFileList(),
        (err: Error) => err.message === 'Password for encrypted file or header is not specified',
      );
    });

    it('throws UnrarError on readFile failure', () => {
      const headers = [makeWasmFileHeader('encrypted.txt', { flags: 0x04 })];
      const archive = makeMockRarArchive(headers);
      archive.readFile = () => makeWasmState(22, 'ERR_PROCESS');
      const unrar = makeMockUnrar(archive);
      const { callbacks } = makeCallbackTracker();
      const extractor = new WasmExtractor(unrar, new ArrayBuffer(0), '', callbacks);

      const { files } = extractor.extract();
      assert.throws(() => [...files]);
    });
  });
});
