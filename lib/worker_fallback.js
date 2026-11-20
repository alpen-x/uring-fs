'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_SCRIPT_PATH = path.join(__dirname, 'worker_script.js');

/**
 * Pool of dedicated worker_threads used as an isolated fallback backend
 * when io_uring is unavailable or bypassed.
 */
class DedicatedWorkerPool {
  constructor(poolSize = 2) {
    this.poolSize = poolSize;
    this.workers = [];
    this.drainingWorkers = new Set();
    this.nextWorkerIdx = 0;
    this.nextReqId = 1;
    this.pending = new Map();
  }

  _spawnWorker() {
    const worker = new Worker(WORKER_SCRIPT_PATH);
    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const slot = { worker, activeCount: 0, terminated: false, draining: false, exitPromise, resolveExit };
    worker.unref();
    worker.on('message', (msg) => this._onMessage(worker, msg));
    worker.on('error', (err) => {
      if (!slot.terminated) {
        this._onError(err);
      }
    });
    worker.on('exit', (code) => {
      this.drainingWorkers.delete(slot);
      slot.resolveExit();
      if (!slot.terminated) {
        const err = new Error(`Fallback worker exited unexpectedly with code ${code}`);
        err.code = 'ERR_WORKER_EXITED';
        this._onError(err);
      }
    });
    return slot;
  }

  _ensureWorkers() {
    if (this.workers.length > 0) {
      return;
    }
    for (let i = 0; i < this.poolSize; i++) {
      this.workers.push(this._spawnWorker());
    }
  }

  _releaseSlot(slot) {
    slot.activeCount--;
    if (slot.activeCount === 0) {
      slot.worker.unref();
      if (slot.draining && !slot.terminated) {
        slot.terminated = true;
        this.drainingWorkers.delete(slot);
        slot.worker.terminate().catch(() => {});
      }
    }
  }

  _onMessage(workerInstance, msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);

    this._releaseSlot(entry.slot);

    if (msg.ok) {
      if ((entry.op === 'readFile' || entry.op === 'readAt') && !entry.encoding && msg.result instanceof Uint8Array) {
        entry.resolve(Buffer.from(msg.result.buffer, msg.result.byteOffset, msg.result.byteLength));
      } else if (entry.op === 'readBatchAt' && Array.isArray(msg.result)) {
        entry.resolve(
          msg.result.map((b) =>
            b instanceof Uint8Array ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : Buffer.from(b)
          )
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    const err = new Error(msg.error.message);
    for (const key of ['code', 'errno', 'syscall', 'path', 'dest']) {
      if (msg.error[key] !== undefined) err[key] = msg.error[key];
    }
    entry.reject(err);
  }

  _teardownAll(rejectErr) {
    for (const [, entry] of this.pending) {
      entry.reject(rejectErr);
    }
    this.pending.clear();
    const oldWorkers = [...this.workers, ...this.drainingWorkers];
    this.workers = [];
    this.drainingWorkers.clear();
    this.nextWorkerIdx = 0;
    return oldWorkers.map((slot) => {
      slot.terminated = true;
      return slot.worker.terminate().catch(() => {});
    });
  }

  _onError(err) {
    this._teardownAll(err);
  }

  resize(newPoolSize) {
    if (typeof newPoolSize !== 'number' || !Number.isFinite(newPoolSize) || newPoolSize < 1) {
      const err = new RangeError(`The value of "newPoolSize" is out of range. It must be a finite number >= 1. Received ${newPoolSize}`);
      err.code = 'ERR_OUT_OF_RANGE';
      throw err;
    }

    const targetSize = Math.floor(newPoolSize);
    this.poolSize = targetSize;

    if (this.workers.length === 0 || targetSize === this.workers.length) {
      return Promise.resolve();
    }

    if (targetSize > this.workers.length) {
      while (this.workers.length < targetSize) {
        this.workers.push(this._spawnWorker());
      }
      return Promise.resolve();
    }

    const removed = this.workers.splice(targetSize);
    if (this.nextWorkerIdx >= this.workers.length) {
      this.nextWorkerIdx = 0;
    }
    const terminations = [];
    for (const slot of removed) {
      if (slot.activeCount === 0) {
        slot.terminated = true;
        terminations.push(slot.worker.terminate().catch(() => {}));
      } else {
        slot.draining = true;
        this.drainingWorkers.add(slot);
        terminations.push(slot.exitPromise);
      }
    }
    return Promise.all(terminations).then(() => undefined);
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
      try {
        slot.worker.postMessage({ id, op, args });
      } catch (err) {
        this.pending.delete(id);
        this._releaseSlot(slot);
        reject(err);
      }
    });
  }

  async terminate() {
    const termErr = new Error('Fallback worker pool was terminated');
    termErr.code = 'ERR_WORKER_TERMINATED';
    await Promise.all(this._teardownAll(termErr));
  }
}

module.exports = {
  DedicatedWorkerPool,
};
