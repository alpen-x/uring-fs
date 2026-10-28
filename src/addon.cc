#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <napi.h>
#include <uv.h>
#include <liburing.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <string>
#include <cstring>
#include <cstdlib>
#include <cerrno>
#include <deque>
#include <vector>

#define DEFAULT_QUEUE_DEPTH 512
#define FALLBACK_QUEUE_DEPTH 128
#define MAX_SPLICE_CHUNK (1024 * 1024)

#ifndef SPLICE_F_MOVE
#define SPLICE_F_MOVE 1
#endif

enum OperationType {
    OP_READ_FILE,
    OP_WRITE_FILE,
    OP_COPY_FILE,
    OP_STAT,
    OP_LSTAT,
    OP_UNLINK,
    OP_MKDIR,
    OP_RENAME,
    OP_SYMLINK,
    OP_LINK,
    OP_FSYNC
};

enum RequestStage {
    STAGE_OPEN,
    STAGE_STATX,
    STAGE_OPEN_DEST,
    STAGE_READ,
    STAGE_WRITE,
    STAGE_COPY_SPLICE_IN,
    STAGE_COPY_SPLICE_OUT,
    STAGE_FSYNC,
    STAGE_CLOSE,
    STAGE_UNLINK,
    STAGE_MKDIR,
    STAGE_RENAME,
    STAGE_SYMLINK,
    STAGE_LINK
};

struct IORequest {
    Napi::Env env;
    Napi::Promise::Deferred deferred;
    OperationType op;
    RequestStage stage;

    std::string path;
    std::string dest_path;
    int fd;
    int dest_fd;
    int pipefd[2];
    int open_flags;
    int copy_flags;
    unsigned int fsync_flags;
    bool flush_after_write;
    mode_t mode;

    char* buffer;
    const char* write_ptr;
    std::string write_str_holder;
    Napi::ObjectReference write_buf_ref;

    size_t size;
    size_t offset;
    size_t write_offset;
    size_t splice_in_pipe;

    int saved_errno;
    const char* failed_syscall;
    struct statx stx;

    IORequest(Napi::Env e, OperationType o, RequestStage initial_stage, std::string p)
        : env(e),
          deferred(Napi::Promise::Deferred::New(e)),
          op(o),
          stage(initial_stage),
          path(std::move(p)),
          fd(-1),
          dest_fd(-1),
          open_flags(0),
          copy_flags(0),
          fsync_flags(0),
          flush_after_write(false),
          mode(0666),
          buffer(nullptr),
          write_ptr(nullptr),
          size(0),
          offset(0),
          write_offset(0),
          splice_in_pipe(0),
          saved_errno(0),
          failed_syscall(nullptr) {
        pipefd[0] = -1;
        pipefd[1] = -1;
        stx.stx_mask = 0;
        stx.stx_mode = 0;
        stx.stx_size = 0;
    }

    ~IORequest() {
        if (buffer) {
            std::free(buffer);
            buffer = nullptr;
        }
        if (pipefd[0] >= 0) {
            close(pipefd[0]);
            pipefd[0] = -1;
        }
        if (pipefd[1] >= 0) {
            close(pipefd[1]);
            pipefd[1] = -1;
        }
        if (!write_buf_ref.IsEmpty()) {
            write_buf_ref.Reset();
        }
    }
};

struct RingStats {
    uint64_t total_requests = 0;
    uint64_t total_sqes_prepared = 0;
    uint64_t total_submit_syscalls = 0;
    uint64_t total_cqes_reaped = 0;
    uint64_t peak_in_flight = 0;
    uint64_t overflow_queued = 0;
    uint64_t credential_resets = 0;
    uint32_t queue_depth = 0;
};

static struct io_uring ring;
static uv_poll_t poll_handle;
static uv_prepare_t prepare_handle;
static uv_check_t check_handle;
static napi_async_context async_context = nullptr;

static bool ring_supported = false;
static bool handles_initialized = false;
static bool poll_refd = false;
static bool flush_hooks_active = false;
static bool in_poll_callback = false;
static std::string unsupported_reason;

static uid_t ring_euid = 0;
static gid_t ring_egid = 0;

static uint64_t active_requests = 0;
static uint32_t in_flight_sqes = 0;
static uint32_t unsubmitted_sqes = 0;

static std::deque<IORequest*> pending_queue;
static RingStats stats;

static void OnPollReadable(uv_poll_t* handle, int status, int events);
static void OnPrepareFlush(uv_prepare_t* handle);
static void OnCheckFlush(uv_check_t* handle);
static void StartFlushHooks();
static void StopFlushHooks();
static void FlushSubmissions();
static void DrainPendingQueue();

