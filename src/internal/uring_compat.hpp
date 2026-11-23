#ifndef URING_FS_INTERNAL_URING_COMPAT_HPP
#define URING_FS_INTERNAL_URING_COMPAT_HPP

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#if defined(__GNUC__) || defined(__clang__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wconversion"
#pragma GCC diagnostic ignored "-Wsign-conversion"
#pragma GCC diagnostic ignored "-Wshadow"
#endif
#include <napi.h>
#if defined(__GNUC__) || defined(__clang__)
#pragma GCC diagnostic pop
#endif
#include <uv.h>
#include <liburing.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/uio.h>
#include <linux/falloc.h>
#include <string>
#include <cstring>
#include <cstdlib>
#include <cerrno>
#include <deque>
#include <unordered_set>
#include <vector>
#ifdef __GLIBC__
#include <malloc.h>
#endif

#ifndef FALLOC_FL_KEEP_SIZE
#define FALLOC_FL_KEEP_SIZE 0x01
#endif
#ifndef FALLOC_FL_PUNCH_HOLE
#define FALLOC_FL_PUNCH_HOLE 0x02
#endif
#ifndef FALLOC_FL_COLLAPSE_RANGE
#define FALLOC_FL_COLLAPSE_RANGE 0x08
#endif
#ifndef FALLOC_FL_ZERO_RANGE
#define FALLOC_FL_ZERO_RANGE 0x10
#endif
#ifndef FALLOC_FL_INSERT_RANGE
#define FALLOC_FL_INSERT_RANGE 0x20
#endif
#ifndef FALLOC_FL_UNSHARE_RANGE
#define FALLOC_FL_UNSHARE_RANGE 0x40
#endif

#ifndef POSIX_FADV_NORMAL
#define POSIX_FADV_NORMAL 0
#endif
#ifndef POSIX_FADV_RANDOM
#define POSIX_FADV_RANDOM 1
#endif
#ifndef POSIX_FADV_SEQUENTIAL
#define POSIX_FADV_SEQUENTIAL 2
#endif
#ifndef POSIX_FADV_WILLNEED
#define POSIX_FADV_WILLNEED 3
#endif
#ifndef POSIX_FADV_DONTNEED
#define POSIX_FADV_DONTNEED 4
#endif
#ifndef POSIX_FADV_NOREUSE
#define POSIX_FADV_NOREUSE 5
#endif

#ifndef SPLICE_F_MOVE
#define SPLICE_F_MOVE 1
#endif

#define DEFAULT_QUEUE_DEPTH 512
#define FALLBACK_QUEUE_DEPTH 128
#define MAX_SPLICE_CHUNK (1024 * 1024)
#define MAX_IO_CHUNK 0x7ffff000ULL
#define DEFAULT_OPTIMISTIC_READ_SIZE (64 * 1024)
#define DIRECT_FD_TABLE_SIZE 1024
static constexpr size_t MAX_HANDLE_DIRECT_SLOTS = 512;
#define MAX_POOLED_BUFFERS 256

// Initializes io_uring using modern kernel flags (COOP_TASKRUN + SINGLE_ISSUER) when supported,
// gracefully falling back to baseline flags (0) on older Linux kernels.
inline int InitRingWithBestFlags(uint32_t depth, struct io_uring* r) {
    unsigned int flags = 0;
#ifdef IORING_SETUP_COOP_TASKRUN
    flags |= IORING_SETUP_COOP_TASKRUN;
#endif
#ifdef IORING_SETUP_SINGLE_ISSUER
    flags |= IORING_SETUP_SINGLE_ISSUER;
#endif
    if (flags != 0) {
        int ret = io_uring_queue_init(depth, r, flags);
        if (ret == 0) {
            return 0;
        }
    }
    return io_uring_queue_init(depth, r, 0);
}

inline Napi::Object CreateErrnoError(
    Napi::Env env,
    int pos_errno,
    const char* syscall,
    const std::string& path,
    const std::string& dest_path = ""
) {
    int uv_err = -pos_errno;
    const char* code = uv_err_name(uv_err);
    const char* msg = uv_strerror(uv_err);

    std::string fullMsg = std::string(code) + ": " + msg + ", " + syscall;
    if (!path.empty()) {
        fullMsg += " '" + path + "'";
    }
    if (!dest_path.empty()) {
        fullMsg += " -> '" + dest_path + "'";
    }

    Napi::Error err = Napi::Error::New(env, fullMsg);
    Napi::Object obj = err.Value();
    obj.Set("errno", Napi::Number::New(env, uv_err));
    obj.Set("code", Napi::String::New(env, code));
    obj.Set("syscall", Napi::String::New(env, syscall));
    if (!path.empty()) {
        obj.Set("path", Napi::String::New(env, path));
    }
    if (!dest_path.empty()) {
        obj.Set("dest", Napi::String::New(env, dest_path));
    }
    return obj;
}

