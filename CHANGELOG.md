# Changelog

All notable changes to `uring-fs` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-11-08

### Added
- **Positional Read (`readAt(filePath, offset, length, options?)`):**
  - High-performance random access positional file reads via a 3-SQE kernel linked chain (`openat_direct(slot) -> read(slot, len, offset) -> close_direct(slot)`).
  - Uses `IOSQE_IO_HARDLINK` on the read SQE to ensure `close_direct` executes atomically within the same kernel roundtrip even on EOF short reads.
  - Slices only the exact requested bytes, preventing unnecessary memory allocation during partial file inspection (critical for `.safetensors`, GGUF weights, parquet files, and embedded vector indices).
  - Full support for string encodings (`'utf8'`, etc.), `AbortSignal`, and 3-tier fallback parity (`worker`, `node:fs`, custom providers).
- **1-SQE `rmdir(path, options?)` via `io_uring_prep_unlinkat`:**
  - Fast empty directory removal in a single io_uring SQE using `AT_REMOVEDIR`.
  - Standard POSIX error behavior (`ENOTEMPTY`/`EEXIST` when directory is not empty, `ENOENT` when missing).
  - Supported across `io_uring`, dedicated worker threads, and `node:fs` fallbacks.
- **Uniform `AbortSignal` Support Across All APIs:**
  - Added pre-aborted signal checks and asynchronous cancellation wrapping across `copyFile`, `stat`, `lstat`, `unlink`, `rmdir`, `mkdir`, `rename`, `symlink`, `link`, `fsync`, and `fdatasync`.
  - Consistent `AbortError` (`ABORT_ERR`) with `cause` preserved from `signal.reason`.

### Changed & Optimized
- **Hot Buffer Recycling for Optimistic Reads (`src/addon.cc`):**
  - By copying small read results to V8 Buffers and recycling the underlying 64 KB buffers directly into `optimistic_buffer_pool`, subsequent reads no longer suffer `std::malloc`/`std::free` heap overhead.
- **Hardened `readAt`, `symlink`, and Custom Provider Fallbacks:**
  - Enforced strict `TypeError` (`ERR_INVALID_ARG_TYPE`) vs `RangeError` (`ERR_OUT_OF_RANGE`) validation on `readAt` `offset` and `length`, and unified 0-byte `readAt` behavior (`ENOENT` on missing files, `EISDIR` on directories) across `io_uring`, `worker`, and `node:fs`.
  - Added 4-argument `symlink(target, path, type, options)` support and in-flight `AbortSignal` file handle cleanup for custom providers in `readAt`, `fsync`, and `fdatasync`.
- **Upgraded CI / GitHub Actions Workflows:**
  - Target Node 24 with `@v7` actions, updated provenance and trusted publishing configurations.

## [1.2.0] - 2026-11-03

### Added
- **1-SQE `access(path, mode?, options?)` and `exists(path, options?)` via `STATX`:**
  - Checks file existence (`F_OK`) and POSIX permissions (`R_OK`, `W_OK`, `X_OK`) in a single `io_uring_prep_statx` submission without opening or closing file descriptors.
  - Full POSIX permission evaluation against effective UID/GID (`geteuid`/`getegid`) and supplementary groups (`getgroups`), including root (`uid == 0`) execution bit semantics.
  - Supports `AbortSignal` and all 3 fallback tiers (`fs`, `worker`, custom provider).
- **Top-Level Permission & Copy Constants:**
  - Exported `F_OK`, `R_OK`, `W_OK`, `X_OK`, and `COPYFILE_EXCL` directly at the top level in CommonJS (`index.js`), ES Modules (`index.mjs`), and TypeScript definitions (`index.d.ts`), in addition to `constants`.
- **`DataView` Support in `writeFile` and `appendFile`:**
  - Native N-API addon (`WriteFileUring`) and JS wrapper now accept any `ArrayBufferView` (`Buffer`, `TypedArray`, and `DataView` with arbitrary `byteOffset`/`byteLength`).
- **Complete `UringStats` Parity with `node:fs.Stats`:**
  - Added `dev` and `rdev` device identifiers (computed via `makedev` from `stx_dev_major`/`minor` and `stx_rdev_major`/`minor`).
  - Added `isBlockDevice()`, `isCharacterDevice()`, `isFIFO()`, and `isSocket()` POSIX mode predicates.
- **Environment Variable Configuration (`URING_FS_FALLBACK`):**
  - Added startup support for `URING_FS_FALLBACK=worker|fs|native|none` to override the active backend without code changes.
- **Extended Open Flags in `parseWriteFlags`:**
  - Added support for `'wx+'`, `'xw+'`, `'a+'`, `'ax+'`, `'xa+'`, `'as'`, `'as+'`, `'rs+'`, and `'sr+'`.

