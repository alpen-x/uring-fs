'use strict';

const fsConstants = require('node:fs').constants;
const fsPromises = require('node:fs/promises');
const pathModule = require('node:path');
const { fileURLToPath } = require('node:url');
const { DedicatedWorkerPool } = require('./lib/worker_fallback');

let native = null;
let loadError = null;

try {
  native = require('./build/Release/uring_fs.node');
} catch (err) {
  loadError = err;
}

const config = {
  fallback: 'fs', // 'fs' | 'worker' | CustomProvider | false | true
  forceFallback: false,
  workerPoolSize: 2,
  optimisticReadSize: 64 * 1024,
};

if (process.env.URING_FS_FALLBACK) {
  const envFallback = process.env.URING_FS_FALLBACK.trim().toLowerCase();
  if (envFallback === 'native' || envFallback === 'fs') {
    config.forceFallback = true;
    config.fallback = 'fs';
  } else if (envFallback === 'worker') {
    config.forceFallback = true;
    config.fallback = 'worker';
  } else if (envFallback === 'none' || envFallback === 'false') {
    config.fallback = false;
  }
}

let workerPool = null;

function getWorkerPool() {
  if (!workerPool) {
    workerPool = new DedicatedWorkerPool(config.workerPoolSize);
  }
  return workerPool;
}

function resolveCustomProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    return null;
  }
  // Supports both objects with .promises (e.g. graceful-fs, memfs) and direct promise objects (e.g. fs-extra)
  if (provider.promises && typeof provider.promises.readFile === 'function') {
    return provider.promises;
  }
  if (typeof provider.readFile === 'function') {
    return provider;
  }
  throw new TypeError(
    'Custom fallback provider must implement fs/promises-compatible methods (e.g. readFile, writeFile).'
  );
}

/**
 * Configures global behavior of uring-fs.
 * @param {{ fallback?: 'fs' | 'worker' | boolean | object, forceFallback?: boolean, workerPoolSize?: number, optimisticReadSize?: number }} options
 */
function configure(options = {}) {
  if (options.fallback !== undefined) {
    if (options.fallback === true || options.fallback === 'fs') {
      config.fallback = 'fs';
    } else if (options.fallback === false || options.fallback === 'none') {
      config.fallback = false;
    } else if (options.fallback === 'worker') {
      config.fallback = 'worker';
    } else if (typeof options.fallback === 'object' && options.fallback !== null) {
      resolveCustomProvider(options.fallback);
      config.fallback = options.fallback;
    } else {
      throw new TypeError(
        'The "fallback" option must be "fs", "worker", false, true, or an fs/promises-compatible provider object.'
      );
    }
  }

  if (typeof options.forceFallback === 'boolean') {
    config.forceFallback = options.forceFallback;
  }

  if (typeof options.workerPoolSize === 'number' && Number.isFinite(options.workerPoolSize) && options.workerPoolSize >= 1) {
    const nextPoolSize = Math.floor(options.workerPoolSize);
    config.workerPoolSize = nextPoolSize;
    if (workerPool && workerPool.poolSize !== nextPoolSize) {
      workerPool.poolSize = nextPoolSize;
    }
  }

  if (typeof options.optimisticReadSize === 'number' && Number.isFinite(options.optimisticReadSize)) {
    const size = Math.max(0, Math.floor(options.optimisticReadSize));
    config.optimisticReadSize = size;
    if (native && typeof native.setOptimisticReadSize === 'function') {
      native.setOptimisticReadSize(size);
    }
  }

  return {
    fallback: typeof config.fallback === 'object' ? 'custom' : config.fallback,
    forceFallback: config.forceFallback,
    workerPoolSize: config.workerPoolSize,
    optimisticReadSize: config.optimisticReadSize,
  };
}

/**
 * Sets the default optimistic read buffer size in bytes (default: 65536).
 * Setting to 0 disables optimistic read globally.
 * @param {number} bytes
 */
function setOptimisticReadSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    const err = new TypeError('The "bytes" argument must be a non-negative finite number.');
    err.code = 'ERR_INVALID_ARG_VALUE';
    throw err;
  }
  const size = Math.floor(bytes);
  config.optimisticReadSize = size;
  if (native && typeof native.setOptimisticReadSize === 'function') {
    native.setOptimisticReadSize(size);
  }
  return size;
}

/**
 * Terminates any active fallback worker threads if initialized.
 */
async function closeFallbackWorkers() {
  if (workerPool) {
    await workerPool.terminate();
    workerPool = null;
  }
}

/**
 * Checks whether io_uring is supported and active on the current Linux kernel.
 * @returns {boolean}
 */
function isUringSupported() {
  return Boolean(native && typeof native.isSupported === 'function' && native.isSupported());
}

/**
 * Returns the currently active I/O backend.
 * @returns {'io_uring' | 'worker' | 'custom' | 'fs' | 'none'}
 */
function getActiveBackend() {
  if (isUringSupported() && !config.forceFallback) {
    return 'io_uring';
  }
  if (config.fallback === false) {
    return 'none';
  }
  if (config.fallback === 'worker') {
    return 'worker';
  }
  if (typeof config.fallback === 'object' && config.fallback !== null) {
    return 'custom';
  }
  return 'fs';
}

/**
 * Returns the reason why io_uring is unavailable, or null if active.
 * @returns {string | null}
 */
function getUnsupportedReason() {
  if (isUringSupported()) {
    return null;
  }
  if (loadError) {
    return `Failed to load native binary: ${loadError.message}`;
  }
  if (native && typeof native.getUnsupportedReason === 'function') {
    return native.getUnsupportedReason() || 'io_uring is not supported in this environment';
  }
  return 'Unsupported platform';
}

/**
 * Returns detailed io_uring ring statistics and batching telemetry.
 */
function getRingStats() {
  if (!native || typeof native.getRingStats !== 'function') {
    return {
      supported: false,
      activeBackend: getActiveBackend(),
      queueDepth: 0,
      activeRequests: 0,
      inFlightSqes: 0,
      pendingOverflowQueue: 0,
      totalRequests: 0,
      totalSqesPrepared: 0,
      totalSubmitSyscalls: 0,
      totalCqesReaped: 0,
      peakInFlight: 0,
      overflowQueued: 0,
      credentialResets: 0,
      optimisticReadSize: config.optimisticReadSize,
      directFdsSupported: false,
      directFdTableSize: 0,
      directFdsInUse: 0,
      syscallsSavedByBatching: 0,
    };
  }
  const raw = native.getRingStats();
  const syscallsSaved = Math.max(0, raw.totalSqesPrepared - raw.totalSubmitSyscalls);
  return {
    ...raw,
    activeBackend: getActiveBackend(),
    syscallsSavedByBatching: syscallsSaved,
  };
}

function normalizePath(p) {
  if (typeof p === 'string') {
    return p;
  }
  if (Buffer.isBuffer(p)) {
    return p.toString('utf8');
  }
  if (p instanceof URL) {
    return fileURLToPath(p);
  }
  const err = new TypeError('The "path" argument must be of type string, Buffer, or URL.');
  err.code = 'ERR_INVALID_ARG_TYPE';
  throw err;
}

function validateEncoding(encoding) {
  if (encoding !== null && encoding !== undefined) {
    if (typeof encoding !== 'string' || !Buffer.isEncoding(encoding)) {
      const err = new TypeError(`The argument 'encoding' is invalid encoding. Received '${encoding}'`);
      err.code = 'ERR_INVALID_ARG_VALUE';
      throw err;
    }
  }
}

const FALLOC_FL_KEEP_SIZE = 0x01;
const FALLOC_FL_PUNCH_HOLE = 0x02;
const FALLOC_FL_COLLAPSE_RANGE = 0x08;
const FALLOC_FL_ZERO_RANGE = 0x10;
const FALLOC_FL_INSERT_RANGE = 0x20;
const FALLOC_FL_UNSHARE_RANGE = 0x40;

const POSIX_FADV_NORMAL = 0;
const POSIX_FADV_RANDOM = 1;
const POSIX_FADV_SEQUENTIAL = 2;
const POSIX_FADV_WILLNEED = 3;
const POSIX_FADV_DONTNEED = 4;
const POSIX_FADV_NOREUSE = 5;