inline bool CheckAccessPermissions(const struct statx& stx, int mode, uid_t ring_euid, gid_t ring_egid) {
    int req_bits = mode & (R_OK | W_OK | X_OK);
    if (req_bits == 0) {
        return true;
    }
    if (ring_euid == 0) {
        if ((req_bits & X_OK) && !S_ISDIR(stx.stx_mode)) {
            return (stx.stx_mode & 0111) != 0;
        }
        return true;
    }

    int granted = 0;
    if (stx.stx_uid == ring_euid) {
        granted = (stx.stx_mode >> 6) & 7;
    } else if (stx.stx_gid == ring_egid) {
        granted = (stx.stx_mode >> 3) & 7;
    } else {
        bool in_group = false;
        int ngroups = getgroups(0, nullptr);
        if (ngroups > 0) {
            std::vector<gid_t> groups(static_cast<size_t>(ngroups));
            int actual = getgroups(ngroups, groups.data());
            for (int i = 0; i < actual; ++i) {
                if (groups[static_cast<size_t>(i)] == stx.stx_gid) {
                    in_group = true;
                    break;
                }
            }
        }
        if (in_group) {
            granted = (stx.stx_mode >> 3) & 7;
        } else {
            granted = stx.stx_mode & 7;
        }
    }

    int needed = 0;
    if (req_bits & R_OK) needed |= 4;
    if (req_bits & W_OK) needed |= 2;
    if (req_bits & X_OK) needed |= 1;

    return (granted & needed) == needed;
}

inline Napi::Object BuildStatObject(Napi::Env env, const struct statx& stx) {
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("dev", Napi::Number::New(env, static_cast<double>(makedev(stx.stx_dev_major, stx.stx_dev_minor))));
    obj.Set("rdev", Napi::Number::New(env, static_cast<double>(makedev(stx.stx_rdev_major, stx.stx_rdev_minor))));
    obj.Set("size", Napi::Number::New(env, static_cast<double>(stx.stx_size)));
    obj.Set("mode", Napi::Number::New(env, stx.stx_mode));
    obj.Set("uid", Napi::Number::New(env, stx.stx_uid));
    obj.Set("gid", Napi::Number::New(env, stx.stx_gid));
    obj.Set("ino", Napi::Number::New(env, static_cast<double>(stx.stx_ino)));
    obj.Set("nlink", Napi::Number::New(env, stx.stx_nlink));
    obj.Set("blksize", Napi::Number::New(env, stx.stx_blksize));
    obj.Set("blocks", Napi::Number::New(env, static_cast<double>(stx.stx_blocks)));

    double atimeMs = static_cast<double>(stx.stx_atime.tv_sec) * 1000.0 + static_cast<double>(stx.stx_atime.tv_nsec) / 1e6;
    double mtimeMs = static_cast<double>(stx.stx_mtime.tv_sec) * 1000.0 + static_cast<double>(stx.stx_mtime.tv_nsec) / 1e6;
    double ctimeMs = static_cast<double>(stx.stx_ctime.tv_sec) * 1000.0 + static_cast<double>(stx.stx_ctime.tv_nsec) / 1e6;
    double btimeMs = (stx.stx_mask & STATX_BTIME)
        ? (static_cast<double>(stx.stx_btime.tv_sec) * 1000.0 + static_cast<double>(stx.stx_btime.tv_nsec) / 1e6)
        : ctimeMs;

    obj.Set("atimeMs", Napi::Number::New(env, atimeMs));
    obj.Set("mtimeMs", Napi::Number::New(env, mtimeMs));
    obj.Set("ctimeMs", Napi::Number::New(env, ctimeMs));
    obj.Set("birthtimeMs", Napi::Number::New(env, btimeMs));

    obj.Set("isFile", Napi::Boolean::New(env, S_ISREG(stx.stx_mode)));
    obj.Set("isDirectory", Napi::Boolean::New(env, S_ISDIR(stx.stx_mode)));
    obj.Set("isSymbolicLink", Napi::Boolean::New(env, S_ISLNK(stx.stx_mode)));
    return obj;
}

#endif // URING_FS_INTERNAL_URING_COMPAT_HPP
