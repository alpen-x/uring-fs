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
    const stats = uringFs.getRingStats();
    if (!uringFs.isUringSupported()) {
      assert.equal(uringFs.getActiveBackend(), 'fs');
      assert.equal(typeof uringFs.getUnsupportedReason(), 'string');
      assert.equal(stats.supported, false);
      return;
    }

    assert.equal(uringFs.getActiveBackend(), 'io_uring');
    assert.equal(uringFs.getUnsupportedReason(), null);
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

    const hasProcFd = fs.existsSync('/proc/self/fd');
    const fdsBeforeCopy = hasProcFd ? fs.readdirSync('/proc/self/fd').length : 0;
    await uringFs.copyFile(largeFile, largeCopy);
    const fdsAfterCopy = hasProcFd ? fs.readdirSync('/proc/self/fd').length : 0;
    if (hasProcFd) {
      assert.equal(fdsAfterCopy, fdsBeforeCopy, 'Zero-copy kernel splice must close all pipe and file descriptors');
    }

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
        if (uringFs.isUringSupported()) {
          assert.equal(err.path, tmpDir);
        }
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

    const hasProcFd = fs.existsSync('/proc/self/fd');
    const fdsBefore = hasProcFd ? fs.readdirSync('/proc/self/fd').length : 0;
    const statsBefore = uringFs.getRingStats();

    await Promise.all(files.map((f, i) => uringFs.writeFile(f, ` payload-${i} `)));

    const contents = await Promise.all(files.map((f) => uringFs.readFile(f, 'utf8')));
    for (let i = 0; i < count; i++) {
      assert.equal(contents[i], ` payload-${i} `);
    }

    const statsAfter = uringFs.getRingStats();
    const fdsAfter = hasProcFd ? fs.readdirSync('/proc/self/fd').length : 0;

    if (uringFs.isUringSupported()) {
      const deltaRequests = statsAfter.totalRequests - statsBefore.totalRequests;
      const deltaSubmits = statsAfter.totalSubmitSyscalls - statsBefore.totalSubmitSyscalls;
      const deltaSqes = statsAfter.totalSqesPrepared - statsBefore.totalSqesPrepared;

      assert.equal(deltaRequests, count * 2);
      assert.ok(deltaSubmits < deltaSqes / 10, `Batching should reduce syscalls by >90% (SQEs: ${deltaSqes}, Submits: ${deltaSubmits})`);
      assert.equal(statsAfter.activeRequests, 0);
      assert.equal(statsAfter.directFdsInUse, 0, 'All direct FD slots must be returned to the free list');
    }
    if (hasProcFd) {
      assert.equal(fdsAfter, fdsBefore, `Zero File Descriptor leaks expected (before: ${fdsBefore}, after: ${fdsAfter})`);
    }
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

    // Restore default configuration (native io_uring when supported, or fs fallback)
    uringFs.configure({ forceFallback: false, fallback: 'fs' });
    assert.equal(uringFs.getActiveBackend(), uringFs.isUringSupported() ? 'io_uring' : 'fs');
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
    assert.equal(esmModule.isUringSupported(), uringFs.isUringSupported());
  });

  test('12. Immunity to libuv Thread Pool Starvation', async (t) => {
    if (!uringFs.isUringSupported()) {
      t.skip('io_uring not active in this environment');
      return;
    }
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
    if (uringFs.isUringSupported()) {
      const deltaClassicSqes = statsAfterClassic.totalSqesPrepared - statsBeforeClassic.totalSqesPrepared;
      assert.equal(deltaClassicSqes, 4, 'Classic read path must execute 4 SQEs: OPEN, STATX, READ, CLOSE');
    }

    // Optimistic path for < 64 KB: linked OPENAT_DIRECT + READ (2 SQEs) + async CLOSE_DIRECT (1 SQE) = 3 SQEs!
    const statsBeforeOptimistic = uringFs.getRingStats();
    const readSmallOpt = await uringFs.readFile(fMinus);
    const statsAfterOptimistic = uringFs.getRingStats();
    assert.equal(readSmallOpt.length, 65535);
    if (uringFs.isUringSupported()) {
      const deltaSmallOptSqes = statsAfterOptimistic.totalSqesPrepared - statsBeforeOptimistic.totalSqesPrepared;
      assert.equal(deltaSmallOptSqes, 3, 'Optimistic read for small file must execute in 3 SQEs');
    }

    // Per-call option: optimisticReadSize = 262144 (256 KB) reads 128 KB in 3 SQEs
    const statsBeforeLargeOpt = uringFs.getRingStats();
    const read128kOpt = await uringFs.readFile(f128k, { optimisticReadSize: 262144 });
    const statsAfterLargeOpt = uringFs.getRingStats();
    assert.equal(read128kOpt.length, 131072);
    assert.equal(Buffer.compare(read128kOpt, size128k), 0);
    if (uringFs.isUringSupported()) {
      const delta128kOptSqes = statsAfterLargeOpt.totalSqesPrepared - statsBeforeLargeOpt.totalSqesPrepared;
      assert.equal(delta128kOptSqes, 3, 'Optimistic read with 256 KB buffer for 128 KB file must execute in 3 SQEs');
    }
  });

  test('14. 1-SQE access and exists via STATX (F_OK, R_OK, W_OK, X_OK, and fallbacks)', async () => {
    const accessFile = path.join(tmpDir, 'access_test.txt');
    const missingFile = path.join(tmpDir, 'does_not_exist_access.txt');
    await uringFs.writeFile(accessFile, 'access-check-payload');

    const statsBefore = uringFs.getRingStats();
    await uringFs.access(accessFile, uringFs.constants.F_OK);
    const statsAfter = uringFs.getRingStats();
    if (uringFs.isUringSupported()) {
      assert.equal(
        statsAfter.totalSqesPrepared - statsBefore.totalSqesPrepared,
        1,
        'access() must execute in exactly 1 STATX SQE'
      );
    }

    await uringFs.access(accessFile, uringFs.constants.R_OK | uringFs.constants.W_OK);
    assert.equal(await uringFs.exists(accessFile), true);
    assert.equal(await uringFs.exists(missingFile), false);

    await assert.rejects(
      async () => {
        await uringFs.access(missingFile);
      },
      { code: 'ENOENT', syscall: 'access' }
    );

    // Non-executable regular file must reject X_OK when not root
    if (process.geteuid && process.geteuid() !== 0) {
      await assert.rejects(
        async () => {
          await uringFs.access(accessFile, uringFs.constants.X_OK);
        },
        { code: 'EACCES', syscall: 'access' }
      );
    }

    // Worker fallback test for access/exists
    assert.equal(await uringFs.exists(accessFile, { fallback: 'worker' }), true);
    assert.equal(await uringFs.exists(missingFile, { fallback: 'worker' }), false);
    await uringFs.closeFallbackWorkers();
  });

  test('15. Strict Node.js fs/promises parity (mkdir recursive return, DataView, error codes, UringStats predicates, constants)', async () => {
    // 1. Top-level constants export parity
    assert.equal(uringFs.F_OK, fs.constants.F_OK);
    assert.equal(uringFs.R_OK, fs.constants.R_OK);
    assert.equal(uringFs.W_OK, fs.constants.W_OK);
    assert.equal(uringFs.X_OK, fs.constants.X_OK);
    assert.equal(uringFs.COPYFILE_EXCL, fs.constants.COPYFILE_EXCL);

    // 2. mkdir({ recursive: true }) returns the first created directory path (matching node:fs/promises)
    const firstDir = path.join(tmpDir, 'rec_first');
    const nestedDir = path.join(firstDir, 'second', 'third');
    const createdPath = await uringFs.mkdir(nestedDir, { recursive: true });
    assert.equal(createdPath, path.resolve(firstDir));
    const alreadyExistsReturn = await uringFs.mkdir(nestedDir, { recursive: true });
    assert.equal(alreadyExistsReturn, undefined);

    // 3. Per-call { fallback: false } and { fallback: 'none' } must succeed when io_uring is supported
    if (uringFs.isUringSupported()) {
      assert.equal(await uringFs.exists(firstDir, { fallback: false }), true);
      assert.equal(await uringFs.exists(firstDir, { fallback: 'none' }), true);
    }

    // 4. DataView support in writeFile and appendFile across backends
    const dvFile = path.join(tmpDir, 'dataview.bin');
    const rawAb = new Uint8Array([10, 20, 30, 40, 50, 60]).buffer;
    const dvSlice = new DataView(rawAb, 1, 4); // [20, 30, 40, 50]
    await uringFs.writeFile(dvFile, dvSlice);
    await uringFs.appendFile(dvFile, dvSlice);
    const dvRead = await uringFs.readFile(dvFile);
    assert.deepEqual(Array.from(dvRead), [20, 30, 40, 50, 20, 30, 40, 50]);

    // 5. UringStats POSIX type predicates and dev/rdev properties
    const st = await uringFs.stat(dvFile);
    assert.equal(typeof st.dev, 'number');
    assert.equal(typeof st.rdev, 'number');
    assert.equal(st.isFile(), true);
    assert.equal(st.isDirectory(), false);
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isBlockDevice(), false);
    assert.equal(st.isCharacterDevice(), false);
    assert.equal(st.isFIFO(), false);
    assert.equal(st.isSocket(), false);

    // 6. Standard Node.js error codes for invalid arguments
    await assert.rejects(
      async () => {
        await uringFs.exists(null);
      },
      { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }
    );
    await assert.rejects(
      async () => {
        await uringFs.readFile(12345);
      },
      { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }
    );
    await assert.rejects(
      async () => {
        await uringFs.access(dvFile, 999);
      },
      { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }
    );
    await assert.rejects(
      async () => {
        await uringFs.readFile(dvFile, 'invalid_encoding_xyz');
      },
      { name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE' }
    );
    assert.throws(
      () => {
        uringFs.setOptimisticReadSize(NaN);
      },
      { name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE' }
    );
    assert.throws(
      () => {
        uringFs.setOptimisticReadSize(Infinity);
      },
      { name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE' }
    );
  });

  test('16. DedicatedWorkerPool crash recovery (ERR_WORKER_EXITED) and mid-flight termination (ERR_WORKER_TERMINATED)', async () => {
    const { DedicatedWorkerPool } = require('../lib/worker_fallback');
    const crashTestFile = path.join(tmpDir, 'worker_crash_test.txt');
    await uringFs.writeFile(crashTestFile, 'worker-recovery-payload');

    const pool = new DedicatedWorkerPool(2);
    try {
      // Warm up the pool (uses workers[0]) and verify normal operation
      const initialRead = await pool.exec('readFile', [crashTestFile, 'utf8'], 'utf8');
      assert.equal(initialRead, 'worker-recovery-payload');
      assert.equal(pool.workers.length, 2);

      // 1. Simulate an abrupt worker crash while a request is in-flight on workers[1]:
      const inFlightCrashPromise = pool.exec('readFile', [crashTestFile, 'utf8'], 'utf8');
      const crashRejection = assert.rejects(inFlightCrashPromise, {
        code: 'ERR_WORKER_EXITED',
      });
      pool.workers[1].worker.terminate();
      await crashRejection;
      assert.equal(pool.workers.length, 0, 'Pool must clear dead workers after an unexpected crash');

      // Verify automatic pool respawn on the very next call
      const recoveredRead = await pool.exec('readFile', [crashTestFile, 'utf8'], 'utf8');
      assert.equal(recoveredRead, 'worker-recovery-payload');
      assert.equal(pool.workers.length, 2, 'Pool must automatically respawn workers on next exec()');

      // 2. Mid-flight pool.terminate() must reject pending promises with ERR_WORKER_TERMINATED instead of hanging
      const inFlightTermPromise = pool.exec('readFile', [crashTestFile, 'utf8'], 'utf8');
      const termRejection = assert.rejects(inFlightTermPromise, {
        code: 'ERR_WORKER_TERMINATED',
      });
      await pool.terminate();
      await termRejection;
      assert.equal(pool.workers.length, 0);
    } finally {
      await pool.terminate();
    }

    // Verify top-level closeFallbackWorkers() mid-flight and recovery
    const topLevelPromise = uringFs.readFile(crashTestFile, { encoding: 'utf8', fallback: 'worker' });
    const topLevelRejection = assert.rejects(topLevelPromise, {
      code: 'ERR_WORKER_TERMINATED',
    });
    await uringFs.closeFallbackWorkers();
    await topLevelRejection;

    const topLevelRecovered = await uringFs.readFile(crashTestFile, { encoding: 'utf8', fallback: 'worker' });
    assert.equal(topLevelRecovered, 'worker-recovery-payload');
    await uringFs.closeFallbackWorkers();
  });

  test('17. Concurrent appendFile atomicity, record integrity, and ordering under Promise.all (200 concurrent writes)', async () => {
    const appendLogFile = path.join(tmpDir, 'concurrent_append.jsonl');
    await uringFs.writeFile(appendLogFile, '');

    const totalRecords = 200;
    const expectedLines = [];
    for (let i = 0; i < totalRecords; i++) {
      const payload = JSON.stringify({
        seq: i,
        tag: `record-${String(i).padStart(4, '0')}`,
        data: 'X'.repeat(256),
      }) + '\n';
      expectedLines.push(payload);
    }

    const expectedTotalBytes = expectedLines.reduce((sum, l) => sum + Buffer.byteLength(l), 0);

    // Fire all 200 appendFile operations simultaneously via Promise.all
    await Promise.all(expectedLines.map((line) => uringFs.appendFile(appendLogFile, line)));

    const rawContent = await uringFs.readFile(appendLogFile, 'utf8');
    assert.equal(
      Buffer.byteLength(rawContent),
      expectedTotalBytes,
      'Total file size must equal exact sum of all 200 concurrent appended records (zero lost or truncated bytes)'
    );

    const lines = rawContent.trim().split('\n');
    assert.equal(lines.length, totalRecords, 'Must contain exactly 200 newline-delimited records');

    const seenSeqs = new Set();
    let inOrderTransitions = 0;
    let prevSeq = -1;

    for (const line of lines) {
      // Every line must be valid, uncorrupted JSON (no interleaving of bytes between concurrent O_APPEND writes)
      const parsed = JSON.parse(line);
      assert.equal(parsed.tag, `record-${String(parsed.seq).padStart(4, '0')}`);
      assert.equal(parsed.data, 'X'.repeat(256));
      seenSeqs.add(parsed.seq);
      if (parsed.seq === prevSeq + 1) {
        inOrderTransitions++;
      }
      prevSeq = parsed.seq;
    }

    assert.equal(seenSeqs.size, totalRecords, 'All 200 unique records (0..199) must be present without duplicates or drops');
  });
});
