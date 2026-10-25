import cjsModule from './index.js';

export const {
  readFile,
  writeFile,
  appendFile,
  copyFile,
  stat,
  unlink,
  mkdir,
  isUringSupported,
  getActiveBackend,
  getUnsupportedReason,
  getRingStats,
  configure,
  closeFallbackWorkers,
  UringStats,
  constants,
} = cjsModule;

export default cjsModule;
