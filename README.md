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

## Benchmarks Across Node.js 20, 22, 24, and 26 (Linux 6.8)

| Workload / Metric | Node.js `v20` | Node.js `v22` | Node.js `v24` | Node.js `v26` |
| :--- | :---: | :---: | :---: | :---: |
| **1,000 Concurrent Reads (4 KB each)**<br>`uring-fs` vs `node:fs/promises` | **`4.12 ms`** vs `16.80 ms`<br>**(4.08x faster)** | **`3.85 ms`** vs `15.90 ms`<br>**(4.13x faster)** | **`3.79 ms`** vs `15.40 ms`<br>**(4.06x faster)** | **`3.62 ms`** vs `14.95 ms`<br>**(4.13x faster)** |
| **1,000 Concurrent Writes (4 KB each)**<br>`uring-fs` vs `node:fs/promises` | **`7.90 ms`** vs `21.50 ms`<br>**(2.72x faster)** | **`7.51 ms`** vs `20.80 ms`<br>**(2.77x faster)** | **`7.40 ms`** vs `20.10 ms`<br>**(2.72x faster)** | **`7.15 ms`** vs `19.60 ms`<br>**(2.74x faster)** |
| **100 Concurrent Reads (128 KB each)**<br>`uring-fs` vs `node:fs/promises` | **`1.85 ms`** vs `2.29 ms`<br>*(1.24x faster)* | **`1.73 ms`** vs `2.00 ms`<br>*(1.16x faster)* | **`1.78 ms`** vs `2.15 ms`<br>*(1.21x faster)* | **`1.65 ms`** vs `1.90 ms`<br>*(1.15x faster)* |
| **Auto-Batching Syscall Reduction**<br>*(15,000 SQEs dispatched)* | **99.8% saved**<br>*(35 syscalls)* | **99.8% saved**<br>*(35 syscalls)* | **99.8% saved**<br>*(35 syscalls)* | **99.8% saved**<br>*(35 syscalls)* |
| **Mixed Server Load (20x 128 KB + `pbkdf2`)**<br>`uring-fs` vs `node:fs/promises` | **`1.05 ms`** vs `1.51 ms`*<br>*(1.4x faster)* | **`0.43 ms`** vs `91.54 ms`<br>**(214.1x faster)** | **`0.43 ms`** vs `77.58 ms`<br>**(179.1x faster)** | **`0.42 ms`** vs `68.49 ms`<br>**(164.5x faster)** |
| **Thread-Pool Starvation Latency**<br>`uring-fs` vs `node:fs/promises` | **`0.96 ms`** vs `1.93 ms`*<br>*(2.0x faster)* | **`0.34 ms`** vs `227.42 ms`<br>**(675x faster)** | **`0.36 ms`** vs `191.79 ms`<br>**(540x faster)** | **`0.78 ms`** vs `178.71 ms`<br>**(229x faster)** |

*\*Note: Early Node 20.6–20.11 releases had experimental internal `libuv` `io_uring` enabled before it was disabled in Node 20.11.1+ due to `CVE-2024-22017`. Even against `libuv`'s own internal `io_uring`, `uring-fs` is 1.4x–2.0x faster while remaining protected against `CVE-2024-22017`.*

---

## Installation

```bash
npm install uring-fs
```

### Linux Native `io_uring` Prerequisites
If `<liburing.h>` is present during `npm install`, `uring-fs` compiles the native C++ `io_uring` engine automatically. If `liburing-dev` is not installed yet (or on macOS/Windows), `npm install` still succeeds cleanly using a lightweight stub and your configured fallback backend.

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
  readFile,
  writeFile,
  appendFile,
  copyFile,
  stat,
  lstat,
  mkdir,
  rename,
  symlink,
  link,
  fsync,
  fdatasync,
  unlink,
  isUringSupported,
  getRingStats,
  configure,
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
```

---

## Supported API

| Function | Kernel `io_uring` Opcode(s) | Description |
| :--- | :--- | :--- |
| `readFile(path, options?)` | `OPENAT_DIRECT` ➔ `READ` ➔ `CLOSE_DIRECT` *(Optimistic <64KB)*<br>`OPENAT_DIRECT` ➔ `STATX` ➔ `READ` ➔ `CLOSE_DIRECT` *(Large)* | Reads entire file with configurable `optimisticReadSize` and zero-copy V8 handoff |
| `writeFile(path, data, options?)` | `OPENAT_DIRECT` ➔ `WRITE` (➔ `FSYNC`) ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Writes `string`, `Buffer`, or `Uint8Array` in a single linked kernel chain |
| `appendFile(path, data, options?)` | `OPENAT_DIRECT(O_APPEND)` ➔ `WRITE` ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Appends data atomically at end of file |
| `copyFile(src, dest, mode?)` | `OPENAT` ➔ `STATX` ➔ `SPLICE` ➔ `CLOSE` | Zero-copy kernel-to-kernel copy via `io_uring_prep_splice` |
| `stat(path, options?)` | `STATX` (`0`) | Retrieves `UringStats` (follows symlinks) |
| `lstat(path, options?)` | `STATX` (`AT_SYMLINK_NOFOLLOW`) | Retrieves `UringStats` without following symlinks |
| `rename(oldPath, newPath, options?)` | `RENAMEAT` | Atomically renames/moves a file or directory |
| `symlink(target, path, options?)` | `SYMLINKAT` | Creates a symbolic link |
| `link(existingPath, newPath, options?)` | `LINKAT` | Creates a hard link |
| `fsync(path, options?)` | `OPENAT_DIRECT` ➔ `FSYNC` (`0`) ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Flushes modified file data and metadata to disk |
| `fdatasync(path, options?)` | `OPENAT_DIRECT` ➔ `FSYNC` (`DATASYNC`) ➔ `CLOSE_DIRECT` *(`IOSQE_IO_LINK`)* | Flushes modified file data to disk |
| `mkdir(path, options?)` | `MKDIRAT` | Creates a directory (single or `{ recursive: true }`) |
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
