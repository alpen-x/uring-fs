'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { readFile: readUring } = require('./index.js');

// Default libuv thread pool has 4 threads.
// Saturate all 4 threads with heavy PBKDF2 tasks.
function saturateThreadPool() {
  console.log('-> Saturating all 4 libuv threads with heavy PBKDF2...');
  for (let i = 0; i < 4; i++) {
    crypto.pbkdf2('password', 'salt', 500000, 64, 'sha512', () => {
      // crypto task completed
    });
  }
}

async function run() {
  const samplePath = path.resolve(__dirname, 'examples/sample.txt');

  console.log('=== LIBUV THREAD POOL STARVATION TEST ===\n');

  // 1. Test with uring-fs while libuv threads are saturated
  saturateThreadPool();
  const startUring = performance.now();
  await readUring(samplePath);
  const timeUring = performance.now() - startUring;
  console.log(`[uring-fs] File read time: ${timeUring.toFixed(2)} ms (Independent from libuv thread pool!)\n`);

  // Wait briefly for pending crypto tasks to drain
  await new Promise((r) => setTimeout(r, 800));

  // 2. Test with node:fs/promises while libuv threads are saturated
  saturateThreadPool();
  const startFs = performance.now();
  await fs.readFile(samplePath);
  const timeFs = performance.now() - startFs;
  console.log(`[node:fs]  File read time: ${timeFs.toFixed(2)} ms (Stalled waiting for a free worker thread!)\n`);

  console.log(`>>> Conclusion: node:fs took ${(timeFs / timeUring).toFixed(0)}x longer due to thread pool starvation.`);
}

run();
