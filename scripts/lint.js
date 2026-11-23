#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const uringFs = require('../index.js');

const rootDir = path.resolve(__dirname, '..');

async function main() {
  let errors = 0;

  function fail(msg) {
    console.error(`[lint] ERROR: ${msg}`);
    errors++;
  }

  // 1. Collect all JS/MJS files in root, lib/, scripts/, and test/
  const jsFiles = [
    path.join(rootDir, 'index.js'),
    path.join(rootDir, 'index.mjs'),
  ];

  for (const subDir of ['lib', 'scripts', 'test']) {
    const fullDir = path.join(rootDir, subDir);
    if (await uringFs.exists(fullDir)) {
      for (const entry of fs.readdirSync(fullDir)) {
        if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
          jsFiles.push(path.join(fullDir, entry));
        }
      }
    }
  }

  // Dogfood uring-fs parallel batched readFile across all JS/MJS sources
  const sources = await Promise.all(jsFiles.map((file) => uringFs.readFile(file, 'utf8')));

  for (let i = 0; i < jsFiles.length; i++) {
    const file = jsFiles[i];
    const rel = path.relative(rootDir, file);
    const src = sources[i];

    // A. Node syntax check (node --check)
    const checkRes = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (checkRes.status !== 0) {
      fail(`Syntax error in ${rel}:\n${checkRes.stderr}`);
    }

    // B. 'use strict' directive check on CommonJS .js files
    if (file.endsWith('.js')) {
      const lines = src.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#!') && !l.startsWith('//'));
      if (lines[0] !== "'use strict';" && lines[0] !== '"use strict";') {
        fail(`${rel} is missing top-level 'use strict'; directive`);
      }
    }

    // C. Disallowed constructs in production modules (index.js & lib/*.js)
    if (rel === 'index.js' || rel.startsWith('lib/')) {
      if (/\beval\s*\(/.test(src) || /\beval\s*:\s*true\b/.test(src)) {
        fail(`${rel} contains forbidden eval usage`);
      }
      if (/\bdebugger\b/.test(src)) {
        fail(`${rel} contains forbidden debugger statement`);
      }
      if (/\bconsole\.(log|debug|dir)\s*\(/.test(src)) {
        fail(`${rel} contains forbidden console.log/debug in production module`);
      }
    }

    // D. Check for Node 22/24 DEP0190 spawnSync(cmd, args, { shell: true }) pattern
    if (rel.startsWith('scripts/') && /spawnSync\([^)]+,\s*\[[^\]]+\],\s*\{[^}]*\bshell\s*:\s*true\b/.test(src)) {
      fail(`${rel} uses unconditional shell: true with spawnSync args array (DEP0190)`);
    }
  }

  // 2. Verify CJS (index.js), ESM (index.mjs), and TypeScript (index.d.ts) export parity
  const cjsExports = Object.keys(uringFs);
  const mjsPath = path.join(rootDir, 'index.mjs');
  const dtsPath = path.join(rootDir, 'index.d.ts');
  const [mjsSrc, dtsSrc] = await Promise.all([
    uringFs.readFile(mjsPath, 'utf8'),
    uringFs.readFile(dtsPath, 'utf8'),
  ]);

  for (const sym of cjsExports) {
    if (!new RegExp(`\\b${sym}\\b`).test(mjsSrc)) {
      fail(`Symbol "${sym}" exported in index.js is missing from index.mjs`);
    }
    if (!new RegExp(`\\b${sym}\\b`).test(dtsSrc)) {
      fail(`Symbol "${sym}" exported in index.js is missing from index.d.ts`);
    }
  }

  // 3. C++ Warning & Static Check (g++ -Werror)
  if (process.platform === 'linux') {
    const gppCheck = spawnSync('which', ['g++'], { encoding: 'utf8' });
    const [hasStdLiburing, hasLocalLiburing] = await Promise.all([
      uringFs.exists('/usr/include/liburing.h'),
      uringFs.exists('/usr/local/include/liburing.h'),
    ]);
    const hasLiburingHeader = hasStdLiburing || hasLocalLiburing;

    if (gppCheck.status === 0) {
      let napiInclude = '';
      try {
        napiInclude = require('node-addon-api').include.replace(/^"|"$/g, '');
      } catch {}

      const nodeHeaderCandidates = [
        path.join(process.env.HOME || '', '.cache', 'node-gyp', process.versions.node, 'include', 'node'),
        '/usr/include/node',
      ];
      let nodeInclude = undefined;
      for (const candidate of nodeHeaderCandidates) {
        if (await uringFs.exists(path.join(candidate, 'node_api.h'))) {
          nodeInclude = candidate;
          break;
        }
      }

      if (napiInclude && nodeInclude) {
        const cxxFlags = [
          '-std=c++17',
          '-O2',
          '-DNAPI_DISABLE_CPP_EXCEPTIONS',
          '-Wall',
          '-Wextra',
          '-Wconversion',
          '-Wsign-conversion',
          '-Wshadow',
          '-Wformat=2',
          '-Wundef',
          '-Werror',
          `-I${napiInclude}`,
          `-I${nodeInclude}`,
          '-fsyntax-only',
        ];
        const cppTargets = hasLiburingHeader ? ['src/addon.cc', 'src/addon_stub.cc'] : ['src/addon_stub.cc'];
        for (const cppFile of cppTargets) {
          const res = spawnSync('g++', [...cxxFlags, path.join(rootDir, cppFile)], { encoding: 'utf8' });
          if (res.status !== 0) {
            fail(`C++ static check failed on ${cppFile}:\n${res.stderr}`);
          }
        }
      }
    }
  }

  if (errors > 0) {
    console.error(`[lint] Failed with ${errors} error(s).`);
    process.exit(1);
  }

  const ringStats = uringFs.getRingStats();
  console.log(
    `[lint] Passed (${jsFiles.length} JS/MJS files, ${cjsExports.length} CJS/ESM/TS exports, C++ -Werror static check, uring-fs dogfooding: backend=${uringFs.getActiveBackend()}, sqes=${ringStats.totalSqesPrepared}).`
  );
}

main().catch((err) => {
  console.error('[lint] Fatal error:', err);
  process.exit(1);
});
