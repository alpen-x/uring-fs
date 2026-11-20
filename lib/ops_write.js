'use strict';

const { COPYFILE_EXCL, FALLOC_FL_KEEP_SIZE, POSIX_FADV_NORMAL } = require('./constants');
const {
  normalizePath,
  validateEncoding,
  validateNonNegInt,
  validatePosition,
  validateBuffersArray,
  toByteView,
  parseWriteFlags,
  createAbortError,
  createErrnoError,
} = require('./validators');
const { executeBackendOp, withProviderHandle } = require('./backend');

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
  const normalized = normalizePath(filePath);

  await executeBackendOp({
    options,
    signal,
    callerFn: writeFile,
    onProvider: (provider) => provider.writeFile(normalized, data, { encoding, mode, flag, flush, signal }),
    onWorker: (pool) => pool.exec('writeFile', [normalized, data, { encoding, mode, flag, flush }]),
    onNative: (native) => {
      const numericFlags = parseWriteFlags(flag);
      let payload = data;
      if (typeof data === 'string' && encoding !== 'utf8' && encoding !== 'utf-8') {
        payload = Buffer.from(data, encoding);
      } else if (ArrayBuffer.isView(data)) {
        payload = toByteView(data);
      }
      return native.writeFile(normalized, payload, numericFlags, mode, flush);
    },
  });
}

async function appendFile(filePath, data, options) {
  const opts = typeof options === 'string'
    ? { encoding: options, flag: 'a' }
    : { flag: 'a', ...options };
  return await writeFile(filePath, data, opts);
}

async function copyFile(srcPath, destPath, options) {
  let mode = 0;
  let signal = undefined;
  if (typeof options === 'number') {
    mode = options;
  } else if (options && typeof options === 'object') {
    if (typeof options.mode === 'number') mode = options.mode;
    signal = options.signal;
  }

  const srcNormalized = normalizePath(srcPath);
  const destNormalized = normalizePath(destPath);
  const opts = typeof options === 'object' ? options : undefined;

  await executeBackendOp({
    options: opts,
    signal,
    callerFn: copyFile,
    onProvider: async (provider) => {
      if (typeof provider.copyFile === 'function') {
        return await provider.copyFile(srcNormalized, destNormalized, mode);
      }
      const content = await provider.readFile(srcNormalized);
      const flag = (mode & COPYFILE_EXCL) ? 'wx' : 'w';
      return await provider.writeFile(destNormalized, content, { flag });
    },
    onWorker: (pool) => pool.exec('copyFile', [srcNormalized, destNormalized, mode]),
    onNative: (native) => {
      const copyFlags = (mode & COPYFILE_EXCL) ? 1 : 0;
      return native.copyFile(srcNormalized, destNormalized, copyFlags);
    },
  });
}

async function writev(filePath, buffers, position = null, options = {}) {
  let pos = position;
  let opts = options;
  if (typeof pos === 'object' && pos !== null) {
    opts = pos;
    pos = null;
  }
  validateBuffersArray(buffers);
  pos = validatePosition(pos, 0);

  if (buffers.length === 0) {
    return { bytesWritten: 0, buffers };
  }

  const signal = opts?.signal;
  const normalized = normalizePath(filePath);
  const openFlagsStr = opts?.flags ?? opts?.flag ?? 'w';
  const openFlags = parseWriteFlags(openFlagsStr);
  const fileMode = opts?.mode !== undefined ? opts?.mode : 0o666;
  const flush = Boolean(opts?.flush);

  return await executeBackendOp({
    options: opts,
    signal,
    callerFn: writev,
    onProvider: async (provider) => {
      if (typeof provider.writev === 'function') {
        return await provider.writev(normalized, buffers, pos, opts);
      }
      return await withProviderHandle(provider, normalized, openFlagsStr, fileMode, signal, 'writev', async (fh) => {
        let res;
        if (typeof fh.writev === 'function') {
          res = await fh.writev(buffers, pos);
        } else {
          let totalBytes = 0;
          let currentPos = pos !== null && pos >= 0 ? pos : null;
          for (const b of buffers) {
            if (signal && signal.aborted) throw createAbortError(signal);
            const view = toByteView(b);
            const { bytesWritten } = await fh.write(view, 0, view.byteLength, currentPos);
            totalBytes += bytesWritten;
            if (currentPos !== null) currentPos += bytesWritten;
          }
          res = { bytesWritten: totalBytes, buffers };
        }
        if (flush && typeof fh.sync === 'function') {
          await fh.sync();
        }
        return res;
      });
    },
    onWorker: async (pool) => {
      const bytesWritten = await pool.exec('writev', [normalized, buffers, pos, openFlags, fileMode, flush]);
      return { bytesWritten, buffers };
    },
    onNative: async (native) => {
      const bytesWritten = await native.writev(
        normalized,
        buffers.map(toByteView),
        pos !== null ? pos : -1,
        openFlags,
        fileMode,
        flush
      );
      return { bytesWritten, buffers };
    },
  });
}