static Napi::Object CreateErrnoError(
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

static void PrepSqeForRequest(struct io_uring_sqe* sqe, IORequest* req) {
    switch (req->stage) {
        case STAGE_OPEN:
            io_uring_prep_openat(sqe, AT_FDCWD, req->path.c_str(), req->open_flags | O_CLOEXEC, req->mode);
            break;
        case STAGE_OPEN_DEST: {
            int dflags = O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC;
            if (req->copy_flags & 1) { // COPYFILE_EXCL (UV_FS_COPYFILE_EXCL = 1)
                dflags |= O_EXCL;
            }
            io_uring_prep_openat(sqe, AT_FDCWD, req->dest_path.c_str(), dflags, req->mode);
            break;
        }
        case STAGE_STATX:
            if (req->op == OP_STAT) {
                io_uring_prep_statx(sqe, AT_FDCWD, req->path.c_str(), 0, STATX_BASIC_STATS | STATX_BTIME, &req->stx);
            } else if (req->op == OP_LSTAT) {
                io_uring_prep_statx(sqe, AT_FDCWD, req->path.c_str(), AT_SYMLINK_NOFOLLOW, STATX_BASIC_STATS | STATX_BTIME, &req->stx);
            } else {
                io_uring_prep_statx(sqe, req->fd, "", AT_EMPTY_PATH, STATX_SIZE | STATX_MODE, &req->stx);
            }
            break;
        case STAGE_READ: {
            size_t remaining = req->size - req->offset;
            io_uring_prep_read(sqe, req->fd, req->buffer + req->offset, remaining, req->offset);
            break;
        }
        case STAGE_WRITE: {
            size_t remaining = req->size - req->offset;
            uint64_t write_offset = (req->open_flags & O_APPEND) ? static_cast<uint64_t>(-1) : req->offset;
            int target_fd = (req->op == OP_COPY_FILE) ? req->dest_fd : req->fd;
            io_uring_prep_write(sqe, target_fd, req->write_ptr + req->offset, remaining, write_offset);
            break;
        }
        case STAGE_COPY_SPLICE_IN: {
            size_t remaining = req->size - req->offset;
            unsigned int chunk = remaining > MAX_SPLICE_CHUNK ? MAX_SPLICE_CHUNK : static_cast<unsigned int>(remaining);
            io_uring_prep_splice(sqe, req->fd, req->offset, req->pipefd[1], -1, chunk, SPLICE_F_MOVE);
            break;
        }
        case STAGE_COPY_SPLICE_OUT: {
            io_uring_prep_splice(
                sqe,
                req->pipefd[0],
                -1,
                req->dest_fd,
                req->write_offset,
                static_cast<unsigned int>(req->splice_in_pipe),
                SPLICE_F_MOVE
            );
            break;
        }
        case STAGE_FSYNC:
            io_uring_prep_fsync(sqe, req->fd, req->fsync_flags);
            break;
        case STAGE_CLOSE:
            io_uring_prep_close(sqe, req->fd);
            break;
        case STAGE_UNLINK:
            io_uring_prep_unlinkat(sqe, AT_FDCWD, req->path.c_str(), 0);
            break;
        case STAGE_MKDIR:
            io_uring_prep_mkdirat(sqe, AT_FDCWD, req->path.c_str(), req->mode);
            break;
        case STAGE_RENAME:
            io_uring_prep_renameat(sqe, AT_FDCWD, req->path.c_str(), AT_FDCWD, req->dest_path.c_str(), 0);
            break;
        case STAGE_SYMLINK:
            io_uring_prep_symlinkat(sqe, req->path.c_str(), AT_FDCWD, req->dest_path.c_str());
            break;
        case STAGE_LINK:
            io_uring_prep_linkat(sqe, AT_FDCWD, req->path.c_str(), AT_FDCWD, req->dest_path.c_str(), 0);
            break;
    }
    io_uring_sqe_set_data(sqe, req);
    unsubmitted_sqes++;
    in_flight_sqes++;
    stats.total_sqes_prepared++;
}

static void FlushSubmissions() {
    if (unsubmitted_sqes == 0 || !ring_supported) {
        return;
    }
    int ret = io_uring_submit(&ring);
    if (ret >= 0) {
        stats.total_submit_syscalls++;
        if (static_cast<uint32_t>(ret) <= unsubmitted_sqes) {
            unsubmitted_sqes -= static_cast<uint32_t>(ret);
        } else {
            unsubmitted_sqes = 0;
        }
    }
}

static void StartFlushHooks() {
    if (!in_poll_callback && !flush_hooks_active && handles_initialized) {
        uv_prepare_start(&prepare_handle, OnPrepareFlush);
        uv_check_start(&check_handle, OnCheckFlush);
        flush_hooks_active = true;
    }
}

static void StopFlushHooks() {
    if (flush_hooks_active && handles_initialized) {
        uv_prepare_stop(&prepare_handle);
        uv_check_stop(&check_handle);
        flush_hooks_active = false;
    }
}

static void EnqueueAsyncClose(int fd) {
    if (fd < 0) return;
    struct io_uring_sqe* sqe = io_uring_get_sqe(&ring);
    if (!sqe && unsubmitted_sqes > 0) {
        FlushSubmissions();
        sqe = io_uring_get_sqe(&ring);
    }
    if (sqe) {
        io_uring_prep_close(sqe, fd);
        io_uring_sqe_set_data(sqe, nullptr);
        unsubmitted_sqes++;
        in_flight_sqes++;
        stats.total_sqes_prepared++;
    } else {
        close(fd);
    }
}

static void CloseCopyPipes(IORequest* req) {
    if (req->pipefd[0] >= 0) {
        close(req->pipefd[0]);
        req->pipefd[0] = -1;
    }
    if (req->pipefd[1] >= 0) {
        close(req->pipefd[1]);
        req->pipefd[1] = -1;
    }
}

static void ScheduleStage(IORequest* req) {
    if (pending_queue.empty()) {
        struct io_uring_sqe* sqe = io_uring_get_sqe(&ring);
        if (!sqe && unsubmitted_sqes > 0) {
            FlushSubmissions();
            sqe = io_uring_get_sqe(&ring);
        }
        if (sqe) {
            PrepSqeForRequest(sqe, req);
            StartFlushHooks();
            return;
        }
    }

    pending_queue.push_back(req);
    stats.overflow_queued++;
    StartFlushHooks();
}

static void DrainPendingQueue() {
    while (!pending_queue.empty()) {
        struct io_uring_sqe* sqe = io_uring_get_sqe(&ring);
        if (!sqe) {
            if (unsubmitted_sqes > 0) {
                FlushSubmissions();
                sqe = io_uring_get_sqe(&ring);
            }
            if (!sqe) {
                break;
            }
        }
        IORequest* req = pending_queue.front();
        pending_queue.pop_front();
        PrepSqeForRequest(sqe, req);
    }
}

static void RefEventLoopIfNeeded() {
    if (!poll_refd && handles_initialized) {
        uv_ref(reinterpret_cast<uv_handle_t*>(&poll_handle));
        poll_refd = true;
    }
    if (active_requests > stats.peak_in_flight) {
        stats.peak_in_flight = active_requests;
    }
}

static void UnrefEventLoopIfIdle() {
    if (active_requests == 0 && in_flight_sqes == 0 && poll_refd && handles_initialized) {
        uv_unref(reinterpret_cast<uv_handle_t*>(&poll_handle));
        poll_refd = false;
    }
}

// Initializes io_uring using modern kernel flags (COOP_TASKRUN + SINGLE_ISSUER) when supported,
// gracefully falling back to baseline flags (0) on older Linux kernels.
static int InitRingWithBestFlags(uint32_t depth, struct io_uring* r) {
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

// Mitigates CVE-2024-22017: If the process changed UID/GID (e.g. via setuid/setgid) and no operations
// are currently in flight, tears down and re-initializes the io_uring instance under the new credentials.
static bool EnsureCredentialsSafe(Napi::Env env) {
    if (!ring_supported) return false;

    // Fast path: only issue geteuid/getegid syscalls when starting a fresh batch or when idle,
    // avoiding 2 syscalls per file during high-concurrency bursts within the same tick.
    if (unsubmitted_sqes > 0) {
        return true;
    }

    uid_t cur_uid = geteuid();
    gid_t cur_gid = getegid();
    if (cur_uid == ring_euid && cur_gid == ring_egid) {
        return true;
    }

    if (active_requests > 0 || in_flight_sqes > 0) {
        // Reject if credentials changed while I/O requests are still in flight
        return false;
    }

    uv_poll_stop(&poll_handle);
    io_uring_queue_exit(&ring);

    int ret = InitRingWithBestFlags(stats.queue_depth, &ring);
    if (ret < 0) {
        ring_supported = false;
        unsupported_reason = std::string("Failed to reinitialize io_uring after UID/GID change: ") + std::strerror(-ret);
        return false;
    }

    ring_euid = cur_uid;
    ring_egid = cur_gid;
    stats.credential_resets++;

    uv_loop_t* loop;
    napi_get_uv_event_loop(env, &loop);
    uv_poll_init(loop, &poll_handle, ring.ring_fd);
    uv_poll_start(&poll_handle, UV_READABLE, OnPollReadable);
    if (!poll_refd) {
        uv_unref(reinterpret_cast<uv_handle_t*>(&poll_handle));
    }
    return true;
}

static void OnPrepareFlush(uv_prepare_t* handle) {
    DrainPendingQueue();
    FlushSubmissions();
    if (pending_queue.empty() && unsubmitted_sqes == 0) {
        StopFlushHooks();
    }
}

static void OnCheckFlush(uv_check_t* handle) {
    DrainPendingQueue();
    FlushSubmissions();
    if (pending_queue.empty() && unsubmitted_sqes == 0) {
        StopFlushHooks();
    }
}

static Napi::Object BuildStatObject(Napi::Env env, const struct statx& stx) {
    Napi::Object obj = Napi::Object::New(env);
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

static void ProcessCompletions() {
    if (in_poll_callback || !ring_supported) {
        return;
    }
    in_poll_callback = true;

    std::vector<IORequest*> finished_requests;
    finished_requests.reserve(128);
    int passes = 0;

    // Reap multiple stages that complete immediately in memory (e.g. OPEN -> STATX -> READ/SPLICE -> CLOSE)
    // without returning to epoll_wait between stages when the kernel responds synchronously.
    while (io_uring_cq_ready(&ring) > 0 && passes < 64) {
        passes++;
        struct io_uring_cqe* cqe;
        unsigned head;
        unsigned count = 0;

        io_uring_for_each_cqe(&ring, head, cqe) {
            count++;
            if (in_flight_sqes > 0) {
                in_flight_sqes--;
            }
            stats.total_cqes_reaped++;

            IORequest* req = reinterpret_cast<IORequest*>(io_uring_cqe_get_data(cqe));
            if (!req) {
                continue;
            }

            int res = cqe->res;

            switch (req->stage) {
                case STAGE_OPEN: {
                    if (res < 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = (req->op == OP_COPY_FILE) ? "copyfile" : "open";
                        finished_requests.push_back(req);
                    } else {
                        req->fd = res;
                        if (req->op == OP_READ_FILE || req->op == OP_COPY_FILE) {
                            req->stage = STAGE_STATX;
                            ScheduleStage(req);
                        } else if (req->op == OP_FSYNC) {
                            req->stage = STAGE_FSYNC;
                            ScheduleStage(req);
                        } else if (req->op == OP_WRITE_FILE) {
                            if (req->size == 0) {
                                req->stage = req->flush_after_write ? STAGE_FSYNC : STAGE_CLOSE;
                                ScheduleStage(req);
                            } else {
                                req->stage = STAGE_WRITE;
                                ScheduleStage(req);
                            }
                        }
                    }
                    break;
                }

                case STAGE_STATX: {
                    if (req->op == OP_STAT || req->op == OP_LSTAT) {
                        if (res < 0) {
                            req->saved_errno = -res;
                            req->failed_syscall = (req->op == OP_LSTAT) ? "lstat" : "stat";
                        }
                        finished_requests.push_back(req);
                        break;
                    }

                    if (req->op == OP_COPY_FILE) {
                        if (res < 0) {
                            req->saved_errno = -res;
                            req->failed_syscall = "copyfile";
                            EnqueueAsyncClose(req->fd);
                            req->fd = -1;
                            finished_requests.push_back(req);
                        } else if (S_ISDIR(req->stx.stx_mode)) {
                            req->saved_errno = EISDIR;
                            req->failed_syscall = "copyfile";
                            EnqueueAsyncClose(req->fd);
                            req->fd = -1;
                            finished_requests.push_back(req);
                        } else {
                            req->size = static_cast<size_t>(req->stx.stx_size);
                            req->mode = req->stx.stx_mode & 0777;
                            req->stage = STAGE_OPEN_DEST;
                            ScheduleStage(req);
                        }
                        break;
                    }

                    // OP_READ_FILE statx completion
                    if (res < 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = "fstat";
                        EnqueueAsyncClose(req->fd);
                        req->fd = -1;
                        finished_requests.push_back(req);
                    } else if (S_ISDIR(req->stx.stx_mode)) {
                        req->saved_errno = EISDIR;
                        req->failed_syscall = "read";
                        EnqueueAsyncClose(req->fd);
                        req->fd = -1;
                        finished_requests.push_back(req);
                    } else {
                        req->size = static_cast<size_t>(req->stx.stx_size);
                        if (req->size == 0) {
                            EnqueueAsyncClose(req->fd);
                            req->fd = -1;
                            finished_requests.push_back(req);
                        } else {
                            req->buffer = static_cast<char*>(std::malloc(req->size));
                            if (!req->buffer) {
                                req->saved_errno = ENOMEM;
                                req->failed_syscall = "read";
                                EnqueueAsyncClose(req->fd);
                                req->fd = -1;
                                finished_requests.push_back(req);
                            } else {
                                req->offset = 0;
                                req->stage = STAGE_READ;
                                ScheduleStage(req);
                            }
                        }
                    }
                    break;
                }

                case STAGE_OPEN_DEST: {
                    if (res < 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = "copyfile";
                        EnqueueAsyncClose(req->fd);
                        req->fd = -1;
                        finished_requests.push_back(req);
                    } else {
                        req->dest_fd = res;
                        if (req->size == 0) {
                            EnqueueAsyncClose(req->fd);
                            req->fd = req->dest_fd;
                            req->dest_fd = -1;
                            req->stage = STAGE_CLOSE;
                            ScheduleStage(req);
                        } else if (pipe2(req->pipefd, O_CLOEXEC) == 0) {
                            if (req->size > 65536) {
                                // Best-effort increase of kernel pipe capacity up to 1 MB
                                fcntl(req->pipefd[1], F_SETPIPE_SZ, MAX_SPLICE_CHUNK);
                            }
                            req->offset = 0;
                            req->write_offset = 0;
                            req->splice_in_pipe = 0;
                            req->stage = STAGE_COPY_SPLICE_IN;
                            ScheduleStage(req);
                        } else {
                            // Fallback to buffered copy if pipe creation fails (e.g., EMFILE)
                            req->buffer = static_cast<char*>(std::malloc(req->size));
                            if (!req->buffer) {
                                req->saved_errno = ENOMEM;
                                req->failed_syscall = "copyfile";
                                EnqueueAsyncClose(req->fd);
                                EnqueueAsyncClose(req->dest_fd);
                                req->fd = -1;
                                req->dest_fd = -1;
                                finished_requests.push_back(req);
                            } else {
                                req->offset = 0;
                                req->stage = STAGE_READ;
                                ScheduleStage(req);
                            }
                        }
                    }
                    break;
                }

                case STAGE_COPY_SPLICE_IN: {
                    if (res < 0) {
                        if (-res == EINTR || -res == EAGAIN) {
                            ScheduleStage(req);
                        } else if ((-res == EINVAL || -res == ENOSYS) && req->offset == 0) {
                            // Filesystem does not support splice: seamlessly fall back to buffered read/write
                            CloseCopyPipes(req);
                            req->buffer = static_cast<char*>(std::malloc(req->size));
                            if (!req->buffer) {
                                req->saved_errno = ENOMEM;
                                req->failed_syscall = "copyfile";
                                EnqueueAsyncClose(req->fd);
                                EnqueueAsyncClose(req->dest_fd);
                                req->fd = -1;
                                req->dest_fd = -1;
                                finished_requests.push_back(req);
                            } else {
                                req->stage = STAGE_READ;
                                ScheduleStage(req);
                            }
                        } else {
                            req->saved_errno = -res;
                            req->failed_syscall = "copyfile";
                            CloseCopyPipes(req);
                            EnqueueAsyncClose(req->fd);
                            EnqueueAsyncClose(req->dest_fd);
                            req->fd = -1;
                            req->dest_fd = -1;
                            finished_requests.push_back(req);
                        }
                    } else if (res == 0) {
                        // Early EOF on source file
                        CloseCopyPipes(req);
                        EnqueueAsyncClose(req->fd);
                        req->fd = req->dest_fd;
                        req->dest_fd = -1;
                        req->stage = STAGE_CLOSE;
                        ScheduleStage(req);
                    } else {
                        req->offset += static_cast<size_t>(res);
                        req->splice_in_pipe = static_cast<size_t>(res);
                        req->stage = STAGE_COPY_SPLICE_OUT;
                        ScheduleStage(req);
                    }
                    break;
                }

                case STAGE_COPY_SPLICE_OUT: {
                    if (res < 0) {
                        if (-res == EINTR || -res == EAGAIN) {
                            ScheduleStage(req);
                        } else {
                            req->saved_errno = -res;
                            req->failed_syscall = "copyfile";
                            CloseCopyPipes(req);
                            EnqueueAsyncClose(req->fd);
                            EnqueueAsyncClose(req->dest_fd);
                            req->fd = -1;
                            req->dest_fd = -1;
                            finished_requests.push_back(req);
                        }
                    } else {
                        req->write_offset += static_cast<size_t>(res);
                        req->splice_in_pipe -= static_cast<size_t>(res);
                        if (req->splice_in_pipe > 0) {
                            ScheduleStage(req);
                        } else if (req->write_offset < req->size) {
                            req->stage = STAGE_COPY_SPLICE_IN;
                            ScheduleStage(req);
                        } else {
                            CloseCopyPipes(req);
                            EnqueueAsyncClose(req->fd);
                            req->fd = req->dest_fd;
                            req->dest_fd = -1;
                            req->stage = STAGE_CLOSE;
                            ScheduleStage(req);
                        }
                    }
                    break;
                }

                case STAGE_READ: {
                    if (res < 0) {
                        if (-res == EINTR || -res == EAGAIN) {
                            ScheduleStage(req);
                        } else {
                            req->saved_errno = -res;
                            req->failed_syscall = (req->op == OP_COPY_FILE) ? "copyfile" : "read";
                            EnqueueAsyncClose(req->fd);
                            if (req->dest_fd >= 0) {
                                EnqueueAsyncClose(req->dest_fd);
                                req->dest_fd = -1;
                            }
                            req->fd = -1;
                            finished_requests.push_back(req);
                        }
                    } else if (res == 0) {
                        // EOF reached before expected size
                        req->size = req->offset;
                        EnqueueAsyncClose(req->fd);
                        req->fd = -1;
                        if (req->op == OP_COPY_FILE) {
                            req->write_ptr = req->buffer;
                            req->offset = 0;
                            req->stage = STAGE_WRITE;
                            ScheduleStage(req);
                        } else {
                            finished_requests.push_back(req);
                        }
                    } else {
                        req->offset += static_cast<size_t>(res);
                        if (req->offset < req->size) {
                            // Short read: schedule remaining bytes
                            ScheduleStage(req);
                        } else {
                            EnqueueAsyncClose(req->fd);
                            req->fd = -1;
                            if (req->op == OP_COPY_FILE) {
                                req->write_ptr = req->buffer;
                                req->offset = 0;
                                req->stage = STAGE_WRITE;
                                ScheduleStage(req);
                            } else {
                                finished_requests.push_back(req);
                            }
                        }
                    }
                    break;
                }

                case STAGE_WRITE: {
                    if (res < 0) {
                        if (-res == EINTR || -res == EAGAIN) {
                            ScheduleStage(req);
                        } else {
                            req->saved_errno = -res;
                            req->failed_syscall = (req->op == OP_COPY_FILE) ? "copyfile" : "write";
                            if (req->op == OP_COPY_FILE) {
                                req->fd = req->dest_fd;
                                req->dest_fd = -1;
                            }
                            req->stage = STAGE_CLOSE;
                            ScheduleStage(req);
                        }
                    } else {
                        req->offset += static_cast<size_t>(res);
                        if (req->offset < req->size) {
                            // Short write: schedule remaining bytes
                            ScheduleStage(req);
                        } else {
                            if (req->op == OP_COPY_FILE) {
                                req->fd = req->dest_fd;
                                req->dest_fd = -1;
                            }
                            req->stage = req->flush_after_write ? STAGE_FSYNC : STAGE_CLOSE;
                            ScheduleStage(req);
                        }
                    }
                    break;
                }

                case STAGE_FSYNC: {
                    if (res < 0 && req->saved_errno == 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = (req->fsync_flags & IORING_FSYNC_DATASYNC) ? "fdatasync" : "fsync";
                    }
                    req->stage = STAGE_CLOSE;
                    ScheduleStage(req);
                    break;
                }

                case STAGE_CLOSE: {
                    req->fd = -1;
                    if (res < 0 && req->saved_errno == 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = "close";
                    }
                    finished_requests.push_back(req);
                    break;
                }

                case STAGE_UNLINK: {
                    if (res < 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = "unlink";
                    }
                    finished_requests.push_back(req);
                    break;
                }

                case STAGE_MKDIR: {
                    if (res < 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = "mkdir";
                    }
                    finished_requests.push_back(req);
                    break;
                }

                case STAGE_RENAME: {
                    if (res < 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = "rename";
                    }
                    finished_requests.push_back(req);
                    break;
                }

                case STAGE_SYMLINK: {
                    if (res < 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = "symlink";
                    }
                    finished_requests.push_back(req);
                    break;
                }

                case STAGE_LINK: {
                    if (res < 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = "link";
                    }
                    finished_requests.push_back(req);
                    break;
                }
            }
        }

        if (count > 0) {
            io_uring_cq_advance(&ring, count);
        }

        DrainPendingQueue();
        FlushSubmissions();
    }

    // Resolve or reject all completed Promises inside a Napi::CallbackScope.
    // The CallbackScope ensures V8 immediately drains microtasks (.then / await continuations)
    // upon exiting this block across all Node.js versions (including Node 24 and 26).
    if (!finished_requests.empty()) {
        Napi::Env cb_env = finished_requests[0]->env;
        Napi::HandleScope handle_scope(cb_env);
        Napi::CallbackScope callback_scope(cb_env, async_context);

        for (IORequest* req : finished_requests) {
            if (req->saved_errno != 0) {
                req->deferred.Reject(
                    CreateErrnoError(req->env, req->saved_errno, req->failed_syscall, req->path, req->dest_path)
                );
            } else {
                switch (req->op) {
                    case OP_READ_FILE: {
                        if (req->size == 0 || !req->buffer) {
                            req->deferred.Resolve(Napi::Buffer<char>::New(req->env, 0));
                        } else {
                            char* raw_buf = req->buffer;
                            size_t len = req->size;
                            req->buffer = nullptr; // Transfer ownership to V8 GC (zero-copy)
                            Napi::Buffer<char> out = Napi::Buffer<char>::New(
                                req->env,
                                raw_buf,
                                len,
                                [](Napi::Env, char* data) { std::free(data); }
                            );
                            req->deferred.Resolve(out);
                        }
                        break;
                    }
                    case OP_WRITE_FILE: {
                        req->deferred.Resolve(Napi::Number::New(req->env, static_cast<double>(req->size)));
                        break;
                    }
                    case OP_STAT:
                    case OP_LSTAT: {
                        req->deferred.Resolve(BuildStatObject(req->env, req->stx));
                        break;
                    }
                    case OP_COPY_FILE:
                    case OP_UNLINK:
                    case OP_MKDIR:
                    case OP_RENAME:
                    case OP_SYMLINK:
                    case OP_LINK:
                    case OP_FSYNC: {
                        req->deferred.Resolve(req->env.Undefined());
                        break;
                    }
                }
            }

            delete req;
            if (active_requests > 0) {
                active_requests--;
            }
        }
    }

    // Flush any new operations that were synchronously queued by .then() / await microtasks above
    DrainPendingQueue();
    FlushSubmissions();

    if (pending_queue.empty() && unsubmitted_sqes == 0) {
        StopFlushHooks();
    } else {
        StartFlushHooks();
    }

    UnrefEventLoopIfIdle();
    in_poll_callback = false;
}

static void OnPollReadable(uv_poll_t* handle, int status, int events) {
    if (status < 0) {
        return;
    }
    ProcessCompletions();
}

Napi::Value ReadFileUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "The 'path' argument must be a string").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    IORequest* req = new IORequest(env, OP_READ_FILE, STAGE_OPEN, filePath);
    req->open_flags = O_RDONLY;
    Napi::Promise promise = req->deferred.Promise();

    if (!EnsureCredentialsSafe(env)) {
        req->deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", filePath));
        delete req;
        return promise;
    }

    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);

    return promise;
}