function parseOpenFlags(flag = 'r') {
  if (typeof flag === 'number') {
    return flag;
  }
  if (typeof flag !== 'string') {
    const err = new TypeError(`The "flags" argument must be of type string or number. Received ${typeof flag}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  switch (flag) {
    case 'r':
      return fsConstants.O_RDONLY;
    case 'rs':
    case 'sr':
      return fsConstants.O_RDONLY | fsConstants.O_SYNC;
    default:
      return parseWriteFlags(flag);
  }
}

function parseWriteFlags(flag = 'w') {
  if (typeof flag === 'number') {
    return flag;
  }
  switch (flag) {
    case 'w':
    case 'wt':
      return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC;
    case 'wx':
    case 'xw':
      return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_EXCL;
    case 'w+':
      return fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC;
    case 'wx+':
    case 'xw+':
      return fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_EXCL;
    case 'a':
    case 'at':
      return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND;
    case 'ax':
    case 'xa':
      return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_EXCL;
    case 'a+':
      return fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND;
    case 'ax+':
    case 'xa+':
      return fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_EXCL;
    case 'as':
      return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_SYNC;
    case 'as+':
      return fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_SYNC;
    case 'r+':
      return fsConstants.O_RDWR;
    case 'rs+':
    case 'sr+':
      return fsConstants.O_RDWR | fsConstants.O_SYNC;
    default: {
      const err = new TypeError(`Unknown file open flag: ${flag}`);
      err.code = 'ERR_INVALID_OPT_VALUE';
      throw err;
    }
  }
}

function createAbortError(signal) {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  if (signal && signal.reason !== undefined) {
    err.cause = signal.reason;
  }
  return err;
}

function createErrnoError(code, syscall, path) {
  let errno = -21;
  let msg = `${code}: illegal operation on a directory, ${syscall}`;
  if (code === 'ENOENT') {
    errno = -2;
    msg = `ENOENT: no such file or directory, ${syscall}`;
  } else if (code === 'EBADF') {
    errno = -9;
    msg = `EBADF: bad file descriptor, ${syscall}`;
  }
  if (path) {
    msg += ` '${path}'`;
  }
  const err = new Error(msg);
  err.code = code;
  err.errno = errno;
  err.syscall = syscall;
  if (path) {
    err.path = path;
  }
  return err;
}

function wrapWithAbortSignal(promise, signal) {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/**
 * Selects which execution backend should handle the current operation.
 * @returns {{ type: 'io_uring' } | { type: 'worker' } | { type: 'provider', provider: any }}
 */
function selectExecutionBackend(options) {
  const strict = options && typeof options === 'object' ? options.strict : undefined;
  const perCallFallback = options && typeof options === 'object' ? options.fallback : undefined;
  const forcePerCallFallback =
    perCallFallback !== undefined &&
    perCallFallback !== false &&
    perCallFallback !== 'none';

  if (isUringSupported() && !config.forceFallback && !forcePerCallFallback) {
    return { type: 'io_uring' };
  }

  const effectiveFallback = perCallFallback !== undefined ? perCallFallback : config.fallback;

  if (strict === true || effectiveFallback === false || effectiveFallback === 'none') {
    const err = new Error(`io_uring is unavailable: ${getUnsupportedReason() || 'disabled by configuration'}`);
    err.code = 'ERR_URING_UNSUPPORTED';
    throw err;
  }

  if (effectiveFallback === 'worker') {
    return { type: 'worker' };
  }

  if (typeof effectiveFallback === 'object' && effectiveFallback !== null) {
    return { type: 'provider', provider: resolveCustomProvider(effectiveFallback) };
  }

  return { type: 'provider', provider: fsPromises };
}

class UringStats {
  constructor(raw) {
    this.dev = raw.dev ?? 0;
    this.rdev = raw.rdev ?? 0;
    this.size = raw.size;
    this.mode = raw.mode;
    this.uid = raw.uid;
    this.gid = raw.gid;
    this.ino = raw.ino;
    this.nlink = raw.nlink;
    this.blksize = raw.blksize;
    this.blocks = raw.blocks;
    this.atimeMs = raw.atimeMs;
    this.mtimeMs = raw.mtimeMs;
    this.ctimeMs = raw.ctimeMs;
    this.birthtimeMs = raw.birthtimeMs;
    this.atime = new Date(raw.atimeMs);
    this.mtime = new Date(raw.mtimeMs);
    this.ctime = new Date(raw.ctimeMs);
    this.birthtime = new Date(raw.birthtimeMs);
    this._isFile = raw.isFile;
    this._isDirectory = raw.isDirectory;
    this._isSymbolicLink = raw.isSymbolicLink;
  }

  isFile() {
    return this._isFile;
  }

  isDirectory() {
    return this._isDirectory;
  }

  isSymbolicLink() {
    return this._isSymbolicLink;
  }

  isBlockDevice() {
    return (this.mode & 0o170000) === 0o060000;
  }

  isCharacterDevice() {
    return (this.mode & 0o170000) === 0o020000;
  }

  isFIFO() {
    return (this.mode & 0o170000) === 0o010000;
  }

  isSocket() {
    return (this.mode & 0o170000) === 0o140000;
  }
}

/**
 * Reads the entire contents of a file asynchronously via io_uring.
 */
async function readFile(filePath, options) {
  let encoding = null;
  let signal = undefined;
  let optimisticReadSize = undefined;

  if (typeof options === 'string') {
    encoding = options;
  } else if (options && typeof options === 'object') {
    encoding = options.encoding ?? null;
    signal = options.signal;
    if (typeof options.optimisticReadSize === 'number' && Number.isFinite(options.optimisticReadSize)) {
      optimisticReadSize = Math.max(0, Math.floor(options.optimisticReadSize));
    }
  }

  validateEncoding(encoding);

  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const normalized = normalizePath(filePath);
  const backend = selectExecutionBackend(options);

  if (backend.type === 'provider') {
    return wrapWithAbortSignal(
      backend.provider.readFile(normalized, encoding ? { encoding, signal } : (signal ? { signal } : undefined)),
      signal
    );
  }

  if (backend.type === 'worker') {
    const workerPromise = getWorkerPool().exec('readFile', [normalized, encoding], encoding);
    return wrapWithAbortSignal(workerPromise, signal);
  }

  const rawPromise = optimisticReadSize !== undefined
    ? native.readFile(normalized, optimisticReadSize)
    : native.readFile(normalized);
  const buffer = await wrapWithAbortSignal(rawPromise, signal);

  if (encoding) {
    return buffer.toString(encoding);
  }
  return buffer;
}

/**
 * Reads a specific portion of a file asynchronously at the specified offset.
 *
 * @param {string | Buffer | URL} filePath Path to the file.
 * @param {number} offset The position in the file to start reading from.
 * @param {number} length The number of bytes to read.
 * @param {string | { encoding?: BufferEncoding | null, signal?: AbortSignal, fallback?: 'fs' | 'worker' | boolean | object, strict?: boolean } | null} [options]
 * @returns {Promise<Buffer | string>}
 */
async function readAt(filePath, offset, length, options) {
  if (typeof offset !== 'number') {
    const err = new TypeError(`The "offset" argument must be of type number. Received ${typeof offset}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 0) {
    const err = new RangeError(`The value of "offset" is out of range. It must be an integer >= 0. Received ${offset}`);
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }
  if (typeof length !== 'number') {
    const err = new TypeError(`The "length" argument must be of type number. Received ${typeof length}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (!Number.isFinite(length) || !Number.isInteger(length) || length < 0) {
    const err = new RangeError(`The value of "length" is out of range. It must be an integer >= 0. Received ${length}`);
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }

  let encoding = null;
  let signal = undefined;

  if (typeof options === 'string') {
    encoding = options;
  } else if (options && typeof options === 'object') {
    encoding = options.encoding ?? null;
    signal = options.signal;
  }

  validateEncoding(encoding);

  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const normalized = normalizePath(filePath);

  const backend = selectExecutionBackend(typeof options === 'object' ? options : undefined);

  if (backend.type === 'provider') {
    if (typeof backend.provider.open === 'function') {
      const openPromise = backend.provider.open(normalized, 'r');
      if (signal) {
        openPromise.then(
          (fh) => {
            if (signal.aborted && fh && typeof fh.close === 'function') {
              fh.close().catch(() => {});
            }
          },
          () => {}
        );
      }
      const fh = await wrapWithAbortSignal(openPromise, signal);
      try {
        if (length === 0) {
          if (typeof fh.stat === 'function') {
            const st = await wrapWithAbortSignal(fh.stat(), signal);
            if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
              const err = new Error('EISDIR: illegal operation on a directory, read');
              err.code = 'EISDIR';
              err.errno = -21;
              err.syscall = 'read';
              throw err;
            }
          }
          await wrapWithAbortSignal(fh.read(Buffer.alloc(1), 0, 0, offset), signal);
          return encoding ? '' : Buffer.alloc(0);
        }
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await wrapWithAbortSignal(fh.read(buf, 0, length, offset), signal);
        const resultBuf = bytesRead < length ? buf.subarray(0, bytesRead) : buf;
        return encoding ? resultBuf.toString(encoding) : resultBuf;
      } finally {
        await fh.close().catch(() => {});
      }
    }
    const fullBuf = await wrapWithAbortSignal(backend.provider.readFile(normalized), signal);
    const rawBuf = Buffer.isBuffer(fullBuf) ? fullBuf : Buffer.from(String(fullBuf));
    const start = Math.min(offset, rawBuf.length);
    const end = Math.min(offset + length, rawBuf.length);
    const slice = rawBuf.subarray(start, end);
    return encoding ? slice.toString(encoding) : slice;
  }

  if (backend.type === 'worker') {
    const workerPromise = getWorkerPool().exec('readAt', [normalized, offset, length]);
    const buffer = await wrapWithAbortSignal(workerPromise, signal);
    return encoding ? buffer.toString(encoding) : buffer;
  }

  const rawPromise = native.readAt(normalized, offset, length);
  const buffer = await wrapWithAbortSignal(rawPromise, signal);
  return encoding ? buffer.toString(encoding) : buffer;
}

/**
 * Writes data to a file asynchronously via io_uring.
 */
async function writeFile(filePath, data, options) {
  let encoding = 'utf8';
  let mode = 0o666;
  let flag = 'w';
  let flush = false;
  let signal = undefined;

  if (typeof options === 'string') {
    encoding = options;
  } else if (options && typeof options === 'object') {
    if (options.encoding) encoding = options.encoding;
    if (options.mode !== undefined) mode = options.mode;
    if (options.flag !== undefined) flag = options.flag;
    if (options.flush !== undefined) flush = Boolean(options.flush);
    signal = options.signal;
  }

  validateEncoding(encoding);

  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const normalized = normalizePath(filePath);
  const backend = selectExecutionBackend(options);

  if (backend.type === 'provider') {
    await wrapWithAbortSignal(
      backend.provider.writeFile(normalized, data, { encoding, mode, flag, flush, signal }),
      signal
    );
    return;
  }

  if (backend.type === 'worker') {
    const workerPromise = getWorkerPool().exec('writeFile', [normalized, data, { encoding, mode, flag, flush }]);
    await wrapWithAbortSignal(workerPromise, signal);
    return;
  }

  const numericFlags = parseWriteFlags(flag);
  let payload = data;
  if (typeof data === 'string' && encoding !== 'utf8' && encoding !== 'utf-8') {
    payload = Buffer.from(data, encoding);
  } else if (ArrayBuffer.isView(data) && !Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  const rawPromise = native.writeFile(normalized, payload, numericFlags, mode, flush);
  await wrapWithAbortSignal(rawPromise, signal);
}

/**
 * Appends data to a file asynchronously via io_uring.
 */
async function appendFile(filePath, data, options) {
  const opts = typeof options === 'string'
    ? { encoding: options, flag: 'a' }
    : { flag: 'a', ...options };
  return writeFile(filePath, data, opts);
}

/**
 * Copies a file asynchronously inside kernel space via io_uring splice (zero-copy).
 */
async function copyFile(srcPath, destPath, options) {
  let mode = 0;
  let signal = undefined;
  if (typeof options === 'number') {
    mode = options;
  } else if (options && typeof options === 'object') {
    if (typeof options.mode === 'number') {
      mode = options.mode;
    }
    signal = options.signal;
  }

  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const srcNormalized = normalizePath(srcPath);
  const destNormalized = normalizePath(destPath);
  const backend = selectExecutionBackend(typeof options === 'object' ? options : undefined);

  if (backend.type === 'provider') {
    if (typeof backend.provider.copyFile === 'function') {
      return wrapWithAbortSignal(backend.provider.copyFile(srcNormalized, destNormalized, mode), signal);
    }
    const content = await wrapWithAbortSignal(backend.provider.readFile(srcNormalized), signal);
    const flag = (mode & fsConstants.COPYFILE_EXCL) ? 'wx' : 'w';
    return wrapWithAbortSignal(backend.provider.writeFile(destNormalized, content, { flag }), signal);
  }

  if (backend.type === 'worker') {
    return wrapWithAbortSignal(getWorkerPool().exec('copyFile', [srcNormalized, destNormalized, mode]), signal);
  }

  const copyFlags = (mode & fsConstants.COPYFILE_EXCL) ? 1 : 0;
  await wrapWithAbortSignal(native.copyFile(srcNormalized, destNormalized, copyFlags), signal);
}

/**
 * Retrieves file or directory metadata via io_uring statx (following symlinks).
 */
async function stat(filePath, options) {
  const signal = options && typeof options === 'object' ? options.signal : undefined;
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const normalized = normalizePath(filePath);
  const backend = selectExecutionBackend(options);

  if (backend.type === 'provider') {
    return wrapWithAbortSignal(backend.provider.stat(normalized), signal);
  }

  if (backend.type === 'worker') {
    const raw = await wrapWithAbortSignal(getWorkerPool().exec('stat', [normalized]), signal);
    return new UringStats(raw);
  }

  const raw = await wrapWithAbortSignal(native.stat(normalized), signal);
  return new UringStats(raw);
}

/**
 * Retrieves file, directory, or symbolic link metadata via io_uring statx (AT_SYMLINK_NOFOLLOW).
 */
async function lstat(filePath, options) {
  const signal = options && typeof options === 'object' ? options.signal : undefined;
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const normalized = normalizePath(filePath);
  const backend = selectExecutionBackend(options);

  if (backend.type === 'provider') {
    if (typeof backend.provider.lstat === 'function') {
      return wrapWithAbortSignal(backend.provider.lstat(normalized), signal);
    }
    return wrapWithAbortSignal(backend.provider.stat(normalized), signal);
  }

  if (backend.type === 'worker') {
    const raw = await wrapWithAbortSignal(getWorkerPool().exec('lstat', [normalized]), signal);
    return new UringStats(raw);
  }

  const raw = await wrapWithAbortSignal(native.lstat(normalized), signal);
  return new UringStats(raw);
}

/**
 * Tests a user's permissions for the file or directory specified by path via 1-SQE io_uring statx.
 */
async function access(filePath, modeOrOptions, options) {
  let mode = fsConstants.F_OK;
  let opts = options;

  if (typeof modeOrOptions === 'number') {
    mode = modeOrOptions;
  } else if (modeOrOptions && typeof modeOrOptions === 'object') {
    opts = modeOrOptions;
    if (modeOrOptions.mode !== undefined) {
      mode = modeOrOptions.mode;
    }
  } else if (modeOrOptions !== undefined) {
    const err = new TypeError(`The "mode" argument must be of type number. Received ${typeof modeOrOptions}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }

  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 7) {
    const err = new RangeError(`The value of "mode" is out of range. It must be an integer >= 0 && <= 7. Received ${mode}`);
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }

  const signal = opts && opts.signal;
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const normalized = normalizePath(filePath);
  const backend = selectExecutionBackend(opts);

  if (backend.type === 'provider') {
    if (typeof backend.provider.access === 'function') {
      return wrapWithAbortSignal(backend.provider.access(normalized, mode), signal);
    }
    return wrapWithAbortSignal(
      backend.provider.stat(normalized).then(() => undefined),
      signal
    );
  }

  if (backend.type === 'worker') {
    return wrapWithAbortSignal(getWorkerPool().exec('access', [normalized, mode]), signal);
  }

  return wrapWithAbortSignal(native.access(normalized, mode), signal);
}

/**
 * Tests whether or not the given path exists on the filesystem via 1-SQE io_uring statx.
 */
async function exists(filePath, options) {
  try {
    await access(filePath, fsConstants.F_OK, options);
    return true;
  } catch (err) {
    if (
      err instanceof TypeError ||
      (err && (err.code === 'ABORT_ERR' || err.code === 'ERR_URING_UNSUPPORTED' || err.code === 'ERR_INVALID_ARG_TYPE'))
    ) {
      throw err;
    }
    return false;
  }
}

/**
 * Removes a file or symbolic link asynchronously via io_uring unlinkat.
 */
async function unlink(filePath, options) {
  const signal = options && typeof options === 'object' ? options.signal : undefined;
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const normalized = normalizePath(filePath);
  const backend = selectExecutionBackend(options);

  if (backend.type === 'provider') {
    return wrapWithAbortSignal(backend.provider.unlink(normalized), signal);
  }

  if (backend.type === 'worker') {
    await wrapWithAbortSignal(getWorkerPool().exec('unlink', [normalized]), signal);
    return;
  }

  await wrapWithAbortSignal(native.unlink(normalized), signal);
}

/**
 * Removes a directory asynchronously via 1-SQE io_uring unlinkat (AT_REMOVEDIR).
 */
async function rmdir(dirPath, options) {
  const signal = options && typeof options === 'object' ? options.signal : undefined;
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const normalized = normalizePath(dirPath);
  const backend = selectExecutionBackend(options);

  if (backend.type === 'provider') {
    if (typeof backend.provider.rmdir === 'function') {
      return wrapWithAbortSignal(backend.provider.rmdir(normalized, options), signal);
    }
    return wrapWithAbortSignal(fsPromises.rmdir(normalized, options), signal);
  }

  if (backend.type === 'worker') {
    await wrapWithAbortSignal(getWorkerPool().exec('rmdir', [normalized, options]), signal);
    return;
  }

  await wrapWithAbortSignal(native.rmdir(normalized), signal);
}

/**
 * Creates a directory via io_uring mkdirat (or recursively).
 */
async function mkdir(dirPath, options) {
  let mode = 0o777;
  let recursive = false;
  let signal = undefined;

  if (typeof options === 'number') {
    mode = options;
  } else if (options && typeof options === 'object') {
    if (options.mode !== undefined) mode = options.mode;
    if (options.recursive !== undefined) recursive = Boolean(options.recursive);
    signal = options.signal;
  }

  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const normalized = normalizePath(dirPath);
  const backend = selectExecutionBackend(typeof options === 'object' ? options : undefined);

  if (backend.type === 'provider') {
    return wrapWithAbortSignal(backend.provider.mkdir(normalized, { recursive, mode }), signal);
  }

  if (backend.type === 'worker') {
    return wrapWithAbortSignal(getWorkerPool().exec('mkdir', [normalized, { recursive, mode }]), signal);
  }

  if (!recursive) {
    await wrapWithAbortSignal(native.mkdir(normalized, mode), signal);
    return undefined;
  }

  const resolved = pathModule.resolve(normalized);
  try {
    await wrapWithAbortSignal(native.mkdir(resolved, mode), signal);
    return resolved;
  } catch (err) {
    if (err.code === 'EEXIST') {
      const st = await stat(resolved, options);
      if (st.isDirectory()) return undefined;
      throw err;
    }
    if (err.code === 'ENOENT') {
      const parent = pathModule.dirname(resolved);
      if (parent !== resolved) {
        const firstCreated = await mkdir(parent, { ...(typeof options === 'object' ? options : {}), recursive: true, mode });
        try {
          await wrapWithAbortSignal(native.mkdir(resolved, mode), signal);
          return firstCreated ?? resolved;
        } catch (e2) {
          if (e2.code === 'EEXIST') {
            const st = await stat(resolved, options);
            if (st.isDirectory()) return firstCreated;
          }
          throw e2;
        }
      }
    }
    throw err;
  }
}

/**
 * Atomically renames or moves a file or directory via io_uring renameat.
 */
async function rename(oldPath, newPath, options) {
  const signal = options && typeof options === 'object' ? options.signal : undefined;
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const oldNormalized = normalizePath(oldPath);
  const newNormalized = normalizePath(newPath);
  const backend = selectExecutionBackend(options);

  if (backend.type === 'provider') {
    return wrapWithAbortSignal(backend.provider.rename(oldNormalized, newNormalized), signal);
  }

  if (backend.type === 'worker') {
    await wrapWithAbortSignal(getWorkerPool().exec('rename', [oldNormalized, newNormalized]), signal);
    return;
  }

  await wrapWithAbortSignal(native.rename(oldNormalized, newNormalized), signal);
}

/**
 * Creates a symbolic link asynchronously via io_uring symlinkat.
 */
async function symlink(target, linkPath, typeOrOptions, optionsArg) {
  const type = typeof typeOrOptions === 'string'
    ? typeOrOptions
    : (typeOrOptions && typeof typeOrOptions === 'object' && typeof typeOrOptions.type === 'string' ? typeOrOptions.type : undefined);
  const options = typeof optionsArg === 'object' && optionsArg !== null
    ? optionsArg
    : (typeof typeOrOptions === 'object' && typeOrOptions !== null ? typeOrOptions : undefined);
  const signal = options ? options.signal : undefined;
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const targetNormalized = normalizePath(target);
  const linkNormalized = normalizePath(linkPath);
  const backend = selectExecutionBackend(options);

  if (backend.type === 'provider') {
    return wrapWithAbortSignal(backend.provider.symlink(targetNormalized, linkNormalized, type), signal);
  }

  if (backend.type === 'worker') {
    await wrapWithAbortSignal(getWorkerPool().exec('symlink', [targetNormalized, linkNormalized, type]), signal);
    return;
  }

  await wrapWithAbortSignal(native.symlink(targetNormalized, linkNormalized), signal);
}

/**
 * Creates a hard link asynchronously via io_uring linkat.
 */
async function link(existingPath, newPath, options) {
  const signal = options && typeof options === 'object' ? options.signal : undefined;
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const existingNormalized = normalizePath(existingPath);
  const newNormalized = normalizePath(newPath);
  const backend = selectExecutionBackend(options);

  if (backend.type === 'provider') {
    return wrapWithAbortSignal(backend.provider.link(existingNormalized, newNormalized), signal);
  }

  if (backend.type === 'worker') {
    await wrapWithAbortSignal(getWorkerPool().exec('link', [existingNormalized, newNormalized]), signal);
    return;
  }

  await wrapWithAbortSignal(native.link(existingNormalized, newNormalized), signal);
}

/**
 * Flushes all modified in-core data and metadata of a file to the storage device via io_uring fsync.
 */
async function fsync(filePath, options) {
  const signal = options && typeof options === 'object' ? options.signal : undefined;
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const normalized = normalizePath(filePath);
  const backend = selectExecutionBackend(options);

  if (backend.type === 'provider') {
    if (typeof backend.provider.fsync === 'function') {
      return wrapWithAbortSignal(backend.provider.fsync(normalized), signal);
    }
    const openFn = typeof backend.provider.open === 'function'
      ? backend.provider.open.bind(backend.provider)
      : fsPromises.open;
    const openPromise = openFn(normalized, 'r');
    if (signal) {
      openPromise.then(
        (fh) => {
          if (signal.aborted && fh && typeof fh.close === 'function') {
            fh.close().catch(() => {});
          }
        },
        () => {}
      );
    }
    const fh = await wrapWithAbortSignal(openPromise, signal);
    try {
      await wrapWithAbortSignal(fh.sync(), signal);
    } finally {
      await fh.close().catch(() => {});
    }
    return;
  }

  if (backend.type === 'worker') {
    await wrapWithAbortSignal(getWorkerPool().exec('fsync', [normalized, false]), signal);
    return;
  }

  await wrapWithAbortSignal(native.fsync(normalized, false), signal);
}

/**
 * Flushes all modified in-core file data (excluding non-essential metadata) via io_uring fdatasync.
 */
async function fdatasync(filePath, options) {
  const signal = options && typeof options === 'object' ? options.signal : undefined;
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  const normalized = normalizePath(filePath);
  const backend = selectExecutionBackend(options);

  if (backend.type === 'provider') {
    if (typeof backend.provider.fdatasync === 'function') {
      return wrapWithAbortSignal(backend.provider.fdatasync(normalized), signal);
    }
    const openFn = typeof backend.provider.open === 'function'
      ? backend.provider.open.bind(backend.provider)
      : fsPromises.open;
    const openPromise = openFn(normalized, 'r');
    if (signal) {
      openPromise.then(
        (fh) => {
          if (signal.aborted && fh && typeof fh.close === 'function') {
            fh.close().catch(() => {});
          }
        },
        () => {}
      );
    }
    const fh = await wrapWithAbortSignal(openPromise, signal);
    try {
      await wrapWithAbortSignal(fh.datasync(), signal);
    } finally {
      await fh.close().catch(() => {});
    }
    return;
  }

  if (backend.type === 'worker') {
    await wrapWithAbortSignal(getWorkerPool().exec('fsync', [normalized, true]), signal);
    return;
  }

  await wrapWithAbortSignal(native.fsync(normalized, true), signal);
}

class UringFileHandle {
  #backend;
  #path;
  #flags;
  #mode;
  #fd;
  #directSlot;
  #nodeHandle;
  #closed = false;
  #activeOps = 0;
  #drainResolvers = [];
  #closePromise = null;

  constructor(backend, path, flags, mode, descriptorInfo, nodeHandle = null) {
    this.#backend = backend;
    this.#path = path;
    this.#flags = flags;
    this.#mode = mode;
    this.#fd = descriptorInfo?.fd ?? -1;
    this.#directSlot = descriptorInfo?.directSlot ?? -1;
    this.#nodeHandle = nodeHandle;
  }

  get fd() {
    if (this.#closed) {
      return -1;
    }
    if (this.#backend === 'io_uring') {
      return this.#fd;
    }
    return this.#nodeHandle ? this.#nodeHandle.fd : -1;
  }

  get directSlot() {
    return this.#closed ? -1 : this.#directSlot;
  }

  get closed() {
    return this.#closed;
  }

  #ensureOpen() {
    if (this.#closed) {
      const err = new Error('EBADF: bad file descriptor, file handle is closed');
      err.code = 'EBADF';
      err.errno = -9;
      err.syscall = 'filehandle';
      throw err;
    }
  }

  #beginOp() {
    this.#ensureOpen();
    this.#activeOps++;
  }

  #endOp() {
    this.#activeOps--;
    if (this.#activeOps === 0 && this.#drainResolvers.length > 0) {
      const resolvers = this.#drainResolvers;
      this.#drainResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  async read(buffer, offset, length, position) {
    this.#beginOp();
    try {
      let callerBuffer = buffer;
      let targetBuf = buffer;
      let bufOffset = offset;
      let readLen = length;
      let pos = position;

      if (targetBuf && typeof targetBuf === 'object' && !Buffer.isBuffer(targetBuf) && !(targetBuf instanceof Uint8Array)) {
        bufOffset = targetBuf.offset;
        readLen = targetBuf.length;
        pos = targetBuf.position;
        targetBuf = targetBuf.buffer;
        callerBuffer = targetBuf;
      }

      if (!targetBuf) {
        targetBuf = Buffer.alloc(16384);
        callerBuffer = targetBuf;
      } else if (!Buffer.isBuffer(targetBuf) && targetBuf instanceof Uint8Array) {
        targetBuf = Buffer.from(targetBuf.buffer, targetBuf.byteOffset, targetBuf.byteLength);
      } else if (!Buffer.isBuffer(targetBuf)) {
        const err = new TypeError('The "buffer" argument must be an instance of Buffer or Uint8Array.');
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }

      if (bufOffset !== undefined && bufOffset !== null) {
        if (typeof bufOffset !== 'number') {
          const err = new TypeError(`The "offset" argument must be of type number. Received ${typeof bufOffset}`);
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
        if (!Number.isInteger(bufOffset) || bufOffset < 0) {
          const err = new RangeError(`The value of "offset" is out of range. It must be an integer >= 0. Received ${bufOffset}`);
          err.code = 'ERR_OUT_OF_RANGE';
          throw err;
        }
      } else {
        bufOffset = 0;
      }

      if (readLen !== undefined && readLen !== null) {
        if (typeof readLen !== 'number') {
          const err = new TypeError(`The "length" argument must be of type number. Received ${typeof readLen}`);
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
        if (!Number.isInteger(readLen) || readLen < 0) {
          const err = new RangeError(`The value of "length" is out of range. It must be an integer >= 0. Received ${readLen}`);
          err.code = 'ERR_OUT_OF_RANGE';
          throw err;
        }
      } else {
        readLen = callerBuffer.byteLength - bufOffset;
      }

      if (bufOffset > callerBuffer.byteLength || readLen > callerBuffer.byteLength - bufOffset) {
        const err = new RangeError('The value of "offset" and "length" is out of range.');
        err.code = 'ERR_OUT_OF_RANGE';
        throw err;
      }

      if (pos !== undefined && pos !== null) {
        if (typeof pos !== 'number') {
          const err = new TypeError(`The "position" argument must be of type number. Received ${typeof pos}`);
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
        if (!Number.isInteger(pos) || pos < -1) {
          const err = new RangeError(`The value of "position" is out of range. Received ${pos}`);
          err.code = 'ERR_OUT_OF_RANGE';
          throw err;
        }
      } else {
        pos = -1;
      }

      if (this.#backend === 'io_uring') {
        const bytesRead = await native.fhRead(this.#fd, this.#directSlot, targetBuf, bufOffset, readLen, pos);
        return { bytesRead, buffer: callerBuffer };
      }

      const res = await this.#nodeHandle.read(targetBuf, bufOffset, readLen, pos < 0 ? null : pos);
      return { bytesRead: res.bytesRead, buffer: callerBuffer };
    } finally {
      this.#endOp();
    }
  }

  async readAt(offset, length, options) {
    this.#beginOp();
    try {
      if (typeof offset !== 'number') {
        const err = new TypeError(`The "offset" argument must be of type number. Received ${typeof offset}`);
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (!Number.isInteger(offset) || offset < 0) {
        const err = new RangeError(`The value of "offset" is out of range. It must be an integer >= 0. Received ${offset}`);
        err.code = 'ERR_OUT_OF_RANGE';
        throw err;
      }
      if (typeof length !== 'number') {
        const err = new TypeError(`The "length" argument must be of type number. Received ${typeof length}`);
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (!Number.isInteger(length) || length < 0) {
        const err = new RangeError(`The value of "length" is out of range. It must be an integer >= 0. Received ${length}`);
        err.code = 'ERR_OUT_OF_RANGE';
        throw err;
      }
      let encoding = null;
      let signal = undefined;
      if (typeof options === 'string') {
        encoding = options;
      } else if (options && typeof options === 'object') {
        encoding = options.encoding ?? null;
        signal = options.signal;
      }
      validateEncoding(encoding);

      if (signal && signal.aborted) {
        throw createAbortError(signal);
      }

      if (length === 0) {
        return encoding ? '' : Buffer.alloc(0);
      }

      if (this.#backend === 'io_uring') {
        const buf = await wrapWithAbortSignal(native.fhReadAt(this.#fd, this.#directSlot, offset, length), signal);
        return encoding ? buf.toString(encoding) : buf;
      }

      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await wrapWithAbortSignal(this.#nodeHandle.read(buf, 0, length, offset), signal);
      const res = bytesRead < length ? buf.subarray(0, bytesRead) : buf;
      return encoding ? res.toString(encoding) : res;
    } finally {
      this.#endOp();
    }
  }

  async readBatchAt(ranges, options = {}) {
    this.#beginOp();
    try {
      const signal = options && typeof options === 'object' ? options.signal : undefined;
      if (signal && signal.aborted) {
        throw createAbortError(signal);
      }
      if (!Array.isArray(ranges)) {
        const err = new TypeError('The "ranges" argument must be an Array.');
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (ranges.length === 0) {
        return [];
      }
      const results = [];
      for (const r of ranges) {
        if (signal && signal.aborted) {
          throw createAbortError(signal);
        }
        const offset = Array.isArray(r) ? r[0] : r?.offset;
        const length = Array.isArray(r) ? r[1] : r?.length;
        results.push(await this.readAt(offset, length, options));
      }
      return results;
    } finally {
      this.#endOp();
    }
  }

  async write(buffer, offsetOrPosition, lengthOrEncoding, position) {
    this.#beginOp();
    try {
      const callerBuffer = buffer;
      let data = buffer;
      let offset = 0;
      let length = 0;
      let pos = -1;

      if (typeof data === 'string') {
        let encoding = 'utf8';
        if (typeof offsetOrPosition === 'string') {
          encoding = offsetOrPosition;
          offsetOrPosition = null;
        } else if (typeof lengthOrEncoding === 'string') {
          encoding = lengthOrEncoding;
        }
        if (offsetOrPosition !== undefined && offsetOrPosition !== null) {
          if (typeof offsetOrPosition !== 'number') {
            const err = new TypeError(`The "position" argument must be of type number. Received ${typeof offsetOrPosition}`);
            err.code = 'ERR_INVALID_ARG_TYPE';
            throw err;
          }
          if (!Number.isInteger(offsetOrPosition) || offsetOrPosition < 0) {
            const err = new RangeError(`The value of "position" is out of range. Received ${offsetOrPosition}`);
            err.code = 'ERR_OUT_OF_RANGE';
            throw err;
          }
          pos = offsetOrPosition;
        }
        data = Buffer.from(data, encoding);
        offset = 0;
        length = data.length;
      } else {
        if (!Buffer.isBuffer(data) && data instanceof Uint8Array) {
          data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        } else if (!Buffer.isBuffer(data)) {
          const err = new TypeError('The "buffer" argument must be of type string or an instance of Buffer or Uint8Array.');
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }

        if (offsetOrPosition !== undefined && offsetOrPosition !== null) {
          if (typeof offsetOrPosition !== 'number') {
            const err = new TypeError(`The "offset" argument must be of type number. Received ${typeof offsetOrPosition}`);
            err.code = 'ERR_INVALID_ARG_TYPE';
            throw err;
          }
          if (!Number.isInteger(offsetOrPosition) || offsetOrPosition < 0) {
            const err = new RangeError(`The value of "offset" is out of range. It must be an integer >= 0. Received ${offsetOrPosition}`);
            err.code = 'ERR_OUT_OF_RANGE';
            throw err;
          }
          offset = offsetOrPosition;
        } else {
          offset = 0;
        }

        if (lengthOrEncoding !== undefined && lengthOrEncoding !== null) {
          if (typeof lengthOrEncoding !== 'number') {
            const err = new TypeError(`The "length" argument must be of type number. Received ${typeof lengthOrEncoding}`);
            err.code = 'ERR_INVALID_ARG_TYPE';
            throw err;
          }
          if (!Number.isInteger(lengthOrEncoding) || lengthOrEncoding < 0) {
            const err = new RangeError(`The value of "length" is out of range. It must be an integer >= 0. Received ${lengthOrEncoding}`);
            err.code = 'ERR_OUT_OF_RANGE';
            throw err;
          }
          length = lengthOrEncoding;
        } else {
          length = callerBuffer.byteLength - offset;
        }

        if (offset > callerBuffer.byteLength || length > callerBuffer.byteLength - offset) {
          const err = new RangeError('The value of "offset" and "length" is out of range.');
          err.code = 'ERR_OUT_OF_RANGE';
          throw err;
        }

        if (position !== undefined && position !== null) {
          if (typeof position !== 'number') {
            const err = new TypeError(`The "position" argument must be of type number. Received ${typeof position}`);
            err.code = 'ERR_INVALID_ARG_TYPE';
            throw err;
          }
          if (!Number.isInteger(position) || position < -1) {
            const err = new RangeError(`The value of "position" is out of range. Received ${position}`);
            err.code = 'ERR_OUT_OF_RANGE';
            throw err;
          }
          pos = position;
        } else {
          pos = -1;
        }
      }

      if (this.#backend === 'io_uring') {
        const bytesWritten = await native.fhWrite(
          this.#fd,
          this.#directSlot,
          data,
          offset,
          length,
          pos,
          this.#flags
        );
        return { bytesWritten, buffer: callerBuffer };
      }

      const res = await this.#nodeHandle.write(data, offset, length, pos < 0 ? null : pos);
      return { bytesWritten: res.bytesWritten, buffer: callerBuffer };
    } finally {
      this.#endOp();
    }
  }

  async writeAt(buffer, position) {
    this.#beginOp();
    try {
      if (typeof buffer === 'string') {
        buffer = Buffer.from(buffer, 'utf8');
      }
      const res = await this.write(buffer, 0, buffer.byteLength, position);
      return res.bytesWritten;
    } finally {
      this.#endOp();
    }
  }

  async readv(buffers, position = null) {
    this.#beginOp();
    try {
      if (!Array.isArray(buffers)) {
        const err = new TypeError('The "buffers" argument must be an Array.');
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (position !== null && position !== undefined) {
        if (typeof position !== 'number') {
          const err = new TypeError(`The "position" argument must be of type number. Received ${typeof position}`);
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
        if (!Number.isInteger(position) || position < 0) {
          const err = new RangeError(`The value of "position" is out of range. It must be an integer >= 0. Received ${position}`);
          err.code = 'ERR_OUT_OF_RANGE';
          throw err;
        }
      }
      if (buffers.length === 0) {
        return { bytesRead: 0, buffers };
      }
      for (let i = 0; i < buffers.length; i++) {
        if (!Buffer.isBuffer(buffers[i]) && !(buffers[i] instanceof Uint8Array)) {
          const err = new TypeError(`buffers[${i}] must be a Buffer or Uint8Array.`);
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
      }
      const pos = position !== undefined && position !== null ? position : -1;
      if (this.#backend === 'io_uring') {
        const bytesRead = await native.fhReadv(this.#fd, this.#directSlot, buffers, pos);
        return { bytesRead, buffers };
      }
      if (typeof this.#nodeHandle.readv === 'function') {
        return await this.#nodeHandle.readv(buffers, pos < 0 ? null : pos);
      }
      let totalBytes = 0;
      let currentPos = pos >= 0 ? pos : null;
      for (const b of buffers) {
        const { bytesRead } = await this.#nodeHandle.read(b, 0, b.length, currentPos);
        totalBytes += bytesRead;
        if (currentPos !== null) currentPos += bytesRead;
        if (bytesRead < b.length) break;
      }
      return { bytesRead: totalBytes, buffers };
    } finally {
      this.#endOp();
    }
  }

  async writev(buffers, position = null) {
    this.#beginOp();
    try {
      if (!Array.isArray(buffers)) {
        const err = new TypeError('The "buffers" argument must be an Array.');
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (position !== null && position !== undefined) {
        if (typeof position !== 'number') {
          const err = new TypeError(`The "position" argument must be of type number. Received ${typeof position}`);
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
        if (!Number.isInteger(position) || position < 0) {
          const err = new RangeError(`The value of "position" is out of range. It must be an integer >= 0. Received ${position}`);
          err.code = 'ERR_OUT_OF_RANGE';
          throw err;
        }
      }
      if (buffers.length === 0) {
        return { bytesWritten: 0, buffers };
      }
      for (let i = 0; i < buffers.length; i++) {
        if (!Buffer.isBuffer(buffers[i]) && !(buffers[i] instanceof Uint8Array)) {
          const err = new TypeError(`buffers[${i}] must be a Buffer or Uint8Array.`);
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
      }
      const pos = position !== undefined && position !== null ? position : -1;
      if (this.#backend === 'io_uring') {
        const bytesWritten = await native.fhWritev(this.#fd, this.#directSlot, buffers, pos, this.#flags);
        return { bytesWritten, buffers };
      }
      if (typeof this.#nodeHandle.writev === 'function') {
        return await this.#nodeHandle.writev(buffers, pos < 0 ? null : pos);
      }
      let totalBytes = 0;
      let currentPos = pos >= 0 ? pos : null;
      for (const b of buffers) {
        const { bytesWritten } = await this.#nodeHandle.write(b, 0, b.length, currentPos);
        totalBytes += bytesWritten;
        if (currentPos !== null) currentPos += bytesWritten;
      }
      return { bytesWritten: totalBytes, buffers };
    } finally {
      this.#endOp();
    }
  }

  async sync() {
    this.#beginOp();
    try {
      if (this.#backend === 'io_uring') {
        await native.fhSync(this.#fd, this.#directSlot, false);
        return;
      }
      await this.#nodeHandle.sync();
    } finally {
      this.#endOp();
    }
  }

  async datasync() {
    this.#beginOp();
    try {
      if (this.#backend === 'io_uring') {
        await native.fhSync(this.#fd, this.#directSlot, true);
        return;
      }
      await this.#nodeHandle.datasync();
    } finally {
      this.#endOp();
    }
  }

  async fallocate(offset, length, mode = 0) {
    this.#beginOp();
    try {
      if (typeof offset !== 'number') {
        const err = new TypeError(`The "offset" argument must be of type number. Received ${typeof offset}`);
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (!Number.isInteger(offset) || offset < 0) {
        const err = new RangeError(`The value of "offset" is out of range. It must be an integer >= 0. Received ${offset}`);
        err.code = 'ERR_OUT_OF_RANGE';
        throw err;
      }
      if (typeof length !== 'number') {
        const err = new TypeError(`The "length" argument must be of type number. Received ${typeof length}`);
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (!Number.isInteger(length) || length < 0) {
        const err = new RangeError(`The value of "length" is out of range. It must be an integer >= 0. Received ${length}`);
        err.code = 'ERR_OUT_OF_RANGE';
        throw err;
      }
      if (mode !== undefined && mode !== null) {
        if (typeof mode !== 'number') {
          const err = new TypeError(`The "mode" argument must be of type number. Received ${typeof mode}`);
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
        if (!Number.isInteger(mode) || mode < 0) {
          const err = new RangeError(`The value of "mode" is out of range. Received ${mode}`);
          err.code = 'ERR_OUT_OF_RANGE';
          throw err;
        }
      }
      const fallocMode = typeof mode === 'number' ? mode : 0;
      if (this.#backend === 'io_uring') {
        await native.fhFallocate(this.#fd, this.#directSlot, fallocMode, offset, length);
        return;
      }
      const st = await this.#nodeHandle.stat();
      if (offset + length > st.size && (fallocMode & FALLOC_FL_KEEP_SIZE) === 0) {
        await this.#nodeHandle.truncate(offset + length);
      }
    } finally {
      this.#endOp();
    }
  }

  async fadvise(offset, length, advice) {
    this.#beginOp();
    try {
      if (typeof offset !== 'number') {
        const err = new TypeError(`The "offset" argument must be of type number. Received ${typeof offset}`);
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (!Number.isInteger(offset) || offset < 0) {
        const err = new RangeError(`The value of "offset" is out of range. It must be an integer >= 0. Received ${offset}`);
        err.code = 'ERR_OUT_OF_RANGE';
        throw err;
      }
      if (typeof length !== 'number') {
        const err = new TypeError(`The "length" argument must be of type number. Received ${typeof length}`);
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (!Number.isInteger(length) || length < 0) {
        const err = new RangeError(`The value of "length" is out of range. It must be an integer >= 0. Received ${length}`);
        err.code = 'ERR_OUT_OF_RANGE';
        throw err;
      }
      if (typeof advice !== 'number') {
        const err = new TypeError(`The "advice" argument must be of type number. Received ${typeof advice}`);
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      if (!Number.isInteger(advice) || advice < 0) {
        const err = new RangeError(`The value of "advice" is out of range. Received ${advice}`);
        err.code = 'ERR_OUT_OF_RANGE';
        throw err;
      }

      if (this.#backend === 'io_uring') {
        await native.fhFadvise(this.#fd, this.#directSlot, offset, length, advice);
        return;
      }
      return;
    } finally {
      this.#endOp();
    }
  }

  async stat(options) {
    this.#beginOp();
    try {
      if (this.#backend === 'io_uring') {
        return await stat(this.#path, options);
      }
      const st = await this.#nodeHandle.stat(options);
      return (st instanceof UringStats) ? st : new UringStats(st);
    } finally {
      this.#endOp();
    }
  }

  async close() {
    if (this.#closed) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#closePromise = (async () => {
      if (this.#activeOps > 0) {
        await new Promise((r) => this.#drainResolvers.push(r));
      }
      if (this.#backend === 'io_uring') {
        await native.fhClose(this.#fd, this.#directSlot);
        return;
      }
      if (this.#nodeHandle && typeof this.#nodeHandle.close === 'function') {
        await this.#nodeHandle.close();
      }
    })();
    return this.#closePromise;
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

/**
 * Reads multiple byte ranges from a file in batch via linked io_uring requests or single-FD fallback.
 */
async function readBatchAt(filePath, ranges, options = {}) {
  let encoding = null;
  let signal = undefined;

  if (typeof options === 'string') {
    encoding = options;
  } else if (options && typeof options === 'object') {
    encoding = options.encoding ?? null;
    signal = options.signal;
  }

  validateEncoding(encoding);

  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }

  if (!Array.isArray(ranges)) {
    const err = new TypeError('The "ranges" argument must be an Array.');
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }

  if (ranges.length === 0) {
    await readAt(filePath, 0, 0, options);
    return [];
  }

  const normalizedRanges = ranges.map((r, idx) => {
    let offset, length;
    if (Array.isArray(r)) {
      [offset, length] = r;
    } else if (r && typeof r === 'object') {
      offset = r.offset;
      length = r.length;
    } else {
      const err = new TypeError(`Invalid range at index ${idx}`);
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    if (typeof offset !== 'number') {
      const err = new TypeError(`The "offset" at index ${idx} must be of type number. Received ${typeof offset}`);
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    if (!Number.isInteger(offset) || offset < 0) {
      const err = new RangeError(`The "offset" at index ${idx} must be an integer >= 0. Received ${offset}`);
      err.code = 'ERR_OUT_OF_RANGE';
      throw err;
    }
    if (typeof length !== 'number') {
      const err = new TypeError(`The "length" at index ${idx} must be of type number. Received ${typeof length}`);
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    if (!Number.isInteger(length) || length < 0) {
      const err = new RangeError(`The "length" at index ${idx} must be an integer >= 0. Received ${length}`);
      err.code = 'ERR_OUT_OF_RANGE';
      throw err;
    }
    return { offset, length };
  });

  const normalized = normalizePath(filePath);
  const backend = selectExecutionBackend(typeof options === 'object' ? options : undefined);

  if (backend.type === 'provider') {
    if (typeof backend.provider.readBatchAt === 'function') {
      return await wrapWithAbortSignal(backend.provider.readBatchAt(normalized, normalizedRanges, options), signal);
    }
    if (backend.provider !== fsPromises && typeof backend.provider.open !== 'function') {
      const fullBuf = await wrapWithAbortSignal(backend.provider.readFile(normalized), signal);
      const buf = Buffer.isBuffer(fullBuf) ? fullBuf : Buffer.from(fullBuf);
      return normalizedRanges.map(({ offset, length }) => {
        const slice = buf.subarray(offset, offset + length);
        return encoding ? slice.toString(encoding) : slice;
      });
    }
    const openFn = backend.provider.open.bind(backend.provider);
    const openPromise = openFn(normalized, 'r');
    if (signal) {
      openPromise.then(
        (fh) => {
          if (signal.aborted && fh && typeof fh.close === 'function') {
            fh.close().catch(() => {});
          }
        },
        () => {}
      );
    }
    const fh = await wrapWithAbortSignal(openPromise, signal);
    try {
      const hasZeroLength = normalizedRanges.some((r) => r.length === 0);
      if (hasZeroLength && typeof fh.stat === 'function') {
        const st = await wrapWithAbortSignal(fh.stat(), signal);
        if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
          throw createErrnoError('EISDIR', 'read', normalized);
        }
      }
      const results = [];
      for (const { offset, length } of normalizedRanges) {
        if (length === 0) {
          results.push(encoding ? '' : Buffer.alloc(0));
          continue;
        }
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await wrapWithAbortSignal(fh.read(buf, 0, length, offset), signal);
        const slice = bytesRead < length ? buf.subarray(0, bytesRead) : buf;
        results.push(encoding ? slice.toString(encoding) : slice);
      }
      return results;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  if (backend.type === 'worker') {
    const rawSlices = await wrapWithAbortSignal(
      getWorkerPool().exec('readBatchAt', [normalized, normalizedRanges]),
      signal
    );
    return encoding ? rawSlices.map(b => b.toString(encoding)) : rawSlices;
  }

  const offsets = normalizedRanges.map(r => r.offset);
  const lengths = normalizedRanges.map(r => r.length);
  const buffers = await wrapWithAbortSignal(
    native.readBatchAt(normalized, offsets, lengths),
    signal
  );
  return encoding ? buffers.map(b => b.toString(encoding)) : buffers;
}

/**
 * Reads data from a file into an array of buffers using vectored I/O (readv).
 */
async function readv(filePath, buffers, position = null, options = {}) {
  let pos = position;
  let opts = options;
  if (typeof pos === 'object' && pos !== null) {
    opts = pos;
    pos = null;
  }
  if (!Array.isArray(buffers)) {
    const err = new TypeError('The "buffers" argument must be an Array.');
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (pos !== null && pos !== undefined) {
    if (typeof pos !== 'number') {
      const err = new TypeError(`The "position" argument must be of type number. Received ${typeof pos}`);
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    if (!Number.isInteger(pos) || pos < 0) {
      const err = new RangeError(`The value of "position" is out of range. It must be an integer >= 0. Received ${pos}`);
      err.code = 'ERR_OUT_OF_RANGE';
      throw err;
    }
  }
  if (buffers.length === 0) {
    return { bytesRead: 0, buffers };
  }
  for (let i = 0; i < buffers.length; i++) {
    if (!Buffer.isBuffer(buffers[i]) && !(buffers[i] instanceof Uint8Array)) {
      const err = new TypeError(`buffers[${i}] must be a Buffer or Uint8Array.`);
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
  }

  const signal = opts?.signal;
  if (signal && signal.aborted) throw createAbortError(signal);

  const normalized = normalizePath(filePath);
  const totalBytesToRead = buffers.reduce((acc, b) => acc + b.byteLength, 0);
  if (totalBytesToRead === 0) {
    const st = await stat(normalized, opts);
    if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
      throw createErrnoError('EISDIR', 'read', normalized);
    }
  }

  const backend = selectExecutionBackend(opts);

  if (backend.type === 'provider') {
    if (typeof backend.provider.readv === 'function') {
      return await wrapWithAbortSignal(backend.provider.readv(normalized, buffers, pos), signal);
    }
    if (backend.provider !== fsPromises && typeof backend.provider.open !== 'function') {
      const err = new Error('ERR_METHOD_NOT_IMPLEMENTED: Custom provider does not implement readv or open');
      err.code = 'ERR_METHOD_NOT_IMPLEMENTED';
      throw err;
    }
    const openFn = backend.provider.open.bind(backend.provider);
    const openPromise = openFn(normalized, 'r');
    if (signal) {
      openPromise.then(
        (fh) => {
          if (signal.aborted && fh && typeof fh.close === 'function') {
            fh.close().catch(() => {});
          }
        },
        () => {}
      );
    }
    const fh = await wrapWithAbortSignal(openPromise, signal);
    try {
      const totalBytesToRead = buffers.reduce((acc, b) => acc + b.byteLength, 0);
      if (totalBytesToRead === 0 && typeof fh.stat === 'function') {
        const st = await wrapWithAbortSignal(fh.stat(), signal);
        if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
          throw createErrnoError('EISDIR', 'read', normalized);
        }
      }
      if (typeof fh.readv === 'function') {
        return await wrapWithAbortSignal(fh.readv(buffers, pos), signal);
      }
      let totalBytes = 0;
      let currentPos = pos !== null && pos !== undefined && pos >= 0 ? pos : null;
      for (const b of buffers) {
        const { bytesRead } = await wrapWithAbortSignal(fh.read(b, 0, b.length, currentPos), signal);
        totalBytes += bytesRead;
        if (currentPos !== null) currentPos += bytesRead;
        if (bytesRead < b.length) break;
      }
      return { bytesRead: totalBytes, buffers };
    } finally {
      await fh.close().catch(() => {});
    }
  }

  if (backend.type === 'worker') {
    const res = await wrapWithAbortSignal(
      getWorkerPool().exec('readv', [normalized, buffers, pos]),
      signal
    );
    if (res && res.buffers) {
      for (let i = 0; i < Math.min(buffers.length, res.buffers.length); i++) {
        const src = res.buffers[i];
        const dst = buffers[i];
        Buffer.from(src.buffer, src.byteOffset, src.byteLength).copy(dst);
      }
      return { bytesRead: res.bytesRead, buffers };
    }
    return { bytesRead: res, buffers };
  }

  const bytesRead = await wrapWithAbortSignal(
    native.readv(normalized, buffers, pos !== null && pos !== undefined ? pos : -1),
    signal
  );
  return { bytesRead, buffers };
}

/**
 * Writes data from an array of buffers to a file using vectored I/O (writev).
 */
async function writev(filePath, buffers, position = null, options = {}) {
  let pos = position;
  let opts = options;
  if (typeof pos === 'object' && pos !== null) {
    opts = pos;
    pos = null;
  }
  if (!Array.isArray(buffers)) {
    const err = new TypeError('The "buffers" argument must be an Array.');
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (pos !== null && pos !== undefined) {
    if (typeof pos !== 'number') {
      const err = new TypeError(`The "position" argument must be of type number. Received ${typeof pos}`);
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    if (!Number.isInteger(pos) || pos < 0) {
      const err = new RangeError(`The value of "position" is out of range. It must be an integer >= 0. Received ${pos}`);
      err.code = 'ERR_OUT_OF_RANGE';
      throw err;
    }
  }
  if (buffers.length === 0) {
    return { bytesWritten: 0, buffers };
  }
  for (let i = 0; i < buffers.length; i++) {
    if (!Buffer.isBuffer(buffers[i]) && !(buffers[i] instanceof Uint8Array)) {
      const err = new TypeError(`buffers[${i}] must be a Buffer or Uint8Array.`);
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
  }

  const signal = opts?.signal;
  if (signal && signal.aborted) throw createAbortError(signal);

  const normalized = normalizePath(filePath);
  const openFlagsStr = opts?.flags || opts?.flag || 'w';
  const openFlags = parseWriteFlags(openFlagsStr);
  const fileMode = opts?.mode !== undefined ? opts?.mode : 0o666;
  const flush = Boolean(opts?.flush);

  const backend = selectExecutionBackend(opts);

  if (backend.type === 'provider') {
    if (typeof backend.provider.writev === 'function') {
      return await wrapWithAbortSignal(backend.provider.writev(normalized, buffers, pos, opts), signal);
    }
    if (backend.provider !== fsPromises && typeof backend.provider.open !== 'function') {
      const err = new Error('ERR_METHOD_NOT_IMPLEMENTED: Custom provider does not implement writev or open');
      err.code = 'ERR_METHOD_NOT_IMPLEMENTED';
      throw err;
    }
    const openFn = backend.provider.open.bind(backend.provider);
    const openPromise = openFn(normalized, openFlagsStr, fileMode);
    if (signal) {
      openPromise.then(
        (fh) => {
          if (signal.aborted && fh && typeof fh.close === 'function') {
            fh.close().catch(() => {});
          }
        },
        () => {}
      );
    }
    const fh = await wrapWithAbortSignal(openPromise, signal);
    try {
      let res;
      if (typeof fh.writev === 'function') {
        res = await wrapWithAbortSignal(fh.writev(buffers, pos), signal);
      } else {
        let totalBytes = 0;
        let currentPos = pos !== null && pos !== undefined && pos >= 0 ? pos : null;
        for (const b of buffers) {
          const { bytesWritten } = await wrapWithAbortSignal(fh.write(b, 0, b.length, currentPos), signal);
          totalBytes += bytesWritten;
          if (currentPos !== null) currentPos += bytesWritten;
        }
        res = { bytesWritten: totalBytes, buffers };
      }
      if (flush && typeof fh.sync === 'function') {
        await wrapWithAbortSignal(fh.sync(), signal);
      }
      return res;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  if (backend.type === 'worker') {
    const bytesWritten = await wrapWithAbortSignal(
      getWorkerPool().exec('writev', [normalized, buffers, pos, openFlags, fileMode, flush]),
      signal
    );
    return { bytesWritten, buffers };
  }

  const bytesWritten = await wrapWithAbortSignal(
    native.writev(normalized, buffers, pos !== null && pos !== undefined ? pos : -1, openFlags, fileMode, flush),
    signal
  );
  return { bytesWritten, buffers };
}

/**
 * Preallocates disk space for a file via io_uring fallocate.
 */
async function fallocate(filePath, offset, length, mode = 0, options = {}) {
  let fallocMode = mode;
  let opts = options;
  if (typeof fallocMode === 'object' && fallocMode !== null) {
    opts = fallocMode;
    fallocMode = 0;
  }
  if (typeof offset !== 'number') {
    const err = new TypeError(`The "offset" argument must be of type number. Received ${typeof offset}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (!Number.isInteger(offset) || offset < 0) {
    const err = new RangeError(`The value of "offset" is out of range. It must be an integer >= 0. Received ${offset}`);
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }
  if (typeof length !== 'number') {
    const err = new TypeError(`The "length" argument must be of type number. Received ${typeof length}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (!Number.isInteger(length) || length < 0) {
    const err = new RangeError(`The value of "length" is out of range. It must be an integer >= 0. Received ${length}`);
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }
  if (fallocMode !== undefined && fallocMode !== null) {
    if (typeof fallocMode !== 'number') {
      const err = new TypeError(`The "mode" argument must be of type number. Received ${typeof fallocMode}`);
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    if (!Number.isInteger(fallocMode) || fallocMode < 0) {
      const err = new RangeError(`The value of "mode" is out of range. Received ${fallocMode}`);
      err.code = 'ERR_OUT_OF_RANGE';
      throw err;
    }
  }

  const signal = opts?.signal;
  if (signal && signal.aborted) throw createAbortError(signal);

  const normalized = normalizePath(filePath);
  const backend = selectExecutionBackend(opts);

  if (backend.type === 'provider') {
    if (typeof backend.provider.fallocate === 'function') {
      return await wrapWithAbortSignal(backend.provider.fallocate(normalized, offset, length, fallocMode), signal);
    }
    if (backend.provider !== fsPromises && typeof backend.provider.open !== 'function') {
      const err = new Error('ERR_METHOD_NOT_IMPLEMENTED: Custom provider does not implement fallocate or open');
      err.code = 'ERR_METHOD_NOT_IMPLEMENTED';
      throw err;
    }
    const openFn = backend.provider.open.bind(backend.provider);
    const openWithGuard = (flag) => {
      const p = openFn(normalized, flag);
      if (signal) {
        p.then(
          (h) => {
            if (signal.aborted && h && typeof h.close === 'function') {
              h.close().catch(() => {});
            }
          },
          () => {}
        );
      }
      return wrapWithAbortSignal(p, signal);
    };
    let fh;
    try {
      fh = await openWithGuard('r+');
    } catch (e) {
      if (e.code === 'ENOENT') {
        fh = await openWithGuard('w+');
      } else {
        throw e;
      }
    }
    try {
      const st = await wrapWithAbortSignal(fh.stat(), signal);
      if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
        throw createErrnoError('EISDIR', 'fallocate', normalized);
      }
      if (offset + length > st.size && (fallocMode & FALLOC_FL_KEEP_SIZE) === 0) {
        await wrapWithAbortSignal(fh.truncate(offset + length), signal);
      }
      return;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  if (backend.type === 'worker') {
    await wrapWithAbortSignal(
      getWorkerPool().exec('fallocate', [normalized, offset, length, fallocMode]),
      signal
    );
    return;
  }

  await wrapWithAbortSignal(
    native.fallocate(normalized, offset, length, fallocMode),
    signal
  );
}

/**
 * Pre-declares access pattern hints for a file via io_uring fadvise (or POSIX fadvise).
 */
async function fadvise(filePath, offset, length, advice, options = {}) {
  let fadviseAdvice = advice;
  let opts = options;
  if (typeof fadviseAdvice === 'object' && fadviseAdvice !== null) {
    opts = fadviseAdvice;
    fadviseAdvice = POSIX_FADV_NORMAL;
  }
  if (typeof offset !== 'number') {
    const err = new TypeError(`The "offset" argument must be of type number. Received ${typeof offset}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (!Number.isInteger(offset) || offset < 0) {
    const err = new RangeError(`The value of "offset" is out of range. It must be an integer >= 0. Received ${offset}`);
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }
  if (typeof length !== 'number') {
    const err = new TypeError(`The "length" argument must be of type number. Received ${typeof length}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (!Number.isInteger(length) || length < 0) {
    const err = new RangeError(`The value of "length" is out of range. It must be an integer >= 0. Received ${length}`);
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }
  if (typeof fadviseAdvice !== 'number') {
    const err = new TypeError(`The "advice" argument must be of type number. Received ${typeof fadviseAdvice}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (!Number.isInteger(fadviseAdvice) || fadviseAdvice < 0) {
    const err = new RangeError(`The value of "advice" is out of range. Received ${fadviseAdvice}`);
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }

  const signal = opts?.signal;
  if (signal && signal.aborted) throw createAbortError(signal);

  const normalized = normalizePath(filePath);
  const backend = selectExecutionBackend(opts);

  if (backend.type === 'provider') {
    if (typeof backend.provider.fadvise === 'function') {
      return await wrapWithAbortSignal(backend.provider.fadvise(normalized, offset, length, fadviseAdvice), signal);
    }
    if (backend.provider !== fsPromises && typeof backend.provider.open !== 'function') {
      const err = new Error('ERR_METHOD_NOT_IMPLEMENTED: Custom provider does not implement fadvise or open');
      err.code = 'ERR_METHOD_NOT_IMPLEMENTED';
      throw err;
    }
    const openFn = backend.provider.open.bind(backend.provider);
    const fh = await wrapWithAbortSignal(openFn(normalized, 'r'), signal);
    try {
      return;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  if (backend.type === 'worker') {
    await wrapWithAbortSignal(
      getWorkerPool().exec('fadvise', [normalized, offset, length, fadviseAdvice]),
      signal
    );
    return;
  }

  await wrapWithAbortSignal(
    native.fadvise(normalized, offset, length, fadviseAdvice),
    signal
  );
}

/**
 * Opens a file and returns a persistent UringFileHandle with pinned descriptor.
 */
async function open(filePath, flags = 'r', mode = 0o666, options = {}) {
  let openFlagsStr = flags;
  let fileMode = mode;
  let opts = options;

  if (typeof openFlagsStr === 'object' && openFlagsStr !== null) {
    opts = openFlagsStr;
    openFlagsStr = opts.flags || opts.flag || 'r';
    fileMode = opts.mode !== undefined ? opts.mode : 0o666;
  } else if (typeof fileMode === 'object' && fileMode !== null) {
    opts = fileMode;
    fileMode = opts.mode !== undefined ? opts.mode : 0o666;
  }

  const numericOpenFlags = parseOpenFlags(openFlagsStr);
  const normalized = normalizePath(filePath);
  const signal = opts?.signal;
  if (signal && signal.aborted) throw createAbortError(signal);

  const backend = selectExecutionBackend(opts);

  if (backend.type === 'provider' || backend.type === 'worker') {
    if (backend.type === 'provider' && backend.provider !== fsPromises && typeof backend.provider.open !== 'function') {
      const err = new Error('ERR_METHOD_NOT_IMPLEMENTED: Custom provider does not implement open');
      err.code = 'ERR_METHOD_NOT_IMPLEMENTED';
      throw err;
    }
    const openFn = (backend.type === 'provider' && typeof backend.provider.open === 'function')
      ? backend.provider.open.bind(backend.provider)
      : fsPromises.open;
    const openPromise = openFn(normalized, openFlagsStr, fileMode);
    if (signal) {
      openPromise.then(
        (fh) => {
          if (signal.aborted && fh && typeof fh.close === 'function') {
            fh.close().catch(() => {});
          }
        },
        () => {}
      );
    }
    const nodeHandle = await wrapWithAbortSignal(openPromise, signal);
    return new UringFileHandle(backend.type, normalized, numericOpenFlags, fileMode, null, nodeHandle);
  }

  const openPromise = native.openHandle(normalized, numericOpenFlags, fileMode);
  if (signal) {
    openPromise.then(
      (desc) => {
        if (signal.aborted && desc) {
          native.fhClose(desc.fd, desc.directSlot).catch(() => {});
        }
      },
      () => {}
    );
  }
  const desc = await wrapWithAbortSignal(openPromise, signal);
  return new UringFileHandle('io_uring', normalized, numericOpenFlags, fileMode, desc, null);
}

const constants = Object.assign({}, fsConstants, {
  FALLOC_FL_KEEP_SIZE,
  FALLOC_FL_PUNCH_HOLE,
  FALLOC_FL_COLLAPSE_RANGE,
  FALLOC_FL_ZERO_RANGE,
  FALLOC_FL_INSERT_RANGE,
  FALLOC_FL_UNSHARE_RANGE,
  POSIX_FADV_NORMAL,
  POSIX_FADV_RANDOM,
  POSIX_FADV_SEQUENTIAL,
  POSIX_FADV_WILLNEED,
  POSIX_FADV_DONTNEED,
  POSIX_FADV_NOREUSE,
});

module.exports = {
  open,
  UringFileHandle,
  readBatchAt,
  readv,
  writev,
  fallocate,
  fadvise,
  FALLOC_FL_KEEP_SIZE,
  FALLOC_FL_PUNCH_HOLE,
  FALLOC_FL_COLLAPSE_RANGE,
  FALLOC_FL_ZERO_RANGE,
  FALLOC_FL_INSERT_RANGE,
  FALLOC_FL_UNSHARE_RANGE,
  POSIX_FADV_NORMAL,
  POSIX_FADV_RANDOM,
  POSIX_FADV_SEQUENTIAL,
  POSIX_FADV_WILLNEED,
  POSIX_FADV_DONTNEED,
  POSIX_FADV_NOREUSE,
  readFile,
  readAt,
  writeFile,
  appendFile,
  copyFile,
  stat,
  lstat,
  access,
  exists,
  unlink,
  rmdir,
  mkdir,
  rename,
  symlink,
  link,
  fsync,
  fdatasync,
  isUringSupported,
  getActiveBackend,
  getUnsupportedReason,
  getRingStats,
  configure,
  setOptimisticReadSize,
  closeFallbackWorkers,
  UringStats,
  constants,
  F_OK: fsConstants.F_OK,
  R_OK: fsConstants.R_OK,
  W_OK: fsConstants.W_OK,
  X_OK: fsConstants.X_OK,
  COPYFILE_EXCL: fsConstants.COPYFILE_EXCL,
};