async function fallocate(filePath, offset, length, mode = 0, options = {}) {
  let fallocMode = mode;
  let opts = options;
  if (typeof fallocMode === 'object' && fallocMode !== null) {
    opts = fallocMode;
    fallocMode = 0;
  }
  validateNonNegInt(offset, 'offset');
  validateNonNegInt(length, 'length');
  if (fallocMode !== undefined && fallocMode !== null) {
    validateNonNegInt(fallocMode, 'mode');
  } else {
    fallocMode = 0;
  }

  const signal = opts?.signal;
  const normalized = normalizePath(filePath);

  await executeBackendOp({
    options: opts,
    signal,
    callerFn: fallocate,
    onProvider: async (provider) => {
      if (typeof provider.fallocate === 'function') {
        return await provider.fallocate(normalized, offset, length, fallocMode);
      }
      const runFallocate = async (fh) => {
        const st = await fh.stat();
        if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
          throw createErrnoError('EISDIR', 'fallocate', normalized);
        }
        if (offset + length > st.size && (fallocMode & FALLOC_FL_KEEP_SIZE) === 0) {
          await fh.truncate(offset + length);
        }
      };
      try {
        return await withProviderHandle(provider, normalized, 'r+', undefined, signal, 'fallocate', runFallocate);
      } catch (e) {
        if (e.code === 'ENOENT') {
          return await withProviderHandle(provider, normalized, 'w+', undefined, signal, 'fallocate', runFallocate);
        }
        throw e;
      }
    },
    onWorker: (pool) => pool.exec('fallocate', [normalized, offset, length, fallocMode]),
    onNative: (native) => native.fallocate(normalized, offset, length, fallocMode),
  });
}

async function fadvise(filePath, offset, length, advice, options = {}) {
  let fadviseAdvice = advice;
  let opts = options;
  if (typeof fadviseAdvice === 'object' && fadviseAdvice !== null) {
    opts = fadviseAdvice;
    fadviseAdvice = POSIX_FADV_NORMAL;
  }
  validateNonNegInt(offset, 'offset');
  validateNonNegInt(length, 'length');
  validateNonNegInt(fadviseAdvice, 'advice');

  const signal = opts?.signal;
  const normalized = normalizePath(filePath);

  await executeBackendOp({
    options: opts,
    signal,
    callerFn: fadvise,
    onProvider: (provider) => {
      if (typeof provider.fadvise === 'function') {
        return provider.fadvise(normalized, offset, length, fadviseAdvice);
      }
      return withProviderHandle(provider, normalized, 'r', undefined, signal, 'fadvise', async () => {});
    },
    onWorker: (pool) => pool.exec('fadvise', [normalized, offset, length, fadviseAdvice]),
    onNative: (native) => native.fadvise(normalized, offset, length, fadviseAdvice),
  });
}

module.exports = {
  writeFile,
  appendFile,
  copyFile,
  writev,
  fallocate,
  fadvise,
};