Napi::Value WriteFileUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || (!info[1].IsString() && !info[1].IsBuffer() && !info[1].IsTypedArray())) {
        Napi::TypeError::New(env, "Expected arguments: (path: string, data: string | Buffer | Uint8Array, flags?: number, mode?: number, flush?: boolean)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    int openFlags = O_WRONLY | O_CREAT | O_TRUNC;
    mode_t mode = 0666;
    bool flushAfterWrite = false;

    if (info.Length() >= 3 && info[2].IsNumber()) {
        openFlags = info[2].As<Napi::Number>().Int32Value();
    }
    if (info.Length() >= 4 && info[3].IsNumber()) {
        mode = static_cast<mode_t>(info[3].As<Napi::Number>().Uint32Value());
    }
    if (info.Length() >= 5 && info[4].IsBoolean()) {
        flushAfterWrite = info[4].As<Napi::Boolean>().Value();
    }

    IORequest* req = new IORequest(env, OP_WRITE_FILE, STAGE_OPEN, filePath);
    req->open_flags = openFlags;
    req->mode = mode;
    req->flush_after_write = flushAfterWrite;
    Napi::Promise promise = req->deferred.Promise();

    if (info[1].IsBuffer()) {
        Napi::Buffer<char> buf = info[1].As<Napi::Buffer<char>>();
        req->write_ptr = buf.Data();
        req->size = buf.Length();
        req->write_buf_ref = Napi::Persistent(info[1].As<Napi::Object>());
    } else if (info[1].IsTypedArray()) {
        Napi::TypedArray ta = info[1].As<Napi::TypedArray>();
        Napi::ArrayBuffer ab = ta.ArrayBuffer();
        req->write_ptr = static_cast<const char*>(ab.Data()) + ta.ByteOffset();
        req->size = ta.ByteLength();
        req->write_buf_ref = Napi::Persistent(info[1].As<Napi::Object>());
    } else {
        req->write_str_holder = info[1].As<Napi::String>().Utf8Value();
        req->write_ptr = req->write_str_holder.data();
        req->size = req->write_str_holder.size();
    }

    if (!EnsureCredentialsSafe(env)) {
        req->deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", filePath));
        delete req;
        return promise;
    }

    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);

    return promise;
}

