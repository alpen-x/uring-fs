'use strict';

const fsPromises = require('node:fs/promises');
const {
  normalizePath,
  validateNonNegInt,
  validatePosition,
  validateBuffersArray,
  toByteView,
  parseEncodingAndSignal,
  parseOpenFlags,
  createAbortError,
  createErrnoError,
  createCallerRejectHandler,
  parseBatchRanges,
} = require('./validators');
const { MAX_IO_CHUNK, isNativeFastPath, getNative, executeBackendOp, withProviderHandle } = require('./backend');
const { stat } = require('./ops_meta');
const { UringFileHandle } = require('./file_handle');

const REJECT_READ_FILE = createCallerRejectHandler(readFile);

function readFile(filePath, options) {
  try {
    if (options === undefined && typeof filePath === 'string' && filePath.indexOf('\0') === -1 && isNativeFastPath()) {
      return getNative().readFile(filePath).catch(REJECT_READ_FILE);
    }
    const { encoding, signal } = parseEncodingAndSignal(options);
    let optimisticReadSize = undefined;
    if (options && typeof options === 'object' && options.optimisticReadSize !== undefined && options.optimisticReadSize !== null) {
      if (
        typeof options.optimisticReadSize !== 'number' ||
        !Number.isSafeInteger(options.optimisticReadSize) ||
        options.optimisticReadSize < 0
      ) {
        const err = new TypeError('The "optimisticReadSize" option must be a non-negative safe integer.');
        err.code = 'ERR_INVALID_ARG_VALUE';
        throw err;
      }
      optimisticReadSize = Math.min(options.optimisticReadSize, MAX_IO_CHUNK);
    }

    const normalized = normalizePath(filePath);
    const p = executeBackendOp({
      options,
      signal,
      callerFn: readFile,
      onProvider: (provider) =>
        provider.readFile(normalized, encoding ? { encoding, signal } : (signal ? { signal } : undefined)),
      onWorker: (pool) => pool.exec('readFile', [normalized, encoding], encoding),
      onNative: (native) =>
        optimisticReadSize !== undefined
          ? native.readFile(normalized, optimisticReadSize)
          : native.readFile(normalized),
    });

    if (!encoding) {
      return p;
    }
    return p.then((res) => (Buffer.isBuffer(res) ? res.toString(encoding) : res));
  } catch (err) {
    return Promise.reject(err);
  }
}

async function readAt(filePath, offset, length, options) {
  validateNonNegInt(offset, 'offset');
  validateNonNegInt(length, 'length');

  const { encoding, signal } = parseEncodingAndSignal(options);
  const normalized = normalizePath(filePath);
  const opts = typeof options === 'object' ? options : undefined;

  const res = await executeBackendOp({
    options: opts,
    signal,
    callerFn: readAt,
    onProvider: async (provider) => {
      if (typeof provider.open === 'function') {
        return await withProviderHandle(provider, normalized, 'r', undefined, signal, 'readAt', async (fh) => {
          if (length === 0) {
            if (typeof fh.stat === 'function') {
              const st = await fh.stat();
              if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
                throw createErrnoError('EISDIR', 'read', normalized);
              }
            }
            await fh.read(Buffer.alloc(1), 0, 0, offset);
            return Buffer.alloc(0);
          }
          const buf = Buffer.allocUnsafe(length);
          const { bytesRead } = await fh.read(buf, 0, length, offset);
          return bytesRead < length ? buf.subarray(0, bytesRead) : buf;
        });
      }
      const fullBuf = await provider.readFile(normalized);
      const rawBuf = Buffer.isBuffer(fullBuf) ? fullBuf : Buffer.from(String(fullBuf));
      return rawBuf.subarray(Math.min(offset, rawBuf.length), Math.min(offset + length, rawBuf.length));
    },
    onWorker: (pool) => pool.exec('readAt', [normalized, offset, length]),
    onNative: (native) => native.readAt(normalized, offset, length),
  });

  return encoding && Buffer.isBuffer(res) ? res.toString(encoding) : res;
}

async function readBatchAt(filePath, ranges, options = {}) {
  const { encoding, signal } = parseEncodingAndSignal(options);

  const normalizedRanges = parseBatchRanges(ranges);
  if (normalizedRanges.length === 0) {
    await readAt(filePath, 0, 0, options);
    return [];
  }

  const normalized = normalizePath(filePath);
  const opts = typeof options === 'object' ? options : undefined;
  let customBatchResult = false;

  const slices = await executeBackendOp({
    options: opts,
    signal,
    callerFn: readBatchAt,
    onProvider: async (provider) => {
      if (typeof provider.readBatchAt === 'function') {
        customBatchResult = true;
        return await provider.readBatchAt(normalized, normalizedRanges, options);
      }
      if (provider !== fsPromises && typeof provider.open !== 'function') {
        const fullBuf = await provider.readFile(normalized);
        const buf = Buffer.isBuffer(fullBuf) ? fullBuf : Buffer.from(fullBuf);
        return normalizedRanges.map(({ offset, length }) => buf.subarray(offset, offset + length));
      }
      return await withProviderHandle(provider, normalized, 'r', undefined, signal, 'readBatchAt', async (fh) => {
        if (normalizedRanges.some((r) => r.length === 0) && typeof fh.stat === 'function') {
          const st = await fh.stat();
          if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
            throw createErrnoError('EISDIR', 'read', normalized);
          }
        }
        const results = [];
        for (const { offset, length } of normalizedRanges) {
          if (signal && signal.aborted) throw createAbortError(signal);
          if (length === 0) {
            results.push(Buffer.alloc(0));
            continue;
          }
          const buf = Buffer.allocUnsafe(length);
          const { bytesRead } = await fh.read(buf, 0, length, offset);
          results.push(bytesRead < length ? buf.subarray(0, bytesRead) : buf);
        }
        return results;
      });
    },
    onWorker: (pool) => pool.exec('readBatchAt', [normalized, normalizedRanges]),
    onNative: (native) =>
      native.readBatchAt(
        normalized,
        normalizedRanges.map((r) => r.offset),
        normalizedRanges.map((r) => r.length)
      ),
  });

  if (customBatchResult || !encoding) {
    return slices;
  }
  return slices.map((b) => (Buffer.isBuffer(b) ? b.toString(encoding) : b));
}

