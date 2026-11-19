#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { detectLibc } = require('../index.js');

const rootDir = path.resolve(__dirname, '..');

const buildFromSource =
  process.env.npm_config_build_from_source === 'true' ||
  process.env.URING_FS_BUILD_FROM_SOURCE === '1' ||
  process.env.URING_FS_MARCH_NATIVE === '1' ||
  process.env.npm_config_march_native === 'true';

if (!buildFromSource && process.platform === 'linux' && process.env.URING_FS_IGNORE_PREBUILDS !== '1') {
  const libc = detectLibc();
  const prebuildCandidates = [];
  if (libc) {
    prebuildCandidates.push(
      path.join(rootDir, 'prebuilds', `linux-${process.arch}`, `uring_fs.${libc}.node`)
    );
  }
  prebuildCandidates.push(
    path.join(rootDir, 'prebuilds', `linux-${process.arch}`, 'uring_fs.node')
  );

  for (const candidate of prebuildCandidates) {
    if (fs.existsSync(candidate)) {
      try {
        require(candidate);
        console.log(`[uring-fs] Using prebuilt native binary (linux-${process.arch}-${libc || 'unknown'})`);
        process.exit(0);
      } catch (err) {
        // Continue to fallback or compilation
      }
    }
  }
}

// Fallback to building from source via node-gyp
try {
  const res = spawnSync('node-gyp', ['rebuild'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
  });

  if (res.status !== 0) {
    console.warn(
      `[uring-fs] Native compilation failed (status ${res.status}). Falling back to JavaScript/worker fallback mode.`
    );
    process.exit(0);
  }
} catch (err) {
  console.warn(
    `[uring-fs] Failed to invoke node-gyp (${err.message}). Falling back to JavaScript/worker fallback mode.`
  );
  process.exit(0);
}
