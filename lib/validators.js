'use strict';

const fsConstants = require('node:fs').constants;
const { fileURLToPath } = require('node:url');

function createTypedError(ErrorCtor, message, code) {
  const err = new ErrorCtor(message);
  err.code = code;
  return err;
}

/**
 * Normalizes a PathLike value (string | Buffer | URL) and guards against CWE-158 null bytes.
 */
function normalizePath(p) {
  let result;
  if (typeof p === 'string') {
    result = p;
  } else if (Buffer.isBuffer(p)) {
    result = p.toString('utf8');
  } else if (p instanceof URL) {
    result = fileURLToPath(p);
  } else {
    throw createTypedError(TypeError, 'The "path" argument must be of type string, Buffer, or URL.', 'ERR_INVALID_ARG_TYPE');
  }
  if (result.indexOf('\0') !== -1) {
    throw createTypedError(
      TypeError,
      `The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ${JSON.stringify(result)}`,
      'ERR_INVALID_ARG_VALUE'
    );
  }
  return result;
}

function validateEncoding(encoding) {
  if (encoding !== null && encoding !== undefined) {
    if (typeof encoding !== 'string' || !Buffer.isEncoding(encoding)) {
      throw createTypedError(TypeError, `The argument 'encoding' is invalid encoding. Received '${encoding}'`, 'ERR_INVALID_ARG_VALUE');
    }
  }
}

function validateNonNegInt(val, name) {
  if (typeof val !== 'number') {
    throw createTypedError(TypeError, `The "${name}" argument must be of type number. Received ${typeof val}`, 'ERR_INVALID_ARG_TYPE');
  }
  if (!Number.isSafeInteger(val) || val < 0) {
    throw createTypedError(RangeError, `The value of "${name}" is out of range. It must be an integer >= 0. Received ${val}`, 'ERR_OUT_OF_RANGE');
  }
  return val;
}

function validatePosition(pos, min = -1) {
  if (pos === undefined || pos === null) {
    return min < 0 ? -1 : null;
  }
  if (typeof pos !== 'number') {
    throw createTypedError(TypeError, `The "position" argument must be of type number. Received ${typeof pos}`, 'ERR_INVALID_ARG_TYPE');
  }
  if (!Number.isSafeInteger(pos) || pos < min) {
    throw createTypedError(RangeError, `The value of "position" is out of range. It must be an integer >= ${min}. Received ${pos}`, 'ERR_OUT_OF_RANGE');
  }
  return pos;
}

function validateBufferOrView(buf, name = 'buffer') {
  if (!ArrayBuffer.isView(buf)) {
    throw createTypedError(TypeError, `The "${name}" argument must be an instance of Buffer, TypedArray, or DataView.`, 'ERR_INVALID_ARG_TYPE');
  }
}

/**
 * Returns a zero-copy Buffer view over any ArrayBufferView (Buffer, TypedArray, or DataView).
 */
function toByteView(view) {
  if (Buffer.isBuffer(view)) {
    return view;
  }
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function validateBufferSliceArgs(buffer, offset, length, position) {
  const bufOffset = (offset !== undefined && offset !== null)
    ? validateNonNegInt(offset, 'offset')
    : 0;
  const sliceLen = (length !== undefined && length !== null)
    ? validateNonNegInt(length, 'length')
    : (buffer.byteLength - bufOffset);

  if (bufOffset > buffer.byteLength || sliceLen > buffer.byteLength - bufOffset) {
    throw createTypedError(RangeError, 'The value of "offset" and "length" is out of range.', 'ERR_OUT_OF_RANGE');
  }

  const pos = validatePosition(position, -1);
  return { offset: bufOffset, length: sliceLen, position: pos };
}

function validateAbortSignal(signal) {
  if (signal !== undefined && signal !== null) {
    if (
      typeof signal !== 'object' ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function'
    ) {
      throw createTypedError(TypeError, 'The "signal" argument must be an instance of AbortSignal.', 'ERR_INVALID_ARG_TYPE');
    }
  }
}

function parseEncodingAndSignal(options) {
  let encoding = null;
  let signal = undefined;
  if (typeof options === 'string') {
    encoding = options;
  } else if (options && typeof options === 'object') {
    encoding = options.encoding ?? null;
    signal = options.signal;
  }
  validateEncoding(encoding);
  validateAbortSignal(signal);
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }
  return { encoding, signal };
}

function validateBuffersArray(buffers) {
  if (!Array.isArray(buffers)) {
    throw createTypedError(TypeError, 'The "buffers" argument must be an Array.', 'ERR_INVALID_ARG_TYPE');
  }
  for (let i = 0; i < buffers.length; i++) {
    if (!ArrayBuffer.isView(buffers[i])) {
      throw createTypedError(TypeError, `buffers[${i}] must be a Buffer, TypedArray, or DataView.`, 'ERR_INVALID_ARG_TYPE');
    }
  }
}

