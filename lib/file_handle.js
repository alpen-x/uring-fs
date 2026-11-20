'use strict';

const { FALLOC_FL_KEEP_SIZE } = require('./constants');
const { UringStats } = require('./stats');
const {
  validateNonNegInt,
  validatePosition,
  validateBufferOrView,
  validateBuffersArray,
  toByteView,
  validateBufferSliceArgs,
  parseEncodingAndSignal,
  validateAbortSignal,
  createAbortError,
  createErrnoError,
  wrapWithAbortSignal,
  parseBatchRanges,
} = require('./validators');
const { getNative } = require('./backend');
const { stat } = require('./ops_meta');

/**
 * Persistent file handle backed by io_uring direct descriptors or Node FileHandle fallback.
 */
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
    if (this.#closed) return -1;
    if (this.#backend === 'io_uring') return this.#fd;
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
      throw createErrnoError('EBADF', 'filehandle');
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

  /**
   * Template Method: guards open state, validates AbortSignal, tracks active op lifecycle,
   * and drains pending operations before handle close completes.
   */
  async #withActiveOp(signal, fn) {
    this.#ensureOpen();
    validateAbortSignal(signal);
    if (signal && signal.aborted) {
      throw createAbortError(signal);
    }
    this.#beginOp();
    try {
      return await fn();
    } finally {
      this.#endOp();
    }
  }

  /**
   * Adapter / Bridge: routes handle I/O to either native io_uring or #nodeHandle
   * with uniform AbortSignal wrapping and caller stack attachment.
   */
  async #execHandleBackend(signal, callerFn, nativeFn, nodeFn) {
    const rawPromise = this.#backend === 'io_uring'
      ? nativeFn(getNative(), this.#fd, this.#directSlot)
      : nodeFn(this.#nodeHandle);
    return await wrapWithAbortSignal(Promise.resolve(rawPromise), signal, callerFn);
  }

  async #dispatchHandleOp(signal, callerFn, nativeFn, nodeFn) {
    return await this.#withActiveOp(signal, () =>
      this.#execHandleBackend(signal, callerFn, nativeFn, nodeFn)
    );
  }

  async #readAtCore(offset, length, encoding, signal, callerFn) {
    if (length === 0) return encoding ? '' : Buffer.alloc(0);

    if (this.#backend === 'io_uring') {
      const buf = await this.#execHandleBackend(
        signal,
        callerFn,
        (n, fd, slot) => n.fhReadAt(fd, slot, offset, length),
        null
      );
      return encoding ? buf.toString(encoding) : buf;
    }

    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.#execHandleBackend(
      signal,
      callerFn,
      null,
      (nh) => nh.read(buf, 0, length, offset)
    );
    const res = bytesRead < length ? buf.subarray(0, bytesRead) : buf;
    return encoding ? res.toString(encoding) : res;
  }

  async #writeCore(buffer, offsetOrPosition, lengthOrEncoding, position, callerFn) {
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
        pos = validatePosition(offsetOrPosition, 0);
      }
      data = Buffer.from(data, encoding);
      offset = 0;
      length = data.length;
    } else {
      validateBufferOrView(data, 'buffer');
      ({ offset, length, position: pos } = validateBufferSliceArgs(
        callerBuffer,
        offsetOrPosition,
        lengthOrEncoding,
        position
      ));
    }

    const res = await this.#execHandleBackend(
      undefined,
      callerFn,
      (n, fd, slot) => n.fhWrite(fd, slot, toByteView(data), offset, length, pos, this.#flags),
      (nh) => nh.write(data, offset, length, pos < 0 ? null : pos)
    );
    const bytesWritten = typeof res === 'number' ? res : res.bytesWritten;
    return { bytesWritten, buffer: callerBuffer };
  }

  async read(buffer, offset, length, position) {
    return await this.#withActiveOp(undefined, async () => {
      let callerBuffer = buffer;
      let targetBuf = buffer;
      let bufOffset = offset;
      let readLen = length;
      let pos = position;

      if (targetBuf && typeof targetBuf === 'object' && !ArrayBuffer.isView(targetBuf)) {
        bufOffset = targetBuf.offset;
        readLen = targetBuf.length;
        pos = targetBuf.position;
        targetBuf = targetBuf.buffer;
        callerBuffer = targetBuf;
      }

      if (!targetBuf) {
        targetBuf = Buffer.alloc(16384);
        callerBuffer = targetBuf;
      } else {
        validateBufferOrView(targetBuf, 'buffer');
      }

      ({ offset: bufOffset, length: readLen, position: pos } = validateBufferSliceArgs(
        callerBuffer,
        bufOffset,
        readLen,
        pos
      ));

      const res = await this.#execHandleBackend(
        undefined,
        this.read,
        (n, fd, slot) => n.fhRead(fd, slot, toByteView(targetBuf), bufOffset, readLen, pos),
        (nh) => nh.read(targetBuf, bufOffset, readLen, pos < 0 ? null : pos)
      );
      const bytesRead = typeof res === 'number' ? res : res.bytesRead;
      return { bytesRead, buffer: callerBuffer };
    });
  }

  async readAt(offset, length, options) {
    const signal = options && typeof options === 'object' ? options.signal : undefined;
    return await this.#withActiveOp(signal, async () => {
      validateNonNegInt(offset, 'offset');
      validateNonNegInt(length, 'length');
      const { encoding } = parseEncodingAndSignal(options);
      return await this.#readAtCore(offset, length, encoding, signal, this.readAt);
    });
  }

  async readBatchAt(ranges, options = {}) {
    const signal = options && typeof options === 'object' ? options.signal : undefined;
    return await this.#withActiveOp(signal, async () => {
      const { encoding } = parseEncodingAndSignal(options);
      const parsed = parseBatchRanges(ranges);
      if (parsed.length === 0) {
        return [];
      }
      if (this.#backend === 'io_uring' || this.#backend === 'worker') {
        return await Promise.all(
          parsed.map(({ offset, length }) => this.#readAtCore(offset, length, encoding, signal, this.readBatchAt))
        );
      }
      const results = [];
      for (const { offset, length } of parsed) {
        if (signal && signal.aborted) throw createAbortError(signal);
        results.push(await this.#readAtCore(offset, length, encoding, signal, this.readBatchAt));
      }
      return results;
    });
  }

  async write(buffer, offsetOrPosition, lengthOrEncoding, position) {
    return await this.#withActiveOp(undefined, () =>
      this.#writeCore(buffer, offsetOrPosition, lengthOrEncoding, position, this.write)
    );
  }

  async writeAt(buffer, position) {
    return await this.#withActiveOp(undefined, async () => {
      const data = typeof buffer === 'string' ? Buffer.from(buffer, 'utf8') : buffer;
      const res = await this.#writeCore(data, 0, data.byteLength, position, this.writeAt);
      return res.bytesWritten;
    });
  }

  async readv(buffers, position = null) {
    return await this.#withActiveOp(undefined, async () => {
      validateBuffersArray(buffers);
      const pos = validatePosition(position, 0) ?? -1;
      if (buffers.length === 0) {
        return { bytesRead: 0, buffers };
      }
      if (buffers.every((b) => b.byteLength === 0)) {
        const st = this.#backend === 'io_uring'
          ? await stat(this.#path)
          : (typeof this.#nodeHandle.stat === 'function' ? await this.#nodeHandle.stat() : null);
        if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
          throw createErrnoError('EISDIR', 'read', this.#path);
        }
      }

      if (this.#backend === 'io_uring') {
        const nativeViews = buffers.map(toByteView);
        const bytesRead = await this.#execHandleBackend(
          undefined,
          this.readv,
          (n, fd, slot) => n.fhReadv(fd, slot, nativeViews, pos),
          null
        );
        return { bytesRead, buffers };
      }

      if (typeof this.#nodeHandle.readv === 'function') {
        return await this.#nodeHandle.readv(buffers, pos < 0 ? null : pos);
      }

      let totalBytes = 0;
      let currentPos = pos >= 0 ? pos : null;
      for (const b of buffers) {
        const view = toByteView(b);
        const { bytesRead } = await this.#nodeHandle.read(view, 0, view.byteLength, currentPos);
        totalBytes += bytesRead;
        if (currentPos !== null) currentPos += bytesRead;
        if (bytesRead < view.byteLength) break;
      }
      return { bytesRead: totalBytes, buffers };
    });
  }

  async writev(buffers, position = null) {
    return await this.#withActiveOp(undefined, async () => {
      validateBuffersArray(buffers);
      const pos = validatePosition(position, 0) ?? -1;
      if (buffers.length === 0) {
        return { bytesWritten: 0, buffers };
      }

      if (this.#backend === 'io_uring') {
        const nativeViews = buffers.map(toByteView);
        const bytesWritten = await this.#execHandleBackend(
          undefined,
          this.writev,
          (n, fd, slot) => n.fhWritev(fd, slot, nativeViews, pos, this.#flags),
          null
        );
        return { bytesWritten, buffers };
      }

      if (typeof this.#nodeHandle.writev === 'function') {
        return await this.#nodeHandle.writev(buffers, pos < 0 ? null : pos);
      }

      let totalBytes = 0;
      let currentPos = pos >= 0 ? pos : null;
      for (const b of buffers) {
        const view = toByteView(b);
        const { bytesWritten } = await this.#nodeHandle.write(view, 0, view.byteLength, currentPos);
        totalBytes += bytesWritten;
        if (currentPos !== null) currentPos += bytesWritten;
      }
      return { bytesWritten: totalBytes, buffers };
    });
  }

  async sync() {
    await this.#dispatchHandleOp(
      undefined,
      this.sync,
      (n, fd, slot) => n.fhSync(fd, slot, false),
      (nh) => nh.sync()
    );
  }

  async datasync() {
    await this.#dispatchHandleOp(
      undefined,
      this.datasync,
      (n, fd, slot) => n.fhSync(fd, slot, true),
      (nh) => nh.datasync()
    );
  }

  async fallocate(offset, length, mode = 0) {
    return await this.#withActiveOp(undefined, async () => {
      validateNonNegInt(offset, 'offset');
      validateNonNegInt(length, 'length');
      const fallocMode = (mode !== undefined && mode !== null) ? validateNonNegInt(mode, 'mode') : 0;

      await this.#execHandleBackend(
        undefined,
        this.fallocate,
        (n, fd, slot) => n.fhFallocate(fd, slot, fallocMode, offset, length),
        async (nh) => {
          const st = await nh.stat();
          if (offset + length > st.size && (fallocMode & FALLOC_FL_KEEP_SIZE) === 0) {
            await nh.truncate(offset + length);
          }
        }
      );
    });
  }

  async fadvise(offset, length, advice) {
    return await this.#withActiveOp(undefined, async () => {
      validateNonNegInt(offset, 'offset');
      validateNonNegInt(length, 'length');
      validateNonNegInt(advice, 'advice');

      await this.#execHandleBackend(
        undefined,
        this.fadvise,
        (n, fd, slot) => n.fhFadvise(fd, slot, offset, length, advice),
        () => Promise.resolve()
      );
    });
  }

  async stat(options) {
    const signal = options && typeof options === 'object' ? options.signal : undefined;
    return await this.#dispatchHandleOp(
      signal,
      this.stat,
      () => stat(this.#path, options),
      async (nh) => {
        const st = await nh.stat(options);
        return (st instanceof UringStats) ? st : new UringStats(st);
      }
    );
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
        await wrapWithAbortSignal(getNative().fhClose(this.#fd, this.#directSlot), undefined, this.close);
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

module.exports = {
  UringFileHandle,
};
