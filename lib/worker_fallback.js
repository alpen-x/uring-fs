'use strict';

const { Worker } = require('node:worker_threads');

const WORKER_SCRIPT = `
'use strict';
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');

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

parentPort.on('message', (msg) => {
  const { id, op, args } = msg;
  try {
    let result = undefined;
    switch (op) {
      case 'readFile': {
        const [filePath, encoding] = args;
        result = fs.readFileSync(filePath, encoding ? { encoding } : undefined);
        break;
      }
      case 'readAt': {
        const [filePath, offset, length] = args;
        const fd = fs.openSync(filePath, 'r');
        try {
          const st = fs.fstatSync(fd);
          if (st.isDirectory()) {
            const err = new Error('EISDIR: illegal operation on a directory, read');
            err.code = 'EISDIR';
            err.errno = -21;
            err.syscall = 'read';
            throw err;
          }
          const buf = Buffer.allocUnsafe(length);
          const bytesRead = fs.readSync(fd, buf, 0, length, offset);
          result = bytesRead < length ? buf.subarray(0, bytesRead) : buf;
        } finally {
          fs.closeSync(fd);
        }
        break;
      }
      case 'writeFile': {
        const [filePath, data, options] = args;
        fs.writeFileSync(filePath, data, options);
        break;
      }
      case 'appendFile': {
        const [filePath, data, options] = args;
        fs.appendFileSync(filePath, data, options);
        break;
      }
      case 'stat': {
        const [filePath] = args;
        result = serializeStats(fs.statSync(filePath));
        break;
      }
      case 'lstat': {
        const [filePath] = args;
        result = serializeStats(fs.lstatSync(filePath));
        break;
      }
      case 'access': {
        const [filePath, mode] = args;
        fs.accessSync(filePath, mode);
        break;
      }
      case 'unlink': {
        const [filePath] = args;
        fs.unlinkSync(filePath);
        break;
      }
      case 'rmdir': {
        const [dirPath, options] = args;
        fs.rmdirSync(dirPath, options);
        break;
      }
      case 'mkdir': {
        const [dirPath, options] = args;
        result = fs.mkdirSync(dirPath, options);
        break;
      }
      case 'copyFile': {
        const [src, dest, mode] = args;
        fs.copyFileSync(src, dest, mode);
        break;
      }
      case 'rename': {
        const [oldPath, newPath] = args;
        fs.renameSync(oldPath, newPath);
        break;
      }
      case 'symlink': {
        const [target, linkPath, type] = args;
        fs.symlinkSync(target, linkPath, type);
        break;
      }
      case 'link': {
        const [existingPath, newPath] = args;
        fs.linkSync(existingPath, newPath);
        break;
      }
      case 'fsync': {
        const [filePath, datasyncOnly] = args;
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
        break;
      }
      default:
        throw new Error('Unknown worker operation: ' + op);
    }
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
`;

class DedicatedWorkerPool {
  constructor(poolSize = 2) {
    this.poolSize = poolSize;
    this.workers = [];
    this.nextWorkerIdx = 0;
    this.nextReqId = 1;
    this.pending = new Map();
    this.terminating = false;
  }

  _ensureWorkers() {
    if (this.workers.length > 0) {
      return;
    }
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(WORKER_SCRIPT, { eval: true });
      const slot = { worker, activeCount: 0, terminated: false };
      worker.unref();
      worker.on('message', (msg) => this._onMessage(worker, msg));
      worker.on('error', (err) => {
        if (!slot.terminated) {
          this._onError(err);
        }
      });
      worker.on('exit', (code) => {
        if (!slot.terminated) {
          const err = new Error(`Fallback worker exited unexpectedly with code ${code}`);
          err.code = 'ERR_WORKER_EXITED';
          this._onError(err);
        }
      });
      this.workers.push(slot);
    }
  }

  _onMessage(workerInstance, msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);

    entry.slot.activeCount--;
    if (entry.slot.activeCount === 0) {
      entry.slot.worker.unref();
    }

    if (msg.ok) {
      if ((entry.op === 'readFile' || entry.op === 'readAt') && !entry.encoding && msg.result instanceof Uint8Array) {
        entry.resolve(Buffer.from(msg.result.buffer, msg.result.byteOffset, msg.result.byteLength));
      } else {
        entry.resolve(msg.result);
      }
    } else {
      const err = new Error(msg.error.message);
      if (msg.error.code !== undefined) err.code = msg.error.code;
      if (msg.error.errno !== undefined) err.errno = msg.error.errno;
      if (msg.error.syscall !== undefined) err.syscall = msg.error.syscall;
      if (msg.error.path !== undefined) err.path = msg.error.path;
      if (msg.error.dest !== undefined) err.dest = msg.error.dest;
      entry.reject(err);
    }
  }

  _onError(err) {
    for (const [, entry] of this.pending) {
      entry.reject(err);
    }
    this.pending.clear();
    const oldWorkers = this.workers;
    this.workers = [];
    this.nextWorkerIdx = 0;
    for (const slot of oldWorkers) {
      slot.terminated = true;
      slot.worker.terminate().catch(() => {});
    }
  }

  exec(op, args, encoding = null) {
    this._ensureWorkers();
    const id = this.nextReqId++;
    const slot = this.workers[this.nextWorkerIdx];
    this.nextWorkerIdx = (this.nextWorkerIdx + 1) % this.workers.length;

    if (slot.activeCount === 0) {
      slot.worker.ref();
    }
    slot.activeCount++;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, slot, op, encoding });
      slot.worker.postMessage({ id, op, args });
    });
  }

  async terminate() {
    const termErr = new Error('Fallback worker pool was terminated');
    termErr.code = 'ERR_WORKER_TERMINATED';
    for (const [, entry] of this.pending) {
      entry.reject(termErr);
    }
    this.pending.clear();
    const oldWorkers = this.workers;
    this.workers = [];
    this.nextWorkerIdx = 0;
    const terminations = oldWorkers.map((s) => {
      s.terminated = true;
      return s.worker.terminate();
    });
    await Promise.all(terminations);
  }
}

module.exports = {
  DedicatedWorkerPool,
};
