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

  test('1. Linux Kernel io_uring support and Direct FD table detection', () => {
    assert.equal(uringFs.isUringSupported(), true, 'io_uring should be active on Linux kernel 6.8+');
    assert.equal(uringFs.getActiveBackend(), 'io_uring');
    assert.equal(uringFs.getUnsupportedReason(), null);

    const stats = uringFs.getRingStats();
    assert.equal(stats.supported, true);
    assert.equal(stats.activeBackend, 'io_uring');
    assert.ok(stats.queueDepth >= 128, `Expected queueDepth >= 128, received: ${stats.queueDepth}`);
    assert.equal(stats.directFdsSupported, true, 'Direct FD table should be active on Linux 5.19+');
    assert.equal(stats.directFdTableSize, 1024);
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

  test('3. Empty files (0 bytes), large files (8 MB), and zero-copy kernel splice copyFile', async () => {
    const emptyFile = path.join(tmpDir, 'empty.dat');
    const emptyCopy = path.join(tmpDir, 'empty_copy.dat');
    await uringFs.writeFile(emptyFile, '');
    const emptyBuf = await uringFs.readFile(emptyFile);
    assert.ok(Buffer.isBuffer(emptyBuf));
    assert.equal(emptyBuf.length, 0);

    await uringFs.copyFile(emptyFile, emptyCopy);
    const emptyCopyBuf = await uringFs.readFile(emptyCopy);
    assert.equal(emptyCopyBuf.length, 0);

    const largeFile = path.join(tmpDir, 'large_8mb.bin');
    const largeCopy = path.join(tmpDir, 'large_8mb_copy.bin');
    const largeData = crypto.randomBytes(8 * 1024 * 1024);
    await uringFs.writeFile(largeFile, largeData);

    const fdsBeforeCopy = fs.readdirSync('/proc/self/fd').length;
    await uringFs.copyFile(largeFile, largeCopy);
    const fdsAfterCopy = fs.readdirSync('/proc/self/fd').length;
    assert.equal(fdsAfterCopy, fdsBeforeCopy, 'Zero-copy kernel splice must close all pipe and file descriptors');

    const readLarge = await uringFs.readFile(largeCopy);
    assert.equal(readLarge.length, largeData.length);
    assert.equal(Buffer.compare(readLarge, largeData), 0, '8 MB spliced copy must match byte-for-byte');
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
      (err) => err.code === 'EEXIST' && err.syscall === 'copyfile' && err.dest === copiedFile
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

  test('6. rename, symlink, lstat, link, fsync, fdatasync, and writeFile({ flush: true }) via io_uring', async () => {
    const origPath = path.join(tmpDir, 'orig_name.txt');
    const renamedPath = path.join(tmpDir, 'renamed.txt');
    const symlinkPath = path.join(tmpDir, 'symlink_ref.txt');
    const hardlinkPath = path.join(tmpDir, 'hardlink_ref.txt');

    await uringFs.writeFile(origPath, 'durable-payload', { flush: true });
    await uringFs.fsync(origPath);
    await uringFs.fdatasync(origPath);

    await uringFs.rename(origPath, renamedPath);
    await assert.rejects(() => uringFs.stat(origPath), (err) => err.code === 'ENOENT');
    assert.equal(await uringFs.readFile(renamedPath, 'utf8'), 'durable-payload');

    await uringFs.symlink(renamedPath, symlinkPath);
    const lstatInfo = await uringFs.lstat(symlinkPath);
    assert.equal(lstatInfo.isSymbolicLink(), true);
    assert.equal(lstatInfo.isFile(), false);

    const statInfo = await uringFs.stat(symlinkPath);
    assert.equal(statInfo.isSymbolicLink(), false);
    assert.equal(statInfo.isFile(), true);

    await uringFs.link(renamedPath, hardlinkPath);
    const linkedStat = await uringFs.stat(hardlinkPath);
    assert.equal(linkedStat.nlink, 2);
    assert.equal(await uringFs.readFile(hardlinkPath, 'utf8'), 'durable-payload');
  });

  test('7. Standardized NodeJS.ErrnoException errors (ENOENT, EISDIR)', async () => {
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

  test('8. AbortSignal support (pre-aborted)', async () => {
    const sampleFile = path.join(tmpDir, 'abort_sample.txt');
    await uringFs.writeFile(sampleFile, 'data');

    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      () => uringFs.readFile(sampleFile, { signal: preAborted.signal }),
      (err) => err.name === 'AbortError' && err.code === 'ABORT_ERR'
    );
  });

  test('9. High Concurrency (1,000 simultaneous files), Auto-Batching, and Zero FD Leaks', async () => {
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
    assert.equal(statsAfter.directFdsInUse, 0, 'All direct FD slots must be returned to the free list');
    assert.equal(fdsAfter, fdsBefore, `Zero File Descriptor leaks expected (before: ${fdsBefore}, after: ${fdsAfter})`);
  });

  test('10. 3-Tier Fallback System: Custom Provider (memfs/graceful-fs style), Worker Pool, and Strict Mode', async () => {
    // 10a. Custom Provider (e.g. simulating memfs or graceful-fs)
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

    // 10b. 'worker' fallback (Dedicated Worker Pool isolated from main libuv thread pool)
    uringFs.configure({ forceFallback: true, fallback: 'worker' });
    assert.equal(uringFs.getActiveBackend(), 'worker');

    const workerFile = path.join(tmpDir, 'worker_fallback.txt');
    const workerRenamed = path.join(tmpDir, 'worker_renamed.txt');
    await uringFs.writeFile(workerFile, 'written-by-worker');
    await uringFs.fsync(workerFile);
    await uringFs.rename(workerFile, workerRenamed);
    assert.equal(await uringFs.readFile(workerRenamed, 'utf8'), 'written-by-worker');
    const st = await uringFs.stat(workerRenamed);
    assert.equal(st.isFile(), true);
    assert.equal(st.size, Buffer.byteLength('written-by-worker'));

    // 10c. Strict Mode (fallback: false)
    uringFs.configure({ forceFallback: true, fallback: false });
    assert.equal(uringFs.getActiveBackend(), 'none');
    await assert.rejects(
      () => uringFs.readFile(workerRenamed),
      (err) => err.code === 'ERR_URING_UNSUPPORTED'
    );

    // Restore default configuration (native io_uring)
    uringFs.configure({ forceFallback: false, fallback: 'fs' });
    assert.equal(uringFs.getActiveBackend(), 'io_uring');
  });

  test('11. ES Modules support (import index.mjs)', async () => {
    const esmModule = await import('../index.mjs');
    assert.equal(typeof esmModule.readFile, 'function');
    assert.equal(typeof esmModule.writeFile, 'function');
    assert.equal(typeof esmModule.copyFile, 'function');
    assert.equal(typeof esmModule.lstat, 'function');
    assert.equal(typeof esmModule.rename, 'function');
    assert.equal(typeof esmModule.symlink, 'function');
    assert.equal(typeof esmModule.link, 'function');
    assert.equal(typeof esmModule.fsync, 'function');
    assert.equal(typeof esmModule.fdatasync, 'function');
    assert.equal(typeof esmModule.setOptimisticReadSize, 'function');
    assert.equal(esmModule.isUringSupported(), true);
  });

  test('12. Immunity to libuv Thread Pool Starvation', async () => {
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

  test('13. Optimistic Read + Direct FD Chaining (Configurable buffer size, boundary conditions, and SQE telemetry)', async () => {
    const initialStats = uringFs.getRingStats();
    assert.equal(initialStats.optimisticReadSize, 65536);

    uringFs.configure({ optimisticReadSize: 131072 });
    assert.equal(uringFs.getRingStats().optimisticReadSize, 131072);

    uringFs.setOptimisticReadSize(65536);
    assert.equal(uringFs.getRingStats().optimisticReadSize, 65536);

    const boundaryDir = path.join(tmpDir, 'boundaries');
    await uringFs.mkdir(boundaryDir, { recursive: true });

    const exact64k = crypto.randomBytes(65536);
    const minusOne64k = crypto.randomBytes(65535);
    const plusOne64k = crypto.randomBytes(65537);
    const size128k = crypto.randomBytes(131072);

    const fExact = path.join(boundaryDir, 'exact64k.bin');
    const fMinus = path.join(boundaryDir, 'minus64k.bin');
    const fPlus = path.join(boundaryDir, 'plus64k.bin');
    const f128k = path.join(boundaryDir, 'size128k.bin');

    await uringFs.writeFile(fExact, exact64k);
    await uringFs.writeFile(fMinus, minusOne64k);
    await uringFs.writeFile(fPlus, plusOne64k);
    await uringFs.writeFile(f128k, size128k);

    const readExact = await uringFs.readFile(fExact);
    assert.equal(readExact.length, 65536);
    assert.equal(Buffer.compare(readExact, exact64k), 0);

    const readMinus = await uringFs.readFile(fMinus);
    assert.equal(readMinus.length, 65535);
    assert.equal(Buffer.compare(readMinus, minusOne64k), 0);

    const readPlus = await uringFs.readFile(fPlus);
    assert.equal(readPlus.length, 65537);
    assert.equal(Buffer.compare(readPlus, plusOne64k), 0);

    const read128 = await uringFs.readFile(f128k);
    assert.equal(read128.length, 131072);
    assert.equal(Buffer.compare(read128, size128k), 0);

    // Per-call option: optimisticReadSize = 0 (disables optimistic read, forces classic STATX path)
    const statsBeforeClassic = uringFs.getRingStats();
    const readClassic = await uringFs.readFile(fExact, { optimisticReadSize: 0 });
    const statsAfterClassic = uringFs.getRingStats();
    assert.equal(readClassic.length, 65536);
    assert.equal(Buffer.compare(readClassic, exact64k), 0);
    const deltaClassicSqes = statsAfterClassic.totalSqesPrepared - statsBeforeClassic.totalSqesPrepared;
    assert.equal(deltaClassicSqes, 4, 'Classic read path must execute 4 SQEs: OPEN, STATX, READ, CLOSE');

    // Optimistic path for < 64 KB: linked OPENAT_DIRECT + READ (2 SQEs) + async CLOSE_DIRECT (1 SQE) = 3 SQEs!
    const statsBeforeOptimistic = uringFs.getRingStats();
    const readSmallOpt = await uringFs.readFile(fMinus);
    const statsAfterOptimistic = uringFs.getRingStats();
    assert.equal(readSmallOpt.length, 65535);
    const deltaSmallOptSqes = statsAfterOptimistic.totalSqesPrepared - statsBeforeOptimistic.totalSqesPrepared;
    assert.equal(deltaSmallOptSqes, 3, 'Optimistic read for small file must execute in 3 SQEs');

    // Per-call option: optimisticReadSize = 262144 (256 KB) reads 128 KB in 3 SQEs
    const statsBeforeLargeOpt = uringFs.getRingStats();
    const read128kOpt = await uringFs.readFile(f128k, { optimisticReadSize: 262144 });
    const statsAfterLargeOpt = uringFs.getRingStats();
    assert.equal(read128kOpt.length, 131072);
    assert.equal(Buffer.compare(read128kOpt, size128k), 0);
    const delta128kOptSqes = statsAfterLargeOpt.totalSqesPrepared - statsBeforeLargeOpt.totalSqesPrepared;
    assert.equal(delta128kOptSqes, 3, 'Optimistic read with 256 KB buffer for 128 KB file must execute in 3 SQEs');
  });
});
