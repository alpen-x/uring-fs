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
#include <sys/socket.h>
#include <sys/sysmacros.h>
#include <sys/uio.h>
#include <linux/falloc.h>
#include <string>
#include <cstring>
#include <cstdlib>
#include <cerrno>
#include <deque>
#include <type_traits>
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

#ifndef IORING_SETUP_CQSIZE
#define IORING_SETUP_CQSIZE (1U << 3)
#endif
#ifndef IORING_SETUP_R_DISABLED
#define IORING_SETUP_R_DISABLED (1U << 6)
#endif
#ifndef IORING_SETUP_COOP_TASKRUN
#define IORING_SETUP_COOP_TASKRUN (1U << 8)
#endif
#ifndef IORING_SETUP_TASKRUN_FLAG
#define IORING_SETUP_TASKRUN_FLAG (1U << 9)
#endif
#ifndef IORING_SETUP_SINGLE_ISSUER
#define IORING_SETUP_SINGLE_ISSUER (1U << 12)
#endif
#ifndef IORING_SQ_CQ_OVERFLOW
#define IORING_SQ_CQ_OVERFLOW (1U << 1)
#endif
#ifndef IORING_SQ_TASKRUN
#define IORING_SQ_TASKRUN (1U << 2)
#endif

#define DEFAULT_QUEUE_DEPTH 1024
#define MID_QUEUE_DEPTH 512
#define FALLBACK_QUEUE_DEPTH 128
#define MAX_SPLICE_CHUNK (1024 * 1024)
#define MAX_IO_CHUNK 0x7ffff000ULL
#define DEFAULT_OPTIMISTIC_READ_SIZE (64 * 1024)
#define DIRECT_FD_TABLE_SIZE 1024
static constexpr size_t MAX_HANDLE_DIRECT_SLOTS = 512;
#define MAX_POOLED_BUFFERS 512
#define MAX_POOLED_BYTES (32 * 1024 * 1024)
#define OPTIMISTIC_COPY_THRESHOLD (64 * 1024)

static constexpr uint8_t ALLOWED_URING_FS_OPCODES[] = {
    IORING_OP_NOP,
    IORING_OP_READV,
    IORING_OP_WRITEV,
    IORING_OP_FSYNC,
    IORING_OP_READ_FIXED,
    IORING_OP_WRITE_FIXED,
    IORING_OP_ASYNC_CANCEL,
    IORING_OP_FALLOCATE,
    IORING_OP_OPENAT,
    IORING_OP_CLOSE,
    IORING_OP_FILES_UPDATE,
    IORING_OP_STATX,
    IORING_OP_READ,
    IORING_OP_WRITE,
    IORING_OP_FADVISE,
    IORING_OP_OPENAT2,
    IORING_OP_SPLICE,
    IORING_OP_RENAMEAT,
    IORING_OP_UNLINKAT,
    IORING_OP_MKDIRAT,
    IORING_OP_SYMLINKAT,
    IORING_OP_LINKAT,
};

static constexpr uint32_t ALLOWED_URING_FS_OPCODES_COUNT =
    static_cast<uint32_t>(sizeof(ALLOWED_URING_FS_OPCODES) / sizeof(ALLOWED_URING_FS_OPCODES[0]));

// Initializes io_uring using progressive modern kernel flags (CQSIZE 4x + SINGLE_ISSUER +
// COOP_TASKRUN + TASKRUN_FLAG) when supported, gracefully falling back on older kernels.
inline int InitRingWithBestFlags(unsigned depth, struct io_uring* r, unsigned extra_flags = 0) {
    const unsigned flag_attempts[] = {
        extra_flags | IORING_SETUP_CQSIZE | IORING_SETUP_SINGLE_ISSUER | IORING_SETUP_COOP_TASKRUN | IORING_SETUP_TASKRUN_FLAG,
        extra_flags | IORING_SETUP_CQSIZE | IORING_SETUP_COOP_TASKRUN,
        extra_flags | IORING_SETUP_CQSIZE,
    };
    for (unsigned flags : flag_attempts) {
        struct io_uring_params params = {};
        params.flags = flags;
        params.cq_entries = depth * 4U;
        int ret = io_uring_queue_init_params(depth, r, &params);
        if (ret == 0) {
            return 0;
        }
    }
    struct io_uring_params params = {};
    params.flags = extra_flags;
    return io_uring_queue_init_params(depth, r, &params);
}

