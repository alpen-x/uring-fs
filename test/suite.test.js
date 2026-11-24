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
    const finalStats = uringFs.getRingStats();
    assert.equal(finalStats.activeRequests, 0, 'Expected 0 activeRequests at test suite end');
    assert.equal(finalStats.inFlightSqes, 0, 'Expected 0 inFlightSqes at test suite end');
    assert.equal(finalStats.directFdsInUse, 0, 'Expected 0 directFdsInUse at test suite end');
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

  test('23. v1.3.2 Static liburing.a, Hidden ELF Symbols, detectLibc, and Prebuilds Fast-Path', async () => {
    const { spawnSync } = require('node:child_process');

    // A. detectLibc verification
    assert.equal(typeof uringFs.detectLibc, 'function');
    const libc = uringFs.detectLibc();
    if (process.platform === 'linux') {
      assert.ok(libc === 'glibc' || libc === 'musl', `Expected 'glibc' or 'musl', got ${libc}`);
    } else {
      assert.equal(libc, null);
    }

    // B. Prebuilds resolution & scripts/install.js fast-path verification on Linux
    if (process.platform === 'linux') {
      const prebuildPath = path.join(__dirname, '..', 'prebuilds', `linux-${process.arch}`, `uring_fs.${libc}.node`);
      const buildPath = path.join(__dirname, '..', 'build', 'Release', 'uring_fs.node');
      let createdTempPrebuild = false;
      if (fs.existsSync(buildPath) && !fs.existsSync(prebuildPath)) {
        fs.mkdirSync(path.dirname(prebuildPath), { recursive: true });
        fs.copyFileSync(buildPath, prebuildPath);
        createdTempPrebuild = true;
      }

      try {
        if (fs.existsSync(prebuildPath)) {
          const installScript = path.join(__dirname, '..', 'scripts', 'install.js');
          const cleanEnv = {
            ...process.env,
            URING_FS_BUILD_FROM_SOURCE: '0',
            URING_FS_IGNORE_PREBUILDS: '0',
            URING_FS_MARCH_NATIVE: '0',
            npm_config_build_from_source: '',
            npm_config_march_native: '',
          };
          const installRes = spawnSync(process.execPath, [installScript], {
            cwd: path.join(__dirname, '..'),
            env: cleanEnv,
            encoding: 'utf8',
          });
          assert.equal(installRes.status, 0);
          assert.match(installRes.stdout, /\[uring-fs\] Using prebuilt native binary/);

          // Verify loading solely from prebuilds when URING_FS_PREBUILD_ONLY=1
          const prebuildOnlyRes = spawnSync(
            process.execPath,
            ['-e', 'const u = require("./index.js"); console.log("SUPPORTED:", u.isUringSupported());'],
            {
              cwd: path.join(__dirname, '..'),
              env: { ...cleanEnv, URING_FS_PREBUILD_ONLY: '1' },
              encoding: 'utf8',
            }
          );
          assert.equal(prebuildOnlyRes.status, 0);
          assert.match(prebuildOnlyRes.stdout, /SUPPORTED: (true|false)/);
        }
      } finally {
        if (createdTempPrebuild && fs.existsSync(prebuildPath)) {
          try {
            fs.unlinkSync(prebuildPath);
          } catch {}
        }
      }

      // C. Static liburing.a & ELF dynamic symbol hiding (0 exported io_uring_* symbols)
      if (fs.existsSync(buildPath)) {
        const nmRes = spawnSync('nm', ['-D', buildPath], { encoding: 'utf8' });
        if (nmRes.status === 0) {
          const leakedUringSymbols = nmRes.stdout
            .split('\n')
            .filter((line) => line.includes('io_uring_'));
          assert.equal(
            leakedUringSymbols.length,
            0,
            `Expected 0 exported io_uring_* symbols in .dynsym, found: ${leakedUringSymbols.join(', ')}`
          );
        }
      }
    }
  });

  test('24. Modular JS layers (lib/libc.js, lib/validators.js, lib/stats.js, lib/worker_script.js) and install side-effect isolation', async () => {
    const { spawnSync } = require('node:child_process');
    const { detectLibc } = require('../lib/libc');
    const { UringStats } = require('../lib/stats');
    const validators = require('../lib/validators');

    // A. lib/libc.js works standalone and scripts/install.js does not require('../index.js')
    assert.equal(detectLibc(), uringFs.detectLibc());
    const installSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install.js'), 'utf8');
    assert.ok(!installSrc.includes("require('../index.js')"), 'scripts/install.js must not load index.js');
    assert.ok(installSrc.includes("require('../lib/libc')"), 'scripts/install.js must import lib/libc');

    // Verify in a fresh process that requiring lib/libc.js does not load index.js or .node addon
    const isolationCheck = spawnSync(
      process.execPath,
      [
        '-e',
        'const { detectLibc } = require("./lib/libc"); detectLibc(); const loaded = Object.keys(require.cache); console.log(JSON.stringify(loaded));',
      ],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' }
    );
    assert.equal(isolationCheck.status, 0);
    const cachedFiles = JSON.parse(isolationCheck.stdout.trim());
    assert.ok(
      !cachedFiles.some((f) => f.endsWith(`${path.sep}index.js`) || f.endsWith('.node')),
      `Requiring lib/libc.js must not load index.js or native .node addon: ${cachedFiles.join(', ')}`
    );

    // B. lib/validators.js unit coverage
    assert.equal(validators.normalizePath('/tmp/abc'), '/tmp/abc');
    assert.equal(validators.normalizePath(Buffer.from('/tmp/buf')), '/tmp/buf');
    assert.equal(validators.normalizePath(new URL('file:///tmp/url')), '/tmp/url');
    assert.throws(() => validators.normalizePath(123), { code: 'ERR_INVALID_ARG_TYPE' });

    assert.doesNotThrow(() => validators.validateEncoding('utf8'));
    assert.doesNotThrow(() => validators.validateEncoding(null));
    assert.throws(() => validators.validateEncoding('invalid-enc'), { code: 'ERR_INVALID_ARG_VALUE' });

    assert.equal(validators.parseOpenFlags('r'), fs.constants.O_RDONLY);
    assert.equal(validators.parseWriteFlags('w'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC);
    assert.throws(() => validators.parseWriteFlags('badflag'), { code: 'ERR_INVALID_OPT_VALUE' });

    const enoentErr = validators.createErrnoError('ENOENT', 'open', '/missing');
    assert.equal(enoentErr.code, 'ENOENT');
    assert.equal(enoentErr.errno, -2);
    assert.equal(enoentErr.path, '/missing');

    const abortErr = validators.createAbortError({ reason: 'stopped' });
    assert.equal(abortErr.code, 'ABORT_ERR');
    assert.equal(abortErr.cause, 'stopped');

    const wrappedOk = await validators.wrapWithAbortSignal(Promise.resolve(42), null);
    assert.equal(wrappedOk, 42);
    await assert.rejects(
      () => validators.wrapWithAbortSignal(new Promise(() => {}), AbortSignal.abort()),
      { code: 'ABORT_ERR' }
    );

    assert.deepEqual(validators.parseBatchRanges([[0, 5], { offset: 10, length: 2 }]), [
      { offset: 0, length: 5 },
      { offset: 10, length: 2 },
    ]);
    assert.throws(() => validators.parseBatchRanges('nope'), { code: 'ERR_INVALID_ARG_TYPE' });
    assert.throws(() => validators.parseBatchRanges([[-1, 5]]), { code: 'ERR_OUT_OF_RANGE' });

    // C. lib/stats.js export parity
    assert.equal(UringStats, uringFs.UringStats);

    // D. lib/worker_script.js file exists and worker_fallback.js does not use { eval: true }
    const workerScriptPath = path.join(__dirname, '..', 'lib', 'worker_script.js');
    assert.ok(fs.existsSync(workerScriptPath), 'lib/worker_script.js must exist');
    const workerFallbackSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'worker_fallback.js'), 'utf8');
    assert.ok(!workerFallbackSrc.includes('eval: true'), 'lib/worker_fallback.js must not use { eval: true }');

    // E. Worker writeFile honors options.flush
    const workerFlushFile = path.join(tmpDir, 'worker_flush_test.txt');
    await uringFs.writeFile(workerFlushFile, 'flushed-via-worker', { fallback: 'worker', flush: true });
    const workerFlushRead = await uringFs.readFile(workerFlushFile, { fallback: 'worker', encoding: 'utf8' });
    assert.equal(workerFlushRead, 'flushed-via-worker');
    await uringFs.closeFallbackWorkers();
  });

  test('25. DedicatedWorkerPool.resize(), parallel fh.readBatchAt, and C++ ArrayBufferView/ReadBatchAt validation', async () => {
    const { DedicatedWorkerPool } = require('../lib/worker_fallback');

    // A. DedicatedWorkerPool.resize() grow, shrink idle, shrink busy, and configure({ workerPoolSize })
    const poolTestFile = path.join(tmpDir, 'pool_resize_test.txt');
    await uringFs.writeFile(poolTestFile, 'resize-payload');

    const pool = new DedicatedWorkerPool(2);
    try {
      assert.equal(await pool.exec('readFile', [poolTestFile, 'utf8'], 'utf8'), 'resize-payload');
      assert.equal(pool.workers.length, 2);

      // Grow from 2 to 4
      await pool.resize(4);
      assert.equal(pool.poolSize, 4);
      assert.equal(pool.workers.length, 4);

      // Shrink from 4 to 1 while busy
      const busyReads = [];
      for (let i = 0; i < 8; i++) {
        busyReads.push(pool.exec('readFile', [poolTestFile, 'utf8'], 'utf8'));
      }
      const resizePromise = pool.resize(1);
      assert.equal(pool.poolSize, 1);
      assert.equal(pool.workers.length, 1);

      const results = await Promise.all(busyReads);
      assert.equal(results.length, 8);
      for (const r of results) {
        assert.equal(r, 'resize-payload');
      }
      await resizePromise;

      // Invalid resize values throw RangeError
      assert.throws(() => pool.resize(0), { code: 'ERR_OUT_OF_RANGE' });
      assert.throws(() => pool.resize(NaN), { code: 'ERR_OUT_OF_RANGE' });
    } finally {
      await pool.terminate();
    }

    // configure({ workerPoolSize }) invokes pool.resize()
    try {
      uringFs.configure({ workerPoolSize: 3 });
      assert.equal(await uringFs.readFile(poolTestFile, { fallback: 'worker', encoding: 'utf8' }), 'resize-payload');
      const cfg = uringFs.configure({ workerPoolSize: 1 });
      assert.equal(cfg.workerPoolSize, 1);
      assert.equal(await uringFs.readFile(poolTestFile, { fallback: 'worker', encoding: 'utf8' }), 'resize-payload');
    } finally {
      uringFs.configure({ workerPoolSize: 2 });
      await uringFs.closeFallbackWorkers();
    }

    // B. Parallel UringFileHandle.prototype.readBatchAt batches SQEs into 1 submit syscall
    const batchFhFile = path.join(tmpDir, 'fh_parallel_batch.bin');
    const payload = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await uringFs.writeFile(batchFhFile, payload);

    const fh = await uringFs.open(batchFhFile, 'r');
    try {
      const ranges = [
        [0, 5],
        [5, 5],
        [10, 6],
        { offset: 16, length: 10 },
        { offset: 26, length: 10 },
      ];
      const before = uringFs.getRingStats();
      const slices = await fh.readBatchAt(ranges);
      const after = uringFs.getRingStats();

      assert.deepEqual(slices.map((b) => b.toString('utf8')), [
        '01234',
        '56789',
        'ABCDEF',
        'GHIJKLMNOP',
        'QRSTUVWXYZ',
      ]);

      if (uringFs.isUringSupported()) {
        const submits = after.totalSubmitSyscalls - before.totalSubmitSyscalls;
        const prepared = after.totalSqesPrepared - before.totalSqesPrepared;
        assert.equal(prepared, 5, `Expected 5 prepared SQEs, got ${prepared}`);
        assert.equal(submits, 1, `Expected all 5 fh.readBatchAt SQEs in 1 submit syscall, got ${submits}`);
      }
    } finally {
      await fh.close();
    }

    // Worker fallback fh.readBatchAt
    const workerFh = await uringFs.open(batchFhFile, 'r', { fallback: 'worker' });
    try {
      const wSlices = await workerFh.readBatchAt([[0, 5], [10, 3]], 'utf8');
      assert.deepEqual(wSlices, ['01234', 'ABC']);
    } finally {
      await workerFh.close();
    }

    // C. ArrayBufferView (Uint16Array & DataView) in writev, readv, fh.writev, fh.readv
    const abvFile = path.join(tmpDir, 'abv_vectored.bin');
    const u16Write = new Uint16Array([0x4241, 0x4443]); // 'ABCD' on little-endian
    const dvRaw = new ArrayBuffer(8);
    const dvWrite = new DataView(dvRaw, 2, 4);
    dvWrite.setUint8(0, 69); // 'E'
    dvWrite.setUint8(1, 70); // 'F'
    dvWrite.setUint8(2, 71); // 'G'
    dvWrite.setUint8(3, 72); // 'H'

    const wvRes = await uringFs.writev(abvFile, [u16Write, dvWrite], 0);
    assert.equal(wvRes.bytesWritten, 8);

    const u16Read = new Uint16Array(2);
    const dvRead = new DataView(new ArrayBuffer(4));
    const rvRes = await uringFs.readv(abvFile, [u16Read, dvRead], 0);
    assert.equal(rvRes.bytesRead, 8);
    assert.deepEqual(u16Read, u16Write);
    assert.equal(dvRead.getUint8(0), 69);
    assert.equal(dvRead.getUint8(3), 72);

    const abvFh = await uringFs.open(abvFile, 'r+');
    try {
      const u16FhWrite = new Uint16Array([0x5a59]); // 'YZ'
      const fhWv = await abvFh.writev([u16FhWrite], 0);
      assert.equal(fhWv.bytesWritten, 2);

      const dvFhRead = new DataView(new ArrayBuffer(4));
      const fhRv = await abvFh.readv([dvFhRead], 0);
      assert.equal(fhRv.bytesRead, 4);
      assert.equal(Buffer.from(dvFhRead.buffer).subarray(0, 2).toString('utf8'), 'YZ');
    } finally {
      await abvFh.close();
    }

    // D. Native ReadBatchAtUring validation directly (if build/Release/uring_fs.node is compiled with liburing)
    const nativeAddonPath = path.join(__dirname, '..', 'build', 'Release', 'uring_fs.node');
    if (!process.env.URING_FS_DISABLE_NATIVE && fs.existsSync(nativeAddonPath)) {
      const native = require(nativeAddonPath);
      if (typeof native.readBatchAt === 'function') {
        assert.throws(() => native.readBatchAt(batchFhFile, [0, 10], [5]), RangeError);
        assert.throws(() => native.readBatchAt(batchFhFile, ['bad'], [5]), TypeError);
        assert.throws(() => native.readBatchAt(batchFhFile, [0], ['bad']), TypeError);
        assert.throws(() => native.readBatchAt(batchFhFile, [-1], [5]), RangeError);
        assert.throws(() => native.readBatchAt(batchFhFile, [0], [-5]), RangeError);
      }
    }
  });

  test('26. Core modularization, DataView/Uint16Array fh.read/write, empty readBatchAt encoding check, worker DataCloneError cleanup, and npm pack check', async () => {
    const { spawnSync } = require('node:child_process');
    const { DedicatedWorkerPool } = require('../lib/worker_fallback');

    // A. fh.read and fh.write with DataView and Uint16Array (io_uring + fs fallback)
    const abvHandleFile = path.join(tmpDir, 'fh_abv_rw.bin');
    for (const opts of [{}, { fallback: 'fs' }]) {
      const fh = await uringFs.open(abvHandleFile, 'w+', 0o666, opts);
      try {
        const u16In = new Uint16Array([0x4241, 0x4443]); // 'ABCD'
        const w1 = await fh.write(u16In, 0, 4, 0);
        assert.equal(w1.bytesWritten, 4);
        assert.equal(w1.buffer, u16In);

        const dvInBuf = new ArrayBuffer(8);
        const dvIn = new DataView(dvInBuf, 2, 4);
        dvIn.setUint8(0, 69); // 'E'
        dvIn.setUint8(1, 70); // 'F'
        dvIn.setUint8(2, 71); // 'G'
        dvIn.setUint8(3, 72); // 'H'
        const w2 = await fh.write(dvIn, 0, 4, 4);
        assert.equal(w2.bytesWritten, 4);
        assert.equal(w2.buffer, dvIn);

        const u16Out = new Uint16Array(2);
        const r1 = await fh.read(u16Out, 0, 4, 0);
        assert.equal(r1.bytesRead, 4);
        assert.equal(r1.buffer, u16Out);
        assert.deepEqual(u16Out, u16In);

        const dvOutBuf = new ArrayBuffer(8);
        const dvOut = new DataView(dvOutBuf, 2, 4);
        const r2 = await fh.read(dvOut, 0, 4, 4);
        assert.equal(r2.bytesRead, 4);
        assert.equal(r2.buffer, dvOut);
        assert.equal(Buffer.from(dvOut.buffer, dvOut.byteOffset, dvOut.byteLength).toString('utf8'), 'EFGH');

        // B. fh.readBatchAt([], 'invalid-encoding') rejects with ERR_INVALID_ARG_VALUE
        await assert.rejects(
          () => fh.readBatchAt([], 'invalid-encoding'),
          (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_VALUE'
        );
      } finally {
        await fh.close();
      }
    }

    // C. C++ IOV_MAX > 1024 and detached ArrayBufferView guards
    if (uringFs.isUringSupported()) {
      const iovFile = path.join(tmpDir, 'iov_max_guard.bin');
      await uringFs.writeFile(iovFile, 'test');
      const tooManyBufs = Array.from({ length: 1025 }, () => Buffer.alloc(1));
      await assert.rejects(
        () => uringFs.readv(iovFile, tooManyBufs, 0),
        (err) => err instanceof RangeError && err.code === 'ERR_OUT_OF_RANGE'
      );

      if (typeof ArrayBuffer.prototype.transfer === 'function') {
        const { getNative } = require('../lib/backend');
        const native = getNative();
        const detachedAb = new ArrayBuffer(16);
        const detachedDv = new DataView(detachedAb);
        detachedAb.transfer();
        assert.throws(
          () => native.writev(iovFile, [detachedDv], 0),
          (err) => err && (err.code === 'EINVAL' || err.errno === -22)
        );
      }
    }

    // D. DedicatedWorkerPool.exec() handles DataCloneError without leaking activeCount or pending
    const pool = new DedicatedWorkerPool(1);
    try {
      await assert.rejects(
        () => pool.exec('writeFile', [path.join(tmpDir, 'uncloneable.txt'), () => {}]),
        (err) => err && (err.name === 'DataCloneError' || /could not be cloned/i.test(err.message))
      );
      assert.equal(pool.pending.size, 0);
      assert.equal(pool.workers[0].activeCount, 0);

      // Pool remains healthy for subsequent operations
      const okFile = path.join(tmpDir, 'after_dataclone.txt');
      await pool.exec('writeFile', [okFile, 'still-alive', { encoding: 'utf8' }]);
      assert.equal(await pool.exec('readFile', [okFile, 'utf8'], 'utf8'), 'still-alive');
    } finally {
      await pool.terminate();
    }

    // E. Verify all modular src/internal/*.hpp and lib/*.js files appear in npm pack --dry-run
    const packRes = spawnSync('npm', ['pack', '--dry-run'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });
    assert.equal(packRes.status, 0);
    const packOutput = `${packRes.stdout}\n${packRes.stderr}`;
    const expectedFiles = [
      'src/addon.cc',
      'src/internal/uring_compat.hpp',
      'src/internal/ring_types.hpp',
      'src/internal/ring_state.hpp',
      'src/internal/scheduler.hpp',
      'src/internal/completions_linked.hpp',
      'src/internal/completions_stages.hpp',
      'src/internal/ring_loop.hpp',
      'src/internal/napi_ops_path.hpp',
      'src/internal/napi_ops_handle.hpp',
      'index.js',
      'lib/libc.js',
      'lib/constants.js',
      'lib/stats.js',
      'lib/validators.js',
      'lib/worker_fallback.js',
      'lib/worker_script.js',
      'lib/backend.js',
      'lib/file_handle.js',
      'lib/ops_read.js',
      'lib/ops_write.js',
      'lib/ops_meta.js',
    ];
    for (const rel of expectedFiles) {
      assert.ok(packOutput.includes(rel), `Expected ${rel} in npm pack --dry-run output`);
    }
  });

  test('27. Round 2 DRY & KISS edge cases: mkdir dangling symlink ENOENT parity, fh.readv 0-byte dir EISDIR, TypedArray writeFile, and open() credential safety', async () => {
    // A. mkdir(danglingSymlink, { recursive: true }) throws ENOENT (matching node:fs/promises across all backends)
    const danglingTarget = path.join(tmpDir, 'does_not_exist_target');
    const danglingLink = path.join(tmpDir, 'dangling_symlink_dir');
    await uringFs.symlink(danglingTarget, danglingLink);
    await assert.rejects(
      () => uringFs.mkdir(danglingLink, { recursive: true }),
      (err) => err && (err.code === 'ENOENT' || err.code === 'EEXIST')
    );
    const nestedUnderDangling = path.join(danglingLink, 'nested');
    await assert.rejects(
      () => uringFs.mkdir(nestedUnderDangling, { recursive: true }),
      (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EEXIST')
    );

    // B. fh.readv([Buffer.alloc(0)], 0) on a directory throws EISDIR across backends
    for (const b of ['default', 'worker', 'fs']) {
      const opts = b === 'default' ? {} : { fallback: b };
      const dirFh = await uringFs.open(tmpDir, 'r', opts);
      try {
        await assert.rejects(
          () => dirFh.readv([Buffer.alloc(0)], 0),
          { code: 'EISDIR' },
          `fh.readv([Buffer.alloc(0)], 0) on directory with ${b} must throw EISDIR`
        );
      } finally {
        await dirFh.close();
      }
    }

    // C. writeFile passes TypedArrays / DataViews directly to native without redundant Buffer.from copy
    const taFile = path.join(tmpDir, 'typed_array_direct.bin');
    const u16 = new Uint16Array([0x4142, 0x4344]);
    await uringFs.writeFile(taFile, u16);
    const readBack = await uringFs.readFile(taFile);
    assert.deepEqual(readBack, Buffer.from(u16.buffer, u16.byteOffset, u16.byteLength));

    const dv = new DataView(new ArrayBuffer(6), 1, 4);
    dv.setUint32(0, 0x55667788, false);
    await uringFs.writeFile(taFile, dv);
    assert.deepEqual(await uringFs.readFile(taFile), Buffer.from([0x55, 0x66, 0x77, 0x88]));

    // D. open() after EnsureCredentialsSafe check and direct-slot accounting
    const statsBefore = uringFs.getRingStats();
    const credFile = path.join(tmpDir, 'open_cred_check.txt');
    await uringFs.writeFile(credFile, 'cred-ok');

    if (
      uringFs.isUringSupported() &&
      typeof process.geteuid === 'function' &&
      process.geteuid() === 0 &&
      typeof process.seteuid === 'function'
    ) {
      fs.chmodSync(tmpDir, 0o755);
      fs.chmodSync(credFile, 0o644);
      const prevUid = process.geteuid();
      const beforeResets = statsBefore.credentialResets;
      process.seteuid(65534);
      try {
        const fh = await uringFs.open(credFile, 'r');
        try {
          assert.equal(await fh.readAt(0, 7, 'utf8'), 'cred-ok');
        } finally {
          await fh.close();
        }
        assert.ok(uringFs.getRingStats().credentialResets > beforeResets);
      } finally {
        process.seteuid(prevUid);
      }
    } else {
      const fh = await uringFs.open(credFile, 'r');
      try {
        if (statsBefore.directFdsSupported) {
          assert.ok(fh.directSlot >= 0);
          assert.equal(uringFs.getRingStats().directFdsInUse, statsBefore.directFdsInUse + 1);
        }
        assert.equal(await fh.readAt(0, 7, 'utf8'), 'cred-ok');
      } finally {
        await fh.close();
      }
      assert.equal(uringFs.getRingStats().directFdsInUse, statsBefore.directFdsInUse);
    }
  });

  test('28. Deterministic C++ Kernel CQE Fault Injection (partial writes, 0-byte write EIO, linked CQE 1 ECANCELED/EAGAIN retries, Pair 2 short-read continuation)', async () => {
    const { getNative } = require('../lib/backend');
    const native = getNative();
    if (!uringFs.isUringSupported() || !native || typeof native.setFaultInjection !== 'function') {
      return;
    }

    const slotsBeforeAll = uringFs.getRingStats().directFdsInUse;

    try {
      // Invalid argument validation on setFaultInjection
      assert.throws(() => native.setFaultInjection('invalid'), TypeError);

      // A. Linked OP_WRITE_FILE Partial Write Continuation (flush: false, flush: true, O_SYNC, 'rs+', and 'as')
      const payload32 = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUV'); // 32 bytes
      assert.equal(payload32.length, 32);

      // A1. flush: false
      const partialNoFlush = path.join(tmpDir, 'fi_partial_write_no_flush.bin');
      const sqesBeforeA1 = uringFs.getRingStats().totalSqesPrepared;
      native.setFaultInjection({ nextWriteShortBytes: 5 });
      await uringFs.writeFile(partialNoFlush, payload32, { flush: false });
      const sqesAfterA1 = uringFs.getRingStats().totalSqesPrepared;
      assert.deepEqual(fs.readFileSync(partialNoFlush), payload32);
      assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);
      assert.ok(sqesAfterA1 - sqesBeforeA1 >= 6, `Expected >= 6 SQEs for partial write continuation, got ${sqesAfterA1 - sqesBeforeA1}`);

      // A2. flush: true
      const partialFlush = path.join(tmpDir, 'fi_partial_write_flush.bin');
      const sqesBeforeA2 = uringFs.getRingStats().totalSqesPrepared;
      native.setFaultInjection({ nextWriteShortBytes: 5 });
      await uringFs.writeFile(partialFlush, payload32, { flush: true });
      const sqesAfterA2 = uringFs.getRingStats().totalSqesPrepared;
      assert.deepEqual(fs.readFileSync(partialFlush), payload32);
      assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);
      assert.ok(sqesAfterA2 - sqesBeforeA2 >= 8, `Expected >= 8 SQEs for flushed partial write continuation, got ${sqesAfterA2 - sqesBeforeA2}`);

      // A3. Explicit O_SYNC flag (O_WRONLY | O_CREAT | O_TRUNC | O_SYNC) and 'rs+' (O_RDWR | O_SYNC)
      const partialOsync = path.join(tmpDir, 'fi_partial_write_osync.bin');
      native.setFaultInjection({ nextWriteShortBytes: 5 });
      await uringFs.writeFile(partialOsync, payload32, {
        flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_SYNC,
      });
      assert.deepEqual(fs.readFileSync(partialOsync), payload32);
      assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

      const partialRsPlus = path.join(tmpDir, 'fi_partial_write_rs_plus.bin');
      fs.writeFileSync(partialRsPlus, '');
      native.setFaultInjection({ nextWriteShortBytes: 5 });
      await uringFs.writeFile(partialRsPlus, payload32, { flag: 'rs+' });
      assert.deepEqual(fs.readFileSync(partialRsPlus), payload32);
      assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

      // A4. 'as' flag (O_APPEND | O_SYNC): real kernel write wrote 32 bytes, continuation appends remaining 27 bytes at EOF without leaking slots
      const partialAs = path.join(tmpDir, 'fi_partial_write_as.bin');
      native.setFaultInjection({ nextWriteShortBytes: 5 });
      await uringFs.writeFile(partialAs, payload32, { flag: 'as' });
      const asDisk = fs.readFileSync(partialAs);
      assert.deepEqual(asDisk, Buffer.concat([payload32, payload32.subarray(5)]));
      assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

      // B. OP_WRITE_FILE Zero-Byte Write Return (res == 0 with size > 0 -> EIO, no infinite loop)
      for (const writeOpts of [{ flush: false }, { flush: true }, { flag: 'as' }]) {
        const zeroWriteFile = path.join(tmpDir, `fi_write_zero_${writeOpts.flag || writeOpts.flush}.bin`);
        native.setFaultInjection({ nextWriteZero: true });
        await assert.rejects(
          () => uringFs.writeFile(zeroWriteFile, payload32, writeOpts),
          (err) => err && err.code === 'EIO' && err.syscall === 'write'
        );
        assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);
      }

      // C. Linked CQE 1 -ECANCELED (125) and -EAGAIN (11) Retries across all linked operations
      const retrySrcFile = path.join(tmpDir, 'fi_retry_src.bin');
      const retryPayload = Buffer.from('FAULT_INJECTION_RETRY_PAYLOAD_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      await uringFs.writeFile(retrySrcFile, retryPayload);

      for (const errCode of [125 /* ECANCELED */, 11 /* EAGAIN */]) {
        // C1. readFile (Optimistic Pair 1 — must NOT return empty 0-byte Buffer!)
        native.setFaultInjection({ nextCqe1Errno: errCode });
        const rfBuf = await uringFs.readFile(retrySrcFile);
        assert.equal(rfBuf.length, retryPayload.length, `readFile CQE1 errno=${errCode} must not return 0-byte buffer`);
        assert.deepEqual(rfBuf, retryPayload);
        assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

        // C2. readAt
        const sqesBeforeReadAt = uringFs.getRingStats().totalSqesPrepared;
        native.setFaultInjection({ nextCqe1Errno: errCode });
        const raBuf = await uringFs.readAt(retrySrcFile, 6, 9);
        assert.equal(raBuf.toString('utf8'), 'INJECTION');
        assert.ok(uringFs.getRingStats().totalSqesPrepared - sqesBeforeReadAt >= 6);
        assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

        // C3. readBatchAt
        const sqesBeforeBatch = uringFs.getRingStats().totalSqesPrepared;
        native.setFaultInjection({ nextCqe1Errno: errCode });
        const rbArr = await uringFs.readBatchAt(retrySrcFile, [[0, 5], [16, 5], [30, 10]]);
        assert.deepEqual(rbArr.map((b) => b.toString('utf8')), ['FAULT', 'RETRY', '0123456789']);
        assert.ok(uringFs.getRingStats().totalSqesPrepared - sqesBeforeBatch >= 10);
        assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

        // C4. fsync (HandleLinkedSimpleOp — must retry, NOT swallow error)
        const sqesBeforeFsync = uringFs.getRingStats().totalSqesPrepared;
        native.setFaultInjection({ nextCqe1Errno: errCode });
        await uringFs.fsync(retrySrcFile);
        assert.equal(uringFs.getRingStats().totalSqesPrepared - sqesBeforeFsync, 6);
        assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

        // C5. fdatasync (HandleLinkedSimpleOp)
        const sqesBeforeFdatasync = uringFs.getRingStats().totalSqesPrepared;
        native.setFaultInjection({ nextCqe1Errno: errCode });
        await uringFs.fdatasync(retrySrcFile);
        assert.equal(uringFs.getRingStats().totalSqesPrepared - sqesBeforeFdatasync, 6);
        assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

        // C6. readv (HandleLinkedSimpleOp)
        const rv1 = Buffer.alloc(5);
        const rv2 = Buffer.alloc(9);
        const sqesBeforeReadv = uringFs.getRingStats().totalSqesPrepared;
        native.setFaultInjection({ nextCqe1Errno: errCode });
        const rvRes = await uringFs.readv(retrySrcFile, [rv1, rv2], 0);
        assert.equal(rvRes.bytesRead, 14);
        assert.equal(Buffer.concat([rv1, rv2]).toString('utf8'), 'FAULT_INJECTIO');
        assert.equal(uringFs.getRingStats().totalSqesPrepared - sqesBeforeReadv, 6);
        assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

        // C7. writev (HandleLinkedSimpleOp — flush: false and flush: true)
        const wvFile = path.join(tmpDir, `fi_retry_writev_${errCode}.bin`);
        const sqesBeforeWritev = uringFs.getRingStats().totalSqesPrepared;
        native.setFaultInjection({ nextCqe1Errno: errCode });
        const wvRes = await uringFs.writev(wvFile, [Buffer.from('HELLO_'), Buffer.from('WORLD')], 0, { flush: true });
        assert.equal(wvRes.bytesWritten, 11);
        assert.equal(fs.readFileSync(wvFile, 'utf8'), 'HELLO_WORLD');
        assert.equal(uringFs.getRingStats().totalSqesPrepared - sqesBeforeWritev, 8);
        assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

        // C8. fallocate (HandleLinkedSimpleOp)
        const fallocFile = path.join(tmpDir, `fi_retry_falloc_${errCode}.bin`);
        const sqesBeforeFalloc = uringFs.getRingStats().totalSqesPrepared;
        native.setFaultInjection({ nextCqe1Errno: errCode });
        await uringFs.fallocate(fallocFile, 0, 256);
        assert.equal(fs.statSync(fallocFile).size, 256);
        assert.equal(uringFs.getRingStats().totalSqesPrepared - sqesBeforeFalloc, 6);
        assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

        // C9. fadvise (HandleLinkedSimpleOp)
        const sqesBeforeFadvise = uringFs.getRingStats().totalSqesPrepared;
        native.setFaultInjection({ nextCqe1Errno: errCode });
        await uringFs.fadvise(retrySrcFile, 0, retryPayload.length, uringFs.POSIX_FADV_SEQUENTIAL);
        assert.equal(uringFs.getRingStats().totalSqesPrepared - sqesBeforeFadvise, 6);
        assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);
      }

      // D. OP_READ_FILE Pair 2 Short-Read Continuation (128 KB file, optimistic 64 KB overflow -> STATX -> Pair 2 clamped to 4096 -> continuation)
      const pair2File = path.join(tmpDir, 'fi_pair2_128k.bin');
      const pair2Data = crypto.randomBytes(128 * 1024);
      await uringFs.writeFile(pair2File, pair2Data);

      const sqesBeforePair2 = uringFs.getRingStats().totalSqesPrepared;
      native.setFaultInjection({ nextPair2ShortBytes: 4096 });
      const pair2Read = await uringFs.readFile(pair2File);
      const sqesAfterPair2 = uringFs.getRingStats().totalSqesPrepared;

      assert.equal(pair2Read.length, pair2Data.length, '128 KB Pair 2 short-read continuation must not truncate');
      assert.equal(Buffer.compare(pair2Read, pair2Data), 0, '128 KB Pair 2 short-read continuation must match byte-for-byte');
      assert.ok(sqesAfterPair2 - sqesBeforePair2 >= 8, `Expected >= 8 SQEs for Pair 1 + STATX + Pair 2 + continuation, got ${sqesAfterPair2 - sqesBeforePair2}`);
      assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

      // E. Short-Read Continuation in HandleLinkedReadAt (readAt) and OP_FH_READ_AT (fh.readAt)
      const shortReadAtFile = path.join(tmpDir, 'fi_short_read_at.bin');
      const shortReadAtPayload = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes
      assert.equal(shortReadAtPayload.length, 20);
      await uringFs.writeFile(shortReadAtFile, shortReadAtPayload);

      const sqesBeforeReadAtShort = uringFs.getRingStats().totalSqesPrepared;
      const fiResReadAt = native.setFaultInjection({ nextReadAtShortBytes: 5 });
      assert.equal(fiResReadAt.nextReadAtShortBytes, 5);
      const readAtShortBuf = await uringFs.readAt(shortReadAtFile, 0, 20);
      assert.deepEqual(readAtShortBuf, shortReadAtPayload, 'readAt short-read continuation must return all 20 bytes intact');
      assert.ok(
        uringFs.getRingStats().totalSqesPrepared - sqesBeforeReadAtShort >= 6,
        'readAt short-read continuation must transition to unlinked continuation'
      );
      assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

      // Verify readAt reading past EOF with fault-injected short read stops cleanly at EOF (20 bytes)
      native.setFaultInjection({ nextReadAtShortBytes: 5 });
      const readAtPastEof = await uringFs.readAt(shortReadAtFile, 0, 30);
      assert.deepEqual(readAtPastEof, shortReadAtPayload);
      assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);

      // Verify OP_FH_READ_AT (fh.readAt) short-read continuation
      const fhShort = await uringFs.open(shortReadAtFile, 'r');
      try {
        const sqesBeforeFhShort = uringFs.getRingStats().totalSqesPrepared;
        native.setFaultInjection({ nextReadAtShortBytes: 5 });
        const fhShortBuf = await fhShort.readAt(0, 20);
        assert.deepEqual(fhShortBuf, shortReadAtPayload, 'fh.readAt short-read continuation must return all 20 bytes intact');
        assert.equal(
          uringFs.getRingStats().totalSqesPrepared - sqesBeforeFhShort,
          2,
          'fh.readAt short-read continuation must schedule 2 read SQEs'
        );

        // Verify fh.readAt reading past EOF with fault-injected short read stops cleanly at EOF (20 bytes)
        native.setFaultInjection({ nextReadAtShortBytes: 5 });
        const fhPastEof = await fhShort.readAt(0, 30);
        assert.deepEqual(fhPastEof, shortReadAtPayload);
      } finally {
        await fhShort.close();
      }
      assert.equal(uringFs.getRingStats().directFdsInUse, slotsBeforeAll);
    } finally {
      native.setFaultInjection({});
    }
  });

  test('29. Comprehensive JS Line & Branch Coverage across lib/*.js modules', async () => {
    const validators = require('../lib/validators');
    const { UringFileHandle } = require('../lib/file_handle');
    const { DedicatedWorkerPool } = require('../lib/worker_fallback');
    const { detectLibc } = require('../lib/libc');
    const backendMod = require('../lib/backend');

    // A. lib/validators.js uncovered branches
    const dvSample = new DataView(new ArrayBuffer(6), 1, 4);
    dvSample.setUint32(0, 0x41424344, false);
    const dvView = validators.toByteView(dvSample);
    assert.ok(Buffer.isBuffer(dvView));
    assert.equal(dvView.toString('utf8'), 'ABCD');
    assert.equal(validators.parseWriteFlags(fs.constants.O_WRONLY | fs.constants.O_CREAT), fs.constants.O_WRONLY | fs.constants.O_CREAT);

    // attachCallerStack fallback when callerFn is not in async/sync stack
    const dummyErr = new Error('stackless');
    dummyErr.stack = 'Error: stackless';
    function notInStack() {}
    validators.attachCallerStack(dummyErr, notInStack);
    assert.match(dummyErr.stack, /\n\s+at /);

    const acOk = new AbortController();
    assert.equal(await validators.wrapWithAbortSignal(Promise.resolve('ok'), acOk.signal), 'ok');
    const acErr = new AbortController();
    await assert.rejects(() => validators.wrapWithAbortSignal(Promise.reject(new Error('fail-fast')), acErr.signal), /fail-fast/);
    const acMid = new AbortController();
    const midPromise = validators.wrapWithAbortSignal(new Promise(() => {}), acMid.signal);
    acMid.abort('cancelled-mid');
    await assert.rejects(() => midPromise, (e) => e.code === 'ABORT_ERR' && e.cause === 'cancelled-mid');

    // B. lib/ops_write.js uncovered branches
    const hexFile = path.join(tmpDir, 'cov_hex_write.bin');
    await uringFs.writeFile(hexFile, '48656c6c6f', 'hex');
    assert.equal(await uringFs.readFile(hexFile, 'utf8'), 'Hello');

    const customNoVecWriteFile = path.join(tmpDir, 'cov_custom_writev.bin');
    let customSynced = false;
    const customStreamProvider = {
      readFile: fsPromises.readFile,
      async open(p, flags, mode) {
        const fh = await fsPromises.open(p, flags, mode);
        return {
          read: (b, o, l, pos) => fh.read(b, o, l, pos),
          write: (b, o, l, pos) => fh.write(b, o, l, pos),
          sync: async () => { customSynced = true; await fh.sync(); },
          stat: () => fh.stat(),
          close: () => fh.close(),
        };
      },
    };
    const wvCust = await uringFs.writev(customNoVecWriteFile, [Buffer.from('AA'), Buffer.from('BB')], 0, {
      fallback: customStreamProvider,
      flush: true,
    });
    assert.equal(wvCust.bytesWritten, 4);
    assert.equal(customSynced, true);
    assert.equal(fs.readFileSync(customNoVecWriteFile, 'utf8'), 'AABB');

    const fallocNullFile = path.join(tmpDir, 'cov_falloc_null.bin');
    await uringFs.fallocate(fallocNullFile, 0, 16, null);
    assert.equal(fs.statSync(fallocNullFile).size, 16);

    const customDirFallocProvider = {
      readFile: fsPromises.readFile,
      async open() {
        return {
          stat: async () => ({ isDirectory: () => true, size: 0 }),
          truncate: async () => {},
          close: async () => {},
        };
      },
    };
    await assert.rejects(
      () => uringFs.fallocate(tmpDir, 0, 16, { fallback: customDirFallocProvider }),
      { code: 'EISDIR' }
    );

    // C. lib/ops_read.js & lib/file_handle.js uncovered branches
    const rvCustShort = await uringFs.readv(customNoVecWriteFile, [Buffer.alloc(10), Buffer.alloc(10)], 0, {
      fallback: customStreamProvider,
    });
    assert.equal(rvCustShort.bytesRead, 4);

    // UringFileHandle readv & writev fallback when underlying nodeHandle lacks readv/writev
    const customFhTarget = path.join(tmpDir, 'cov_fh_novec.bin');
    const rawNodeFh = await fsPromises.open(customFhTarget, 'w+');
    const strippedHandle = {
      fd: rawNodeFh.fd,
      read: (b, o, l, pos) => rawNodeFh.read(b, o, l, pos),
      write: (b, o, l, pos) => rawNodeFh.write(b, o, l, pos),
      stat: () => rawNodeFh.stat(),
      close: () => rawNodeFh.close(),
    };
    const wrappedFh = new UringFileHandle('provider', customFhTarget, fs.constants.O_RDWR, 0o666, null, strippedHandle);
    try {
      const fhWvRes = await wrappedFh.writev([Buffer.from('XY'), Buffer.from('Z')], 0);
      assert.equal(fhWvRes.bytesWritten, 3);
      const fhRvBuf1 = Buffer.alloc(2);
      const fhRvBuf2 = Buffer.alloc(5);
      const fhRvRes = await wrappedFh.readv([fhRvBuf1, fhRvBuf2], 0);
      assert.equal(fhRvRes.bytesRead, 3);
      assert.equal(fhRvBuf1.toString('utf8'), 'XY');
      assert.equal(fhRvBuf2.subarray(0, 1).toString('utf8'), 'Z');
    } finally {
      await wrappedFh.close();
    }

    // open() with non-pre-aborted signal that aborts mid-flight (both io_uring and fs fallback)
    const acOpenUring = new AbortController();
    const openUringPromise = uringFs.open(customNoVecWriteFile, 'r', 0o666, { signal: acOpenUring.signal });
    acOpenUring.abort();
    await assert.rejects(() => openUringPromise, { code: 'ABORT_ERR' });

    const acOpenFs = new AbortController();
    const openFsPromise = uringFs.open(customNoVecWriteFile, 'r', 0o666, { fallback: 'fs', signal: acOpenFs.signal });
    acOpenFs.abort();
    await assert.rejects(() => openFsPromise, { code: 'ABORT_ERR' });

    // withProviderHandle with signal aborted while provider.open() is pending
    const acWithProvider = new AbortController();
    let providerClosed = false;
    const delayedProvider = {
      open: () => new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            close: async () => { providerClosed = true; },
          });
        }, 15);
      }),
    };
    const wphPromise = backendMod.withProviderHandle(delayedProvider, 'virt', 'r', undefined, acWithProvider.signal, 'testOp', async () => {});
    acWithProvider.abort();
    await assert.rejects(() => wphPromise, { code: 'ABORT_ERR' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(providerClosed, true);

    // D. lib/ops_meta.js uncovered branches
    await uringFs.access(customNoVecWriteFile, { mode: uringFs.R_OK });
    await assert.rejects(() => uringFs.access(customNoVecWriteFile, 'bad-mode'), { code: 'ERR_INVALID_ARG_TYPE' });
    const statOnlyProvider = {
      readFile: fsPromises.readFile,
      stat: async () => ({ isFile: () => true }),
    };
    await uringFs.access(customNoVecWriteFile, uringFs.F_OK, { fallback: statOnlyProvider });

    const numModeDir = path.join(tmpDir, 'cov_mkdir_num_mode');
    await uringFs.mkdir(numModeDir, 0o755);
    assert.ok(fs.statSync(numModeDir).isDirectory());

    const workerMkdirPath = path.join(tmpDir, 'cov_mkdir_worker', 'nested');
    await uringFs.mkdir(workerMkdirPath, { recursive: true, fallback: 'worker' });
    assert.ok(fs.statSync(workerMkdirPath).isDirectory());

    await assert.rejects(() => uringFs.mkdir(customNoVecWriteFile, { recursive: true }), { code: 'EEXIST' });
    await assert.rejects(() => uringFs.mkdir(path.join(customNoVecWriteFile, 'sub'), { recursive: true }), { code: 'ENOTDIR' });

    // Concurrent recursive mkdir triggering EEXIST on nested parent/child
    const raceDir = path.join(tmpDir, 'cov_mkdir_race', 'a', 'b');
    await Promise.all([
      uringFs.mkdir(raceDir, { recursive: true }),
      uringFs.mkdir(raceDir, { recursive: true }),
    ]);
    assert.ok(fs.statSync(raceDir).isDirectory());

    // Symlink loop ELOOP in checkExistingDir & non-EEXIST failure after parent creation in recursive mkdir
    const loopA = path.join(tmpDir, 'cov_mkdir_loop_a');
    const loopB = path.join(tmpDir, 'cov_mkdir_loop_b');
    await uringFs.symlink(loopB, loopA);
    await uringFs.symlink(loopA, loopB);
    await assert.rejects(() => uringFs.mkdir(loopA, { recursive: true }), { code: 'ELOOP' });

    const tooLongChild = path.join(tmpDir, 'cov_mkdir_long_parent', 'x'.repeat(300));
    await assert.rejects(() => uringFs.mkdir(tooLongChild, { recursive: true }), { code: 'ENAMETOOLONG' });

    // lib/ops_read.js worker readv scalar return branch
    {
      const pool = backendMod.getWorkerPool();
      const origExec = pool.exec.bind(pool);
      pool.exec = async () => 4;
      try {
        const scalarRv = await uringFs.readv(customNoVecWriteFile, [Buffer.alloc(4)], 0, { fallback: 'worker' });
        assert.equal(scalarRv.bytesRead, 4);
      } finally {
        pool.exec = origExec;
        await uringFs.closeFallbackWorkers();
      }
    }

    // E. lib/worker_script.js & lib/worker_fallback.js uncovered branches
    const workerOpsDir = path.join(tmpDir, 'cov_worker_ops');
    await uringFs.mkdir(workerOpsDir, { fallback: 'worker' });
    const workerSrc = path.join(workerOpsDir, 'src.txt');
    const workerSym = path.join(workerOpsDir, 'sym.txt');
    const workerHard = path.join(workerOpsDir, 'hard.txt');
    await uringFs.writeFile(workerSrc, 'init-', { fallback: 'worker' });
    await uringFs.symlink(workerSrc, workerSym, 'file', { fallback: 'worker' });
    await uringFs.link(workerSrc, workerHard, { fallback: 'worker' });
    await uringFs.fdatasync(workerSrc, { fallback: 'worker' });
    await uringFs.writev(workerSrc, [Buffer.from('wv1'), Buffer.from('wv2')], 0, { fallback: 'worker', flush: true });
    assert.equal(fs.readFileSync(workerSrc, 'utf8'), 'wv1wv2');
    await assert.rejects(() => uringFs.fallocate(workerOpsDir, 0, 16, { fallback: 'worker' }), { code: 'EISDIR' });
    await uringFs.unlink(workerSym, { fallback: 'worker' });
    await uringFs.unlink(workerHard, { fallback: 'worker' });
    await uringFs.unlink(workerSrc, { fallback: 'worker' });
    await uringFs.rmdir(workerOpsDir, { fallback: 'worker' });
    await uringFs.closeFallbackWorkers();

    const covPool = new DedicatedWorkerPool(2);
    try {
      // resize before spawning workers, and same-size resize after spawning
      await covPool.resize(3);
      assert.equal(covPool.poolSize, 3);
      const appendWorkerFile = path.join(tmpDir, 'cov_worker_append.txt');
      await covPool.exec('appendFile', [appendWorkerFile, 'line1\n', 'utf8']);
      await covPool.exec('appendFile', [appendWorkerFile, 'line2\n', 'utf8']);
      assert.equal(fs.readFileSync(appendWorkerFile, 'utf8'), 'line1\nline2\n');
      await covPool.resize(3); // same-size no-op
      await assert.rejects(() => covPool.exec('unknownOp', []), /Unknown worker operation/);

      // Simulate worker 'error' event while active
      const pendingErr = covPool.exec('readFile', [appendWorkerFile, 'utf8'], 'utf8');
      covPool.workers[0].worker.emit('error', new Error('simulated worker error'));
      await assert.rejects(() => pendingErr, /simulated worker error/);
    } finally {
      await covPool.terminate();
    }

    // F. lib/libc.js branches (non-Linux, musl via report, musl via fs.existsSync, fallback glibc)
    const origPlatformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
    const origGetReport = process.report.getReport;
    const origExistsSync = fs.existsSync;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      assert.equal(detectLibc(), null);

      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      process.report.getReport = () => ({ header: {}, sharedObjects: ['/lib/ld-musl-x86_64.so.1'] });
      assert.equal(detectLibc(), 'musl');

      process.report.getReport = () => ({ header: {}, sharedObjects: [] });
      fs.existsSync = (p) => p === '/etc/alpine-release';
      assert.equal(detectLibc(), 'musl');

      fs.existsSync = () => false;
      assert.equal(detectLibc(), 'glibc');
    } finally {
      if (origPlatformDesc) Object.defineProperty(process, 'platform', origPlatformDesc);
      process.report.getReport = origGetReport;
      fs.existsSync = origExistsSync;
    }

    // G. lib/backend.js env fallback, resolveCustomProvider, loadError, & unsupported-native branches
    assert.equal(backendMod.resolveCustomProvider(null), null);
    assert.equal(backendMod.resolveCustomProvider('not-an-object'), null);

    const backendPath = require.resolve('../lib/backend');
    const cachedBackend = require.cache[backendPath];
    const nativeBuildPath = path.join(__dirname, '..', 'build', 'Release', 'uring_fs.node');
    const resolvedNativePath = fs.existsSync(nativeBuildPath) ? require.resolve(nativeBuildPath) : null;
    const cachedNative = resolvedNativePath ? require.cache[resolvedNativePath] : undefined;
    const origArchDesc = Object.getOwnPropertyDescriptor(process, 'arch');
    const origEnv = {
      URING_FS_FALLBACK: process.env.URING_FS_FALLBACK,
      URING_FS_PREBUILD_ONLY: process.env.URING_FS_PREBUILD_ONLY,
      URING_FS_IGNORE_PREBUILDS: process.env.URING_FS_IGNORE_PREBUILDS,
      URING_FS_DISABLE_NATIVE: process.env.URING_FS_DISABLE_NATIVE,
    };
    try {
      process.env.URING_FS_DISABLE_NATIVE = '1';
      delete require.cache[backendPath];
      const disabledBackend = require(backendPath);
      assert.equal(disabledBackend.getNative(), null);
      assert.match(disabledBackend.getUnsupportedReason(), /URING_FS_DISABLE_NATIVE=1/);
      assert.deepEqual(disabledBackend.probeRingRestriction(), { restricted: false, blockedSocketErrno: -38 });

      process.env.URING_FS_DISABLE_NATIVE = 'stub';
      delete require.cache[backendPath];
      const stubBackend = require(backendPath);
      assert.equal(stubBackend.isUringSupported(), false);
      assert.match(stubBackend.getUnsupportedReason(), /URING_FS_DISABLE_NATIVE=stub/);
      assert.equal(stubBackend.setOptimisticReadSize(4096), 4096);
      delete process.env.URING_FS_DISABLE_NATIVE;

      process.env.URING_FS_PREBUILD_ONLY = '1';
      process.env.URING_FS_IGNORE_PREBUILDS = '1';

      for (const [envVal, expectedBackend] of [
        ['fs', 'fs'],
        ['worker', 'worker'],
        ['none', 'none'],
      ]) {
        process.env.URING_FS_FALLBACK = envVal;
        delete require.cache[backendPath];
        const freshBackend = require(backendPath);
        assert.equal(freshBackend.getNative(), null);
        assert.equal(freshBackend.getActiveBackend(), expectedBackend);
        assert.equal(freshBackend.getUnsupportedReason(), 'Unsupported platform');
        const st = freshBackend.getRingStats();
        assert.equal(st.supported, false);
        assert.equal(st.syscallsSavedByBatching, 0);
      }

      // Exercise candidate require() catch -> loadError -> getUnsupportedReason()
      delete process.env.URING_FS_FALLBACK;
      process.env.URING_FS_PREBUILD_ONLY = '1';
      process.env.URING_FS_IGNORE_PREBUILDS = '0';
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      Object.defineProperty(process, 'arch', { value: 'fake_arch_for_test', configurable: true });
      delete require.cache[backendPath];
      const errBackend = require(backendPath);
      assert.equal(errBackend.getNative(), null);
      assert.match(errBackend.getUnsupportedReason(), /^Failed to load native binary:/);

      // Exercise native.getUnsupportedReason() when native addon loads but isSupported() is false
      if (resolvedNativePath && cachedNative) {
        if (origPlatformDesc) Object.defineProperty(process, 'platform', origPlatformDesc);
        if (origArchDesc) Object.defineProperty(process, 'arch', origArchDesc);
        process.env.URING_FS_PREBUILD_ONLY = '0';
        require.cache[resolvedNativePath] = {
          id: resolvedNativePath,
          filename: resolvedNativePath,
          loaded: true,
          exports: {
            isSupported: () => false,
            getUnsupportedReason: () => 'Simulated old kernel',
          },
        };
        delete require.cache[backendPath];
        const mockReasonBackend = require(backendPath);
        assert.equal(mockReasonBackend.getUnsupportedReason(), 'Simulated old kernel');

        require.cache[resolvedNativePath].exports.getUnsupportedReason = () => '';
        assert.equal(mockReasonBackend.getUnsupportedReason(), 'io_uring is not supported in this environment');
      }
    } finally {
      if (origPlatformDesc) Object.defineProperty(process, 'platform', origPlatformDesc);
      if (origArchDesc) Object.defineProperty(process, 'arch', origArchDesc);
      if (resolvedNativePath && cachedNative) require.cache[resolvedNativePath] = cachedNative;
      for (const [k, v] of Object.entries(origEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      require.cache[backendPath] = cachedBackend;
    }
  });

  test('30. Round 3 Security (CWE-158 null-byte paths), Safe Integers, AbortSignal validation, and numeric 0 flags', async () => {
    const testFile = path.join(tmpDir, 'round3_hardening.txt');
    await uringFs.writeFile(testFile, 'round3-payload');

    // A. CWE-158 null-byte path rejection across string, Buffer, and URL
    await assert.rejects(
      () => uringFs.readFile('foo\0bar'),
      (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_VALUE'
    );
    await assert.rejects(
      () => uringFs.writeFile(Buffer.from('a\0b'), 'x'),
      (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_VALUE'
    );
    await assert.rejects(
      () => uringFs.open('x\0y'),
      (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_VALUE'
    );

    // B. Unsafe integer rejection (ERR_OUT_OF_RANGE) and optimisticReadSize clamping
    await assert.rejects(
      () => uringFs.readAt(testFile, 1e20, 10),
      (err) => err instanceof RangeError && err.code === 'ERR_OUT_OF_RANGE'
    );
    await assert.rejects(
      () => uringFs.readAt(testFile, 0, Number.MAX_SAFE_INTEGER + 2),
      (err) => err instanceof RangeError && err.code === 'ERR_OUT_OF_RANGE'
    );
    await assert.rejects(
      () => uringFs.fallocate(testFile, 1e20, 10),
      (err) => err instanceof RangeError && err.code === 'ERR_OUT_OF_RANGE'
    );
    await assert.rejects(
      () => uringFs.readBatchAt(testFile, [[1e20, 5]]),
      (err) => err instanceof RangeError && err.code === 'ERR_OUT_OF_RANGE'
    );
    await assert.rejects(
      () => uringFs.readBatchAt(testFile, [[0, Number.MAX_SAFE_INTEGER + 2]]),
      (err) => err instanceof RangeError && err.code === 'ERR_OUT_OF_RANGE'
    );
    await assert.rejects(
      () => uringFs.readv(testFile, [Buffer.alloc(4)], 1e20),
      (err) => err instanceof RangeError && err.code === 'ERR_OUT_OF_RANGE'
    );
    await assert.rejects(
      () => uringFs.access(testFile, 1e20),
      (err) => err instanceof RangeError && err.code === 'ERR_OUT_OF_RANGE'
    );

    assert.throws(
      () => uringFs.setOptimisticReadSize(1e20),
      (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_VALUE'
    );
    await assert.rejects(
      () => uringFs.readFile(testFile, { optimisticReadSize: 1e20 }),
      (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_VALUE'
    );

    const prevOptSize = uringFs.getRingStats().optimisticReadSize;
    try {
      const clampedSize = uringFs.setOptimisticReadSize(0xffffffff);
      assert.equal(clampedSize, 0x7ffff000);
      assert.equal(uringFs.getRingStats().optimisticReadSize, 0x7ffff000);

      const readClamped = await uringFs.readFile(testFile, { encoding: 'utf8', optimisticReadSize: 0xffffffff });
      assert.equal(readClamped, 'round3-payload');
    } finally {
      uringFs.setOptimisticReadSize(prevOptSize);
    }

    // C. Invalid AbortSignal rejection (ERR_INVALID_ARG_TYPE) and fh.stat({ signal })
    await assert.rejects(
      () => uringFs.readFile(testFile, { signal: {} }),
      (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_TYPE'
    );
    await assert.rejects(
      () => uringFs.writeFile(testFile, 'ignored', { signal: 123 }),
      (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_TYPE'
    );
    await assert.rejects(
      () => uringFs.stat(testFile, { signal: { aborted: false } }),
      (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_TYPE'
    );

    for (const openOpts of [{ flags: 0 }, { flags: 0, fallback: 'fs' }]) {
      const fh = await uringFs.open(testFile, openOpts);
      try {
        const readOut = await fh.readAt(0, 14, 'utf8');
        assert.equal(readOut, 'round3-payload');

        const st = await fh.stat();
        assert.equal(st.size, 14);

        await assert.rejects(
          () => fh.stat({ signal: 'bad' }),
          (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_TYPE'
        );
        await assert.rejects(
          () => fh.stat({ signal: AbortSignal.abort() }),
          { name: 'AbortError', code: 'ABORT_ERR' }
        );
      } finally {
        await fh.close();
      }
    }

    // D. Numeric 0 (O_RDONLY) flag preserved via ?? in writev (fails with EBADF/EACCES on read-only open if existing)
    const roFile = path.join(tmpDir, 'round3_ro_writev.txt');
    await uringFs.writeFile(roFile, 'readonly');
    await assert.rejects(
      () => uringFs.writev(roFile, [Buffer.from('x')], 0, { flags: 0 }),
      (err) => err && (err.code === 'EBADF' || err.code === 'EACCES' || err.code === 'EINVAL')
    );
  });

  test('31. Round 4: Native io_uring Caller Stack Traces (err.stack) and In-Flight CleanupModule Safety', async () => {
    const { spawnSync } = require('node:child_process');

    // A. Caller stack frames on native io_uring rejections
    const missingPath = path.join(tmpDir, 'definitely_missing_round4.txt');
    async function invokeReadFileMissing() {
      return await uringFs.readFile(missingPath);
    }
    await assert.rejects(
      () => invokeReadFileMissing(),
      (err) => {
        assert.equal(err.code, 'ENOENT');
        assert.match(err.stack, /\n\s+at /);
        assert.match(err.stack, /invokeReadFileMissing/);
        return true;
      }
    );

    await assert.rejects(
      () => uringFs.readAt(tmpDir, 0, 10),
      (err) => {
        assert.equal(err.code, 'EISDIR');
        assert.match(err.stack, /\n\s+at /);
        return true;
      }
    );

    await assert.rejects(
      () => uringFs.stat(missingPath),
      (err) => {
        assert.equal(err.code, 'ENOENT');
        assert.match(err.stack, /\n\s+at /);
        return true;
      }
    );

    // Also verify UringFileHandle native rejections include caller stack frames
    const roFile = path.join(tmpDir, 'round4_ro_handle.txt');
    await uringFs.writeFile(roFile, 'ro');
    const fh = await uringFs.open(roFile, 'r');
    try {
      await assert.rejects(
        () => fh.write('cannot-write'),
        (err) => {
          assert.ok(err && err.code);
          assert.match(err.stack, /\n\s+at /);
          return true;
        }
      );
    } finally {
      await fh.close();
    }

    // Also verify AbortSignal-wrapped native rejection includes caller stack frames
    const ac = new AbortController();
    await assert.rejects(
      () => uringFs.readFile(missingPath, { signal: ac.signal }),
      (err) => {
        assert.equal(err.code, 'ENOENT');
        assert.match(err.stack, /\n\s+at /);
        return true;
      }
    );

    // B. CleanupModule safely deletes in-flight & overflow-queued IORequest* instances on env teardown
    const cleanupTarget = path.join(tmpDir, 'round4_cleanup.txt');
    await uringFs.writeFile(cleanupTarget, 'cleanup-payload');
    const cleanupRes = spawnSync(
      process.execPath,
      [
        '-e',
        `const u = require('./index.js');
         const p = ${JSON.stringify(cleanupTarget)};
         for (let i = 0; i < 600; i++) {
           u.readFile(p).catch(() => {});
         }
         process.exit(0);`,
      ],
      {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
      }
    );
    assert.equal(cleanupRes.status, 0, `CleanupModule subprocess failed: ${cleanupRes.stderr}`);

    // C. rmdir with fallback: 'worker' and live AbortSignal (no DataCloneError)
    const workerRmdirDir = path.join(tmpDir, 'round4_worker_rmdir_signal');
    await uringFs.mkdir(workerRmdirDir);
    const liveAc = new AbortController();
    await uringFs.rmdir(workerRmdirDir, { fallback: 'worker', signal: liveAc.signal });
    assert.equal(await uringFs.exists(workerRmdirDir), false);
  });

  test('32. v1.3.4 Kernel Opcode Restrictions (IORING_REGISTER_RESTRICTIONS), CQSIZE 4x, getRingStatus, and Intrusive/RAII Engine Verification', async () => {
    const { spawnSync } = require('node:child_process');

    // A. Ring stats & restriction probe telemetry
    const stats = uringFs.getRingStats();
    assert.equal(typeof stats.restrictionsSupported, 'boolean');
    assert.equal(typeof stats.allowedOpcodesCount, 'number');
    assert.equal(typeof stats.cqSize, 'number');
    assert.equal(typeof stats.cqOverflows, 'number');
    assert.ok(stats.cqOverflows >= 0);

    const probe = uringFs.probeRingRestriction();
    if (uringFs.isUringSupported()) {
      assert.equal(stats.restrictionsSupported, true);
      assert.equal(stats.allowedOpcodesCount, 22);
      assert.ok(stats.cqSize >= stats.queueDepth, `Expected cqSize (${stats.cqSize}) >= queueDepth (${stats.queueDepth})`);
      assert.equal(stats.cqSize, stats.queueDepth * 4);
      assert.deepEqual(probe, { restricted: true, blockedSocketErrno: -13 });
    } else {
      assert.equal(stats.restrictionsSupported, false);
      assert.equal(stats.allowedOpcodesCount, 0);
      assert.equal(stats.cqSize, 0);
      assert.equal(stats.cqOverflows, 0);
      assert.deepEqual(probe, { restricted: false, blockedSocketErrno: -38 });
    }

    // B. getRingStatus() and ESM export parity
    const status = uringFs.getRingStatus();
    assert.deepEqual(status, {
      activeBackend: uringFs.getActiveBackend(),
      isUringSupported: uringFs.isUringSupported(),
      fallbackReason: uringFs.getUnsupportedReason(),
      restrictionsSupported: stats.restrictionsSupported,
      allowedOpcodesCount: stats.allowedOpcodesCount,
      queueDepth: stats.queueDepth,
      cqSize: stats.cqSize,
      optimisticReadSize: stats.optimisticReadSize,
    });

    const esm = await import('../index.mjs');
    assert.equal(typeof esm.probeRingRestriction, 'function');
    assert.equal(typeof esm.getRingStatus, 'function');

    // C. configure({ restrictions }) toggle & TypeError validation
    assert.throws(
      () => uringFs.configure({ restrictions: 'bad' }),
      (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_TYPE'
    );

    try {
      const cfgOff = uringFs.configure({ restrictions: false });
      assert.equal(cfgOff.restrictions, false);
      assert.equal(uringFs.getRingStats().restrictionsSupported, false);
      assert.equal(uringFs.getRingStatus().restrictionsSupported, false);
      assert.equal(uringFs.getRingStats().allowedOpcodesCount, 0);
      const probeOff = uringFs.probeRingRestriction();
      assert.equal(probeOff.restricted, false);
      assert.notEqual(probeOff.blockedSocketErrno, -13);

      const cfgOn = uringFs.configure({ restrictions: true });
      assert.equal(cfgOn.restrictions, true);
      if (uringFs.isUringSupported()) {
        const stOn = uringFs.getRingStats();
        assert.equal(stOn.restrictionsSupported, true);
        assert.equal(uringFs.getRingStatus().restrictionsSupported, true);
        assert.equal(stOn.allowedOpcodesCount, 22);
        assert.equal(stOn.directFdsSupported, true);
        assert.deepEqual(uringFs.probeRingRestriction(), { restricted: true, blockedSocketErrno: -13 });
      }

      // Regression guard: configure({ restrictions }) while a direct-slot handle is open must NOT tear down the live ring
      const guardFile = path.join(tmpDir, 'v134_reinit_guard.txt');
      await uringFs.writeFile(guardFile, 'active-handle-guard');
      const openFh = await uringFs.open(guardFile, 'r');
      try {
        if (uringFs.isUringSupported()) {
          assert.equal(uringFs.getRingStats().directFdsInUse, 1);
          uringFs.configure({ restrictions: false });
          // Ring remains active and restricted while direct slot is in use
          assert.equal(uringFs.getRingStats().restrictionsSupported, true);
        }
        const buf = Buffer.alloc(19);
        const { bytesRead } = await openFh.read(buf, 0, 19, 0);
        assert.equal(bytesRead, 19);
        assert.equal(buf.toString('utf8'), 'active-handle-guard');
      } finally {
        await openFh.close();
      }
      // Once the handle is closed and the ring is idle, configure({ restrictions: false }) applies cleanly
      uringFs.configure({ restrictions: false });
      assert.equal(uringFs.getRingStats().restrictionsSupported, false);
      uringFs.configure({ restrictions: true });
      if (uringFs.isUringSupported()) {
        assert.equal(uringFs.getRingStats().restrictionsSupported, true);
      }
    } finally {
      uringFs.configure({ restrictions: process.env.URING_FS_RESTRICTIONS !== '0' });
    }

    // D. URING_FS_RESTRICTIONS=0 child process override
    const childFile = path.join(tmpDir, 'v134_no_restrictions.txt');
    const childRes = spawnSync(
      process.execPath,
      [
        '-e',
        `const assert = require('node:assert/strict');
         const u = require('./index.js');
         (async () => {
           const st = u.getRingStats();
           assert.equal(st.restrictionsSupported, false);
           assert.equal(st.allowedOpcodesCount, 0);
           assert.equal(u.probeRingRestriction().restricted, false);
           await u.writeFile(${JSON.stringify(childFile)}, 'unrestricted-ok');
           assert.equal(await u.readFile(${JSON.stringify(childFile)}, 'utf8'), 'unrestricted-ok');
         })().catch((err) => { console.error(err); process.exit(1); });`,
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, URING_FS_RESTRICTIONS: '0' },
        encoding: 'utf8',
      }
    );
    assert.equal(childRes.status, 0, `URING_FS_RESTRICTIONS=0 subprocess failed: ${childRes.stderr}`);

    // E. Intrusive live_requests_head teardown & RAII DirectSlotTable / OptimisticBufferPool verification
    const poolFile = path.join(tmpDir, 'v134_raii_pool.txt');
    await uringFs.writeFile(poolFile, 'raii-buffer-pool-test-payload');
    const prevOptSize = uringFs.getRingStats().optimisticReadSize;
    try {
      uringFs.setOptimisticReadSize(4096);
      await Promise.all(Array.from({ length: 32 }, () => uringFs.readFile(poolFile, 'utf8')));
      uringFs.setOptimisticReadSize(8192);
      const reads = await Promise.all(Array.from({ length: 32 }, () => uringFs.readFile(poolFile, 'utf8')));
      for (const content of reads) {
        assert.equal(content, 'raii-buffer-pool-test-payload');
      }
    } finally {
      uringFs.setOptimisticReadSize(prevOptSize);
    }

    // Concurrent probe while requests are in-flight
    const inflightReads = Promise.all(Array.from({ length: 16 }, () => uringFs.readFile(poolFile, 'utf8')));
    const concurrentProbe = uringFs.probeRingRestriction();
    await inflightReads;
    if (uringFs.isUringSupported()) {
      assert.deepEqual(concurrentProbe, { restricted: true, blockedSocketErrno: -13 });
    } else {
      assert.deepEqual(concurrentProbe, { restricted: false, blockedSocketErrno: -38 });
    }

    const postStats = uringFs.getRingStats();
    assert.equal(postStats.activeRequests, 0);
    assert.equal(postStats.directFdsInUse, 0);

    // Intrusive live_requests_head CleanupModule teardown with queued requests (io_uring_queue_exit before freeing buffers)
    const intrusiveChild = spawnSync(
      process.execPath,
      [
        '-e',
        `const u = require('./index.js');
         const p = ${JSON.stringify(poolFile)};
         for (let i = 0; i < 800; i++) {
           u.readFile(p).catch(() => {});
         }
         process.exit(0);`,
      ],
      {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
      }
    );
    assert.equal(intrusiveChild.signal, null);
    assert.equal(intrusiveChild.status, 0, `Intrusive CleanupModule subprocess failed: ${intrusiveChild.stderr}`);

    // F. OIDC Trusted Publishing & npm stage publish fallback regression guard in publish.yml
    const publishYml = await uringFs.readFile(
      path.join(__dirname, '..', '.github', 'workflows', 'publish.yml'),
      'utf8'
    );
    assert.match(publishYml, /id-token:\s*write/);
    assert.match(
      publishYml,
      /npm publish --provenance --access public \|\| npm stage publish --provenance --access public/
    );
  });
});
