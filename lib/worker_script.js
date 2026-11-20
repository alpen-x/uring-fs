'use strict';

const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const { toByteView, createErrnoError } = require('./validators');

function serializeStats(st) {
  return {
    dev: st.dev,
    rdev: st.rdev,
    size: st.size,
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    ino: st.ino,
    nlink: st.nlink,
    blksize: st.blksize,
    blocks: st.blocks,
    atimeMs: st.atimeMs,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    birthtimeMs: st.birthtimeMs,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymbolicLink: st.isSymbolicLink(),
  };
}

function withReadFd(filePath, fn) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) {
      throw createErrnoError('EISDIR', 'read');
    }
    return fn(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readRangeSync(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  const bytesRead = fs.readSync(fd, buf, 0, length, offset);
  return bytesRead < length ? buf.subarray(0, bytesRead) : buf;
}

const OP_HANDLERS = {
  readFile(filePath, encoding) {
    return fs.readFileSync(filePath, encoding ? { encoding } : undefined);
  },

  readAt(filePath, offset, length) {
    return withReadFd(filePath, (fd) => readRangeSync(fd, offset, length));
  },

  writeFile(filePath, data, options) {
    if (options && options.flush) {
      const flag = options.flag ?? 'w';
      const mode = options.mode !== undefined ? options.mode : 0o666;
      const fd = fs.openSync(filePath, flag, mode);
      try {
        fs.writeFileSync(fd, data, options);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return;
    }
    fs.writeFileSync(filePath, data, options);
  },

  appendFile(filePath, data, options) {
    fs.appendFileSync(filePath, data, options);
  },

  stat(filePath) {
    return serializeStats(fs.statSync(filePath));
  },

  lstat(filePath) {
    return serializeStats(fs.lstatSync(filePath));
  },

  access(filePath, mode) {
    fs.accessSync(filePath, mode);
  },

  unlink(filePath) {
    fs.unlinkSync(filePath);
  },

  rmdir(dirPath, options) {
    fs.rmdirSync(dirPath, options);
  },

  mkdir(dirPath, options) {
    return fs.mkdirSync(dirPath, options);
  },

  copyFile(src, dest, mode) {
    fs.copyFileSync(src, dest, mode);
  },

  rename(oldPath, newPath) {
    fs.renameSync(oldPath, newPath);
  },

  symlink(target, linkPath, type) {
    fs.symlinkSync(target, linkPath, type);
  },

  link(existingPath, newPath) {
    fs.linkSync(existingPath, newPath);
  },

  fsync(filePath, datasyncOnly) {
    const fd = fs.openSync(filePath, 'r');
    try {
      if (datasyncOnly) {
        fs.fdatasyncSync(fd);
      } else {
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }
  },

  readBatchAt(filePath, ranges) {
    return withReadFd(filePath, (fd) =>
      ranges.map((r) => {
        const offset = Array.isArray(r) ? r[0] : r.offset;
        const length = Array.isArray(r) ? r[1] : r.length;
        return readRangeSync(fd, offset, length);
      })
    );
  },

  readv(filePath, buffers, position) {
    return withReadFd(filePath, (fd) => {
      let totalBytes = 0;
      let currentPos = position !== undefined && position !== null && position >= 0 ? position : 0;
      const readBuffers = [];
      for (let i = 0; i < buffers.length; i++) {
        const view = toByteView(buffers[i]);
        const n = fs.readSync(fd, view, 0, view.byteLength, currentPos);
        totalBytes += n;
        currentPos += n;
        readBuffers.push(view);
        if (n < view.byteLength) break;
      }
      return { bytesRead: totalBytes, buffers: readBuffers };
    });
  },

  writev(filePath, buffers, position, openFlags, mode, flush) {
    const flags = openFlags !== undefined && openFlags !== null ? openFlags : 'w';
    const fileMode = mode !== undefined && mode !== null ? mode : 0o666;
    const fd = fs.openSync(filePath, flags, fileMode);
    try {
      let totalBytes = 0;
      let currentPos = position !== undefined && position !== null && position >= 0 ? position : null;
      for (let i = 0; i < buffers.length; i++) {
        const view = toByteView(buffers[i]);
        const n = fs.writeSync(fd, view, 0, view.byteLength, currentPos);
        totalBytes += n;
        if (currentPos !== null) {
          currentPos += n;
        }
      }
      if (flush) {
        fs.fsyncSync(fd);
      }
      return totalBytes;
    } finally {
      fs.closeSync(fd);
    }
  },

  fallocate(filePath, offset, length, mode) {
    const fd = fs.openSync(filePath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o666);
    try {
      const st = fs.fstatSync(fd);
      const targetSize = offset + length;
      if ((mode & 0x01) === 0 && targetSize > st.size) {
        fs.ftruncateSync(fd, targetSize);
      }
    } finally {
      fs.closeSync(fd);
    }
  },

  fadvise(filePath) {
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY);
    fs.closeSync(fd);
  },
};

parentPort.on('message', (msg) => {
  const { id, op, args } = msg;
  try {
    if (!Object.hasOwn(OP_HANDLERS, op)) {
      throw new Error('Unknown worker operation: ' + op);
    }
    const result = OP_HANDLERS[op](...args);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        message: err.message,
        code: err.code,
        errno: err.errno,
        syscall: err.syscall,
        path: err.path,
        dest: err.dest,
      },
    });
  }
});
