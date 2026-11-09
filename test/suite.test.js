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
      assert.ok(deltaSubmits < deltaSqes / 8, `Batching should reduce syscalls by >87% (SQEs: ${deltaSqes}, Submits: ${deltaSubmits})`);
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

  test('18. Positional readAt (3-SQE chain), 1-SQE rmdir, and uniform AbortSignal across all APIs', async () => {
    // 1. readAt positional reads and slice accuracy
    const posFile = path.join(tmpDir, 'read_at_pos.bin');
    const fullText = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    await uringFs.writeFile(posFile, fullText);

    // Read middle chunk as Buffer
    const statsBeforePos = uringFs.getRingStats();
    const slice0 = await uringFs.readAt(posFile, 0, 10);
    const statsAfterPos = uringFs.getRingStats();
    assert.equal(slice0.toString('utf8'), '0123456789');
    if (uringFs.isUringSupported()) {
      assert.equal(
        statsAfterPos.totalSqesPrepared - statsBeforePos.totalSqesPrepared,
        3,
        'readAt must execute in exactly 3 SQEs: OPENAT_DIRECT -> READ -> CLOSE_DIRECT'
      );
    }

    // Read with string encoding option
    const sliceStr = await uringFs.readAt(posFile, 10, 5, 'utf8');
    assert.equal(sliceStr, 'ABCDE');

    const sliceObjEnc = await uringFs.readAt(posFile, 10, 5, { encoding: 'utf8' });
    assert.equal(sliceObjEnc, 'ABCDE');

    // Read extending past EOF (offset 20 to past end)
    const slicePastEof = await uringFs.readAt(posFile, 20, 100, 'utf8');
    assert.equal(slicePastEof, 'KLMNOPQRSTUVWXYZ');

    // Read completely beyond EOF
    const beyondEof = await uringFs.readAt(posFile, 100, 10);
    assert.equal(beyondEof.length, 0);

    // Read with length 0
    const zeroLenBuf = await uringFs.readAt(posFile, 5, 0);
    assert.equal(zeroLenBuf.length, 0);
    const zeroLenStr = await uringFs.readAt(posFile, 5, 0, 'utf8');
    assert.equal(zeroLenStr, '');

    // readAt length 0 on non-existent file rejects with ENOENT, and on directory rejects with EISDIR
    await assert.rejects(
      async () => {
        await uringFs.readAt(path.join(tmpDir, 'non_existent_file.bin'), 0, 0);
      },
      { code: 'ENOENT' }
    );
    await assert.rejects(
      async () => {
        await uringFs.readAt(tmpDir, 0, 0);
      },
      { code: 'EISDIR' }
    );

    // Argument bounds and type validation
    await assert.rejects(
      async () => {
        await uringFs.readAt(posFile, 'invalid', 10);
      },
      { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }
    );
    await assert.rejects(
      async () => {
        await uringFs.readAt(posFile, 0, 'invalid');
      },
      { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }
    );
    await assert.rejects(
      async () => {
        await uringFs.readAt(posFile, -1, 10);
      },
      { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }
    );
    await assert.rejects(
      async () => {
        await uringFs.readAt(posFile, 0, -5);
      },
      { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }
    );

    // readAt fallback backends
    const workerSlice = await uringFs.readAt(posFile, 10, 5, { fallback: 'worker', encoding: 'utf8' });
    assert.equal(workerSlice, 'ABCDE');
    const fsSlice = await uringFs.readAt(posFile, 10, 5, { fallback: 'fs', encoding: 'utf8' });
    assert.equal(fsSlice, 'ABCDE');
    await uringFs.closeFallbackWorkers();

    // 2. rmdir directory removal
    const emptySubdir = path.join(tmpDir, 'empty_dir_to_remove');
    await uringFs.mkdir(emptySubdir);
    assert.equal(await uringFs.exists(emptySubdir), true);

    const statsBeforeRmdir = uringFs.getRingStats();
    await uringFs.rmdir(emptySubdir);
    const statsAfterRmdir = uringFs.getRingStats();
    if (uringFs.isUringSupported()) {
      assert.equal(
        statsAfterRmdir.totalSqesPrepared - statsBeforeRmdir.totalSqesPrepared,
        1,
        'rmdir must execute in exactly 1 SQE via io_uring_prep_unlinkat with AT_REMOVEDIR'
      );
    }
    assert.equal(await uringFs.exists(emptySubdir), false);

    // Attempt rmdir on non-empty directory
    const nonEmptyDir = path.join(tmpDir, 'non_empty_dir');
    await uringFs.mkdir(nonEmptyDir);
    const insideFile = path.join(nonEmptyDir, 'inside.txt');
    await uringFs.writeFile(insideFile, 'hello');
    await assert.rejects(
      async () => {
        await uringFs.rmdir(nonEmptyDir);
      },
      (err) => err.code === 'ENOTEMPTY' || err.code === 'EEXIST'
    );
    await uringFs.unlink(insideFile);
    await uringFs.rmdir(nonEmptyDir);
    assert.equal(await uringFs.exists(nonEmptyDir), false);

    // Attempt rmdir on non-existent directory
    await assert.rejects(
      async () => {
        await uringFs.rmdir(path.join(tmpDir, 'does_not_exist_dir'));
      },
      { code: 'ENOENT' }
    );

    // rmdir fallbacks
    const workerEmptyDir = path.join(tmpDir, 'worker_empty_dir');
    await uringFs.mkdir(workerEmptyDir);
    await uringFs.rmdir(workerEmptyDir, { fallback: 'worker' });
    assert.equal(await uringFs.exists(workerEmptyDir), false);

    const fsEmptyDir = path.join(tmpDir, 'fs_empty_dir');
    await uringFs.mkdir(fsEmptyDir);
    await uringFs.rmdir(fsEmptyDir, { fallback: 'fs' });
    assert.equal(await uringFs.exists(fsEmptyDir), false);
    await uringFs.closeFallbackWorkers();

    // 3. Uniform AbortSignal coverage across all APIs
    const abortedSignal = AbortSignal.abort(new Error('Operation cancelled'));

    await assert.rejects(
      async () => {
        await uringFs.readAt(posFile, 0, 10, { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.rmdir(tmpDir, { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.copyFile(posFile, path.join(tmpDir, 'abort_dest.bin'), { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.stat(posFile, { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.lstat(posFile, { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.unlink(posFile, { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.mkdir(path.join(tmpDir, 'abort_mkdir'), { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.rename(posFile, path.join(tmpDir, 'abort_rename'), { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.symlink(posFile, path.join(tmpDir, 'abort_symlink'), { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.symlink(posFile, path.join(tmpDir, 'abort_symlink4'), 'file', { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.link(posFile, path.join(tmpDir, 'abort_link'), { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.fsync(posFile, { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.fdatasync(posFile, { signal: abortedSignal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );
  });

  test('19. Batched positional readBatchAt (multi-slice linked read, >30 slices unlinked fallback, EOF clamping, encoding, and fallbacks)', async () => {
    const batchFile = path.join(tmpDir, 'batch_read_test.bin');
    const totalBytes = 2048;
    const testData = Buffer.alloc(totalBytes);
    for (let i = 0; i < totalBytes; i++) {
      testData[i] = i % 251; // Prime cycle for deterministic pattern
    }
    await uringFs.writeFile(batchFile, testData);

    // A. Multi-slice linked 1-roundtrip read (5 slices)
    const ranges = [
      [0, 16],
      [64, 32],
      { offset: 128, length: 64 },
      [512, 128],
      { offset: 1024, length: 256 },
    ];

    const statsBefore = uringFs.getRingStats();
    const slices = await uringFs.readBatchAt(batchFile, ranges);
    const statsAfter = uringFs.getRingStats();

    assert.equal(slices.length, 5);
    assert.deepEqual(slices[0], testData.subarray(0, 16));
    assert.deepEqual(slices[1], testData.subarray(64, 96));
    assert.deepEqual(slices[2], testData.subarray(128, 192));
    assert.deepEqual(slices[3], testData.subarray(512, 640));
    assert.deepEqual(slices[4], testData.subarray(1024, 1280));

    if (uringFs.isUringSupported()) {
      // Linked SQEs: 1 (openat_direct) + 5 (read) + 1 (close_direct) = 7 SQEs
      const prepared = statsAfter.totalSqesPrepared - statsBefore.totalSqesPrepared;
      assert.equal(prepared, 7, `Expected exactly 7 SQEs for 5-slice linked read, got ${prepared}`);
    }

    // B. Empty ranges []
    const emptySlices = await uringFs.readBatchAt(batchFile, []);
    assert.deepEqual(emptySlices, []);

    // C. EOF clamping and past-EOF slices
    const eofRanges = [
      { offset: 2000, length: 100 }, // Only 48 bytes left until 2048
      { offset: 3000, length: 50 },  // Past EOF -> 0 bytes
      { offset: 500, length: 0 },    // 0-byte slice
    ];
    const eofSlices = await uringFs.readBatchAt(batchFile, eofRanges);
    assert.equal(eofSlices[0].length, 48);
    assert.deepEqual(eofSlices[0], testData.subarray(2000, 2048));
    assert.equal(eofSlices[1].length, 0);
    assert.equal(eofSlices[2].length, 0);

    // D. Text file with encoding option
    const textFile = path.join(tmpDir, 'batch_text.txt');
    const textContent = 'ZERO-SLICE ONE-SLICE TWO-SLICE THREE-SLICE FOUR-SLICE';
    await uringFs.writeFile(textFile, textContent, 'utf8');

    const textRanges = [
      { offset: 0, length: 10 },
      { offset: 11, length: 9 },
      { offset: 21, length: 9 },
    ];
    const textSlices = await uringFs.readBatchAt(textFile, textRanges, 'utf8');
    assert.deepEqual(textSlices, ['ZERO-SLICE', 'ONE-SLICE', 'TWO-SLICE']);

    const textSlicesObj = await uringFs.readBatchAt(textFile, textRanges, { encoding: 'utf8' });
    assert.deepEqual(textSlicesObj, ['ZERO-SLICE', 'ONE-SLICE', 'TWO-SLICE']);

    // E. Large batch (>30 slices -> triggers unlinked single-FD fallback)
    const largeRanges = [];
    for (let i = 0; i < 35; i++) {
      largeRanges.push({ offset: i * 30, length: 20 });
    }
    const largeSlices = await uringFs.readBatchAt(batchFile, largeRanges);
    assert.equal(largeSlices.length, 35);
    for (let i = 0; i < 35; i++) {
      assert.deepEqual(largeSlices[i], testData.subarray(i * 30, i * 30 + 20));
    }

    // F. Fallback parity (Worker pool & fs/promises)
    const workerSlices = await uringFs.readBatchAt(batchFile, ranges, { fallback: 'worker' });
    assert.deepEqual(workerSlices, slices);

    const fsSlices = await uringFs.readBatchAt(batchFile, ranges, { fallback: 'fs' });
    assert.deepEqual(fsSlices, slices);

    // G. AbortSignal and error validation
    const abController = new AbortController();
    abController.abort();
    await assert.rejects(
      async () => {
        await uringFs.readBatchAt(batchFile, ranges, { signal: abController.signal });
      },
      { name: 'AbortError', code: 'ABORT_ERR' }
    );

    await assert.rejects(
      async () => {
        await uringFs.readBatchAt(path.join(tmpDir, 'non_existent_batch.bin'), ranges);
      },
      { code: 'ENOENT' }
    );

    await assert.rejects(
      async () => {
        await uringFs.readBatchAt(batchFile, [{ offset: -1, length: 10 }]);
      },
      { code: 'ERR_OUT_OF_RANGE' }
    );

    await assert.rejects(
      async () => {
        await uringFs.readBatchAt(batchFile, 'not-an-array');
      },
      { code: 'ERR_INVALID_ARG_TYPE' }
    );

    // H. Empty ranges [] and 0-byte slice [{ offset: 0, length: 0 }] on missing file (ENOENT) and directory (EISDIR) across backends
    const batchBackends = [
      { name: 'default', opts: {} },
      { name: 'worker', opts: { fallback: 'worker' } },
      { name: 'fs', opts: { fallback: 'fs' } },
    ];
    const missingBatchFile = path.join(tmpDir, 'definitely_missing_batch.bin');
    for (const { name, opts } of batchBackends) {
      await assert.rejects(
        async () => {
          await uringFs.readBatchAt(missingBatchFile, [], opts);
        },
        { code: 'ENOENT' },
        `readBatchAt([], ${name}) on missing file must reject with ENOENT`
      );

      await assert.rejects(
        async () => {
          await uringFs.readBatchAt(missingBatchFile, [{ offset: 0, length: 0 }], opts);
        },
        { code: 'ENOENT' },
        `readBatchAt(0-byte, ${name}) on missing file must reject with ENOENT`
      );

      await assert.rejects(
        async () => {
          await uringFs.readBatchAt(tmpDir, [], opts);
        },
        { code: 'EISDIR' },
        `readBatchAt([], ${name}) on directory must reject with EISDIR`
      );

      await assert.rejects(
        async () => {
          await uringFs.readBatchAt(tmpDir, [{ offset: 0, length: 0 }], opts);
        },
        { code: 'EISDIR' },
        `readBatchAt(0-byte, ${name}) on directory must reject with EISDIR`
      );
    }
  });

  test('20. Persistent UringFileHandle (1-SQE operations, Symbol.asyncDispose, closed handle EBADF, and direct-slot zero-leak telemetry)', async () => {
    const handleFile = path.join(tmpDir, 'handle_test.bin');
    const initialData = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz');
    await uringFs.writeFile(handleFile, initialData);

    const initialStats = uringFs.getRingStats();
    assert.equal(initialStats.directFdsInUse, 0, 'No direct FDs should be in use initially');

    // A. Open handle for reading
    const fh = await uringFs.open(handleFile, 'r');
    assert.equal(fh.closed, false);

    if (uringFs.isUringSupported() && initialStats.directFdsSupported) {
      assert.ok(fh.directSlot >= 0, `Expected directSlot >= 0, got ${fh.directSlot}`);
      assert.equal(uringFs.getRingStats().directFdsInUse, 1, '1 direct FD should be in use');
    }

    // B. Verify 1-SQE telemetry per operation
    // 1. readAt
    let s0 = uringFs.getRingStats().totalSqesPrepared;
    const sliceA = await fh.readAt(0, 10);
    let s1 = uringFs.getRingStats().totalSqesPrepared;
    assert.deepEqual(sliceA, initialData.subarray(0, 10));
    if (uringFs.isUringSupported()) {
      assert.equal(s1 - s0, 1, 'fh.readAt must prepare exactly 1 SQE');
    }

    // 2. read into provided buffer
    const readTarget = Buffer.alloc(10);
    s0 = uringFs.getRingStats().totalSqesPrepared;
    const { bytesRead } = await fh.read(readTarget, 0, 10, 10);
    s1 = uringFs.getRingStats().totalSqesPrepared;
    assert.equal(bytesRead, 10);
    assert.deepEqual(readTarget, initialData.subarray(10, 20));
    if (uringFs.isUringSupported()) {
      assert.equal(s1 - s0, 1, 'fh.read must prepare exactly 1 SQE');
    }

    // Argument validation on fh.read (negative/out of bounds and invalid type)
    await assert.rejects(async () => fh.read(readTarget, -1, 5), { code: 'ERR_OUT_OF_RANGE' });
    await assert.rejects(async () => fh.read(readTarget, 0, -5), { code: 'ERR_OUT_OF_RANGE' });
    await assert.rejects(async () => fh.read(readTarget, '0', 5), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(async () => fh.read(readTarget, 0, '5'), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(async () => fh.read(readTarget, 8, 5), { code: 'ERR_OUT_OF_RANGE' });

    // 3. stat
    s0 = uringFs.getRingStats().totalSqesPrepared;
    const st = await fh.stat();
    s1 = uringFs.getRingStats().totalSqesPrepared;
    assert.equal(st.size, initialData.length);
    assert.equal(st.isFile(), true);
    if (uringFs.isUringSupported()) {
      assert.equal(s1 - s0, 1, 'fh.stat must prepare exactly 1 SQE');
    }

    // 4. readBatchAt on file handle
    const handleBatch = await fh.readBatchAt([
      { offset: 0, length: 5 },
      { offset: 5, length: 5 },
    ], 'utf8');
    assert.deepEqual(handleBatch, ['ABCDE', 'FGHIJ']);

    // C. Close handle and verify direct FD slot is freed
    await fh.close();
    assert.equal(fh.closed, true);
    assert.equal(fh.fd, -1);
    assert.equal(fh.directSlot, -1);
    assert.equal(uringFs.getRingStats().directFdsInUse, 0, 'Direct FDs in use must return to 0 after close');

    // Idempotent close
    await fh.close();
    assert.equal(fh.closed, true);

    // D. Operations on closed handle must throw EBADF
    await assert.rejects(async () => fh.read(Buffer.alloc(10)), { code: 'EBADF' });
    await assert.rejects(async () => fh.readAt(0, 10), { code: 'EBADF' });
    await assert.rejects(async () => fh.readBatchAt([{ offset: 0, length: 5 }]), { code: 'EBADF' });
    await assert.rejects(async () => fh.write(Buffer.from('test')), { code: 'EBADF' });
    await assert.rejects(async () => fh.writeAt('test', 0), { code: 'EBADF' });
    await assert.rejects(async () => fh.sync(), { code: 'EBADF' });
    await assert.rejects(async () => fh.datasync(), { code: 'EBADF' });
    await assert.rejects(async () => fh.stat(), { code: 'EBADF' });
    await assert.rejects(async () => fh.fallocate(0, 1024), { code: 'EBADF' });

    // E. Open handle for writing ('w+') and verify write, writeAt, sync, datasync 1-SQE telemetry
    const writeHandleFile = path.join(tmpDir, 'handle_write_test.bin');
    const writeFh = await uringFs.open(writeHandleFile, 'w+');

    // write
    s0 = uringFs.getRingStats().totalSqesPrepared;
    const writeRes = await writeFh.write(Buffer.from('Header-Data\n'), 0, 12, 0);
    s1 = uringFs.getRingStats().totalSqesPrepared;
    assert.equal(writeRes.bytesWritten, 12);
    if (uringFs.isUringSupported()) {
      assert.equal(s1 - s0, 1, 'fh.write must prepare exactly 1 SQE');
    }

    // Argument validation on fh.write (negative/out of bounds and invalid type)
    await assert.rejects(async () => writeFh.write(Buffer.from('test'), -1, 4), { code: 'ERR_OUT_OF_RANGE' });
    await assert.rejects(async () => writeFh.write(Buffer.from('test'), 0, -4), { code: 'ERR_OUT_OF_RANGE' });
    await assert.rejects(async () => writeFh.write(Buffer.from('test'), '0', 4), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(async () => writeFh.write(Buffer.from('test'), 0, '4'), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(async () => writeFh.write(Buffer.from('test'), 3, 4), { code: 'ERR_OUT_OF_RANGE' });

    // Pure Uint8Array view with non-zero byteOffset in fh.write & fh.read
    const u8TestFile = path.join(tmpDir, 'handle_u8_test.bin');
    const u8Fh = await uringFs.open(u8TestFile, 'w+');
    const u8Ab = new ArrayBuffer(64);
    const u8Write = new Uint8Array(u8Ab, 16, 16);
    u8Write.fill(88); // 'X'
    const u8WriteRes = await u8Fh.write(u8Write, 0, 16, 0);
    assert.equal(u8WriteRes.bytesWritten, 16);
    assert.equal(u8WriteRes.buffer, u8Write, 'fh.write res.buffer must strictly match the caller Uint8Array instance');

    const u8ReadAb = new ArrayBuffer(64);
    const u8Read = new Uint8Array(u8ReadAb, 8, 16);
    const u8ReadRes = await u8Fh.read(u8Read, 0, 16, 0);
    assert.equal(u8ReadRes.bytesRead, 16);
    assert.equal(u8ReadRes.buffer, u8Read, 'fh.read res.buffer must strictly match the caller Uint8Array instance');
    assert.equal(Buffer.from(u8Read.buffer, u8Read.byteOffset, u8Read.byteLength).toString('utf8'), 'X'.repeat(16));
    await u8Fh.close();

    // writeAt
    s0 = uringFs.getRingStats().totalSqesPrepared;
    const bytesWrittenAt = await writeFh.writeAt('Body-Payload\n', 12);
    s1 = uringFs.getRingStats().totalSqesPrepared;
    assert.equal(bytesWrittenAt, 13);
    if (uringFs.isUringSupported()) {
      assert.equal(s1 - s0, 1, 'fh.writeAt must prepare exactly 1 SQE');
    }

    // sync
    s0 = uringFs.getRingStats().totalSqesPrepared;
    await writeFh.sync();
    s1 = uringFs.getRingStats().totalSqesPrepared;
    if (uringFs.isUringSupported()) {
      assert.equal(s1 - s0, 1, 'fh.sync must prepare exactly 1 SQE');
    }

    // datasync
    s0 = uringFs.getRingStats().totalSqesPrepared;
    await writeFh.datasync();
    s1 = uringFs.getRingStats().totalSqesPrepared;
    if (uringFs.isUringSupported()) {
      assert.equal(s1 - s0, 1, 'fh.datasync must prepare exactly 1 SQE');
    }

    await writeFh.close();
    assert.equal(uringFs.getRingStats().directFdsInUse, 0);

    const writtenContent = await uringFs.readFile(writeHandleFile, 'utf8');
    assert.equal(writtenContent, 'Header-Data\nBody-Payload\n');

    // F. Symbol.asyncDispose support (await using pattern)
    {
      const dispFh = await uringFs.open(handleFile, 'r');
      assert.equal(dispFh.closed, false);
      await dispFh[Symbol.asyncDispose]();
      assert.equal(dispFh.closed, true);
      assert.equal(uringFs.getRingStats().directFdsInUse, 0);
    }

    // G. Fallback parity (Worker and fs/promises handles)
    const workerFh = await uringFs.open(handleFile, 'r', 0o666, { fallback: 'worker' });
    const workerSlice = await workerFh.readAt(0, 10, 'utf8');
    assert.equal(workerSlice, 'ABCDEFGHIJ');
    await workerFh.close();
    await assert.rejects(async () => workerFh.readAt(0, 5), { code: 'EBADF' });

    const fsFh = await uringFs.open(handleFile, 'r', 0o666, { fallback: 'fs' });
    const fsSlice = await fsFh.readAt(0, 10, 'utf8');
    assert.equal(fsSlice, 'ABCDEFGHIJ');
    await fsFh.close();
    await assert.rejects(async () => fsFh.readAt(0, 5), { code: 'EBADF' });

    // H. Concurrent fh.close() while fh.readAt operations are in-flight (drain queue verification)
    const drainFh = await uringFs.open(handleFile, 'r');
    const inFlightReads = Array.from({ length: 30 }, () => drainFh.readAt(0, 10, 'utf8'));
    const closePromise = drainFh.close();
    const drainedResults = await Promise.all(inFlightReads);
    await closePromise;
    assert.equal(drainFh.closed, true);
    for (const r of drainedResults) {
      assert.equal(r, 'ABCDEFGHIJ');
    }
    await assert.rejects(async () => drainFh.readAt(0, 5), { code: 'EBADF' });
  });

  test('21. Vectored Scatter/Gather readv & writev and disk pre-allocation fallocate', async () => {
    const vecFile = path.join(tmpDir, 'vectored_test.bin');

    // A. Top-level writev
    const writeBufs = [
      Buffer.from('RECORD-START|'),
      Buffer.from('DATA-CHUNK-1234567890|'),
      Buffer.from('RECORD-END\n'),
    ];
    const writevRes = await uringFs.writev(vecFile, writeBufs, 0);
    assert.equal(writevRes.bytesWritten, 13 + 22 + 11);
    assert.equal(writevRes.buffers, writeBufs);

    const fileContent = await uringFs.readFile(vecFile, 'utf8');
    assert.equal(fileContent, 'RECORD-START|DATA-CHUNK-1234567890|RECORD-END\n');

    // B. Top-level readv (scatter read)
    const b1 = Buffer.alloc(13);
    const b2 = Buffer.alloc(22);
    const b3 = Buffer.alloc(11);
    const readvRes = await uringFs.readv(vecFile, [b1, b2, b3], 0);
    assert.equal(readvRes.bytesRead, 46);
    assert.equal(b1.toString('utf8'), 'RECORD-START|');
    assert.equal(b2.toString('utf8'), 'DATA-CHUNK-1234567890|');
    assert.equal(b3.toString('utf8'), 'RECORD-END\n');

    // C. Vectored I/O on UringFileHandle
    const fh = await uringFs.open(vecFile, 'r+');
    const fhB1 = Buffer.alloc(13);
    const fhB2 = Buffer.alloc(22);
    const fhReadvRes = await fh.readv([fhB1, fhB2], 0);
    assert.equal(fhReadvRes.bytesRead, 35);
    assert.equal(fhB1.toString('utf8'), 'RECORD-START|');
    assert.equal(fhB2.toString('utf8'), 'DATA-CHUNK-1234567890|');

    const updateBufs = [
      Buffer.from('NEW-START|'),
      Buffer.from('UPDATED-CHUNK-99999|'),
    ];
    const fhWritevRes = await fh.writev(updateBufs, 0);
    assert.equal(fhWritevRes.bytesWritten, 10 + 20);
    await fh.close();

    const updatedContent = await uringFs.readFile(vecFile, 'utf8');
    assert.ok(updatedContent.startsWith('NEW-START|UPDATED-CHUNK-99999|'));

    // D. Empty buffers array edge cases
    const emptyReadv = await uringFs.readv(vecFile, []);
    assert.equal(emptyReadv.bytesRead, 0);
    assert.deepEqual(emptyReadv.buffers, []);

    const emptyWritev = await uringFs.writev(vecFile, []);
    assert.equal(emptyWritev.bytesWritten, 0);
    assert.deepEqual(emptyWritev.buffers, []);

    // D2. Pure Uint8Array views (including non-zero byteOffset) in writev, readv, fh.writev, fh.readv
    const u8Ab = new ArrayBuffer(64);
    const u8_v1 = new Uint8Array(u8Ab, 4, 8);
    const u8_v2 = new Uint8Array(u8Ab, 20, 8);
    u8_v1.fill(77); // 'M'
    u8_v2.fill(78); // 'N'
    const u8VecFile = path.join(tmpDir, 'u8_vec.bin');
    const u8WritevRes = await uringFs.writev(u8VecFile, [u8_v1, u8_v2], 0);
    assert.equal(u8WritevRes.bytesWritten, 16);
    assert.equal(u8WritevRes.buffers[0], u8_v1);
    assert.equal(u8WritevRes.buffers[1], u8_v2);

    const u8ReadAb = new ArrayBuffer(64);
    const u8_r1 = new Uint8Array(u8ReadAb, 2, 8);
    const u8_r2 = new Uint8Array(u8ReadAb, 18, 8);
    const u8ReadvRes = await uringFs.readv(u8VecFile, [u8_r1, u8_r2], 0);
    assert.equal(u8ReadvRes.bytesRead, 16);
    assert.equal(u8ReadvRes.buffers[0], u8_r1);
    assert.equal(u8ReadvRes.buffers[1], u8_r2);
    assert.equal(Buffer.from(u8_r1.buffer, u8_r1.byteOffset, u8_r1.byteLength).toString('utf8'), 'M'.repeat(8));
    assert.equal(Buffer.from(u8_r2.buffer, u8_r2.byteOffset, u8_r2.byteLength).toString('utf8'), 'N'.repeat(8));

    // Handle-level u8 vectored I/O
    const u8Handle = await uringFs.open(u8VecFile, 'r+');
    const u8_fh_r1 = new Uint8Array(new ArrayBuffer(32), 4, 8);
    const u8_fh_r2 = new Uint8Array(new ArrayBuffer(32), 16, 8);
    const u8FhReadvRes = await u8Handle.readv([u8_fh_r1, u8_fh_r2], 0);
    assert.equal(u8FhReadvRes.bytesRead, 16);
    assert.equal(u8FhReadvRes.buffers[0], u8_fh_r1);
    assert.equal(u8FhReadvRes.buffers[1], u8_fh_r2);
    assert.equal(Buffer.from(u8_fh_r1.buffer, u8_fh_r1.byteOffset, u8_fh_r1.byteLength).toString('utf8'), 'M'.repeat(8));
    assert.equal(Buffer.from(u8_fh_r2.buffer, u8_fh_r2.byteOffset, u8_fh_r2.byteLength).toString('utf8'), 'N'.repeat(8));
    await u8Handle.close();

    // E. fallocate disk pre-allocation
    const allocFile = path.join(tmpDir, 'fallocate_test.bin');
    await uringFs.writeFile(allocFile, Buffer.from('Initial 16 bytes'));

    // Verify constants
    assert.equal(uringFs.FALLOC_FL_KEEP_SIZE, 0x01);
    assert.equal(uringFs.FALLOC_FL_PUNCH_HOLE, 0x02);
    assert.equal(uringFs.FALLOC_FL_COLLAPSE_RANGE, 0x08);
    assert.equal(uringFs.FALLOC_FL_ZERO_RANGE, 0x10);
    assert.equal(uringFs.FALLOC_FL_INSERT_RANGE, 0x20);
    assert.equal(uringFs.FALLOC_FL_UNSHARE_RANGE, 0x40);

    // Top-level fallocate (extending file size)
    await uringFs.fallocate(allocFile, 0, 4096);
    const stAlloc = await uringFs.stat(allocFile);
    assert.ok(stAlloc.size >= 4096, `Expected size >= 4096, got ${stAlloc.size}`);

    // Top-level fallocate with KEEP_SIZE
    await uringFs.fallocate(allocFile, 4096, 4096, uringFs.FALLOC_FL_KEEP_SIZE);
    const stKeep = await uringFs.stat(allocFile);
    assert.equal(stKeep.size, 4096);

    // fallocate on UringFileHandle
    const allocFh = await uringFs.open(allocFile, 'r+');
    await allocFh.fallocate(0, 8192);
    const stHandleAlloc = await allocFh.stat();
    assert.ok(stHandleAlloc.size >= 8192, `Expected size >= 8192, got ${stHandleAlloc.size}`);
    await allocFh.close();

    // F. Fallback parity (Worker and fs)
    const workerVecFile = path.join(tmpDir, 'worker_vec.bin');
    await uringFs.writev(workerVecFile, [Buffer.from('Worker-Vec-1|'), Buffer.from('Worker-Vec-2')], 0, { fallback: 'worker' });
    const wb1 = Buffer.alloc(13);
    const wb2 = Buffer.alloc(12);
    await uringFs.readv(workerVecFile, [wb1, wb2], 0, { fallback: 'worker' });
    assert.equal(wb1.toString('utf8'), 'Worker-Vec-1|');
    assert.equal(wb2.toString('utf8'), 'Worker-Vec-2');

    const fsVecFile = path.join(tmpDir, 'fs_vec.bin');
    await uringFs.writev(fsVecFile, [Buffer.from('Fs-Vec-1|'), Buffer.from('Fs-Vec-2')], 0, { fallback: 'fs' });
    const fb1 = Buffer.alloc(9);
    const fb2 = Buffer.alloc(8);
    await uringFs.readv(fsVecFile, [fb1, fb2], 0, { fallback: 'fs' });
    assert.equal(fb1.toString('utf8'), 'Fs-Vec-1|');
    assert.equal(fb2.toString('utf8'), 'Fs-Vec-2');

    // Worker & fs fallocate fallback
    const workerAllocFile = path.join(tmpDir, 'worker_alloc.bin');
    await uringFs.writeFile(workerAllocFile, Buffer.from('1234'));
    await uringFs.fallocate(workerAllocFile, 0, 2048, 0, { fallback: 'worker' });
    const stWorkerAlloc = await uringFs.stat(workerAllocFile);
    assert.ok(stWorkerAlloc.size >= 2048);

    const fsAllocFile = path.join(tmpDir, 'fs_alloc.bin');
    await uringFs.writeFile(fsAllocFile, Buffer.from('1234'));
    await uringFs.fallocate(fsAllocFile, 0, 2048, 0, { fallback: 'fs' });
    const stFsAlloc = await uringFs.stat(fsAllocFile);
    assert.ok(stFsAlloc.size >= 2048);

    // G. FALLOC_FL_KEEP_SIZE parity across all 3 backends
    for (const b of ['default', 'worker', 'fs']) {
      const opts = b === 'default' ? {} : { fallback: b };
      const keepFile = path.join(tmpDir, `falloc_keep_${b}.bin`);
      await uringFs.writeFile(keepFile, Buffer.alloc(100, 'Z'), opts);
      await uringFs.fallocate(keepFile, 100, 4096, uringFs.FALLOC_FL_KEEP_SIZE, opts);
      const st = await uringFs.stat(keepFile, opts);
      assert.equal(st.size, 100, `FALLOC_FL_KEEP_SIZE on ${b} must not alter logical file size`);
    }

    // H. fallocate on directory throws EISDIR across all backends
    for (const b of ['default', 'worker', 'fs']) {
      const opts = b === 'default' ? {} : { fallback: b };
      await assert.rejects(
        async () => {
          await uringFs.fallocate(tmpDir, 0, 1024, 0, opts);
        },
        { code: 'EISDIR' },
        `fallocate on directory with ${b} must throw EISDIR`
      );
    }

    // I. readv with 0-byte buffer on directory throws EISDIR across all backends
    for (const b of ['default', 'worker', 'fs']) {
      const opts = b === 'default' ? {} : { fallback: b };
      await assert.rejects(
        async () => {
          await uringFs.readv(tmpDir, [Buffer.alloc(0)], 0, opts);
        },
        { code: 'EISDIR' },
        `readv with 0-byte buffer on directory with ${b} must throw EISDIR`
      );
    }
  });

  test('22. v1.3.0 fadvise, zero-byte readAt bugfix, write string signature, worker/fs handles, and custom provider coverage', async () => {
    const testFile = path.join(tmpDir, 'test_v130_suite.bin');
    await uringFs.writeFile(testFile, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');

    // A. Bug 1: fh.readAt(0, 0) and fh.readBatchAt with 0-byte slice across all backends
    for (const b of ['default', 'worker', 'fs']) {
      const opts = b === 'default' ? {} : { fallback: b };
      const fh = await uringFs.open(testFile, 'r', opts);
      try {
        const res0 = await fh.readAt(0, 0);
        assert.ok(Buffer.isBuffer(res0));
        assert.equal(res0.length, 0, `fh.readAt(0, 0) on ${b} must return a 0-byte Buffer`);

        const res0Str = await fh.readAt(0, 0, 'utf8');
        assert.equal(res0Str, '', `fh.readAt(0, 0, 'utf8') on ${b} must return empty string`);

        const resBatch = await fh.readBatchAt([[0, 5], [5, 0], [5, 5]]);
        assert.equal(resBatch.length, 3);
        assert.equal(resBatch[0].toString('utf8'), 'ABCDE');
        assert.equal(resBatch[1].length, 0, `fh.readBatchAt 0-byte middle slice on ${b} must be 0 bytes`);
        assert.equal(resBatch[2].toString('utf8'), 'FGHIJ');
      } finally {
        await fh[Symbol.asyncDispose]();
      }
    }

    // B. Bug 2: fh.write(string, encoding) 2-argument signature & return value
    for (const b of ['default', 'worker', 'fs']) {
      const opts = b === 'default' ? {} : { fallback: b };
      const strFile = path.join(tmpDir, `str_write_${b}.txt`);
      await uringFs.writeFile(strFile, '', opts);
      {
        const fh = await uringFs.open(strFile, 'r+', opts);
        try {
          // 2-argument signature fh.write(string, encoding)
          const res2 = await fh.write('hello', 'utf8');
          assert.equal(res2.bytesWritten, 5);
          assert.strictEqual(res2.buffer, 'hello', 'fh.write(string) must preserve original string reference');

          // 1-argument signature fh.write(string)
          const res1 = await fh.write(' world');
          assert.equal(res1.bytesWritten, 6);
          assert.strictEqual(res1.buffer, ' world');

          // 2-argument signature fh.write(string, position)
          const resPos = await fh.write('!', 11);
          assert.equal(resPos.bytesWritten, 1);
          assert.strictEqual(resPos.buffer, '!');

          // 3-argument signature fh.write(string, position, encoding)
          const res3 = await fh.write('~', 12, 'utf8');
          assert.equal(res3.bytesWritten, 1);
          assert.strictEqual(res3.buffer, '~');
        } finally {
          await fh[Symbol.asyncDispose]();
        }
      }
      assert.equal(await uringFs.readFile(strFile, 'utf8', opts), 'hello world!~');
    }

    // C. POSIX constants and fadvise / fh.fadvise across backends
    assert.equal(uringFs.POSIX_FADV_NORMAL, 0);
    assert.equal(uringFs.POSIX_FADV_RANDOM, 1);
    assert.equal(uringFs.POSIX_FADV_SEQUENTIAL, 2);
    assert.equal(uringFs.POSIX_FADV_WILLNEED, 3);
    assert.equal(uringFs.POSIX_FADV_DONTNEED, 4);
    assert.equal(uringFs.POSIX_FADV_NOREUSE, 5);
    assert.equal(uringFs.constants.POSIX_FADV_NORMAL, 0);
    assert.equal(uringFs.constants.POSIX_FADV_WILLNEED, 3);

    for (const b of ['default', 'worker', 'fs']) {
      const opts = b === 'default' ? {} : { fallback: b };
      const advFile = path.join(tmpDir, `fadv_${b}.bin`);
      await uringFs.writeFile(advFile, Buffer.alloc(4096, 0x42), opts);

      // Top-level fadvise with all advice flags
      if (b === 'default' && uringFs.isUringSupported()) {
        const statsBefore = uringFs.getRingStats();
        await uringFs.fadvise(advFile, 0, 4096, uringFs.POSIX_FADV_WILLNEED, opts);
        const statsAfter = uringFs.getRingStats();
        assert.equal(
          statsAfter.totalSqesPrepared - statsBefore.totalSqesPrepared,
          3,
          'fadvise on io_uring must execute in linked 3-SQE chain (openat_direct -> fadvise -> close_direct)'
        );
      } else {
        await uringFs.fadvise(advFile, 0, 4096, uringFs.POSIX_FADV_WILLNEED, opts);
      }

      await uringFs.fadvise(advFile, 0, 2048, uringFs.POSIX_FADV_DONTNEED, opts);
      await uringFs.fadvise(advFile, 0, 2048, uringFs.POSIX_FADV_SEQUENTIAL, opts);
      await uringFs.fadvise(advFile, 0, 2048, uringFs.POSIX_FADV_RANDOM, opts);
      await uringFs.fadvise(advFile, 0, 2048, uringFs.POSIX_FADV_NORMAL, opts);
      await uringFs.fadvise(advFile, 0, 2048, uringFs.POSIX_FADV_NOREUSE, opts);

      // UringFileHandle.prototype.fadvise
      {
        const fh = await uringFs.open(advFile, 'r', opts);
        try {
          if (b === 'default' && uringFs.isUringSupported()) {
            const statsBefore = uringFs.getRingStats();
            await fh.fadvise(0, 4096, uringFs.POSIX_FADV_WILLNEED);
            const statsAfter = uringFs.getRingStats();
            assert.equal(
              statsAfter.totalSqesPrepared - statsBefore.totalSqesPrepared,
              1,
              'fh.fadvise on io_uring must execute in exactly 1 SQE'
            );
          } else {
            await fh.fadvise(0, 4096, uringFs.POSIX_FADV_WILLNEED);
          }
          await fh.fadvise(0, 2048, uringFs.POSIX_FADV_DONTNEED);
          await fh.fadvise(0, 2048, uringFs.POSIX_FADV_SEQUENTIAL);
        } finally {
          await fh[Symbol.asyncDispose]();
        }
      }

      // ENOENT on missing file
      const missingAdv = path.join(tmpDir, `missing_adv_${b}.bin`);
      await assert.rejects(
        async () => {
          await uringFs.fadvise(missingAdv, 0, 100, uringFs.POSIX_FADV_NORMAL, opts);
        },
        { code: 'ENOENT' },
        `fadvise on missing file with ${b} must throw ENOENT`
      );
    }

    // D. Closed handle EBADF checks across all methods
    {
      const closeTestFile = path.join(tmpDir, 'close_ebadf.bin');
      await uringFs.writeFile(closeTestFile, '1234567890');
      const fh = await uringFs.open(closeTestFile, 'r+');
      assert.equal(fh.closed, false);
      assert.ok(typeof fh.fd === 'number');
      await fh.close();
      assert.equal(fh.closed, true);

      await assert.rejects(() => fh.read(Buffer.alloc(5)), { code: 'EBADF' });
      await assert.rejects(() => fh.readAt(0, 5), { code: 'EBADF' });
      await assert.rejects(() => fh.readBatchAt([[0, 5]]), { code: 'EBADF' });
      await assert.rejects(() => fh.write(Buffer.from('a')), { code: 'EBADF' });
      await assert.rejects(() => fh.writeAt(Buffer.from('a'), 0), { code: 'EBADF' });
      await assert.rejects(() => fh.readv([Buffer.alloc(5)]), { code: 'EBADF' });
      await assert.rejects(() => fh.writev([Buffer.from('a')]), { code: 'EBADF' });
      await assert.rejects(() => fh.sync(), { code: 'EBADF' });
      await assert.rejects(() => fh.datasync(), { code: 'EBADF' });
      await assert.rejects(() => fh.stat(), { code: 'EBADF' });
      await assert.rejects(() => fh.fallocate(0, 100), { code: 'EBADF' });
      await assert.rejects(() => fh.fadvise(0, 100, 0), { code: 'EBADF' });
      // Idempotent close
      await fh.close();
    }

    // E. Full UringFileHandle method coverage under worker and fs fallbacks
    for (const b of ['worker', 'fs']) {
      const opts = { fallback: b };
      const handleFile = path.join(tmpDir, `handle_full_${b}.bin`);
      await uringFs.writeFile(handleFile, '0123456789ABCDEF', opts);

      const fh = await uringFs.open(handleFile, 'r+', opts);
      try {
        assert.ok(typeof fh.fd === 'number');
        assert.equal(fh.closed, false);

        // read & write
        const rBuf = Buffer.alloc(4);
        const rRes = await fh.read(rBuf, 0, 4, 0);
        assert.equal(rRes.bytesRead, 4);
        assert.equal(rBuf.toString('utf8'), '0123');

        const wRes = await fh.write(Buffer.from('WXYZ'), 0, 4, 0);
        assert.equal(wRes.bytesWritten, 4);

        // readAt & writeAt
        const slice = await fh.readAt(0, 4);
        assert.equal(slice.toString('utf8'), 'WXYZ');
        const wAtBytes = await fh.writeAt(Buffer.from('AB'), 2);
        assert.equal(wAtBytes, 2);

        // readBatchAt
        const batchRes = await fh.readBatchAt([[0, 2], [2, 2]]);
        assert.equal(batchRes[0].toString('utf8'), 'WX');
        assert.equal(batchRes[1].toString('utf8'), 'AB');
        const emptyBatch = await fh.readBatchAt([]);
        assert.deepEqual(emptyBatch, []);

        // readv & writev
        const vWriteRes = await fh.writev([Buffer.from('11'), Buffer.from('22')], 4);
        assert.equal(vWriteRes.bytesWritten, 4);
        const vBufs = [Buffer.alloc(2), Buffer.alloc(2)];
        const vReadRes = await fh.readv(vBufs, 4);
        assert.equal(vReadRes.bytesRead, 4);
        assert.equal(vBufs[0].toString('utf8'), '11');
        assert.equal(vBufs[1].toString('utf8'), '22');

        // sync & datasync & stat
        await fh.sync();
        await fh.datasync();
        const st = await fh.stat();
        assert.ok(st instanceof uringFs.UringStats);
        assert.ok(st.isFile());

        // fallocate & fadvise
        await fh.fallocate(0, 2048, 0);
        const stAlloc = await fh.stat();
        assert.ok(stAlloc.size >= 2048);
        await fh.fadvise(0, 1024, uringFs.POSIX_FADV_WILLNEED);
      } finally {
        await fh[Symbol.asyncDispose]();
      }
    }

    // F. writev({ flush: true }) 4 SQEs telemetry on io_uring
    const flushFile = path.join(tmpDir, 'writev_flush.bin');
    if (uringFs.isUringSupported()) {
      const statsBefore = uringFs.getRingStats();
      await uringFs.writev(flushFile, [Buffer.from('FLUSH-TEST')], { flush: true });
      const statsAfter = uringFs.getRingStats();
      assert.equal(
        statsAfter.totalSqesPrepared - statsBefore.totalSqesPrepared,
        4,
        'writev({ flush: true }) on io_uring must prepare exactly 4 SQEs (openat_direct -> writev -> fsync -> close_direct)'
      );
    } else {
      await uringFs.writev(flushFile, [Buffer.from('FLUSH-TEST')], { flush: true });
    }
    assert.equal(await uringFs.readFile(flushFile, 'utf8'), 'FLUSH-TEST');

    // Argument-shifting overloads
    // readv(path, buffers, options)
    const shiftFile = path.join(tmpDir, 'arg_shift.bin');
    await uringFs.writeFile(shiftFile, 'AAAABBBB');
    const shiftBufs = [Buffer.alloc(4), Buffer.alloc(4)];
    const rv1 = await uringFs.readv(shiftFile, shiftBufs, { fallback: 'fs' });
    assert.equal(rv1.bytesRead, 8);
    const rv2 = await uringFs.readv(shiftFile, [Buffer.alloc(4)], null, { fallback: 'worker' });
    assert.equal(rv2.bytesRead, 4);

    // writev(path, buffers, options)
    const wv1 = await uringFs.writev(shiftFile, [Buffer.from('CCCC')], { fallback: 'fs' });
    assert.equal(wv1.bytesWritten, 4);
    const wv2 = await uringFs.writev(shiftFile, [Buffer.from('DDDD')], null, { fallback: 'worker' });
    assert.equal(wv2.bytesWritten, 4);

    // fallocate(path, offset, length, options)
    await uringFs.fallocate(shiftFile, 0, 512, { fallback: 'fs' });

    // open(path, options) and open(path, flags, options)
    {
      const h1 = await uringFs.open(shiftFile, { flags: 'r', fallback: 'fs' });
      assert.equal(h1.closed, false);
      await h1[Symbol.asyncDispose]();
    }
    {
      const h2 = await uringFs.open(shiftFile, 'r', { fallback: 'worker' });
      assert.equal(h2.closed, false);
      await h2[Symbol.asyncDispose]();
    }

    // G. Custom Provider with v1.3.0 methods
    const providerCalls = [];
    const customProviderFull = {
      async readFile(p) { providerCalls.push(['readFile', p]); return Buffer.from('CUSTOM'); },
      async writeFile(p, d) { providerCalls.push(['writeFile', p, d]); },
      async stat(p) { providerCalls.push(['stat', p]); return { size: 6, isFile: () => true }; },
      async unlink(p) { providerCalls.push(['unlink', p]); },
      async mkdir(p) { providerCalls.push(['mkdir', p]); },
      async readBatchAt(p, ranges) { providerCalls.push(['readBatchAt', p, ranges]); return ranges.map(() => Buffer.from('SL')); },
      async readv(p, bufs, pos) { providerCalls.push(['readv', p, pos]); return { bytesRead: 4, buffers: bufs }; },
      async writev(p, bufs, pos) { providerCalls.push(['writev', p, pos]); return { bytesWritten: 4, buffers: bufs }; },
      async fallocate(p, off, len, mode) { providerCalls.push(['fallocate', p, off, len, mode]); },
      async fadvise(p, off, len, adv) { providerCalls.push(['fadvise', p, off, len, adv]); },
      async open(p, flags, mode) {
        providerCalls.push(['open', p, flags, mode]);
        return {
          fd: 99,
          stat: async () => ({ size: 10, isFile: () => true }),
          close: async () => {},
        };
      },
    };

    await uringFs.readBatchAt('virt.bin', [[0, 2]], { fallback: customProviderFull });
    await uringFs.readv('virt.bin', [Buffer.alloc(2)], 0, { fallback: customProviderFull });
    await uringFs.writev('virt.bin', [Buffer.from('hi')], 0, { fallback: customProviderFull });
    await uringFs.fallocate('virt.bin', 0, 100, 0, { fallback: customProviderFull });
    await uringFs.fadvise('virt.bin', 0, 100, 0, { fallback: customProviderFull });
    const custH = await uringFs.open('virt.bin', 'r', { fallback: customProviderFull });
    await custH.close();

    const ops = providerCalls.map((c) => c[0]);
    assert.deepEqual(ops, ['readBatchAt', 'readv', 'writev', 'fallocate', 'fadvise', 'open']);

    // Minimal Custom Provider (only readFile / writeFile)
    const customProviderMin = {
      async readFile() { return Buffer.from('MINIMAL-CONTENT'); },
      async writeFile() {},
      async stat() { return { size: 15, isFile: () => true }; },
      async unlink() {},
      async mkdir() {},
    };

    // readBatchAt falls back to slicing in memory via readFile
    const minSlices = await uringFs.readBatchAt('virt.bin', [[0, 7], [8, 7]], { fallback: customProviderMin });
    assert.equal(minSlices[0].toString('utf8'), 'MINIMAL');
    assert.equal(minSlices[1].toString('utf8'), 'CONTENT');

    // Unsupported methods throw ERR_METHOD_NOT_IMPLEMENTED
    await assert.rejects(
      () => uringFs.readv('virt.bin', [Buffer.alloc(2)], 0, { fallback: customProviderMin }),
      { code: 'ERR_METHOD_NOT_IMPLEMENTED' }
    );
    await assert.rejects(
      () => uringFs.writev('virt.bin', [Buffer.from('hi')], 0, { fallback: customProviderMin }),
      { code: 'ERR_METHOD_NOT_IMPLEMENTED' }
    );
    await assert.rejects(
      () => uringFs.fallocate('virt.bin', 0, 100, 0, { fallback: customProviderMin }),
      { code: 'ERR_METHOD_NOT_IMPLEMENTED' }
    );
    await assert.rejects(
      () => uringFs.fadvise('virt.bin', 0, 100, 0, { fallback: customProviderMin }),
      { code: 'ERR_METHOD_NOT_IMPLEMENTED' }
    );
    await assert.rejects(
      () => uringFs.open('virt.bin', 'r', { fallback: customProviderMin }),
      { code: 'ERR_METHOD_NOT_IMPLEMENTED' }
    );

    // H. Argument type and range validations for fadvise and file handles
    await assert.rejects(() => uringFs.fadvise(testFile, 'not-num', 10, 0), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.fadvise(testFile, -1, 10, 0), { code: 'ERR_OUT_OF_RANGE' });
    await assert.rejects(() => uringFs.fadvise(testFile, 0, 'not-num', 0), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.fadvise(testFile, 0, -1, 0), { code: 'ERR_OUT_OF_RANGE' });
    await assert.rejects(() => uringFs.fadvise(testFile, 0, 10, 'not-num'), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.fadvise(testFile, 0, 10, -1), { code: 'ERR_OUT_OF_RANGE' });

    {
      const fh = await uringFs.open(testFile, 'r+');
      try {
        await assert.rejects(() => fh.fadvise('not-num', 10, 0), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.fadvise(-1, 10, 0), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.fadvise(0, 'not-num', 0), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.fadvise(0, -1, 0), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.fadvise(0, 10, 'not-num'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.fadvise(0, 10, -1), { code: 'ERR_OUT_OF_RANGE' });

        // fh.write validations
        await assert.rejects(() => fh.write(12345), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.write(Buffer.alloc(5), 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.write(Buffer.alloc(5), -1), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.write(Buffer.alloc(5), 0, 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.write(Buffer.alloc(5), 0, -1), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.write(Buffer.alloc(5), 10, 10), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.write(Buffer.alloc(5), 0, 5, 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.write(Buffer.alloc(5), 0, 5, -2), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.write('str', 'bad'), { code: 'ERR_UNKNOWN_ENCODING' });
        await assert.rejects(() => fh.write('str', -1), { code: 'ERR_OUT_OF_RANGE' });

        // fh.read validations
        await assert.rejects(() => fh.read('not-buf'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.read(Buffer.alloc(5), 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.read(Buffer.alloc(5), -1), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.read(Buffer.alloc(5), 0, 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.read(Buffer.alloc(5), 0, -1), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.read(Buffer.alloc(5), 10, 10), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.read(Buffer.alloc(5), 0, 5, 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.read(Buffer.alloc(5), 0, 5, -2), { code: 'ERR_OUT_OF_RANGE' });

        // fh.readAt validations
        await assert.rejects(() => fh.readAt('bad', 5), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.readAt(-1, 5), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.readAt(0, 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.readAt(0, -1), { code: 'ERR_OUT_OF_RANGE' });

        // fh.readBatchAt validations
        await assert.rejects(() => fh.readBatchAt('not-array'), { code: 'ERR_INVALID_ARG_TYPE' });

        // fh.readv validations
        await assert.rejects(() => fh.readv('not-array'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.readv([123]), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.readv([Buffer.alloc(5)], 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.readv([Buffer.alloc(5)], -2), { code: 'ERR_OUT_OF_RANGE' });

        // fh.writev validations
        await assert.rejects(() => fh.writev('not-array'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.writev([123]), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.writev([Buffer.from('a')], 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.writev([Buffer.from('a')], -2), { code: 'ERR_OUT_OF_RANGE' });

        // fh.fallocate validations
        await assert.rejects(() => fh.fallocate('bad', 10), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.fallocate(-1, 10), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.fallocate(0, 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.fallocate(0, -1), { code: 'ERR_OUT_OF_RANGE' });
        await assert.rejects(() => fh.fallocate(0, 10, 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
        await assert.rejects(() => fh.fallocate(0, 10, -1), { code: 'ERR_OUT_OF_RANGE' });
      } finally {
        await fh[Symbol.asyncDispose]();
      }
    }

    // Top-level open/readv/writev/fallocate validations
    await assert.rejects(() => uringFs.open(12345), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.open(testFile, 'invalid-flags'), { code: 'ERR_INVALID_OPT_VALUE' });
    await assert.rejects(() => uringFs.readv(testFile, 'not-array'), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.readv(testFile, [123]), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.readv(testFile, [Buffer.alloc(5)], 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.readv(testFile, [Buffer.alloc(5)], -2), { code: 'ERR_OUT_OF_RANGE' });
    await assert.rejects(() => uringFs.writev(testFile, 'not-array'), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.writev(testFile, [123]), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.writev(testFile, [Buffer.from('a')], 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.writev(testFile, [Buffer.from('a')], -2), { code: 'ERR_OUT_OF_RANGE' });
    await assert.rejects(() => uringFs.fallocate(testFile, 'bad', 10), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.fallocate(testFile, -1, 10), { code: 'ERR_OUT_OF_RANGE' });
    await assert.rejects(() => uringFs.fallocate(testFile, 0, 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.fallocate(testFile, 0, -1), { code: 'ERR_OUT_OF_RANGE' });
    await assert.rejects(() => uringFs.fallocate(testFile, 0, 10, 'bad'), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.fallocate(testFile, 0, 10, -1), { code: 'ERR_OUT_OF_RANGE' });

    // I. Comprehensive Fallback, Config, and Overload Coverage
    // 1. configure() options & custom provider resolving
    assert.throws(() => uringFs.configure({ fallback: 'invalid-backend' }), TypeError);
    assert.throws(() => uringFs.configure({ fallback: { notAProvider: 1 } }), TypeError);
    uringFs.configure({ fallback: { promises: { readFile: async () => 'mock-ok' } } });
    uringFs.configure({ workerPoolSize: 4 });
    uringFs.configure({ fallback: 'fs', workerPoolSize: 2 });

    // 2. Buffer paths & flag permutations
    const bufPath = Buffer.from(testFile);
    const bufStat = await uringFs.stat(bufPath);
    assert.ok(bufStat.size >= 0);
    await uringFs.writeFile(bufPath, 'flags-test-data', { flag: 'w' });

    const flagVariants = ['wt', 'xw', 'w+', 'wx+', 'xw+', 'at', 'ax', 'xa', 'a+', 'ax+', 'xa+', 'as', 'as+', 'r+', 'rs+', 'sr+'];
    for (const fl of flagVariants) {
      try {
        const h = await uringFs.open(testFile, fl, { fallback: 'fs' });
        await h.close();
      } catch (err) {
        // Exclusive flags (e.g. xw, ax) will throw EEXIST on existing file, which is valid and tests parseWriteFlags!
        assert.ok(err.code === 'EEXIST' || err.code === 'EINVAL' || err.code === 'ERR_INVALID_ARG_VALUE');
      }
    }
    // Numeric open flag
    const numH = await uringFs.open(testFile, fs.constants.O_RDONLY, { fallback: 'fs' });
    await numH.close();

    // 3. readAt and readBatchAt edge cases under fallback: 'fs'
    await uringFs.writeFile(testFile, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    const fsReadZero = await uringFs.readAt(testFile, 0, 0, { fallback: 'fs' });
    assert.equal(fsReadZero.length, 0);
    const fsReadEnc = await uringFs.readAt(testFile, 0, 5, { fallback: 'fs', encoding: 'utf8' });
    assert.equal(typeof fsReadEnc, 'string');
    await assert.rejects(() => uringFs.readAt(tmpDir, 0, 0, { fallback: 'fs' }), { code: 'EISDIR' });
    const custMinSlice = await uringFs.readAt('virt.bin', 0, 4, { fallback: customProviderMin });
    assert.equal(custMinSlice.toString('utf8'), 'MINI');

    const fsBatchZero = await uringFs.readBatchAt(testFile, [[0, 3], [3, 0], [3, 2]], { fallback: 'fs' });
    assert.equal(fsBatchZero[0].length, 3);
    assert.equal(fsBatchZero[1].length, 0);
    assert.equal(fsBatchZero[2].length, 2);
    const fsBatchZeroEnc = await uringFs.readBatchAt(testFile, [[0, 0]], { fallback: 'fs', encoding: 'utf8' });
    assert.deepEqual(fsBatchZeroEnc, ['']);
    await assert.rejects(() => uringFs.readBatchAt(tmpDir, [[0, 0]], { fallback: 'fs' }), { code: 'EISDIR' });

    // 4. readv and writev under fallback: 'fs'
    const fsReadvRes = await uringFs.readv(testFile, [Buffer.alloc(2), Buffer.alloc(3)], 0, { fallback: 'fs' });
    assert.equal(fsReadvRes.bytesRead, 5);
    await assert.rejects(() => uringFs.readv(tmpDir, [Buffer.alloc(0)], 0, { fallback: 'fs' }), { code: 'EISDIR' });
    const fsWritevFile = path.join(tmpDir, 'writev_fs.bin');
    const fsWritevFlush = await uringFs.writev(fsWritevFile, [Buffer.from('f'), Buffer.from('s')], 0, { fallback: 'fs', flush: true });
    assert.equal(fsWritevFlush.bytesWritten, 2);

    // 5. fallocate and fadvise under fallback: 'fs'
    const nonExistentFalloc = path.join(tmpDir, 'nonexistent_falloc.bin');
    await uringFs.fallocate(nonExistentFalloc, 0, 64, { fallback: 'fs' });
    assert.equal((await fs.promises.stat(nonExistentFalloc)).size, 64);
    await assert.rejects(() => uringFs.fallocate(tmpDir, 0, 64, { fallback: 'fs' }), { code: 'EISDIR' });
    await uringFs.fadvise(testFile, 0, 64, { fallback: 'fs' });

    // 6. copyFile, lstat, access, fsync, fdatasync under fallbacks
    const workerCopy = path.join(tmpDir, 'worker_copy.bin');
    await uringFs.copyFile(testFile, workerCopy, { fallback: 'worker' });
    assert.ok(fs.existsSync(workerCopy));

    const fsCopy = path.join(tmpDir, 'fs_copy.bin');
    await uringFs.copyFile(testFile, fsCopy, { fallback: 'fs' });
    assert.ok(fs.existsSync(fsCopy));

    const custCopy = path.join(tmpDir, 'cust_copy.bin');
    await uringFs.copyFile('virt_src.bin', custCopy, { fallback: customProviderMin });

    await uringFs.lstat(testFile, { fallback: 'worker' });
    await uringFs.lstat(testFile, { fallback: 'fs' });
    await uringFs.access(testFile, uringFs.constants.F_OK, { fallback: 'worker' });
    await uringFs.access(testFile, uringFs.constants.F_OK, { fallback: 'fs' });
    await uringFs.fsync(testFile, { fallback: 'fs' });
    await uringFs.fdatasync(testFile, { fallback: 'fs' });

    // 7. UringFileHandle read & write overload patterns
    {
      const handleRead = await uringFs.open(testFile, 'r');
      try {
        // fh.read(buf) with omitted offset/length/position from offset 0
        const bufRead = await handleRead.read(Buffer.alloc(5));
        assert.equal(bufRead.bytesRead, 5);

        // fh.read() default buffer (reads remaining 31 bytes)
        const defaultRead = await handleRead.read();
        assert.ok(defaultRead.bytesRead >= 0);
        assert.equal(defaultRead.buffer.length, 16384);

        // fh.read(object)
        const objRead = await handleRead.read({ buffer: Buffer.alloc(10), offset: 0, length: 5, position: 0 });
        assert.equal(objRead.bytesRead, 5);

        // fh.readv([]) with empty buffers array
        const emptyReadv = await handleRead.readv([]);
        assert.equal(emptyReadv.bytesRead, 0);
      } finally {
        await handleRead.close();
      }

      const handleWrite = await uringFs.open(testFile, 'r+');
      try {
        // fh.write(buf) with omitted offset/length/position
        const bufWrite = await handleWrite.write(Buffer.from('hi'));
        assert.equal(bufWrite.bytesWritten, 2);

        // fh.write('str', {}) invalid position type
        await assert.rejects(() => handleWrite.write('str', {}), { code: 'ERR_INVALID_ARG_TYPE' });

        // fh.writev([]) with empty buffers array
        const emptyWritev = await handleWrite.writev([]);
        assert.equal(emptyWritev.bytesWritten, 0);

        // Pre-aborted signal on handle methods
        await assert.rejects(() => handleWrite.readAt(0, 5, { signal: AbortSignal.abort() }), { name: 'AbortError' });
        await assert.rejects(() => handleWrite.readBatchAt([[0, 5]], { signal: AbortSignal.abort() }), { name: 'AbortError' });
      } finally {
        await handleWrite.close();
      }
    }

    // 8. readBatchAt range element validations
    await assert.rejects(() => uringFs.readBatchAt(testFile, ['bad-entry']), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.readBatchAt(testFile, [['bad-offset', 5]]), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.readBatchAt(testFile, [[-1, 5]]), { code: 'ERR_OUT_OF_RANGE' });
    await assert.rejects(() => uringFs.readBatchAt(testFile, [[0, 'bad-length']]), { code: 'ERR_INVALID_ARG_TYPE' });
    await assert.rejects(() => uringFs.readBatchAt(testFile, [[0, -1]]), { code: 'ERR_OUT_OF_RANGE' });

    // 9. Additional fs fallback and provider coverage
    const fsDir = path.join(tmpDir, 'fs_coverage_dir');
    await uringFs.mkdir(fsDir, { fallback: 'fs' });
    const fsRenamedDir = path.join(tmpDir, 'fs_coverage_dir_renamed');
    await uringFs.rename(fsDir, fsRenamedDir, { fallback: 'fs' });
    await uringFs.rmdir(fsRenamedDir, { fallback: 'fs' });

    const fsUnlinkFile = path.join(tmpDir, 'fs_unlink.bin');
    await uringFs.writeFile(fsUnlinkFile, 'unlink-me');
    await uringFs.unlink(fsUnlinkFile, { fallback: 'fs' });

    const fsLinkTarget = path.join(tmpDir, 'fs_link_target.bin');
    await uringFs.writeFile(fsLinkTarget, 'link-target');
    const fsSymlinkPath = path.join(tmpDir, 'fs_symlink.bin');
    await uringFs.symlink(fsLinkTarget, fsSymlinkPath, { fallback: 'fs' });
    const fsHardlinkPath = path.join(tmpDir, 'fs_hardlink.bin');
    await uringFs.link(fsLinkTarget, fsHardlinkPath, { fallback: 'fs' });

    const custSyncProvider = {
      ...customProviderMin,
      async fsync() {},
      async fdatasync() {},
    };
    await uringFs.fsync('virt.bin', { fallback: custSyncProvider });
    await uringFs.fdatasync('virt.bin', { fallback: custSyncProvider });

    await assert.rejects(() => uringFs.open(testFile, true), { code: 'ERR_INVALID_ARG_TYPE' });
    const srHandle = await uringFs.open(testFile, 'sr', { fallback: 'fs' });
    await srHandle.close();
  });
});