Napi::Value CopyFileUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "Expected arguments: (src: string, dest: string, flags?: number)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string srcPath = info[0].As<Napi::String>().Utf8Value();
    std::string destPath = info[1].As<Napi::String>().Utf8Value();
    int copyFlags = 0;
    if (info.Length() >= 3 && info[2].IsNumber()) {
        copyFlags = info[2].As<Napi::Number>().Int32Value();
    }

    IORequest* req = new IORequest(env, OP_COPY_FILE, STAGE_OPEN, srcPath);
    req->dest_path = destPath;
    req->open_flags = O_RDONLY;
    req->copy_flags = copyFlags;
    Napi::Promise promise = req->deferred.Promise();

    if (!EnsureCredentialsSafe(env)) {
        req->deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", srcPath, destPath));
        delete req;
        return promise;
    }

    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);

    return promise;
}

Napi::Value StatUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "The 'path' argument must be a string").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    IORequest* req = new IORequest(env, OP_STAT, STAGE_STATX, filePath);
    Napi::Promise promise = req->deferred.Promise();

    if (!EnsureCredentialsSafe(env)) {
        req->deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", filePath));
        delete req;
        return promise;
    }

    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);

    return promise;
}

Napi::Value LstatUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "The 'path' argument must be a string").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    IORequest* req = new IORequest(env, OP_LSTAT, STAGE_STATX, filePath);
    Napi::Promise promise = req->deferred.Promise();

    if (!EnsureCredentialsSafe(env)) {
        req->deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", filePath));
        delete req;
        return promise;
    }

    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);

    return promise;
}

