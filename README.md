# `uring-fs` (`io_uring` File System for Node.js)

**True asynchronous filesystem I/O for Node.js on Linux powered by `io_uring` — with zero `libuv` thread-pool contention, 99% syscall reduction via Tick Auto-Batching, in-kernel zero-copy `splice`, and a 3-Tier Pluggable Fallback System.**

---

## Why `uring-fs` Exists

In Node.js, network I/O is non-blocking via `epoll`, but regular file I/O (`node:fs`) cannot use `epoll`. Because `libuv` disabled its internal `io_uring` integration by default (following `CVE-2024-22017`), Node.js routes all `fs`, `crypto`, `zlib`, and `dns.lookup` operations through a shared **4-thread pool** (`UV_THREADPOOL_SIZE=4`).

When a server performs CPU-bound thread-pool work (such as password hashing, TLS/crypto, or Gzip/Brotli compression), `fs.promises.readFile` stalls in the queue waiting for a worker thread.

**`uring-fs`** solves this by:
1. **100% Asynchronous Kernel State Machine:** Executes `openat`, `statx`, `read`, `write`, `splice`, `fsync`, `renameat`, `symlinkat`, `linkat`, `mkdirat`, `unlinkat`, and `close` entirely inside the Linux kernel's `io_uring` submission/completion rings (`SQ`/`CQ`), using **zero `libuv` worker threads**.
2. **Direct File Descriptors (`io_uring_register_files_sparse`) & Kernel Operation Chaining (`IOSQE_IO_LINK`):**
   - Registers a 1,024-slot in-kernel Direct File Descriptor table (`IOSQE_FIXED_FILE`), completely bypassing the POSIX process file descriptor table (`/proc/self/fd`) and eliminating kernel `files_struct` lock contention.
   - Chains multi-step lifecycles (`OPENAT_DIRECT` ➔ `WRITE` [➔ `FSYNC`] ➔ `CLOSE_DIRECT`, and linked `READ` pipelines) inside the kernel via `IOSQE_IO_LINK` in a single submission without returning to user space between steps.
3. **Configurable Optimistic Read (`optimisticReadSize`, default 64 KB):**
   - Eliminates the `STATX` roundtrip for files smaller than `optimisticReadSize` by chaining `OPENAT_DIRECT` ➔ `READ` directly, cutting SQEs by 25% (`3` instead of `4`).
   - Configurable globally (`configure({ optimisticReadSize })` / `setOptimisticReadSize(bytes)`) or per-call (`readFile(path, { optimisticReadSize })`).
4. **Tick Auto-Batching (`uv_prepare_t` + `uv_check_t`):** Automatically batches concurrent file operations issued in the same Event Loop tick into a single `io_uring_enter` syscall (saving up to **99.8% of syscalls**).
5. **Modern Kernel Optimizations (`SINGLE_ISSUER` + `COOP_TASKRUN`):** Automatically enables `IORING_SETUP_SINGLE_ISSUER` and `IORING_SETUP_COOP_TASKRUN` on Linux 6.0+ (with graceful fallback on older kernels) to eliminate kernel submission spinlocks and inter-processor interrupts (IPIs).
6. **Zero-Copy V8 Buffer Handoff & In-Kernel `splice` Copy:**
   - `readFile` uses a hot pre-faulted buffer pool for small reads and zero-copy V8 external buffer handoff for large reads.
   - `copyFile` uses `io_uring_prep_splice` (`IORING_OP_SPLICE`) to move bytes directly between file descriptors inside the Linux kernel page cache with **zero user-space memory allocation**.