### Fixed
- **Linked SQE Short-Write & Short-Read Resumption (`src/addon.cc`):**
  - Fixed a potential data truncation bug where a partial write or `EINTR`/`EAGAIN` inside a linked `openat_direct -> write -> [fsync ->] close_direct` chain would cancel the linked `close_direct` (`-ECANCELED`) and close the descriptor without writing the remaining bytes. It now transitions to `STAGE_WRITE` on the open direct descriptor slot until all bytes are written and flushed.
  - Fixed a potential truncation bug in `TryScheduleLinkedReadPair2` (`read -> close_direct`) where a short kernel read before EOF would overwrite `req->size` with the partial `req->offset`. It now re-schedules `STAGE_READ_DIRECT_PAIR2` until `req->offset == req->size` or true EOF (`res == 0`).
- **Recursive `mkdir(path, { recursive: true })` Return Value (`index.js`):**
  - Fixed `mkdir` in `io_uring` mode to return the *first* newly created directory path (or `undefined` if already existing), matching the exact `node:fs/promises.mkdir` contract.
- **Per-Call `{ fallback: false }` / `{ fallback: 'none' }` Selection (`index.js`):**
  - Fixed `selectExecutionBackend` falsely throwing `ERR_URING_UNSUPPORTED` when `{ fallback: false }` or `{ fallback: 'none' }` was passed per-call on a system where `io_uring` is supported and active.
- **Credential Reset `uv_poll_t` Re-initialization & CVE-2024-22017 Check (`src/addon.cc`):**
  - Removed the `unsubmitted_sqes > 0` fast-path skip in `EnsureCredentialsSafe` so UID/GID changes within the same event-loop tick are always detected.
  - Avoided calling `uv_poll_init` twice on the static `poll_handle` during credential resets (which could corrupt libuv's internal `handle_queue`), updating `poll_handle.io_watcher.fd` after `uv_poll_stop` instead.
- **Direct Descriptor Fallback Close & Module Cleanup (`src/addon.cc`):**
  - In `EnqueueAsyncCloseDirect`, if the SQ ring is completely full (`sqe == nullptr`), the kernel direct descriptor is now synchronously closed via `io_uring_register_files_update(&ring, slot, &empty_fd, 1)` before returning the slot to `direct_fd_free_list`.
  - `CleanupModule` now drains any leftover entries in `pending_queue` and `pending_pair2_queue` and destroys `napi_async_context`.
  - `FlushSubmissions` now advances any unadvanced CQEs (`unadvanced_cqes`) before invoking `io_uring_submit`.
  - Clamped individual read/write SQE lengths to `MAX_IO_CHUNK` (`0x7ffff000`).
- **Standardized Node.js Error Codes & Input Validation (`index.js`):**
  - `normalizePath` now attaches `err.code = 'ERR_INVALID_ARG_TYPE'`.
  - `exists()` now re-throws `TypeError` (`ERR_INVALID_ARG_TYPE`) on invalid path arguments (e.g., `exists(null)`) instead of returning `false`.
  - `access()` validates `mode` is an integer in `0..7` and throws `RangeError` (`ERR_OUT_OF_RANGE`) otherwise.
  - `readFile()` and `writeFile()` eagerly validate `encoding` before I/O and throw `TypeError` (`ERR_INVALID_ARG_VALUE`).
  - `setOptimisticReadSize()` and `configure()` validate `Number.isFinite()` to reject `NaN` and `Infinity`.
- **Dedicated Worker Pool Recovery (`lib/worker_fallback.js`):**
  - Added abnormal worker `'exit'` handling, automatic pool reset after worker crashes, and pending promise rejection on `terminate()`.

## [1.1.0] - 2026-11-02

### Added
- Configurable Optimistic Read (`optimisticReadSize`, default 64 KB) with a 256-slot Hot Buffer Pool and in-place `std::realloc` shrink-to-fit.
- Kernel Direct File Descriptors (`io_uring_register_files_sparse` with 1,024 slots) and `IOSQE_IO_LINK` operation chaining (`openat_direct -> read/write -> close_direct`).
- Zero-copy in-kernel `copyFile` via `io_uring_prep_splice`.
- New filesystem operations: `lstat`, `rename`, `symlink`, `link`, `fsync`, `fdatasync`, and `writeFile(..., { flush: true })`.

## [1.0.0] - 2026-11-01

### Added
- Initial release of `uring-fs` with `readFile`, `writeFile`, `appendFile`, `stat`, `mkdir`, `unlink`, automatic event-loop tick batching (`uv_prepare`/`uv_check`), 3-tier fallback system (`fs`, `worker`, custom provider), and CVE-2024-22017 mitigation.