Napi::Value UnlinkUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "The 'path' argument must be a string").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    IORequest* req = new IORequest(env, OP_UNLINK, STAGE_UNLINK, filePath);
    Napi::Promise promise = req->deferred.Promise();

    if (!EnsureCredentialsSafe(env)) {
        req->deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", filePath));
        delete req;
        return promise;
    }

    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);

    return promise;
}

Napi::Value MkdirUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "The 'path' argument must be a string").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string dirPath = info[0].As<Napi::String>().Utf8Value();
    mode_t mode = 0777;
    if (info.Length() >= 2 && info[1].IsNumber()) {
        mode = static_cast<mode_t>(info[1].As<Napi::Number>().Uint32Value());
    }

    IORequest* req = new IORequest(env, OP_MKDIR, STAGE_MKDIR, dirPath);
    req->mode = mode;
    Napi::Promise promise = req->deferred.Promise();

    if (!EnsureCredentialsSafe(env)) {
        req->deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", dirPath));
        delete req;
        return promise;
    }

    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);

    return promise;
}

Napi::Value RenameUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "Expected arguments: (oldPath: string, newPath: string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string oldPath = info[0].As<Napi::String>().Utf8Value();
    std::string newPath = info[1].As<Napi::String>().Utf8Value();

    IORequest* req = new IORequest(env, OP_RENAME, STAGE_RENAME, oldPath);
    req->dest_path = newPath;
    Napi::Promise promise = req->deferred.Promise();

    if (!EnsureCredentialsSafe(env)) {
        req->deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", oldPath, newPath));
        delete req;
        return promise;
    }

    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);

    return promise;
}

