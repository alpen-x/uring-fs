#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const gitDir = path.join(rootDir, '.git');
const hooksDir = path.join(rootDir, '.githooks');

if (fs.existsSync(gitDir) && fs.existsSync(hooksDir)) {
  try {
    for (const hook of ['pre-commit', 'pre-push']) {
      const p = path.join(hooksDir, hook);
      if (fs.existsSync(p)) {
        fs.chmodSync(p, 0o755);
      }
    }
    spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: rootDir, stdio: 'ignore' });
  } catch {}
}
