import cjsModule from './index.js';

export const {
  readFile,
  writeFile,
  appendFile,
  copyFile,
  stat,
  lstat,
  unlink,
  mkdir,
  rename,
  symlink,
  link,
  fsync,
  fdatasync,
  isUringSupported,
  getActiveBackend,
  getUnsupportedReason,
  getRingStats,
  configure,
  setOptimisticReadSize,
  closeFallbackWorkers,
  UringStats,
  constants,
} = cjsModule;

export default cjsModule;
