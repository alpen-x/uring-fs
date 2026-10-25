'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const uringFs = require('../index.js');

let tmpDir;

describe('uring-fs - Full Test Suite (io_uring + Fallbacks)', () => {
  before(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'uring-fs-test-'));
  });

  after(async () => {
    await uringFs.closeFallbackWorkers();
    if (tmpDir) {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('1. Linux Kernel io_uring support detection', () => {
    assert.equal(uringFs.isUringSupported(), true, 'io_uring should be active on Linux kernel 6.8+');
    assert.equal(uringFs.getActiveBackend(), 'io_uring');
    assert.equal(uringFs.getUnsupportedReason(), null);

    const stats = uringFs.getRingStats();
    assert.equal(stats.supported, true);
    assert.equal(stats.activeBackend, 'io_uring');
    assert.ok(stats.queueDepth >= 128, `Expected queueDepth >= 128, received: ${stats.queueDepth}`);
  });

  test('2. Write and read UTF-8 text, Buffer, Uint8Array, and file:// URL', async () => {
    const filePath = path.join(tmpDir, 'utf8_test.txt');
    const content = 'Hello World! Unicode accents (áéíóú) and emojis 🚀🔥 via uring-fs.';

    await uringFs.writeFile(filePath, content, 'utf8');

    const buf = await uringFs.readFile(filePath);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.toString('utf8'), content);

    const str = await uringFs.readFile(filePath, 'utf8');
    assert.equal(str, content);

    const fileUrl = pathToFileURL(filePath);
    const strFromUrl = await uringFs.readFile(fileUrl, { encoding: 'utf8' });
    assert.equal(strFromUrl, content);

    const uint8 = new Uint8Array([65, 66, 67, 68]); // "ABCD"
    await uringFs.writeFile(filePath, uint8);
    assert.equal(await uringFs.readFile(filePath, 'utf8'), 'ABCD');
  });

  test('3. Empty files (0 bytes) and large files (8 MB)', async () => {
    const emptyFile = path.join(tmpDir, 'empty.dat');
    await uringFs.writeFile(emptyFile, '');
    const emptyBuf = await uringFs.readFile(emptyFile);
    assert.ok(Buffer.isBuffer(emptyBuf));
    assert.equal(emptyBuf.length, 0);

    const largeFile = path.join(tmpDir, 'large_8mb.bin');
    const largeData = crypto.randomBytes(8 * 1024 * 1024);
    await uringFs.writeFile(largeFile, largeData);

    const readLarge = await uringFs.readFile(largeFile);
    assert.equal(readLarge.length, largeData.length);
    assert.equal(Buffer.compare(readLarge, largeData), 0, '8 MB payload must match byte-for-byte');
  });

  test('4. appendFile, copyFile, and exclusive write flags (wx / COPYFILE_EXCL)', async () => {
    const logFile = path.join(tmpDir, 'append.log');
    await uringFs.writeFile(logFile, 'Line 1\n');
    await uringFs.appendFile(logFile, 'Line 2\n');
    await uringFs.appendFile(logFile, 'Line 3\n');

    const result = await uringFs.readFile(logFile, 'utf8');
    assert.equal(result, 'Line 1\nLine 2\nLine 3\n');

    await assert.rejects(
      () => uringFs.writeFile(logFile, 'Fail', { flag: 'wx' }),
      (err) => err.code === 'EEXIST' && err.syscall === 'open'
    );

    const copiedFile = path.join(tmpDir, 'copied.log');
    await uringFs.copyFile(logFile, copiedFile);
    assert.equal(await uringFs.readFile(copiedFile, 'utf8'), result);

    await assert.rejects(
      () => uringFs.copyFile(logFile, copiedFile, uringFs.constants.COPYFILE_EXCL),
      (err) => err.code === 'EEXIST'
    );
  });

  test('5. stat, mkdir (single and recursive), and unlink via io_uring', async () => {
    const nestedDir = path.join(tmpDir, 'a', 'b', 'c');
    await uringFs.mkdir(nestedDir, { recursive: true });

    const dirStat = await uringFs.stat(nestedDir);
    assert.equal(dirStat.isDirectory(), true);
    assert.equal(dirStat.isFile(), false);
    assert.ok(dirStat.mtime instanceof Date);

    const targetFile = path.join(nestedDir, 'item.txt');
    await uringFs.writeFile(targetFile, '1234567890');

    const fileStat = await uringFs.stat(targetFile);
    assert.equal(fileStat.isFile(), true);
    assert.equal(fileStat.isDirectory(), false);
    assert.equal(fileStat.size, 10);

    await uringFs.unlink(targetFile);
    await assert.rejects(
      () => uringFs.stat(targetFile),
      (err) => err.code === 'ENOENT'
    );
  });

  test('6. Standardized NodeJS.ErrnoException errors (ENOENT, EISDIR)', async () => {
    const missingPath = path.join(tmpDir, 'does_not_exist_12345.txt');

    await assert.rejects(
      () => uringFs.readFile(missingPath),
      (err) => {
        assert.equal(err.code, 'ENOENT');
        assert.equal(err.errno, -2);
        assert.equal(err.syscall, 'open');
        assert.equal(err.path, missingPath);
        return true;
      }
    );

    await assert.rejects(
      () => uringFs.readFile(tmpDir),
      (err) => {
        assert.equal(err.code, 'EISDIR');
        assert.equal(err.syscall, 'read');
        assert.equal(err.path, tmpDir);
        return true;
      }
    );
  });

  test('7. AbortSignal support (pre-aborted)', async () => {
    const sampleFile = path.join(tmpDir, 'abort_sample.txt');
    await uringFs.writeFile(sampleFile, 'data');

    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      () => uringFs.readFile(sampleFile, { signal: preAborted.signal }),
      (err) => err.name === 'AbortError' && err.code === 'ABORT_ERR'
    );
  });

  test('8. High Concurrency (1,000 simultaneous files), Auto-Batching, and Zero FD Leaks', async () => {
    const concurrencyDir = path.join(tmpDir, 'concurrency_1000');
    await uringFs.mkdir(concurrencyDir, { recursive: true });

    const count = 1000;
    const files = Array.from({ length: count }, (_, i) => path.join(concurrencyDir, `f_${i}.txt`));

    const fdsBefore = fs.readdirSync('/proc/self/fd').length;
    const statsBefore = uringFs.getRingStats();

    await Promise.all(files.map((f, i) => uringFs.writeFile(f, ` payload-${i} `)));

    const contents = await Promise.all(files.map((f) => uringFs.readFile(f, 'utf8')));
    for (let i = 0; i < count; i++) {
      assert.equal(contents[i], ` payload-${i} `);
    }

    const statsAfter = uringFs.getRingStats();
    const fdsAfter = fs.readdirSync('/proc/self/fd').length;

    const deltaRequests = statsAfter.totalRequests - statsBefore.totalRequests;
    const deltaSubmits = statsAfter.totalSubmitSyscalls - statsBefore.totalSubmitSyscalls;
    const deltaSqes = statsAfter.totalSqesPrepared - statsBefore.totalSqesPrepared;

    assert.equal(deltaRequests, count * 2);
    assert.ok(deltaSubmits < deltaSqes / 10, `Batching should reduce syscalls by >90% (SQEs: ${deltaSqes}, Submits: ${deltaSubmits})`);
    assert.equal(statsAfter.activeRequests, 0);
    assert.equal(fdsAfter, fdsBefore, `Zero File Descriptor leaks expected (before: ${fdsBefore}, after: ${fdsAfter})`);
  });

  test('9. 3-Tier Fallback System: Custom Provider (memfs/graceful-fs style), Worker Pool, and Strict Mode', async () => {
    // 9a. Custom Provider (e.g. simulating memfs or graceful-fs)
    const memoryStore = new Map();
    const customMemoryProvider = {
      async writeFile(p, data) {
        memoryStore.set(p, Buffer.from(data));
      },
      async readFile(p, opts) {
        if (!memoryStore.has(p)) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        const buf = memoryStore.get(p);
        return opts?.encoding ? buf.toString(opts.encoding) : buf;
      },
      async stat(p) {
        return { size: memoryStore.get(p)?.length ?? 0, isFile: () => true, isDirectory: () => false };
      },
      async unlink(p) {
        memoryStore.delete(p);
      },
      async mkdir() {},
    };

    uringFs.configure({ forceFallback: true, fallback: customMemoryProvider });
    assert.equal(uringFs.getActiveBackend(), 'custom');

    await uringFs.writeFile('/virtual/mem.txt', 'hello-custom-provider');
    assert.equal(await uringFs.readFile('/virtual/mem.txt', 'utf8'), 'hello-custom-provider');

    // 9b. 'worker' fallback (Dedicated Worker Pool isolated from main libuv thread pool)
    uringFs.configure({ forceFallback: true, fallback: 'worker' });
    assert.equal(uringFs.getActiveBackend(), 'worker');

    const workerFile = path.join(tmpDir, 'worker_fallback.txt');
    await uringFs.writeFile(workerFile, 'written-by-worker');
    assert.equal(await uringFs.readFile(workerFile, 'utf8'), 'written-by-worker');
    const st = await uringFs.stat(workerFile);
    assert.equal(st.isFile(), true);
    assert.equal(st.size, Buffer.byteLength('written-by-worker'));

    // 9c. Strict Mode (fallback: false)
    uringFs.configure({ forceFallback: true, fallback: false });
    assert.equal(uringFs.getActiveBackend(), 'none');
    await assert.rejects(
      () => uringFs.readFile(workerFile),
      (err) => err.code === 'ERR_URING_UNSUPPORTED'
    );

    // Restore default configuration (native io_uring)
    uringFs.configure({ forceFallback: false, fallback: 'fs' });
    assert.equal(uringFs.getActiveBackend(), 'io_uring');
  });

  test('10. ES Modules support (import index.mjs)', async () => {
    const esmModule = await import('../index.mjs');
    assert.equal(typeof esmModule.readFile, 'function');
    assert.equal(typeof esmModule.writeFile, 'function');
    assert.equal(esmModule.isUringSupported(), true);
  });

  test('11. Immunity to libuv Thread Pool Starvation', async () => {
    const testFile = path.join(tmpDir, 'starvation.txt');
    await uringFs.writeFile(testFile, 'thread-pool-immune');

    const cryptoTasks = [];
    for (let i = 0; i < 4; i++) {
      cryptoTasks.push(
        new Promise((resolve) => {
          crypto.pbkdf2('password', 'salt', 300000, 64, 'sha512', () => resolve());
        })
      );
    }

    const startUring = performance.now();
    const data = await uringFs.readFile(testFile, 'utf8');
    const uringTime = performance.now() - startUring;

    assert.equal(data, 'thread-pool-immune');
    assert.ok(uringTime < 15, `io_uring read must not block on the libuv thread pool (took ${uringTime.toFixed(2)}ms)`);

    await Promise.all(cryptoTasks);
  });
});
