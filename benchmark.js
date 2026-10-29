'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const uringFs = require('./index.js');

const NUM_SMALL_FILES = 1000;
const SMALL_FILE_SIZE = 4 * 1024; // 4 KB per file
const NUM_FILES = 100;
const FILE_SIZE = 128 * 1024; // 128 KB per file
const BENCH_DIR = path.resolve(__dirname, 'bench_tmp');

async function setup() {
  await fs.mkdir(BENCH_DIR, { recursive: true });
  console.log(
    `Generating ${NUM_SMALL_FILES} small files (4 KB) and ${NUM_FILES} medium files (128 KB)...`
  );

  const smallBuffer = Buffer.alloc(SMALL_FILE_SIZE, 'a');
  const dummyBuffer = Buffer.alloc(FILE_SIZE, 'x');
  const writes = [];
  for (let i = 0; i < NUM_SMALL_FILES; i++) {
    writes.push(uringFs.writeFile(path.join(BENCH_DIR, `small_${i}.dat`), smallBuffer));
  }
  for (let i = 0; i < NUM_FILES; i++) {
    writes.push(uringFs.writeFile(path.join(BENCH_DIR, `file_${i}.dat`), dummyBuffer));
  }
  await Promise.all(writes);
  console.log('Files generated successfully via io_uring!\n');
}

async function testNodeFs(files) {
  const start = performance.now();
  await Promise.all(files.map((f) => fs.readFile(f)));
  return performance.now() - start;
}

async function testIoUring(files) {
  const start = performance.now();
  await Promise.all(files.map((f) => uringFs.readFile(f)));
  return performance.now() - start;
}

function triggerBackgroundThreadPoolLoad() {
  const tasks = [];
  for (let i = 0; i < 4; i++) {
    tasks.push(
      new Promise((resolve) => {
        crypto.pbkdf2('bench-secret', 'salt', 200000, 64, 'sha512', () => resolve());
      })
    );
  }
  return Promise.all(tasks);
}

async function cleanup() {
  await fs.rm(BENCH_DIR, { recursive: true, force: true });
}

async function main() {
  await setup();
  const smallFiles = Array.from({ length: NUM_SMALL_FILES }, (_, i) =>
    path.join(BENCH_DIR, `small_${i}.dat`)
  );
  const files = Array.from({ length: NUM_FILES }, (_, i) => path.join(BENCH_DIR, `file_${i}.dat`));

  // Warm-up
  for (let w = 0; w < 3; w++) {
    await testNodeFs(smallFiles);
    await testIoUring(smallFiles);
    await testNodeFs(files);
    await testIoUring(files);
  }

  console.log('=== SCENARIO 1A: HIGH-CONCURRENCY SMALL FILES (1,000 files x 4 KB) ===');
  const smallFsTimes = [];
  const smallUringTimes = [];
  const smallStatsBefore = uringFs.getRingStats();

  for (let i = 0; i < 5; i++) {
    const tFs = await testNodeFs(smallFiles);
    const tUring = await testIoUring(smallFiles);
    smallFsTimes.push(tFs);
    smallUringTimes.push(tUring);
    console.log(
      `Round ${i + 1}: node:fs = ${tFs.toFixed(2)}ms | uring-fs (io_uring) = ${tUring.toFixed(2)}ms`
    );
  }

  const smallStatsAfter = uringFs.getRingStats();
  const avgSmallFs = smallFsTimes.reduce((a, b) => a + b, 0) / smallFsTimes.length;
  const avgSmallUring = smallUringTimes.reduce((a, b) => a + b, 0) / smallUringTimes.length;
  const smallSqesDelta = smallStatsAfter.totalSqesPrepared - smallStatsBefore.totalSqesPrepared;
  const smallSubmitsDelta =
    smallStatsAfter.totalSubmitSyscalls - smallStatsBefore.totalSubmitSyscalls;

  console.log(
    `\nScenario 1A Average: node:fs = ${avgSmallFs.toFixed(2)}ms | uring-fs (io_uring) = ${avgSmallUring.toFixed(2)}ms (${(
      avgSmallFs / avgSmallUring
    ).toFixed(2)}x faster!)`
  );
  console.log(
    `Optimistic Read + Direct FD Batching: ${smallSqesDelta} kernel ops in ${smallSubmitsDelta} io_uring_enter syscalls (${(
      (1 - smallSubmitsDelta / smallSqesDelta) *
      100
    ).toFixed(1)}% syscalls saved!)\n`
  );

  console.log('=== SCENARIO 1B: PURE CONCURRENT READ (100 files x 128 KB) ===');
  uringFs.setOptimisticReadSize(262144);
  const fsTimes = [];
  const uringTimes = [];

  const statsBefore = uringFs.getRingStats();

  for (let i = 0; i < 5; i++) {
    const tFs = await testNodeFs(files);
    const tUring = await testIoUring(files);
    fsTimes.push(tFs);
    uringTimes.push(tUring);
    console.log(`Round ${i + 1}: node:fs = ${tFs.toFixed(2)}ms | uring-fs (io_uring) = ${tUring.toFixed(2)}ms`);
  }

  const statsAfter = uringFs.getRingStats();
  uringFs.setOptimisticReadSize(65536);
  const avgFs = fsTimes.reduce((a, b) => a + b, 0) / fsTimes.length;
  const avgUring = uringTimes.reduce((a, b) => a + b, 0) / uringTimes.length;

  console.log(
    `\nScenario 1B Average: node:fs = ${avgFs.toFixed(2)}ms | uring-fs (io_uring) = ${avgUring.toFixed(2)}ms (${(
      avgFs / avgUring
    ).toFixed(2)}x faster!)`
  );

  const sqesDelta = statsAfter.totalSqesPrepared - statsBefore.totalSqesPrepared;
  const submitsDelta = statsAfter.totalSubmitSyscalls - statsBefore.totalSubmitSyscalls;
  console.log(
    `Auto-Batching Efficiency: ${sqesDelta} kernel operations dispatched in only ${submitsDelta} io_uring_enter syscalls (${(
      (1 - submitsDelta / sqesDelta) *
      100
    ).toFixed(1)}% syscalls saved!)\n`
  );

  console.log('=== SCENARIO 2: SERVER UNDER MIXED LOAD (Crypto/Zlib saturating the Thread Pool) ===');
  const bg1 = triggerBackgroundThreadPoolLoad();
  const mixedUringTime = await testIoUring(files.slice(0, 20));
  await bg1;

  const bg2 = triggerBackgroundThreadPoolLoad();
  const mixedFsTime = await testNodeFs(files.slice(0, 20));
  await bg2;

  console.log(`node:fs/promises (under thread pool load): ${mixedFsTime.toFixed(2)}ms`);
  console.log(`uring-fs io_uring (under thread pool load): ${mixedUringTime.toFixed(2)}ms`);
  console.log(`Mixed-load server speedup: ${(mixedFsTime / mixedUringTime).toFixed(1)}x faster via uring-fs (io_uring)!`);

  await cleanup();
}

main().catch(console.error);
