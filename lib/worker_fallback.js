'use strict';

const { Worker } = require('node:worker_threads');

const WORKER_SCRIPT = `
'use strict';
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');

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
        const st = fs.statSync(filePath);
        result = {
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
        break;
      }
      case 'unlink': {
        const [filePath] = args;
        fs.unlinkSync(filePath);
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
  }

  _ensureWorkers() {
    if (this.workers.length > 0) {
      return;
    }
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(WORKER_SCRIPT, { eval: true });
      worker.unref();
      worker.on('message', (msg) => this._onMessage(worker, msg));
      worker.on('error', (err) => this._onError(err));
      this.workers.push({ worker, activeCount: 0 });
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
      if (entry.op === 'readFile' && !entry.encoding && msg.result instanceof Uint8Array) {
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
      entry.reject(err);
    }
  }

  _onError(err) {
    for (const [, entry] of this.pending) {
      entry.reject(err);
    }
    this.pending.clear();
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
    const terminations = this.workers.map((s) => s.worker.terminate());
    this.workers = [];
    this.pending.clear();
    await Promise.all(terminations);
  }
}

module.exports = {
  DedicatedWorkerPool,
};
