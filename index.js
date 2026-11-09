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
  if (typeof offset !== 'number' || !Number.isFinite(offset) || !Number.isInteger(offset) || offset < 0) {
    const err = new RangeError(`The "offset" argument must be a non-negative integer. Received ${offset}`);
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }
  if (typeof length !== 'number' || !Number.isFinite(length) || !Number.isInteger(length) || length < 0) {
    const err = new RangeError(`The "length" argument must be a non-negative integer. Received ${length}`);
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

  if (length === 0) {
    return encoding ? '' : Buffer.alloc(0);
  }

  const backend = selectExecutionBackend(typeof options === 'object' ? options : undefined);

  if (backend.type === 'provider') {
    if (typeof backend.provider.open === 'function') {
      const fh = await wrapWithAbortSignal(backend.provider.open(normalized, 'r'), signal);
      try {
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await wrapWithAbortSignal(fh.read(buf, 0, length, offset), signal);
        const resultBuf = bytesRead < length ? buf.subarray(0, bytesRead) : buf;
        return encoding ? resultBuf.toString(encoding) : resultBuf;
      } finally {
        await fh.close();
      }
    }
    const fullBuf = await wrapWithAbortSignal(backend.provider.readFile(normalized), signal);
    const start = Math.min(offset, fullBuf.length);
    const end = Math.min(offset + length, fullBuf.length);
    const slice = fullBuf.subarray(start, end);
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
    return wrapWithAbortSignal(backend.provider.rmdir(normalized, options), signal);
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
async function symlink(target, linkPath, typeOrOptions) {
  const type = typeof typeOrOptions === 'string' ? typeOrOptions : undefined;
  const options = typeof typeOrOptions === 'object' && typeOrOptions !== null ? typeOrOptions : undefined;
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
    const fh = await wrapWithAbortSignal(fsPromises.open(normalized, 'r'), signal);
    try {
      await wrapWithAbortSignal(fh.sync(), signal);
    } finally {
      await fh.close();
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
    const fh = await wrapWithAbortSignal(fsPromises.open(normalized, 'r'), signal);
    try {
      await wrapWithAbortSignal(fh.datasync(), signal);
    } finally {
      await fh.close();
    }
    return;
  }

  if (backend.type === 'worker') {
    await wrapWithAbortSignal(getWorkerPool().exec('fsync', [normalized, true]), signal);
    return;
  }

  await wrapWithAbortSignal(native.fsync(normalized, true), signal);
}

module.exports = {
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
  constants: fsConstants,
  F_OK: fsConstants.F_OK,
  R_OK: fsConstants.R_OK,
  W_OK: fsConstants.W_OK,
  X_OK: fsConstants.X_OK,
  COPYFILE_EXCL: fsConstants.COPYFILE_EXCL,
};
