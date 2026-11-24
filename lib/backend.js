'use strict';

const fsPromises = require('node:fs/promises');
const pathModule = require('node:path');
const { detectLibc } = require('./libc');
const { DedicatedWorkerPool } = require('./worker_fallback');
const { validateAbortSignal, createAbortError, wrapWithAbortSignal } = require('./validators');

const ROOT_DIR = pathModule.join(__dirname, '..');
const MAX_IO_CHUNK = 0x7ffff000;

let native = null;
let loadError = null;

const candidates = [];
if (process.env.URING_FS_DISABLE_NATIVE === '1') {
  loadError = new Error('Native addon disabled via URING_FS_DISABLE_NATIVE=1');
} else if (process.env.URING_FS_DISABLE_NATIVE === 'stub') {
  native = {
    isSupported: () => false,
    getUnsupportedReason: () => 'Simulated addon_stub via URING_FS_DISABLE_NATIVE=stub',
    setOptimisticReadSize: (bytes) => Math.min(Math.max(0, Math.trunc(Number(bytes) || 0)), MAX_IO_CHUNK),
    probeDisallowedOpcode: () => ({ restricted: false, blockedSocketErrno: -38 }),
    setRestrictionsConfig: (enabled) => Boolean(enabled),
  };
} else {
  if (process.env.URING_FS_PREBUILD_ONLY !== '1') {
    candidates.push(pathModule.join(ROOT_DIR, 'build', 'Release', 'uring_fs.node'));
  }

  if (process.platform === 'linux' && process.env.URING_FS_IGNORE_PREBUILDS !== '1') {
    const libc = detectLibc();
    if (libc) {
      candidates.push(pathModule.join(ROOT_DIR, 'prebuilds', `linux-${process.arch}`, `uring_fs.${libc}.node`));
      candidates.push(`@alpenx/uring-fs-linux-${process.arch}-${libc}`);
      candidates.push(`@uring-fs/linux-${process.arch}-${libc}`);
    }
    candidates.push(pathModule.join(ROOT_DIR, 'prebuilds', `linux-${process.arch}`, 'uring_fs.node'));
    candidates.push(`@alpenx/uring-fs-linux-${process.arch}`);
    candidates.push(`@uring-fs/linux-${process.arch}`);
  }
}

for (const candidate of candidates) {
  try {
    native = require(candidate);
    loadError = null;
    break;
  } catch (err) {
    if (!loadError) {
      loadError = err;
    }
  }
}

const config = {
  fallback: 'fs', // 'fs' | 'worker' | CustomProvider | false | true
  forceFallback: false,
  workerPoolSize: 2,
  optimisticReadSize: 64 * 1024,
  restrictions: process.env.URING_FS_RESTRICTIONS !== '0',
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

function getNative() {
  return native;
}

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
 * @param {{ fallback?: 'fs' | 'worker' | boolean | object, forceFallback?: boolean, workerPoolSize?: number, optimisticReadSize?: number, restrictions?: boolean }} options
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
      workerPool.resize(nextPoolSize);
    }
  }

  if (
    typeof options.optimisticReadSize === 'number' &&
    Number.isSafeInteger(options.optimisticReadSize) &&
    options.optimisticReadSize >= 0
  ) {
    const size = Math.min(options.optimisticReadSize, MAX_IO_CHUNK);
    config.optimisticReadSize = size;
    if (native && typeof native.setOptimisticReadSize === 'function') {
      native.setOptimisticReadSize(size);
    }
  }

  if (options.restrictions !== undefined) {
    if (typeof options.restrictions !== 'boolean') {
      const err = new TypeError(
        `The "restrictions" option must be of type boolean. Received ${typeof options.restrictions}`
      );
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    config.restrictions = options.restrictions;
    if (native && typeof native.setRestrictionsConfig === 'function') {
      native.setRestrictionsConfig(options.restrictions);
    }
  }

  return {
    fallback: typeof config.fallback === 'object' ? 'custom' : config.fallback,
    forceFallback: config.forceFallback,
    workerPoolSize: config.workerPoolSize,
    optimisticReadSize: config.optimisticReadSize,
    restrictions: config.restrictions,
  };
}

