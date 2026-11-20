#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { detectLibc } = require('../lib/libc');

const rootDir = path.resolve(__dirname, '..');
const builtAddonPath = path.join(rootDir, 'build', 'Release', 'uring_fs.node');

const shouldRebuild = process.argv.includes('--rebuild') || !fs.existsSync(builtAddonPath);

if (shouldRebuild) {
  console.log('[uring-fs] Building native addon via node-gyp rebuild...');
  const res = spawnSync('node-gyp', ['rebuild'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(`[uring-fs] Compilation failed with status ${res.status}`);
    process.exit(res.status || 1);
  }
}

if (!fs.existsSync(builtAddonPath)) {
  console.error(`[uring-fs] Expected addon at ${builtAddonPath} not found.`);
  process.exit(1);
}

const libc = detectLibc() || 'glibc';
const targetDir = path.join(rootDir, 'prebuilds', `${process.platform}-${process.arch}`);
const targetPath = path.join(targetDir, `uring_fs.${libc}.node`);

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(builtAddonPath, targetPath);

console.log(`[uring-fs] Prebuilt binary copied to ${targetPath}`);