Napi::Value SymlinkUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "Expected arguments: (target: string, path: string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string targetPath = info[0].As<Napi::String>().Utf8Value();
    std::string linkPath = info[1].As<Napi::String>().Utf8Value();

    IORequest* req = new IORequest(env, OP_SYMLINK, STAGE_SYMLINK, targetPath);
    req->dest_path = linkPath;
    Napi::Promise promise = req->deferred.Promise();

    if (!EnsureCredentialsSafe(env)) {
        req->deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", targetPath, linkPath));
        delete req;
        return promise;
    }

    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);

    return promise;
}

Napi::Value LinkUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "Expected arguments: (existingPath: string, newPath: string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string existingPath = info[0].As<Napi::String>().Utf8Value();
    std::string newPath = info[1].As<Napi::String>().Utf8Value();

    IORequest* req = new IORequest(env, OP_LINK, STAGE_LINK, existingPath);
    req->dest_path = newPath;
    Napi::Promise promise = req->deferred.Promise();

    if (!EnsureCredentialsSafe(env)) {
        req->deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", existingPath, newPath));
        delete req;
        return promise;
    }

    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);

    return promise;
}

Napi::Value FsyncUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "The 'path' argument must be a string").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    bool datasyncOnly = (info.Length() >= 2 && info[1].IsBoolean() && info[1].As<Napi::Boolean>().Value());

    IORequest* req = new IORequest(env, OP_FSYNC, STAGE_OPEN, filePath);
    req->open_flags = O_RDONLY;
    req->fsync_flags = datasyncOnly ? IORING_FSYNC_DATASYNC : 0;
    Napi::Promise promise = req->deferred.Promise();

    if (!EnsureCredentialsSafe(env)) {
        req->deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", filePath));
        delete req;
        return promise;
    }

    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);

    return promise;
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), ring_supported);
}