async function readv(filePath, buffers, position = null, options = {}) {
  let pos = position;
  let opts = options;
  if (typeof pos === 'object' && pos !== null) {
    opts = pos;
    pos = null;
  }
  validateBuffersArray(buffers);
  pos = validatePosition(pos, 0);

  if (buffers.length === 0) {
    return { bytesRead: 0, buffers };
  }

  const signal = opts?.signal;
  const normalized = normalizePath(filePath);
  const totalBytesToRead = buffers.reduce((acc, b) => acc + b.byteLength, 0);

  return await executeBackendOp({
    options: opts,
    signal,
    callerFn: readv,
    onProvider: async (provider) => {
      if (typeof provider.readv === 'function') {
        return await provider.readv(normalized, buffers, pos);
      }
      return await withProviderHandle(provider, normalized, 'r', undefined, signal, 'readv', async (fh) => {
        if (totalBytesToRead === 0 && typeof fh.stat === 'function') {
          const st = await fh.stat();
          if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
            throw createErrnoError('EISDIR', 'read', normalized);
          }
        }
        if (typeof fh.readv === 'function') {
          return await fh.readv(buffers, pos);
        }
        let totalBytes = 0;
        let currentPos = pos !== null && pos >= 0 ? pos : null;
        for (const b of buffers) {
          if (signal && signal.aborted) throw createAbortError(signal);
          const view = toByteView(b);
          const { bytesRead } = await fh.read(view, 0, view.byteLength, currentPos);
          totalBytes += bytesRead;
          if (currentPos !== null) currentPos += bytesRead;
          if (bytesRead < view.byteLength) break;
        }
        return { bytesRead: totalBytes, buffers };
      });
    },
    onWorker: async (pool) => {
      const res = await pool.exec('readv', [normalized, buffers, pos]);
      if (res && res.buffers) {
        for (let i = 0; i < Math.min(buffers.length, res.buffers.length); i++) {
          const src = res.buffers[i];
          const dstView = toByteView(buffers[i]);
          Buffer.from(src.buffer, src.byteOffset, src.byteLength).copy(dstView);
        }
        return { bytesRead: res.bytesRead, buffers };
      }
      return { bytesRead: res, buffers };
    },
    onNative: async (native) => {
      if (totalBytesToRead === 0) {
        const st = await stat(normalized, opts);
        if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
          throw createErrnoError('EISDIR', 'read', normalized);
        }
      }
      const bytesRead = await native.readv(normalized, buffers.map(toByteView), pos !== null ? pos : -1);
      return { bytesRead, buffers };
    },
  });
}

function attachAbortCleanup(promise, signal, cleanupFn) {
  if (signal) {
    promise.then(
      (res) => {
        if (signal.aborted && res) {
          cleanupFn(res);
        }
      },
      () => {}
    );
  }
  return promise;
}

async function open(filePath, flags = 'r', mode = 0o666, options = {}) {
  let openFlagsStr = flags;
  let fileMode = mode;
  let opts = options;

  if (typeof openFlagsStr === 'object' && openFlagsStr !== null) {
    opts = openFlagsStr;
    openFlagsStr = opts.flags ?? opts.flag ?? 'r';
    fileMode = opts.mode !== undefined ? opts.mode : 0o666;
  } else if (typeof fileMode === 'object' && fileMode !== null) {
    opts = fileMode;
    fileMode = opts.mode !== undefined ? opts.mode : 0o666;
  }

  const numericOpenFlags = parseOpenFlags(openFlagsStr);
  const normalized = normalizePath(filePath);
  const signal = opts?.signal;

  const openFallbackHandle = async (backendType, openFn) => {
    const nodeHandle = await attachAbortCleanup(
      openFn(normalized, openFlagsStr, fileMode),
      signal,
      (fh) => {
        if (typeof fh.close === 'function') fh.close().catch(() => {});
      }
    );
    return new UringFileHandle(backendType, normalized, numericOpenFlags, fileMode, null, nodeHandle);
  };

  return await executeBackendOp({
    options: opts,
    signal,
    callerFn: open,
    onProvider: (provider) => {
      if (provider !== fsPromises && typeof provider.open !== 'function') {
        const err = new Error('ERR_METHOD_NOT_IMPLEMENTED: Custom provider does not implement open');
        err.code = 'ERR_METHOD_NOT_IMPLEMENTED';
        throw err;
      }
      const openFn = typeof provider.open === 'function'
        ? provider.open.bind(provider)
        : fsPromises.open;
      return openFallbackHandle('provider', openFn);
    },
    onWorker: () => openFallbackHandle('worker', fsPromises.open),
    onNative: async (native) => {
      const desc = await attachAbortCleanup(
        native.openHandle(normalized, numericOpenFlags, fileMode),
        signal,
        (d) => native.fhClose(d.fd, d.directSlot).catch(() => {})
      );
      return new UringFileHandle('io_uring', normalized, numericOpenFlags, fileMode, desc, null);
    },
  });
}

module.exports = {
  readFile,
  readAt,
  readBatchAt,
  readv,
  open,
};
