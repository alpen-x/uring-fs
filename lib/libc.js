'use strict';

const fs = require('node:fs');

/**
 * Detects the C standard library variant on Linux ('glibc' or 'musl').
 * Returns null on non-Linux operating systems.
 */
function detectLibc() {
  if (process.platform !== 'linux') {
    return null;
  }
  try {
    if (typeof process.report?.getReport === 'function') {
      const rep = process.report.getReport();
      if (rep && rep.header && rep.header.glibcVersionRuntime) {
        return 'glibc';
      }
      if (rep && Array.isArray(rep.sharedObjects)) {
        if (rep.sharedObjects.some((s) => typeof s === 'string' && s.includes('musl'))) {
          return 'musl';
        }
      }
    }
  } catch {}

  try {
    if (
      fs.existsSync('/lib/ld-musl-x86_64.so.1') ||
      fs.existsSync('/lib/ld-musl-aarch64.so.1') ||
      fs.existsSync('/etc/alpine-release')
    ) {
      return 'musl';
    }
  } catch {}

  return 'glibc';
}

module.exports = {
  detectLibc,
};