/**
 * Sets the default optimistic read buffer size in bytes (default: 65536).
 * Setting to 0 disables optimistic read globally.
 * @param {number} bytes
 */
function setOptimisticReadSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
    const err = new TypeError('The "bytes" argument must be a non-negative safe integer.');
    err.code = 'ERR_INVALID_ARG_VALUE';
    throw err;
  }
  const size = Math.min(bytes, MAX_IO_CHUNK);
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
      restrictionsSupported: false,
      allowedOpcodesCount: 0,
      cqSize: 0,
      cqOverflows: 0,
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

/**
 * Probes whether the active io_uring instance enforces kernel opcode restrictions
 * by submitting a disallowed socket SQE (expected to fail with -EACCES / -13).
 * @returns {{ restricted: boolean, blockedSocketErrno: number }}
 */
function probeRingRestriction() {
  if (!isUringSupported() || !native || typeof native.probeDisallowedOpcode !== 'function') {
    return { restricted: false, blockedSocketErrno: -38 };
  }
  return native.probeDisallowedOpcode();
}

/**
 * Returns a concise summary of the current io_uring backend, kernel hardening, and ring sizing.
 */
function getRingStatus() {
  const ringStats = getRingStats();
  return {
    activeBackend: ringStats.activeBackend,
    isUringSupported: isUringSupported(),
    fallbackReason: getUnsupportedReason(),
    restrictionsSupported: ringStats.restrictionsSupported,
    allowedOpcodesCount: ringStats.allowedOpcodesCount,
    queueDepth: ringStats.queueDepth,
    cqSize: ringStats.cqSize,
    optimisticReadSize: ringStats.optimisticReadSize,
  };
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

/**
 * Executes an operation through the selected backend strategy (provider, worker, or io_uring),
 * centralizing AbortSignal validation, pre-abort short-circuiting, and caller stack capture.
 */
function executeBackendOp({ options, signal, callerFn, onProvider, onWorker, onNative }) {
  try {
    validateAbortSignal(signal);
    if (signal && signal.aborted) {
      throw createAbortError(signal);
    }

    const backend = selectExecutionBackend(options);
    let opPromise;
    if (backend.type === 'provider') {
      opPromise = onProvider(backend.provider);
    } else if (backend.type === 'worker') {
      opPromise = onWorker(getWorkerPool());
    } else {
      opPromise = onNative(getNative());
    }

    return wrapWithAbortSignal(opPromise, signal, callerFn || executeBackendOp);
  } catch (err) {
    return Promise.reject(err);
  }
}

async function withProviderHandle(provider, filePath, flags, mode, signal, methodName, fn) {
  if (typeof provider.open !== 'function') {
    const err = new Error(`ERR_METHOD_NOT_IMPLEMENTED: Custom provider does not implement ${methodName} or open`);
    err.code = 'ERR_METHOD_NOT_IMPLEMENTED';
    throw err;
  }
  const openPromise = mode !== undefined
    ? provider.open(filePath, flags, mode)
    : provider.open(filePath, flags);
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
    return await wrapWithAbortSignal(Promise.resolve().then(() => fn(fh)), signal);
  } finally {
    if (fh && typeof fh.close === 'function') {
      await fh.close().catch(() => {});
    }
  }
}

module.exports = {
  MAX_IO_CHUNK,
  config,
  getNative,
  getWorkerPool,
  resolveCustomProvider,
  configure,
  setOptimisticReadSize,
  closeFallbackWorkers,
  isUringSupported,
  getActiveBackend,
  getUnsupportedReason,
  getRingStats,
  probeRingRestriction,
  getRingStatus,
  selectExecutionBackend,
  executeBackendOp,
  withProviderHandle,
};
