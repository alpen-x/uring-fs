/// <reference types="node" />
import { URL } from 'node:url';

export type PathLike = string | Buffer | URL;

export interface CustomFsProvider {
  readFile: (path: string, options?: any) => Promise<Buffer | string>;
  writeFile: (path: string, data: any, options?: any) => Promise<void>;
  appendFile?: (path: string, data: any, options?: any) => Promise<void>;
  copyFile?: (src: string, dest: string, mode?: number) => Promise<void>;
  stat: (path: string) => Promise<any>;
  lstat?: (path: string) => Promise<any>;
  unlink: (path: string) => Promise<void>;
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

export interface UringCommonOptions {
  /**
   * When `true`, throws `ERR_URING_UNSUPPORTED` if `io_uring` is inactive on the current system.
   */
  strict?: boolean;
  /**
   * Overrides the fallback strategy for this specific call.
   */
  fallback?: FallbackStrategy;
}

export interface UringReadOptions extends UringCommonOptions {
  encoding?: BufferEncoding | null;
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
  syscallsSavedByBatching: number;
}

export class UringStats {
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
}

export function readFile(
  path: PathLike,
  options?: { encoding?: null; signal?: AbortSignal; strict?: boolean; fallback?: FallbackStrategy } | null
): Promise<Buffer>;
export function readFile(
  path: PathLike,
  options: BufferEncoding | { encoding: BufferEncoding; signal?: AbortSignal; strict?: boolean; fallback?: FallbackStrategy }
): Promise<string>;
export function readFile(
  path: PathLike,
  options?: BufferEncoding | UringReadOptions | null
): Promise<Buffer | string>;

export function writeFile(
  path: PathLike,
  data: string | Buffer | Uint8Array,
  options?: BufferEncoding | UringWriteOptions | null
): Promise<void>;

export function appendFile(
  path: PathLike,
  data: string | Buffer | Uint8Array,
  options?: BufferEncoding | UringWriteOptions | null
): Promise<void>;

export function copyFile(
  src: PathLike,
  dest: PathLike,
  options?: number | UringCopyOptions
): Promise<void>;

export function stat(path: PathLike, options?: UringCommonOptions): Promise<UringStats>;

export function lstat(path: PathLike, options?: UringCommonOptions): Promise<UringStats>;

export function unlink(path: PathLike, options?: UringCommonOptions): Promise<void>;

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
  typeOrOptions?: string | UringCommonOptions
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
};
export function closeFallbackWorkers(): Promise<void>;
export const constants: typeof import('node:fs').constants;