Napi::Value GetUnsupportedReason(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), unsupported_reason);
}

Napi::Value GetRingStats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("supported", Napi::Boolean::New(env, ring_supported));
    obj.Set("queueDepth", Napi::Number::New(env, stats.queue_depth));
    obj.Set("activeRequests", Napi::Number::New(env, static_cast<double>(active_requests)));
    obj.Set("inFlightSqes", Napi::Number::New(env, in_flight_sqes));
    obj.Set("pendingOverflowQueue", Napi::Number::New(env, static_cast<double>(pending_queue.size())));
    obj.Set("totalRequests", Napi::Number::New(env, static_cast<double>(stats.total_requests)));
    obj.Set("totalSqesPrepared", Napi::Number::New(env, static_cast<double>(stats.total_sqes_prepared)));
    obj.Set("totalSubmitSyscalls", Napi::Number::New(env, static_cast<double>(stats.total_submit_syscalls)));
    obj.Set("totalCqesReaped", Napi::Number::New(env, static_cast<double>(stats.total_cqes_reaped)));
    obj.Set("peakInFlight", Napi::Number::New(env, static_cast<double>(stats.peak_in_flight)));
    obj.Set("overflowQueued", Napi::Number::New(env, static_cast<double>(stats.overflow_queued)));
    obj.Set("credentialResets", Napi::Number::New(env, static_cast<double>(stats.credential_resets)));
    return obj;
}

