'use strict';

const { readFile, writeFile } = require('../index.js');
const path = require('node:path');

async function run() {
  console.log('--- TEST 1: Reading file via io_uring in Node.js ---');

  // Timer to demonstrate that the Node.js Event Loop keeps ticking freely
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    process.stdout.write(`[Event Loop Tick #${ticks}] `);
  }, 5);

  const samplePath = path.resolve(__dirname, 'sample.txt');
  const buffer = await readFile(samplePath);

  console.log('\n\nFile read successfully via io_uring:');
  console.log(buffer.toString('utf-8'));

  console.log('--- TEST 2: Writing file via io_uring in Node.js ---');
  const outputPath = path.resolve(__dirname, 'output_uring.txt');
  const textToWrite = `File generated asynchronously by Node.js using io_uring!\nTimestamp: ${new Date().toISOString()}\n`;

  const bytesWritten = await writeFile(outputPath, textToWrite);
  console.log(`Bytes written to disk via io_uring: ${bytesWritten}`);

  console.log('--- TEST 3: Re-reading the newly written file ---');
  const readBack = await readFile(outputPath);
  console.log('Verified content:');
  console.log(readBack.toString('utf-8'));

  clearInterval(timer);
  console.log('All example checks completed successfully!');
}

run().catch((err) => {
  console.error('Error during execution:', err);
  process.exit(1);
});
