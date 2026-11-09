/// <reference types="node" />
import { URL } from 'node:url';

export type PathLike = string | Buffer | URL;

export interface CustomFsProvider {
  open?: (path: string, flags?: string, mode?: number) => Promise<any>;
  readFile: (path: string, options?: any) => Promise<Buffer | string>;
  readAt?: (path: string, offset: number, length: number, options?: any) => Promise<Buffer | string>;
  readBatchAt?: (path: string, ranges: any[], options?: any) => Promise<any[]>;
  readv?: (path: string, buffers: any[], position?: number | null) => Promise<any>;
  writev?: (path: string, buffers: any[], position?: number | null, options?: any) => Promise<any>;
  fallocate?: (path: string, offset: number, length: number, mode?: number) => Promise<void>;
  fadvise?: (path: string, offset: number, length: number, advice: number) => Promise<void>;
  writeFile: (path: string, data: any, options?: any) => Promise<void>;
  appendFile?: (path: string, data: any, options?: any) => Promise<void>;
  copyFile?: (src: string, dest: string, mode?: number) => Promise<void>;
  stat: (path: string) => Promise<any>;
  lstat?: (path: string) => Promise<any>;
  access?: (path: string, mode?: number) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  rmdir?: (path: string, options?: any) => Promise<void>;
  mkdir: (path: string, options?: any) => Promise<string | undefined>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  symlink?: (target: string, path: string, type?: string) => Promise<void>;
  link?: (existingPath: string, newPath: string) => Promise<void>;
  fsync?: (path: string) => Promise<void>;
  fdatasync?: (path: string) => Promise<void>;
}

export type FallbackStrategy =
  | 'fs'
  | 'worker'
  | 'none'
  | boolean
  | CustomFsProvider
  | { promises: CustomFsProvider };

export type BatchSliceRange =
  | { offset: number; length: number }
  | [number, number];

export interface UringReadBatchOptions extends UringCommonOptions {
  encoding?: BufferEncoding | null;
}

export interface UringReadvOptions extends UringCommonOptions {}

export interface UringWritevOptions extends UringCommonOptions {
  flag?: string | number;
  flags?: string | number;
  mode?: number;
  flush?: boolean;
}

export interface UringFallocateOptions extends UringCommonOptions {}

export interface UringFadviseOptions extends UringCommonOptions {}

export interface UringOpenOptions extends UringCommonOptions {
  flag?: string | number;
  flags?: string | number;
  mode?: number;
}

export interface ReadvResult<T extends NodeJS.ArrayBufferView[] = NodeJS.ArrayBufferView[]> {
  bytesRead: number;
  buffers: T;
}

export interface WritevResult<T extends NodeJS.ArrayBufferView[] = NodeJS.ArrayBufferView[]> {
  bytesWritten: number;
  buffers: T;
}

export interface ReadHandleResult<T extends NodeJS.ArrayBufferView = NodeJS.ArrayBufferView> {
  bytesRead: number;
  buffer: T;
}

export interface WriteHandleResult<T = NodeJS.ArrayBufferView | string> {
  bytesWritten: number;
  buffer: T;
}

export class UringFileHandle {
  readonly fd: number;
  readonly directSlot: number;
  readonly closed: boolean;

  read<T extends NodeJS.ArrayBufferView>(
    buffer?: T,
    offset?: number,
    length?: number,
    position?: number | null
  ): Promise<ReadHandleResult<T>>;
  read<T extends NodeJS.ArrayBufferView = Buffer>(
    options?: {
      buffer?: T;
      offset?: number;
      length?: number;
      position?: number | null;
    }
  ): Promise<ReadHandleResult<T>>;

  readAt(
    offset: number,
    length: number,
    options?: { encoding?: null; signal?: AbortSignal } | null
  ): Promise<Buffer>;
  readAt(
    offset: number,
    length: number,
    options: BufferEncoding | { encoding: BufferEncoding; signal?: AbortSignal }
  ): Promise<string>;
  readAt(
    offset: number,
    length: number,
    options?: BufferEncoding | UringReadAtOptions | null
  ): Promise<Buffer | string>;

  readBatchAt(
    ranges: BatchSliceRange[],
    options?: { encoding?: null; signal?: AbortSignal } | null
  ): Promise<Buffer[]>;
  readBatchAt(
    ranges: BatchSliceRange[],
    options: BufferEncoding | { encoding: BufferEncoding; signal?: AbortSignal }
  ): Promise<string[]>;
  readBatchAt(
    ranges: BatchSliceRange[],
    options?: BufferEncoding | UringReadBatchOptions | null
  ): Promise<(Buffer | string)[]>;