static void CleanupModule(void* arg) {
    if (handles_initialized) {
        StopFlushHooks();
        uv_close(reinterpret_cast<uv_handle_t*>(&prepare_handle), nullptr);
        uv_close(reinterpret_cast<uv_handle_t*>(&check_handle), nullptr);
        uv_poll_stop(&poll_handle);
        uv_close(reinterpret_cast<uv_handle_t*>(&poll_handle), nullptr);
        handles_initialized = false;
    }
    if (ring_supported) {
        io_uring_queue_exit(&ring);
        ring_supported = false;
    }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    if (!handles_initialized && !ring_supported && unsupported_reason.empty()) {
        uint32_t depth = DEFAULT_QUEUE_DEPTH;
        int ret = InitRingWithBestFlags(depth, &ring);
        if (ret < 0) {
            depth = FALLBACK_QUEUE_DEPTH;
            ret = InitRingWithBestFlags(depth, &ring);
        }

        if (ret < 0) {
            ring_supported = false;
            unsupported_reason = std::string(std::strerror(-ret)) + " (errno " + std::to_string(-ret) + ")";
        } else {
            ring_supported = true;
            stats.queue_depth = depth;
            ring_euid = geteuid();
            ring_egid = getegid();

            uv_loop_t* loop;
            napi_get_uv_event_loop(env, &loop);

            uv_poll_init(loop, &poll_handle, ring.ring_fd);
            uv_poll_start(&poll_handle, UV_READABLE, OnPollReadable);
            uv_unref(reinterpret_cast<uv_handle_t*>(&poll_handle));
            poll_refd = false;

            uv_prepare_init(loop, &prepare_handle);
            uv_unref(reinterpret_cast<uv_handle_t*>(&prepare_handle));

            uv_check_init(loop, &check_handle);
            uv_unref(reinterpret_cast<uv_handle_t*>(&check_handle));
            flush_hooks_active = false;

            napi_async_init(env, exports, Napi::String::New(env, "uring-fs"), &async_context);

            handles_initialized = true;
            napi_add_env_cleanup_hook(env, CleanupModule, nullptr);
        }
    }

    exports.Set("readFile", Napi::Function::New(env, ReadFileUring));
    exports.Set("writeFile", Napi::Function::New(env, WriteFileUring));
    exports.Set("copyFile", Napi::Function::New(env, CopyFileUring));
    exports.Set("stat", Napi::Function::New(env, StatUring));
    exports.Set("lstat", Napi::Function::New(env, LstatUring));
    exports.Set("unlink", Napi::Function::New(env, UnlinkUring));
    exports.Set("mkdir", Napi::Function::New(env, MkdirUring));
    exports.Set("rename", Napi::Function::New(env, RenameUring));
    exports.Set("symlink", Napi::Function::New(env, SymlinkUring));
    exports.Set("link", Napi::Function::New(env, LinkUring));
    exports.Set("fsync", Napi::Function::New(env, FsyncUring));
    exports.Set("isSupported", Napi::Function::New(env, IsSupported));
    exports.Set("getUnsupportedReason", Napi::Function::New(env, GetUnsupportedReason));
    exports.Set("getRingStats", Napi::Function::New(env, GetRingStats));
    return exports;
}

NODE_API_MODULE(uring_fs, Init)