7. **CVE-2024-22017 Credential Guard:** Tracks `geteuid()` / `getegid()` per batch and automatically resets the ring if process privileges change.
8. **3-Tier Pluggable Fallback System:** Works everywhere (macOS, Windows, restricted Docker) with your choice of:
   - `'fs'` (default): `node:fs/promises`
   - `'worker'`: Built-in dedicated `worker_threads` I/O pool (still isolated from `libuv`'s 4-thread pool!)
   - Custom Provider Object: Plug in `graceful-fs`, `fs-extra`, `memfs`, or any custom adapter
   - `false`: Strict mode (throws `ERR_URING_UNSUPPORTED` if `io_uring` is inactive)

---

## Benchmarks Across Node.js 20, 22, 24, and 26 (Linux 6.8, `v1.3.4`)

| Workload / Metric | Node.js `v20` (`v20.10.0`) | Node.js `v22` (`v22.17.0`) | Node.js `v24` (`v24.22.1`) | Node.js `v26` (`v26.12.1`) |
| :--- | :---: | :---: | :---: | :---: |
| **1,000 Concurrent Reads (4 KB each)**<br>`uring-fs` vs `node:fs/promises` | **`4.70 ms`** vs `13.92 ms`<br>**(2.96x faster)** | **`5.39 ms`** vs `17.75 ms`<br>**(3.29x faster)** | **`4.62 ms`** vs `15.75 ms`<br>**(3.41x faster)** | `4.68 ms` vs **`2.37 ms`**<br>*(1.97x slower, uncontended cache)* |
| **1,000 Concurrent Writes (4 KB each)**<br>`uring-fs` vs `node:fs/promises` | **`9.35 ms`** vs `16.25 ms`<br>**(1.74x faster)** | **`8.69 ms`** vs `12.98 ms`<br>**(1.49x faster)** | **`8.26 ms`** vs `8.52 ms`<br>**(1.03x faster)** | `7.92 ms` vs **`5.13 ms`**<br>*(1.54x slower, uncontended cache)* |
| **100 Concurrent Reads (128 KB each)**<br>`uring-fs` vs `node:fs/promises` | **`2.82 ms`** vs `3.34 ms`<br>**(1.18x faster)** | `2.63 ms` vs **`2.42 ms`**<br>*(1.09x slower, uncontended cache)* | **`3.34 ms`** vs `4.34 ms`<br>**(1.30x faster)** | `2.78 ms` vs **`1.77 ms`**<br>*(1.57x slower, uncontended cache)* |
| **Auto-Batching Syscall Reduction**<br>*(15,000 SQEs dispatched)* | **99.9% saved**<br>*(20 syscalls)* | **99.9% saved**<br>*(20 syscalls)* | **99.9% saved**<br>*(20 syscalls)* | **99.9% saved**<br>*(20 syscalls)* |
| **Mixed Server Load (20x 128 KB + `pbkdf2`)**<br>`uring-fs` vs `node:fs/promises` | **`0.70 ms`** vs `1.62 ms`*<br>**(2.3x faster)** | **`0.68 ms`** vs `95.44 ms`<br>**(139.6x faster)** | **`0.66 ms`** vs `77.48 ms`<br>**(117.6x faster)** | **`0.85 ms`** vs `69.02 ms`<br>**(81.5x faster)** |
| **Thread-Pool Starvation Latency**<br>`uring-fs` vs `node:fs/promises` | **`0.54 ms`** vs `1.83 ms`*<br>*(3x faster)* | **`0.24 ms`** vs `232.88 ms`<br>**(990x faster)** | **`0.82 ms`** vs `199.62 ms`<br>**(244x faster)** | **`0.23 ms`** vs `186.20 ms`<br>**(816x faster)** |

*\*Note: Early Node 20.6–20.11 releases had experimental internal `libuv` `io_uring` enabled before it was disabled in Node 20.11.1+ due to `CVE-2024-22017`. Even against `libuv`'s own internal `io_uring`, `uring-fs` is ~2.3x–3x faster while remaining protected against `CVE-2024-22017`.*

*\*\*Note on uncontended microbenchmarks: On Linux warm page cache with an idle `libuv` thread pool, Node 26's updated `fs/promises` path (`open + fstat + read + close in one thread pool round trip`) can dispatch across 4 idle worker threads faster in raw wall-clock microbenchmarks, whereas under realistic mixed server or crypto/zlib thread-pool contention `uring-fs` remains **81x–990x faster** across Node.js 22, 24, and 26.*

---

## Installation

```bash
npm install uring-fs
```

### Zero-Friction Prebuilds vs. Host CPU-Optimized Compilation (`-march=native`)

By default on Linux (`x64` and `arm64`, both `glibc` and `musl`), `uring-fs` ships with precompiled N-API binaries statically linked against `liburing.a` (with hidden ELF symbol visibility). This means `npm install uring-fs` works out-of-the-box in seconds with **zero runtime `liburing.so.2` or `build-essential` dependencies**—even in slim Docker/Alpine containers or when package managers run with `--ignore-scripts`.

> **Does static prebuilding hurt `liburing` performance on my CPU?**
> No: 95% of `liburing`'s hot path (`io_uring_get_sqe`, `io_uring_prep_*`, `io_uring_cqe_seen`, atomic memory barriers) consists of `static inline` header routines compiled with `-O3`, while the heavy I/O, DMA, and NVMe queue processing runs directly inside **your host's own Linux kernel**.
>
> However, if you want to compile `src/addon.cc` and `<liburing.h>` inline ring routines specifically tuned for your host CPU microarchitecture (`-O3 -march=native -mtune=native`) or link dynamically against your system's `liburing.so`, you can opt into source compilation at any time:

```bash
# 1. Install and compile tuned for the exact host CPU (-O3 -march=native -mtune=native)
URING_FS_MARCH_NATIVE=1 npm install uring-fs

# 2. Or rebuild an existing installation from source with standard -O3
URING_FS_BUILD_FROM_SOURCE=1 npm rebuild uring-fs

# 3. Or link dynamically against the system's shared liburing.so instead of static liburing.a
URING_FS_SHARED_LIBURING=1 URING_FS_BUILD_FROM_SOURCE=1 npm rebuild uring-fs
```

### Linux Build-From-Source Prerequisites (Only needed when compiling from source)
```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y liburing-dev build-essential

# Fedora / RHEL
sudo dnf install -y liburing-devel gcc-c++ make

# Arch Linux
sudo pacman -S liburing base-devel
```

---

## Quick Start (CommonJS & ESM)

```js
import {
  open,
  readBatchAt,
  readv,
  writev,
  fallocate,
  fadvise,
  readFile,
  readAt,
  writeFile,
  appendFile,
  copyFile,
  stat,
  lstat,
  access,
  exists,
  mkdir,
  rmdir,
  rename,
  symlink,
  link,
  fsync,
  fdatasync,
  unlink,
  isUringSupported,
  getRingStats,
  configure,
  POSIX_FADV_WILLNEED,
} from 'uring-fs';

console.log('io_uring active:', isUringSupported());

// Write with optional in-kernel fsync before close ({ flush: true })
await writeFile('hello.txt', 'Hello from Linux Kernel io_uring!\n', { flush: true });
await appendFile('hello.txt', 'Appended asynchronously.\n');

// Zero-copy in-kernel file copy via io_uring_prep_splice
await copyFile('hello.txt', 'hello_copy.txt');

// Atomic rename, symlinks, hardlinks, and lstat
await rename('hello_copy.txt', 'hello_renamed.txt');
await symlink('hello.txt', 'hello.link');
const linkInfo = await lstat('hello.link');
console.log('Is symlink:', linkInfo.isSymbolicLink());

const content = await readFile('hello.txt', 'utf8');
console.log(content);

// Inspect ring telemetry and syscall savings
console.log(getRingStats());

await unlink('hello.link');
await unlink('hello_renamed.txt');
await unlink('hello.txt');

// 1. Batched Positional Reads (readBatchAt) in 1 kernel roundtrip:
const slices = await readBatchAt('weights.bin', [
  [0, 1024],
  { offset: 4096, length: 512 },
  [8192, 2048],
]);

// 2. Persistent UringFileHandle (1-SQE operations, Symbol.asyncDispose):
{
  await using fh = await open('data.bin', 'r+');
  await fh.write(Buffer.from('Header'), 0, 6, 0); // Exactly 1 SQE!
  const { bytesRead } = await fh.read(Buffer.alloc(6), 0, 6, 0);
  const st = await fh.stat();
  await fh.sync();
  // Automatically closed on scope exit with zero descriptor leaks!
}

// 3. Vectored Scatter/Gather I/O (readv & writev):
await writev('network_log.bin', [
  Buffer.from('HTTP/1.1 200 OK\r\n'),
  Buffer.from('Content-Type: text/plain\r\n\r\n'),
  Buffer.from('Payload body'),
]);

// 4. Disk Pre-allocation (fallocate):
await fallocate('large_database.db', 0, 1024 * 1024 * 1024); // 1 GB preallocated

// 5. Pre-declare Access Pattern Hints (fadvise):
await fadvise('large_database.db', 0, 1024 * 1024 * 1024, POSIX_FADV_WILLNEED);
```

---

## Supported API

| Function | Kernel `io_uring` Opcode(s) | Description |
| :--- | :--- | :--- |
| `readBatchAt(path, ranges, options?)` | `OPENAT_DIRECT` ➔ `N * READ` ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Batched positional read of multiple ranges in a single kernel roundtrip |
| `readv(path, buffers, position?, options?)` | `OPENAT_DIRECT` ➔ `READV` ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Vectored scatter read into multiple buffers |
| `writev(path, buffers, position?, options?)` | `OPENAT_DIRECT` ➔ `WRITEV` ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Vectored gather write from multiple buffers |
| `fallocate(path, offset, length, mode?, options?)` | `OPENAT_DIRECT` ➔ `FALLOCATE` ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Direct disk space pre-allocation |
| `fadvise(path, offset, length, advice, options?)` | `OPENAT_DIRECT` ➔ `FADVISE` ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Pre-declares access pattern hints (`POSIX_FADV_*`) for page cache management |
| `open(path, flags?, mode?, options?)` | `OPENAT_DIRECT` *(1-SQE)* | Opens a file returning a persistent `UringFileHandle` with 1-SQE ops |
| `readFile(path, options?)` | `OPENAT_DIRECT` ➔ `READ` ➔ `CLOSE_DIRECT` *(Optimistic <64KB)*<br>`OPENAT_DIRECT` ➔ `STATX` ➔ `READ` ➔ `CLOSE_DIRECT` *(Large)* | Reads entire file with configurable `optimisticReadSize` and zero-copy V8 handoff |
| `readAt(path, offset, length, options?)` | `OPENAT_DIRECT` ➔ `READ` ➔ `CLOSE_DIRECT` *(`IOSQE_IO_HARDLINK`)* | Reads exact file slice at byte offset without thread pool or file table overhead |
| `writeFile(path, data, options?)` | `OPENAT_DIRECT` ➔ `WRITE` (➔ `FSYNC`) ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Writes `string`, `Buffer`, or `Uint8Array` in a single linked kernel chain |
| `appendFile(path, data, options?)` | `OPENAT_DIRECT(O_APPEND)` ➔ `WRITE` ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Appends data atomically at end of file |
| `copyFile(src, dest, mode?)` | `OPENAT` ➔ `STATX` ➔ `SPLICE` ➔ `CLOSE` | Zero-copy kernel-to-kernel copy via `io_uring_prep_splice` |
| `stat(path, options?)` | `STATX` (`0`) | Retrieves `UringStats` (follows symlinks) |
| `lstat(path, options?)` | `STATX` (`AT_SYMLINK_NOFOLLOW`) | Retrieves `UringStats` without following symlinks |
| `access(path, mode?, options?)` | `STATX` *(1-SQE)* | Checks file existence (`F_OK`) and permissions (`R_OK`, `W_OK`, `X_OK`) without opening an FD |
| `exists(path, options?)` | `STATX` *(1-SQE)* | Returns `Promise<boolean>` indicating whether the path exists |
| `rename(oldPath, newPath, options?)` | `RENAMEAT` | Atomically renames/moves a file or directory |
| `symlink(target, path, options?)` | `SYMLINKAT` | Creates a symbolic link |
| `link(existingPath, newPath, options?)` | `LINKAT` | Creates a hard link |
| `fsync(path, options?)` | `OPENAT_DIRECT` ➔ `FSYNC` (`0`) ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Flushes modified file data and metadata to disk |
| `fdatasync(path, options?)` | `OPENAT_DIRECT` ➔ `FSYNC` (`DATASYNC`) ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Flushes modified file data to disk |
| `mkdir(path, options?)` | `MKDIRAT` | Creates a directory (single or `{ recursive: true }`) |
| `rmdir(path, options?)` | `UNLINKAT` (`AT_REMOVEDIR`) *(1-SQE)* | Removes an empty directory |
| `unlink(path, options?)` | `UNLINKAT` | Removes a file or symbolic link |
| `setOptimisticReadSize(bytes)` | *(Configuration)* | Sets default optimistic read buffer size in bytes (`0` disables) |

---

## Tuning & 3-Tier Fallback Configuration

You can tune the optimistic read buffer size globally or per-call, and configure how `uring-fs` behaves when running outside Linux or inside a container where `io_uring` is restricted by `seccomp`:

```js
import { configure, setOptimisticReadSize, readFile } from 'uring-fs';
import gracefulFs from 'graceful-fs';

// Tune Optimistic Read buffer size globally (default: 65536 = 64 KB; 0 disables)
configure({ optimisticReadSize: 131072 }); // 128 KB
setOptimisticReadSize(65536);              // 64 KB

// Or override per readFile call:
const data = await readFile('medium-asset.bin', { optimisticReadSize: 262144 });

// 1. Default: Fallback to node:fs/promises
configure({ fallback: 'fs' });

// 2. Dedicated Worker Pool: Uses node:worker_threads so file I/O STILL avoids
// competing with crypto/zlib on libuv's 4-thread pool even on macOS/Windows/Docker!
configure({ fallback: 'worker', workerPoolSize: 2 });

// 3. Custom Provider: Plug in graceful-fs, fs-extra, memfs, or a custom storage engine
configure({ fallback: gracefulFs.promises });

// 4. Strict Mode: Throw ERR_URING_UNSUPPORTED if kernel io_uring is unavailable
configure({ fallback: false });
```

---

## License

MIT