  write<T extends NodeJS.ArrayBufferView>(
    buffer: T,
    offset?: number,
    length?: number,
    position?: number | null
  ): Promise<WriteHandleResult<T>>;
  write(
    string: string,
    position?: number | null,
    encoding?: BufferEncoding | null
  ): Promise<WriteHandleResult<string>>;
  write(
    string: string,
    encoding?: BufferEncoding | null
  ): Promise<WriteHandleResult<string>>;

  writeAt(
    buffer: NodeJS.ArrayBufferView | string,
    position?: number | null
  ): Promise<number>;

  readv<T extends NodeJS.ArrayBufferView[]>(
    buffers: T,
    position?: number | null
  ): Promise<ReadvResult<T>>;

  writev<T extends NodeJS.ArrayBufferView[]>(
    buffers: T,
    position?: number | null
  ): Promise<WritevResult<T>>;

  sync(): Promise<void>;
  datasync(): Promise<void>;

  fallocate(
    offset: number,
    length: number,
    mode?: number
  ): Promise<void>;

  fadvise(
    offset: number,
    length: number,
    advice: number
  ): Promise<void>;

  stat(options?: UringCommonOptions): Promise<UringStats>;

  close(): Promise<void>;

  [Symbol.asyncDispose](): Promise<void>;
}

export interface UringCommonOptions {
  /**
   * When `true`, throws `ERR_URING_UNSUPPORTED` if `io_uring` is inactive on the current system.
   */
  strict?: boolean;
  /**
   * Overrides the fallback strategy for this specific call.
   */
  fallback?: FallbackStrategy;
  /**
   * An optional AbortSignal to cancel the operation.
   */
  signal?: AbortSignal;
}

export interface UringReadOptions extends UringCommonOptions {
  encoding?: BufferEncoding | null;
  signal?: AbortSignal;
  /**
   * Size of the initial optimistic read buffer in bytes (default: 65536).
   * Setting to 0 disables optimistic read and queries file size via statx first.
   */
  optimisticReadSize?: number;
}

export interface UringReadAtOptions extends UringCommonOptions {
  encoding?: BufferEncoding | null;
  signal?: AbortSignal;
}

export interface UringRmdirOptions extends UringCommonOptions {
  maxRetries?: number;
  retryDelay?: number;
  signal?: AbortSignal;
}

export interface UringWriteOptions extends UringCommonOptions {
  encoding?: BufferEncoding | null;
  mode?: number;
  flag?: string | number;
  /**
   * When `true`, flushes all data to the underlying storage device via `io_uring_prep_fsync` before closing.
   */
  flush?: boolean;
  signal?: AbortSignal;
}

export interface UringMkdirOptions extends UringCommonOptions {
  recursive?: boolean;
  mode?: number;
}

export interface UringCopyOptions extends UringCommonOptions {
  mode?: number;
}

export interface UringFsConfig {
  /**
   * Strategy when `io_uring` is unavailable:
   * - `'fs'` or `true` (default): uses `node:fs/promises`
   * - `'worker'`: uses a dedicated `worker_threads` pool (isolated from libuv's 4-thread pool)
   * - Provider object (e.g. `graceful-fs`, `fs-extra`, `memfs`)
   * - `false` or `'none'`: throws an error if `io_uring` is inactive
   */
  fallback?: FallbackStrategy;
  /**
   * When `true`, forces the configured fallback backend even on Linux systems with active `io_uring`.
   */
  forceFallback?: boolean;
  /**
   * Number of worker threads for `fallback: 'worker'` mode (default: 2).
   */
  workerPoolSize?: number;
  /**
   * Default size of the initial optimistic read buffer in bytes (default: 65536).
   * Setting to 0 disables optimistic read globally.
   */
  optimisticReadSize?: number;
}

export interface RingStats {
  supported: boolean;
  activeBackend: 'io_uring' | 'worker' | 'custom' | 'fs' | 'none';
  queueDepth: number;
  activeRequests: number;
  inFlightSqes: number;
  pendingOverflowQueue: number;
  totalRequests: number;
  totalSqesPrepared: number;
  totalSubmitSyscalls: number;
  totalCqesReaped: number;
  peakInFlight: number;
  overflowQueued: number;
  credentialResets: number;
  optimisticReadSize: number;
  directFdsSupported: boolean;
  directFdTableSize: number;
  directFdsInUse: number;
  syscallsSavedByBatching: number;
}

