'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const uringFs = require('./index.js');

const NUM_FILES = 100;
const FILE_SIZE = 128 * 1024; // 128 KB per file
const BENCH_DIR = path.resolve(__dirname, 'bench_tmp');

async function setup() {
  await fs.mkdir(BENCH_DIR, { recursive: true });
  console.log(`Generating ${NUM_FILES} test files of ${(FILE_SIZE / 1024).toFixed(0)} KB each...`);

  const dummyBuffer = Buffer.alloc(FILE_SIZE, 'x');
  const writes = [];
  for (let i = 0; i < NUM_FILES; i++) {
    const file = path.join(BENCH_DIR, `file_${i}.dat`);
    writes.push(uringFs.writeFile(file, dummyBuffer));
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
  const files = Array.from({ length: NUM_FILES }, (_, i) => path.join(BENCH_DIR, `file_${i}.dat`));

  // Warm-up
  for (let w = 0; w < 3; w++) {
    await testNodeFs(files);
    await testIoUring(files);
  }

  console.log('=== SCENARIO 1: PURE CONCURRENT READ (100 files x 128 KB) ===');
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
  const avgFs = fsTimes.reduce((a, b) => a + b, 0) / fsTimes.length;
  const avgUring = uringTimes.reduce((a, b) => a + b, 0) / uringTimes.length;

  console.log(`\nScenario 1 Average: node:fs = ${avgFs.toFixed(2)}ms | uring-fs (io_uring) = ${avgUring.toFixed(2)}ms (${(avgFs / avgUring).toFixed(2)}x)`);

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
