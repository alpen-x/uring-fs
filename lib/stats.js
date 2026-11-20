'use strict';

/**
 * Node.js fs.Stats-compatible wrapper around io_uring statx results.
 */
class UringStats {
  constructor(raw) {
    this.dev = raw.dev ?? 0;
    this.rdev = raw.rdev ?? 0;
    this.size = raw.size;
    this.mode = raw.mode;
    this.uid = raw.uid;
    this.gid = raw.gid;
    this.ino = raw.ino;
    this.nlink = raw.nlink;
    this.blksize = raw.blksize;
    this.blocks = raw.blocks;
    this.atimeMs = raw.atimeMs;
    this.mtimeMs = raw.mtimeMs;
    this.ctimeMs = raw.ctimeMs;
    this.birthtimeMs = raw.birthtimeMs;
    this.atime = new Date(raw.atimeMs);
    this.mtime = new Date(raw.mtimeMs);
    this.ctime = new Date(raw.ctimeMs);
    this.birthtime = new Date(raw.birthtimeMs);
    this._isFile = typeof raw.isFile === 'function' ? raw.isFile() : Boolean(raw.isFile);
    this._isDirectory = typeof raw.isDirectory === 'function' ? raw.isDirectory() : Boolean(raw.isDirectory);
    this._isSymbolicLink = typeof raw.isSymbolicLink === 'function' ? raw.isSymbolicLink() : Boolean(raw.isSymbolicLink);
  }

  isFile() {
    return this._isFile;
  }

  isDirectory() {
    return this._isDirectory;
  }

  isSymbolicLink() {
    return this._isSymbolicLink;
  }

  isBlockDevice() {
    return (this.mode & 0o170000) === 0o060000;
  }

  isCharacterDevice() {
    return (this.mode & 0o170000) === 0o020000;
  }

  isFIFO() {
    return (this.mode & 0o170000) === 0o010000;
  }

  isSocket() {
    return (this.mode & 0o170000) === 0o140000;
  }
}

module.exports = {
  UringStats,
};