export class UringStats {
  readonly dev: number;
  readonly rdev: number;
  readonly size: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly ino: number;
  readonly nlink: number;
  readonly blksize: number;
  readonly blocks: number;
  readonly atimeMs: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
  readonly atime: Date;
  readonly mtime: Date;
  readonly ctime: Date;
  readonly birthtime: Date;

  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

export function readFile(
  path: PathLike,
  options?: { encoding?: null; signal?: AbortSignal; strict?: boolean; fallback?: FallbackStrategy; optimisticReadSize?: number } | null
): Promise<Buffer>;
export function readFile(
  path: PathLike,
  options: BufferEncoding | { encoding: BufferEncoding; signal?: AbortSignal; strict?: boolean; fallback?: FallbackStrategy; optimisticReadSize?: number }
): Promise<string>;
export function readFile(
  path: PathLike,
  options?: BufferEncoding | UringReadOptions | null
): Promise<Buffer | string>;

export function readAt(
  path: PathLike,
  offset: number,
  length: number,
  options?: { encoding?: null; signal?: AbortSignal; strict?: boolean; fallback?: FallbackStrategy } | null
): Promise<Buffer>;
export function readAt(
  path: PathLike,
  offset: number,
  length: number,
  options: BufferEncoding | { encoding: BufferEncoding; signal?: AbortSignal; strict?: boolean; fallback?: FallbackStrategy }
): Promise<string>;
export function readAt(
  path: PathLike,
  offset: number,
  length: number,
  options?: BufferEncoding | UringReadAtOptions | null
): Promise<Buffer | string>;

export function writeFile(
  path: PathLike,
  data: string | Buffer | NodeJS.ArrayBufferView,
  options?: BufferEncoding | UringWriteOptions | null
): Promise<void>;

export function appendFile(
  path: PathLike,
  data: string | Buffer | NodeJS.ArrayBufferView,
  options?: BufferEncoding | UringWriteOptions | null
): Promise<void>;

export function copyFile(
  src: PathLike,
  dest: PathLike,
  options?: number | UringCopyOptions
): Promise<void>;

export interface UringAccessOptions extends UringCommonOptions {
  mode?: number;
  signal?: AbortSignal;
}

export function stat(path: PathLike, options?: UringCommonOptions): Promise<UringStats>;

export function lstat(path: PathLike, options?: UringCommonOptions): Promise<UringStats>;

export function access(
  path: PathLike,
  modeOrOptions?: number | UringAccessOptions,
  options?: UringAccessOptions
): Promise<void>;

export function exists(path: PathLike, options?: UringAccessOptions): Promise<boolean>;

export function unlink(path: PathLike, options?: UringCommonOptions): Promise<void>;

export function rmdir(path: PathLike, options?: UringRmdirOptions): Promise<void>;

export function mkdir(
  path: PathLike,
  options?: number | UringMkdirOptions
): Promise<string | undefined>;

export function rename(
  oldPath: PathLike,
  newPath: PathLike,
  options?: UringCommonOptions
): Promise<void>;

export function symlink(
  target: PathLike,
  path: PathLike,
  type?: string | null | UringCommonOptions,
  options?: UringCommonOptions
): Promise<void>;

export function link(
  existingPath: PathLike,
  newPath: PathLike,
  options?: UringCommonOptions
): Promise<void>;

export function fsync(path: PathLike, options?: UringCommonOptions): Promise<void>;

export function fdatasync(path: PathLike, options?: UringCommonOptions): Promise<void>;

export function isUringSupported(): boolean;
export function getActiveBackend(): 'io_uring' | 'worker' | 'custom' | 'fs' | 'none';
export function getUnsupportedReason(): string | null;
export function getRingStats(): RingStats;
export function configure(options?: UringFsConfig): {
  fallback: 'fs' | 'worker' | 'custom' | false;
  forceFallback: boolean;
  workerPoolSize: number;
  optimisticReadSize: number;
};
export function setOptimisticReadSize(bytes: number): number;
export function closeFallbackWorkers(): Promise<void>;
export function readBatchAt(
  path: PathLike,
  ranges: BatchSliceRange[],
  options?: { encoding?: null; signal?: AbortSignal; strict?: boolean; fallback?: FallbackStrategy } | null
): Promise<Buffer[]>;
export function readBatchAt(
  path: PathLike,
  ranges: BatchSliceRange[],
  options: BufferEncoding | { encoding: BufferEncoding; signal?: AbortSignal; strict?: boolean; fallback?: FallbackStrategy }
): Promise<string[]>;
export function readBatchAt(
  path: PathLike,
  ranges: BatchSliceRange[],
  options?: BufferEncoding | UringReadBatchOptions | null
): Promise<(Buffer | string)[]>;

export function readv<T extends NodeJS.ArrayBufferView[]>(
  path: PathLike,
  buffers: T,
  position?: number | null | UringReadvOptions,
  options?: UringReadvOptions
): Promise<ReadvResult<T>>;

export function writev<T extends NodeJS.ArrayBufferView[]>(
  path: PathLike,
  buffers: T,
  position?: number | null | UringWritevOptions,
  options?: UringWritevOptions
): Promise<WritevResult<T>>;

export function fallocate(
  path: PathLike,
  offset: number,
  length: number,
  mode?: number | UringFallocateOptions,
  options?: UringFallocateOptions
): Promise<void>;

export function fadvise(
  path: PathLike,
  offset: number,
  length: number,
  advice: number,
  options?: UringFadviseOptions
): Promise<void>;

export function open(
  path: PathLike,
  flags?: string | number | UringOpenOptions,
  mode?: number | UringOpenOptions,
  options?: UringOpenOptions
): Promise<UringFileHandle>;

export const FALLOC_FL_KEEP_SIZE: number;
export const FALLOC_FL_PUNCH_HOLE: number;
export const FALLOC_FL_COLLAPSE_RANGE: number;
export const FALLOC_FL_ZERO_RANGE: number;
export const FALLOC_FL_INSERT_RANGE: number;
export const FALLOC_FL_UNSHARE_RANGE: number;

export const POSIX_FADV_NORMAL: number;
export const POSIX_FADV_RANDOM: number;
export const POSIX_FADV_SEQUENTIAL: number;
export const POSIX_FADV_WILLNEED: number;
export const POSIX_FADV_DONTNEED: number;
export const POSIX_FADV_NOREUSE: number;

export const constants: typeof import('node:fs').constants & {
  FALLOC_FL_KEEP_SIZE: number;
  FALLOC_FL_PUNCH_HOLE: number;
  FALLOC_FL_COLLAPSE_RANGE: number;
  FALLOC_FL_ZERO_RANGE: number;
  FALLOC_FL_INSERT_RANGE: number;
  FALLOC_FL_UNSHARE_RANGE: number;
  POSIX_FADV_NORMAL: number;
  POSIX_FADV_RANDOM: number;
  POSIX_FADV_SEQUENTIAL: number;
  POSIX_FADV_WILLNEED: number;
  POSIX_FADV_DONTNEED: number;
  POSIX_FADV_NOREUSE: number;
};
export const F_OK: number;
export const R_OK: number;
export const W_OK: number;
export const X_OK: number;
export const COPYFILE_EXCL: number;

declare const _default: {
  open: typeof open;
  UringFileHandle: typeof UringFileHandle;
  readBatchAt: typeof readBatchAt;
  readv: typeof readv;
  writev: typeof writev;
  fallocate: typeof fallocate;
  fadvise: typeof fadvise;
  FALLOC_FL_KEEP_SIZE: typeof FALLOC_FL_KEEP_SIZE;
  FALLOC_FL_PUNCH_HOLE: typeof FALLOC_FL_PUNCH_HOLE;
  FALLOC_FL_COLLAPSE_RANGE: typeof FALLOC_FL_COLLAPSE_RANGE;
  FALLOC_FL_ZERO_RANGE: typeof FALLOC_FL_ZERO_RANGE;
  FALLOC_FL_INSERT_RANGE: typeof FALLOC_FL_INSERT_RANGE;
  FALLOC_FL_UNSHARE_RANGE: typeof FALLOC_FL_UNSHARE_RANGE;
  POSIX_FADV_NORMAL: typeof POSIX_FADV_NORMAL;
  POSIX_FADV_RANDOM: typeof POSIX_FADV_RANDOM;
  POSIX_FADV_SEQUENTIAL: typeof POSIX_FADV_SEQUENTIAL;
  POSIX_FADV_WILLNEED: typeof POSIX_FADV_WILLNEED;
  POSIX_FADV_DONTNEED: typeof POSIX_FADV_DONTNEED;
  POSIX_FADV_NOREUSE: typeof POSIX_FADV_NOREUSE;
  readFile: typeof readFile;
  readAt: typeof readAt;
  writeFile: typeof writeFile;
  appendFile: typeof appendFile;
  copyFile: typeof copyFile;
  stat: typeof stat;
  lstat: typeof lstat;
  access: typeof access;
  exists: typeof exists;
  unlink: typeof unlink;
  rmdir: typeof rmdir;
  mkdir: typeof mkdir;
  rename: typeof rename;
  symlink: typeof symlink;
  link: typeof link;
  fsync: typeof fsync;
  fdatasync: typeof fdatasync;
  isUringSupported: typeof isUringSupported;
  getActiveBackend: typeof getActiveBackend;
  getUnsupportedReason: typeof getUnsupportedReason;
  getRingStats: typeof getRingStats;
  configure: typeof configure;
  setOptimisticReadSize: typeof setOptimisticReadSize;
  closeFallbackWorkers: typeof closeFallbackWorkers;
  UringStats: typeof UringStats;
  constants: typeof constants;
  F_OK: typeof F_OK;
  R_OK: typeof R_OK;
  W_OK: typeof W_OK;
  X_OK: typeof X_OK;
  COPYFILE_EXCL: typeof COPYFILE_EXCL;
};

export default _default;