const WRITE_FLAG_MAP = {
  w: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
  wt: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
  wx: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_EXCL,
  xw: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_EXCL,
  'w+': fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC,
  'wx+': fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_EXCL,
  'xw+': fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_EXCL,
  a: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
  at: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
  ax: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_EXCL,
  xa: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_EXCL,
  'a+': fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND,
  'ax+': fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_EXCL,
  'xa+': fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_EXCL,
  as: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_SYNC,
  'as+': fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_SYNC,
  'r+': fsConstants.O_RDWR,
  'rs+': fsConstants.O_RDWR | fsConstants.O_SYNC,
  'sr+': fsConstants.O_RDWR | fsConstants.O_SYNC,
};

const OPEN_FLAG_MAP = {
  r: fsConstants.O_RDONLY,
  rs: fsConstants.O_RDONLY | fsConstants.O_SYNC,
  sr: fsConstants.O_RDONLY | fsConstants.O_SYNC,
};

function parseWriteFlags(flag = 'w') {
  if (typeof flag === 'number') {
    return flag;
  }
  if (Object.hasOwn(WRITE_FLAG_MAP, flag)) {
    return WRITE_FLAG_MAP[flag];
  }
  throw createTypedError(TypeError, `Unknown file open flag: ${flag}`, 'ERR_INVALID_OPT_VALUE');
}

function parseOpenFlags(flag = 'r') {
  if (typeof flag === 'number') {
    return flag;
  }
  if (typeof flag !== 'string') {
    throw createTypedError(TypeError, `The "flags" argument must be of type string or number. Received ${typeof flag}`, 'ERR_INVALID_ARG_TYPE');
  }
  if (Object.hasOwn(OPEN_FLAG_MAP, flag)) {
    return OPEN_FLAG_MAP[flag];
  }
  return parseWriteFlags(flag);
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

const ERRNO_MAP = {
  ENOENT: { errno: -2, label: 'no such file or directory' },
  EBADF: { errno: -9, label: 'bad file descriptor' },
  EISDIR: { errno: -21, label: 'illegal operation on a directory' },
};

function createErrnoError(code, syscall, path) {
  const info = ERRNO_MAP[code] || ERRNO_MAP.EISDIR;
  let msg = `${code}: ${info.label}, ${syscall}`;
  if (path) {
    msg += ` '${path}'`;
  }
  const err = new Error(msg);
  err.code = code;
  err.errno = info.errno;
  err.syscall = syscall;
  if (path) {
    err.path = path;
  }
  return err;
}

/**
 * Attaches caller JS stack frames to stackless native C++ rejections.
 */
function attachCallerStack(err, callerFn = attachCallerStack) {
  if (err && typeof err === 'object' && typeof err.stack === 'string' && !err.stack.includes('\n    at ')) {
    const holder = { name: err.name, message: err.message };
    Error.captureStackTrace(holder, callerFn);
    if (!holder.stack.includes('\n    at ')) {
      Error.captureStackTrace(holder, attachCallerStack);
    }
    err.stack = holder.stack;
  }
  return err;
}

function wrapWithAbortSignal(promise, signal, callerFn = wrapWithAbortSignal) {
  try {
    validateAbortSignal(signal);
    if (signal && signal.aborted) {
      throw createAbortError(signal);
    }
  } catch (err) {
    return Promise.reject(attachCallerStack(err, callerFn));
  }

  const basePromise = Promise.resolve(promise);
  if (!signal) {
    return basePromise.catch((err) => {
      throw attachCallerStack(err, callerFn);
    });
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(attachCallerStack(createAbortError(signal), callerFn));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    basePromise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(attachCallerStack(err, callerFn));
      }
    );
  });
}

function validateBatchInt(val, field, idx) {
  if (typeof val !== 'number') {
    throw createTypedError(TypeError, `The "${field}" at index ${idx} must be of type number. Received ${typeof val}`, 'ERR_INVALID_ARG_TYPE');
  }
  if (!Number.isSafeInteger(val) || val < 0) {
    throw createTypedError(RangeError, `The "${field}" at index ${idx} must be an integer >= 0. Received ${val}`, 'ERR_OUT_OF_RANGE');
  }
  return val;
}

function parseBatchRanges(ranges) {
  if (!Array.isArray(ranges)) {
    throw createTypedError(TypeError, 'The "ranges" argument must be an Array.', 'ERR_INVALID_ARG_TYPE');
  }
  return ranges.map((r, idx) => {
    let offset;
    let length;
    if (Array.isArray(r)) {
      [offset, length] = r;
    } else if (r && typeof r === 'object') {
      offset = r.offset;
      length = r.length;
    } else {
      throw createTypedError(TypeError, `Invalid range at index ${idx}`, 'ERR_INVALID_ARG_TYPE');
    }
    return {
      offset: validateBatchInt(offset, 'offset', idx),
      length: validateBatchInt(length, 'length', idx),
    };
  });
}

module.exports = {
  normalizePath,
  validateEncoding,
  validateNonNegInt,
  validatePosition,
  validateAbortSignal,
  validateBufferOrView,
  validateBuffersArray,
  toByteView,
  validateBufferSliceArgs,
  parseEncodingAndSignal,
  parseWriteFlags,
  parseOpenFlags,
  createAbortError,
  createErrnoError,
  attachCallerStack,
  wrapWithAbortSignal,
  parseBatchRanges,
};
