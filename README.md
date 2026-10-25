# `uring-fs` (`io_uring` File System for Node.js)

**True asynchronous filesystem I/O for Node.js on Linux powered by `io_uring` — with zero `libuv` thread-pool contention, 99% syscall reduction via Tick Auto-Batching, and a 3-Tier Pluggable Fallback System.**

---

## Why `uring-fs` Exists

In Node.js, network I/O is non-blocking via `epoll`, but regular file I/O (`node:fs`) cannot use `epoll`. Because `libuv` disabled its internal `io_uring` integration by default (following `CVE-2024-22017`), Node.js routes all `fs`, `crypto`, `zlib`, and `dns.lookup` operations through a shared **4-thread pool** (`UV_THREADPOOL_SIZE=4`).

When a server performs CPU-bound thread-pool work (such as password hashing, TLS/crypto, or Gzip/Brotli compression), `fs.promises.readFile` stalls in the queue waiting for a worker thread.

**`uring-fs`** solves this by:
1. **100% Asynchronous Kernel State Machine:** Executes `openat` ➔ `statx` ➔ `read`/`write` ➔ `close` entirely inside the Linux kernel's `io_uring` submission/completion rings (`SQ`/`CQ`), using **zero `libuv` worker threads**.
2. **Tick Auto-Batching (`uv_prepare_t` + `uv_check_t`):** Automatically batches concurrent file operations issued in the same Event Loop tick into a single `io_uring_enter` syscall (saving up to **99% of syscalls**).
3. **Modern Kernel Optimizations (`SINGLE_ISSUER` + `COOP_TASKRUN`):** Automatically enables `IORING_SETUP_SINGLE_ISSUER` and `IORING_SETUP_COOP_TASKRUN` on Linux 6.0+ (with graceful fallback on older kernels) to eliminate kernel submission spinlocks and inter-processor interrupts (IPIs).
4. **Zero-Copy V8 Buffer Handoff:** Transfers kernel-read memory buffers directly to V8's garbage collector without an intermediate `memcpy`.
5. **CVE-2024-22017 Credential Guard:** Tracks `geteuid()` / `getegid()` per batch and automatically resets the ring if process privileges change.
6. **3-Tier Pluggable Fallback System:** Works everywhere (macOS, Windows, restricted Docker) with your choice of:
   - `'fs'` (default): `node:fs/promises`
   - `'worker'`: Built-in dedicated `worker_threads` I/O pool (still isolated from `libuv`'s 4-thread pool!)
   - Custom Provider Object: Plug in `graceful-fs`, `fs-extra`, `memfs`, or any custom adapter
   - `false`: Strict mode (throws `ERR_URING_UNSUPPORTED` if `io_uring` is inactive)

---

## Benchmarks Across Node.js 20, 22, 24, and 26 (Linux 6.8)

| Workload / Metric | Node.js `v20` | Node.js `v22` | Node.js `v24` | Node.js `v26` |
| :--- | :---: | :---: | :---: | :---: |
| **100 Concurrent Reads (128 KB each)**<br>`uring-fs` vs `node:fs/promises` | `2.41 ms` vs `2.29 ms` | **`1.81 ms`** vs `2.10 ms`<br>*(1.16x faster)* | **`2.00 ms`** vs `2.24 ms`<br>*(1.12x faster)* | `2.00 ms` vs `1.69 ms` |
| **Auto-Batching Syscall Reduction**<br>*(2,000 SQEs dispatched)* | **98.9% saved**<br>*(23 syscalls)* | **98.9% saved**<br>*(23 syscalls)* | **98.9% saved**<br>*(22 syscalls)* | **98.9% saved**<br>*(23 syscalls)* |
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
  mkdir,
  unlink,
  isUringSupported,
  getRingStats,
  configure,
} from 'uring-fs';

console.log('io_uring active:', isUringSupported());

await writeFile('hello.txt', 'Hello from Linux Kernel io_uring!\n');
await appendFile('hello.txt', 'Appended asynchronously.\n');

const content = await readFile('hello.txt', 'utf8');
console.log(content);

const info = await stat('hello.txt');
console.log('File size:', info.size, 'isFile:', info.isFile());

// Inspect ring telemetry and syscall savings
console.log(getRingStats());

await unlink('hello.txt');
```

---

## 3-Tier Fallback Configuration

When running outside Linux or inside a container where `io_uring` is restricted by `seccomp`, you can choose how `uring-fs` behaves:

```js
import { configure } from 'uring-fs';
import gracefulFs from 'graceful-fs';

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