// Registers an explicit SQE and register-op whitelist on a ring initialized with IORING_SETUP_R_DISABLED,
// then activates the ring via io_uring_enable_rings().
inline int ApplyRingRestrictions(struct io_uring* r) {
    static constexpr uint8_t MODERN_REGISTER_OPS[] = {
        IORING_REGISTER_ENABLE_RINGS,
        IORING_REGISTER_FILES,
        IORING_REGISTER_FILES_UPDATE,
        IORING_REGISTER_FILES2,
        IORING_REGISTER_FILES_UPDATE2,
        IORING_REGISTER_BUFFERS,
        IORING_REGISTER_BUFFERS2,
        IORING_REGISTER_BUFFERS_UPDATE,
        IORING_UNREGISTER_BUFFERS,
        IORING_REGISTER_PROBE,
        IORING_REGISTER_SYNC_CANCEL,
    };
    static constexpr uint8_t CORE_REGISTER_OPS[] = {
        IORING_REGISTER_ENABLE_RINGS,
        IORING_REGISTER_FILES,
        IORING_REGISTER_FILES_UPDATE,
        IORING_REGISTER_BUFFERS,
        IORING_UNREGISTER_BUFFERS,
        IORING_REGISTER_PROBE,
    };

    auto try_register = [r](const uint8_t* reg_ops, size_t reg_count) -> int {
        std::vector<struct io_uring_restriction> res(ALLOWED_URING_FS_OPCODES_COUNT + reg_count + 1);
        std::memset(res.data(), 0, res.size() * sizeof(struct io_uring_restriction));
        size_t idx = 0;
        for (uint32_t i = 0; i < ALLOWED_URING_FS_OPCODES_COUNT; ++i) {
            res[idx].opcode = IORING_RESTRICTION_SQE_OP;
            res[idx].sqe_op = ALLOWED_URING_FS_OPCODES[i];
            idx++;
        }
        for (size_t i = 0; i < reg_count; ++i) {
            res[idx].opcode = IORING_RESTRICTION_REGISTER_OP;
            res[idx].register_op = reg_ops[i];
            idx++;
        }
        res[idx].opcode = IORING_RESTRICTION_SQE_FLAGS_ALLOWED;
        res[idx].sqe_flags = static_cast<__u8>(
            IOSQE_FIXED_FILE | IOSQE_IO_LINK | IOSQE_IO_HARDLINK | IOSQE_IO_DRAIN | IOSQE_ASYNC
        );
        idx++;
        return io_uring_register_restrictions(r, res.data(), static_cast<unsigned int>(res.size()));
    };

    int ret = try_register(MODERN_REGISTER_OPS, sizeof(MODERN_REGISTER_OPS) / sizeof(MODERN_REGISTER_OPS[0]));
    if (ret == -EINVAL) {
        ret = try_register(CORE_REGISTER_OPS, sizeof(CORE_REGISTER_OPS) / sizeof(CORE_REGISTER_OPS[0]));
    }
    if (ret < 0) {
        return ret;
    }
    return io_uring_enable_rings(r);
}

inline bool RingHasCqOverflow(const struct io_uring* r) {
    if (!r || !r->sq.kflags) {
        return false;
    }
    return (__atomic_load_n(r->sq.kflags, __ATOMIC_RELAXED) & IORING_SQ_CQ_OVERFLOW) != 0;
}

inline bool RingNeedsTaskRun(const struct io_uring* r) {
    if (!r || !r->sq.kflags) {
        return false;
    }
    return (__atomic_load_n(r->sq.kflags, __ATOMIC_RELAXED) & IORING_SQ_TASKRUN) != 0;
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
