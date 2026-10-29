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
#ifdef __GLIBC__
#include <malloc.h>
#endif

#define DEFAULT_QUEUE_DEPTH 512
#define FALLBACK_QUEUE_DEPTH 128
#define MAX_SPLICE_CHUNK (1024 * 1024)
#define DEFAULT_OPTIMISTIC_READ_SIZE (64 * 1024)
#define DIRECT_FD_TABLE_SIZE 1024

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
    STAGE_READ_DIRECT_PAIR2,
    STAGE_WRITE,
    STAGE_COPY_SPLICE_IN,
    STAGE_COPY_SPLICE_OUT,
    STAGE_FSYNC,
    STAGE_CLOSE,
    STAGE_CLOSE_DIRECT,
    STAGE_UNLINK,
    STAGE_MKDIR,
    STAGE_RENAME,
    STAGE_SYMLINK,
    STAGE_LINK
};

static struct io_uring ring;
static bool ring_supported = false;
static bool direct_fds_supported = false;
static std::vector<int> direct_fd_free_list;
static size_t default_optimistic_read_size = DEFAULT_OPTIMISTIC_READ_SIZE;

static void InitDirectFdTable() {
    direct_fd_free_list.clear();
    if (!ring_supported) {
        direct_fds_supported = false;
        return;
    }
    int ret = io_uring_register_files_sparse(&ring, DIRECT_FD_TABLE_SIZE);
    if (ret == 0) {
        direct_fds_supported = true;
        direct_fd_free_list.reserve(DIRECT_FD_TABLE_SIZE);
        for (int i = DIRECT_FD_TABLE_SIZE - 1; i >= 0; --i) {
            direct_fd_free_list.push_back(i);
        }
    } else {
        direct_fds_supported = false;
    }
}

static int AllocateDirectSlot() {
    if (!direct_fds_supported || direct_fd_free_list.empty()) {
        return -1;
    }
    int slot = direct_fd_free_list.back();
    direct_fd_free_list.pop_back();
    return slot;
}

static void FreeDirectSlot(int slot) {
    if (slot >= 0 && slot < DIRECT_FD_TABLE_SIZE) {
        direct_fd_free_list.push_back(slot);
    }
}

static constexpr size_t MAX_POOLED_BUFFERS = 256;
static std::vector<char*> optimistic_buffer_pool;
static size_t pooled_buffer_size = 0;

static void ClearOptimisticBufferPool() {
    for (char* buf : optimistic_buffer_pool) {
        std::free(buf);
    }
    optimistic_buffer_pool.clear();
}

static char* AcquireReadBuffer(size_t size) {
    if (size > 0 && size == default_optimistic_read_size) {
        if (pooled_buffer_size != default_optimistic_read_size) {
            ClearOptimisticBufferPool();
            pooled_buffer_size = default_optimistic_read_size;
        }
        if (!optimistic_buffer_pool.empty()) {
            char* buf = optimistic_buffer_pool.back();
            optimistic_buffer_pool.pop_back();
            return buf;
        }
    }
    return static_cast<char*>(std::malloc(size));
}

static void ReleaseReadBuffer(char* buf, size_t capacity) {
    if (!buf) return;
    if (capacity > 0 &&
        capacity == default_optimistic_read_size &&
        pooled_buffer_size == default_optimistic_read_size &&
        optimistic_buffer_pool.size() < MAX_POOLED_BUFFERS) {
        optimistic_buffer_pool.push_back(buf);
    } else {
        std::free(buf);
    }
}

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

    int direct_slot;
    bool is_linked_chain;
    uint32_t pending_linked_cqes;
    int linked_stage_index;
    bool open_succeeded;

    bool optimistic_read;
    size_t optimistic_read_size;

    char* buffer;
    size_t buffer_capacity;
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
          direct_slot(-1),
          is_linked_chain(false),
          pending_linked_cqes(0),
          linked_stage_index(0),
          open_succeeded(false),
          optimistic_read(false),
          optimistic_read_size(0),
          buffer(nullptr),
          buffer_capacity(0),
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
        if (direct_slot >= 0) {
            FreeDirectSlot(direct_slot);
            direct_slot = -1;
        }
        if (buffer) {
            ReleaseReadBuffer(buffer, buffer_capacity);
            buffer = nullptr;
            buffer_capacity = 0;
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

static uv_poll_t poll_handle;
static uv_prepare_t prepare_handle;
static uv_check_t check_handle;
static napi_async_context async_context = nullptr;

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
static std::deque<IORequest*> pending_pair2_queue;
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
            } else if (req->direct_slot >= 0) {
                io_uring_prep_statx(sqe, AT_FDCWD, req->path.c_str(), 0, STATX_SIZE | STATX_MODE, &req->stx);
            } else {
                io_uring_prep_statx(sqe, req->fd, "", AT_EMPTY_PATH, STATX_SIZE | STATX_MODE, &req->stx);
            }
            break;
        case STAGE_READ: {
            size_t remaining = req->size - req->offset;
            if (req->direct_slot >= 0) {
                io_uring_prep_read(sqe, req->direct_slot, req->buffer + req->offset, remaining, req->offset);
                sqe->flags |= IOSQE_FIXED_FILE;
            } else {
                io_uring_prep_read(sqe, req->fd, req->buffer + req->offset, remaining, req->offset);
            }
            break;
        }
        case STAGE_READ_DIRECT_PAIR2:
            break;
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
        case STAGE_CLOSE_DIRECT:
            io_uring_prep_close_direct(sqe, static_cast<unsigned>(req->direct_slot));
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

// Fire-and-forget close for a direct descriptor slot.
// Encodes `(slot << 1) | 1ULL` in CQE user_data so the slot is returned to the free list
// only after the kernel confirms the direct descriptor is closed.
static void EnqueueAsyncCloseDirect(int slot) {
    if (slot < 0) return;
    struct io_uring_sqe* sqe = io_uring_get_sqe(&ring);
    if (!sqe && unsubmitted_sqes > 0) {
        FlushSubmissions();
        sqe = io_uring_get_sqe(&ring);
    }
    if (sqe) {
        io_uring_prep_close_direct(sqe, static_cast<unsigned>(slot));
        uint64_t tagged_slot = (static_cast<uint64_t>(static_cast<uint32_t>(slot)) << 1) | 1ULL;
        io_uring_sqe_set_data64(sqe, tagged_slot);
        unsubmitted_sqes++;
        in_flight_sqes++;
        stats.total_sqes_prepared++;
    } else {
        FreeDirectSlot(slot);
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

static bool TryScheduleLinkedWrite(IORequest* req) {
    if (!direct_fds_supported) return false;

    uint32_t needed = 3;
    if (req->size == 0) {
        needed = req->flush_after_write ? 3 : 2;
    } else {
        needed = req->flush_after_write ? 4 : 3;
    }

    if (in_flight_sqes + needed > stats.queue_depth) {
        return false;
    }
    if (io_uring_sq_space_left(&ring) < needed && unsubmitted_sqes > 0) {
        FlushSubmissions();
    }
    if (io_uring_sq_space_left(&ring) < needed) {
        return false;
    }

    int slot = AllocateDirectSlot();
    if (slot < 0) {
        return false;
    }

    req->direct_slot = slot;
    req->is_linked_chain = true;
    req->pending_linked_cqes = needed;
    req->linked_stage_index = 0;
    req->open_succeeded = false;

    int open_flags = req->open_flags & ~O_CLOEXEC;
    uint64_t write_offset = (req->open_flags & O_APPEND) ? static_cast<uint64_t>(-1) : 0;

    if (req->size == 0) {
        if (!req->flush_after_write) {
            struct io_uring_sqe* sqe0 = io_uring_get_sqe(&ring);
            io_uring_prep_openat_direct(sqe0, AT_FDCWD, req->path.c_str(), open_flags, req->mode, slot);
            sqe0->flags |= IOSQE_IO_LINK;
            io_uring_sqe_set_data(sqe0, req);

            struct io_uring_sqe* sqe1 = io_uring_get_sqe(&ring);
            io_uring_prep_close_direct(sqe1, slot);
            io_uring_sqe_set_data(sqe1, req);
        } else {
            struct io_uring_sqe* sqe0 = io_uring_get_sqe(&ring);
            io_uring_prep_openat_direct(sqe0, AT_FDCWD, req->path.c_str(), open_flags, req->mode, slot);
            sqe0->flags |= IOSQE_IO_LINK;
            io_uring_sqe_set_data(sqe0, req);

            struct io_uring_sqe* sqe1 = io_uring_get_sqe(&ring);
            io_uring_prep_fsync(sqe1, slot, req->fsync_flags);
            sqe1->flags |= IOSQE_FIXED_FILE | IOSQE_IO_LINK;
            io_uring_sqe_set_data(sqe1, req);

            struct io_uring_sqe* sqe2 = io_uring_get_sqe(&ring);
            io_uring_prep_close_direct(sqe2, slot);
            io_uring_sqe_set_data(sqe2, req);
        }
    } else {
        if (!req->flush_after_write) {
            struct io_uring_sqe* sqe0 = io_uring_get_sqe(&ring);
            io_uring_prep_openat_direct(sqe0, AT_FDCWD, req->path.c_str(), open_flags, req->mode, slot);
            sqe0->flags |= IOSQE_IO_LINK;
            io_uring_sqe_set_data(sqe0, req);

            struct io_uring_sqe* sqe1 = io_uring_get_sqe(&ring);
            io_uring_prep_write(sqe1, slot, req->write_ptr, req->size, write_offset);
            sqe1->flags |= IOSQE_FIXED_FILE | IOSQE_IO_LINK;
            io_uring_sqe_set_data(sqe1, req);

            struct io_uring_sqe* sqe2 = io_uring_get_sqe(&ring);
            io_uring_prep_close_direct(sqe2, slot);
            io_uring_sqe_set_data(sqe2, req);
        } else {
            struct io_uring_sqe* sqe0 = io_uring_get_sqe(&ring);
            io_uring_prep_openat_direct(sqe0, AT_FDCWD, req->path.c_str(), open_flags, req->mode, slot);
            sqe0->flags |= IOSQE_IO_LINK;
            io_uring_sqe_set_data(sqe0, req);

            struct io_uring_sqe* sqe1 = io_uring_get_sqe(&ring);
            io_uring_prep_write(sqe1, slot, req->write_ptr, req->size, write_offset);
            sqe1->flags |= IOSQE_FIXED_FILE | IOSQE_IO_LINK;
            io_uring_sqe_set_data(sqe1, req);

            struct io_uring_sqe* sqe2 = io_uring_get_sqe(&ring);
            io_uring_prep_fsync(sqe2, slot, req->fsync_flags);
            sqe2->flags |= IOSQE_FIXED_FILE | IOSQE_IO_LINK;
            io_uring_sqe_set_data(sqe2, req);

            struct io_uring_sqe* sqe3 = io_uring_get_sqe(&ring);
            io_uring_prep_close_direct(sqe3, slot);
            io_uring_sqe_set_data(sqe3, req);
        }
    }

    unsubmitted_sqes += needed;
    in_flight_sqes += needed;
    stats.total_sqes_prepared += needed;
    StartFlushHooks();
    return true;
}

static bool TryScheduleLinkedFsync(IORequest* req) {
    if (!direct_fds_supported) return false;

    uint32_t needed = 3;
    if (in_flight_sqes + needed > stats.queue_depth) {
        return false;
    }
    if (io_uring_sq_space_left(&ring) < needed && unsubmitted_sqes > 0) {
        FlushSubmissions();
    }
    if (io_uring_sq_space_left(&ring) < needed) {
        return false;
    }

    int slot = AllocateDirectSlot();
    if (slot < 0) {
        return false;
    }

    req->direct_slot = slot;
    req->is_linked_chain = true;
    req->pending_linked_cqes = needed;
    req->linked_stage_index = 0;
    req->open_succeeded = false;

    int open_flags = req->open_flags & ~O_CLOEXEC;

    struct io_uring_sqe* sqe0 = io_uring_get_sqe(&ring);
    io_uring_prep_openat_direct(sqe0, AT_FDCWD, req->path.c_str(), open_flags, req->mode, slot);
    sqe0->flags |= IOSQE_IO_LINK;
    io_uring_sqe_set_data(sqe0, req);

    struct io_uring_sqe* sqe1 = io_uring_get_sqe(&ring);
    io_uring_prep_fsync(sqe1, slot, req->fsync_flags);
    sqe1->flags |= IOSQE_FIXED_FILE | IOSQE_IO_LINK;
    io_uring_sqe_set_data(sqe1, req);

    struct io_uring_sqe* sqe2 = io_uring_get_sqe(&ring);
    io_uring_prep_close_direct(sqe2, slot);
    io_uring_sqe_set_data(sqe2, req);

    unsubmitted_sqes += needed;
    in_flight_sqes += needed;
    stats.total_sqes_prepared += needed;
    StartFlushHooks();
    return true;
}

// Unified Optimization #1 + #2:
// - When optimistic_read_size > 0: links OPENAT_DIRECT(slot) -> READ(slot, optimistic_read_size) in a single submission!
//   If the file fits in optimistic_read_size, the entire read completes in 1 kernel roundtrip and STATX is skipped.
// - When optimistic_read_size == 0: links OPENAT_DIRECT(slot) -> STATX(path) in Pair 1, followed by READ(slot) -> CLOSE_DIRECT(slot) in Pair 2.
static bool TryScheduleLinkedReadPair1(IORequest* req) {
    if (!direct_fds_supported) return false;

    uint32_t needed = 2;
    if (in_flight_sqes + needed > stats.queue_depth) {
        return false;
    }
    if (io_uring_sq_space_left(&ring) < needed && unsubmitted_sqes > 0) {
        FlushSubmissions();
    }
    if (io_uring_sq_space_left(&ring) < needed) {
        return false;
    }

    int slot = AllocateDirectSlot();
    if (slot < 0) {
        return false;
    }

    if (req->optimistic_read_size > 0) {
        req->buffer = AcquireReadBuffer(req->optimistic_read_size);
        if (!req->buffer) {
            FreeDirectSlot(slot);
            return false;
        }
        req->buffer_capacity = req->optimistic_read_size;
        req->size = req->optimistic_read_size;
        req->offset = 0;
        req->optimistic_read = true;
    }

    req->direct_slot = slot;
    req->is_linked_chain = true;
    req->pending_linked_cqes = needed;
    req->linked_stage_index = 0;
    req->open_succeeded = false;

    int open_flags = req->open_flags & ~O_CLOEXEC;

    struct io_uring_sqe* sqe0 = io_uring_get_sqe(&ring);
    io_uring_prep_openat_direct(sqe0, AT_FDCWD, req->path.c_str(), open_flags, req->mode, slot);
    sqe0->flags |= IOSQE_IO_LINK;
    io_uring_sqe_set_data(sqe0, req);

    struct io_uring_sqe* sqe1 = io_uring_get_sqe(&ring);
    if (req->optimistic_read) {
        io_uring_prep_read(sqe1, slot, req->buffer, req->optimistic_read_size, 0);
        sqe1->flags |= IOSQE_FIXED_FILE;
    } else {
        io_uring_prep_statx(sqe1, AT_FDCWD, req->path.c_str(), 0, STATX_SIZE | STATX_MODE, &req->stx);
    }
    io_uring_sqe_set_data(sqe1, req);

    unsubmitted_sqes += needed;
    in_flight_sqes += needed;
    stats.total_sqes_prepared += needed;
    StartFlushHooks();
    return true;
}

static bool TryScheduleLinkedReadPair2(IORequest* req) {
    uint32_t needed = 2;
    if (in_flight_sqes + needed > stats.queue_depth) {
        return false;
    }
    if (io_uring_sq_space_left(&ring) < needed && unsubmitted_sqes > 0) {
        FlushSubmissions();
    }
    if (io_uring_sq_space_left(&ring) < needed) {
        return false;
    }

    req->is_linked_chain = true;
    req->pending_linked_cqes = needed;
    req->linked_stage_index = 0;

    size_t remaining = req->size - req->offset;

    struct io_uring_sqe* sqe0 = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe0, req->direct_slot, req->buffer + req->offset, remaining, req->offset);
    sqe0->flags |= IOSQE_FIXED_FILE | IOSQE_IO_LINK;
    io_uring_sqe_set_data(sqe0, req);

    struct io_uring_sqe* sqe1 = io_uring_get_sqe(&ring);
    io_uring_prep_close_direct(sqe1, req->direct_slot);
    io_uring_sqe_set_data(sqe1, req);

    unsubmitted_sqes += needed;
    in_flight_sqes += needed;
    stats.total_sqes_prepared += needed;
    StartFlushHooks();
    return true;
}

static void ScheduleStage(IORequest* req) {
    if (req->stage == STAGE_READ_DIRECT_PAIR2) {
        if (pending_pair2_queue.empty() && TryScheduleLinkedReadPair2(req)) {
            return;
        }
        pending_pair2_queue.push_back(req);
        stats.overflow_queued++;
        StartFlushHooks();
        return;
    }

    if (req->stage == STAGE_CLOSE_DIRECT || (req->stage == STAGE_STATX && req->direct_slot >= 0)) {
        if (pending_pair2_queue.empty() && in_flight_sqes + 1 <= stats.queue_depth) {
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
        pending_pair2_queue.push_back(req);
        stats.overflow_queued++;
        StartFlushHooks();
        return;
    }

    if (pending_queue.empty()) {
        if (req->stage == STAGE_OPEN) {
            if (req->op == OP_WRITE_FILE) {
                if (TryScheduleLinkedWrite(req)) return;
            } else if (req->op == OP_FSYNC) {
                if (TryScheduleLinkedFsync(req)) return;
            } else if (req->op == OP_READ_FILE) {
                if (TryScheduleLinkedReadPair1(req)) return;
            }
        }

        if (in_flight_sqes + 1 <= stats.queue_depth) {
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
    }

    pending_queue.push_back(req);
    stats.overflow_queued++;
    StartFlushHooks();
}

static void DrainPendingQueue() {
    // 1. Prioritize draining pair2 and close_direct requests to complete reads and free direct slots
    while (!pending_pair2_queue.empty()) {
        IORequest* req = pending_pair2_queue.front();
        if (req->stage == STAGE_READ_DIRECT_PAIR2) {
            if (TryScheduleLinkedReadPair2(req)) {
                pending_pair2_queue.pop_front();
                continue;
            }
            break;
        } else if (req->stage == STAGE_CLOSE_DIRECT || (req->stage == STAGE_STATX && req->direct_slot >= 0)) {
            if (in_flight_sqes + 1 > stats.queue_depth) {
                break;
            }
            struct io_uring_sqe* sqe = io_uring_get_sqe(&ring);
            if (!sqe && unsubmitted_sqes > 0) {
                FlushSubmissions();
                sqe = io_uring_get_sqe(&ring);
            }
            if (!sqe) {
                break;
            }
            pending_pair2_queue.pop_front();
            PrepSqeForRequest(sqe, req);
            continue;
        } else {
            pending_pair2_queue.pop_front();
        }
    }

    // 2. Drain new requests from pending_queue
    while (!pending_queue.empty()) {
        IORequest* req = pending_queue.front();

        if (req->stage == STAGE_OPEN) {
            if (req->op == OP_WRITE_FILE) {
                if (TryScheduleLinkedWrite(req)) {
                    pending_queue.pop_front();
                    continue;
                }
                if (direct_fds_supported) {
                    break;
                }
            } else if (req->op == OP_FSYNC) {
                if (TryScheduleLinkedFsync(req)) {
                    pending_queue.pop_front();
                    continue;
                }
                if (direct_fds_supported) {
                    break;
                }
            } else if (req->op == OP_READ_FILE) {
                if (TryScheduleLinkedReadPair1(req)) {
                    pending_queue.pop_front();
                    continue;
                }
                if (direct_fds_supported) {
                    break;
                }
            }
        }

        if (in_flight_sqes + 1 > stats.queue_depth) {
            break;
        }
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
        return false;
    }

    uv_poll_stop(&poll_handle);
    io_uring_queue_exit(&ring);

    int ret = InitRingWithBestFlags(stats.queue_depth, &ring);
    if (ret < 0) {
        ring_supported = false;
        direct_fds_supported = false;
        direct_fd_free_list.clear();
        unsupported_reason = std::string("Failed to reinitialize io_uring after UID/GID change: ") + std::strerror(-ret);
        return false;
    }

    InitDirectFdTable();

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
    if (pending_queue.empty() && pending_pair2_queue.empty() && unsubmitted_sqes == 0) {
        StopFlushHooks();
    }
}

static void OnCheckFlush(uv_check_t* handle) {
    DrainPendingQueue();
    FlushSubmissions();
    if (pending_queue.empty() && pending_pair2_queue.empty() && unsubmitted_sqes == 0) {
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

    // Reap multiple stages that complete immediately in memory
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

            uint64_t raw_data = io_uring_cqe_get_data64(cqe);
            if (raw_data == 0) {
                continue;
            }
            if (raw_data & 1ULL) {
                int closed_slot = static_cast<int>(raw_data >> 1);
                FreeDirectSlot(closed_slot);
                continue;
            }

            IORequest* req = reinterpret_cast<IORequest*>(static_cast<uintptr_t>(raw_data));
            int res = cqe->res;

            if (req->is_linked_chain) {
                int cqe_idx = req->linked_stage_index++;
                req->pending_linked_cqes--;

                if (req->op == OP_WRITE_FILE) {
                    if (req->size == 0) {
                        if (!req->flush_after_write) {
                            if (cqe_idx == 0) {
                                if (res < 0) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = "open";
                                } else {
                                    req->open_succeeded = true;
                                }
                            } else if (cqe_idx == 1) {
                                if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = "close";
                                }
                            }
                        } else {
                            if (cqe_idx == 0) {
                                if (res < 0) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = "open";
                                } else {
                                    req->open_succeeded = true;
                                }
                            } else if (cqe_idx == 1) {
                                if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = (req->fsync_flags & IORING_FSYNC_DATASYNC) ? "fdatasync" : "fsync";
                                }
                            } else if (cqe_idx == 2) {
                                if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = "close";
                                }
                            }
                        }
                    } else {
                        if (!req->flush_after_write) {
                            if (cqe_idx == 0) {
                                if (res < 0) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = "open";
                                } else {
                                    req->open_succeeded = true;
                                }
                            } else if (cqe_idx == 1) {
                                if (res < 0) {
                                    if (req->saved_errno == 0 && -res != ECANCELED) {
                                        req->saved_errno = -res;
                                        req->failed_syscall = "write";
                                    }
                                } else {
                                    req->offset += static_cast<size_t>(res);
                                }
                            } else if (cqe_idx == 2) {
                                if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = "close";
                                }
                            }
                        } else {
                            if (cqe_idx == 0) {
                                if (res < 0) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = "open";
                                } else {
                                    req->open_succeeded = true;
                                }
                            } else if (cqe_idx == 1) {
                                if (res < 0) {
                                    if (req->saved_errno == 0 && -res != ECANCELED) {
                                        req->saved_errno = -res;
                                        req->failed_syscall = "write";
                                    }
                                } else {
                                    req->offset += static_cast<size_t>(res);
                                }
                            } else if (cqe_idx == 2) {
                                if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = (req->fsync_flags & IORING_FSYNC_DATASYNC) ? "fdatasync" : "fsync";
                                }
                            } else if (cqe_idx == 3) {
                                if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = "close";
                                }
                            }
                        }
                    }

                    if (req->pending_linked_cqes == 0) {
                        req->is_linked_chain = false;
                        if (req->open_succeeded && -res == ECANCELED) {
                            req->stage = STAGE_CLOSE_DIRECT;
                            ScheduleStage(req);
                        } else {
                            FreeDirectSlot(req->direct_slot);
                            req->direct_slot = -1;
                            finished_requests.push_back(req);
                        }
                    }
                    continue;
                }

                if (req->op == OP_FSYNC) {
                    if (cqe_idx == 0) {
                        if (res < 0) {
                            req->saved_errno = -res;
                            req->failed_syscall = "open";
                        } else {
                            req->open_succeeded = true;
                        }
                    } else if (cqe_idx == 1) {
                        if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
                            req->saved_errno = -res;
                            req->failed_syscall = (req->fsync_flags & IORING_FSYNC_DATASYNC) ? "fdatasync" : "fsync";
                        }
                    } else if (cqe_idx == 2) {
                        if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
                            req->saved_errno = -res;
                            req->failed_syscall = "close";
                        }
                    }

                    if (req->pending_linked_cqes == 0) {
                        req->is_linked_chain = false;
                        if (req->open_succeeded && -res == ECANCELED) {
                            req->stage = STAGE_CLOSE_DIRECT;
                            ScheduleStage(req);
                        } else {
                            FreeDirectSlot(req->direct_slot);
                            req->direct_slot = -1;
                            finished_requests.push_back(req);
                        }
                    }
                    continue;
                }

                if (req->op == OP_READ_FILE) {
                    if (req->optimistic_read) {
                        // Unified Pair 1 (Optimistic): 0: openat_direct, 1: read(optimistic_read_size)
                        if (cqe_idx == 0) {
                            if (res < 0) {
                                req->saved_errno = -res;
                                req->failed_syscall = "open";
                            } else {
                                req->open_succeeded = true;
                            }
                        } else if (cqe_idx == 1) {
                            if (res < 0) {
                                if (req->saved_errno == 0 && -res != ECANCELED) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = "read";
                                }
                            } else {
                                req->offset = static_cast<size_t>(res);
                            }
                        }

                        if (req->pending_linked_cqes == 0) {
                            req->is_linked_chain = false;
                            req->optimistic_read = false;

                            if (!req->open_succeeded) {
                                FreeDirectSlot(req->direct_slot);
                                req->direct_slot = -1;
                                finished_requests.push_back(req);
                            } else if (req->saved_errno != 0) {
                                EnqueueAsyncCloseDirect(req->direct_slot);
                                req->direct_slot = -1;
                                finished_requests.push_back(req);
                            } else if (req->offset < req->optimistic_read_size) {
                                // Entire file read in 1 single linked submission!
                                req->size = req->offset;
                                EnqueueAsyncCloseDirect(req->direct_slot);
                                req->direct_slot = -1;
                                finished_requests.push_back(req);
                            } else {
                                // File is >= optimistic_read_size: query total size via STATX
                                req->stage = STAGE_STATX;
                                ScheduleStage(req);
                            }
                        }
                    } else if (req->stage == STAGE_OPEN) {
                        // Classic Pair 1 (optimistic_read_size == 0): 0: openat_direct, 1: statx
                        if (cqe_idx == 0) {
                            if (res < 0) {
                                req->saved_errno = -res;
                                req->failed_syscall = "open";
                            } else {
                                req->open_succeeded = true;
                            }
                        } else if (cqe_idx == 1) {
                            if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
                                req->saved_errno = -res;
                                req->failed_syscall = "stat";
                            }
                        }

                        if (req->pending_linked_cqes == 0) {
                            req->is_linked_chain = false;
                            if (!req->open_succeeded || req->saved_errno != 0) {
                                if (req->open_succeeded) {
                                    EnqueueAsyncCloseDirect(req->direct_slot);
                                    req->direct_slot = -1;
                                } else {
                                    FreeDirectSlot(req->direct_slot);
                                    req->direct_slot = -1;
                                }
                                finished_requests.push_back(req);
                            } else if (S_ISDIR(req->stx.stx_mode)) {
                                req->saved_errno = EISDIR;
                                req->failed_syscall = "read";
                                EnqueueAsyncCloseDirect(req->direct_slot);
                                req->direct_slot = -1;
                                finished_requests.push_back(req);
                            } else if (req->stx.stx_size == 0) {
                                req->size = 0;
                                EnqueueAsyncCloseDirect(req->direct_slot);
                                req->direct_slot = -1;
                                finished_requests.push_back(req);
                            } else {
                                req->size = static_cast<size_t>(req->stx.stx_size);
                                req->buffer = static_cast<char*>(std::malloc(req->size));
                                if (!req->buffer) {
                                    req->saved_errno = ENOMEM;
                                    req->failed_syscall = "read";
                                    EnqueueAsyncCloseDirect(req->direct_slot);
                                    req->direct_slot = -1;
                                    finished_requests.push_back(req);
                                } else {
                                    req->offset = 0;
                                    req->stage = STAGE_READ_DIRECT_PAIR2;
                                    ScheduleStage(req);
                                }
                            }
                        }
                    } else {
                        // Pair 2: 0: read(remainder), 1: close_direct
                        if (cqe_idx == 0) {
                            if (res < 0) {
                                if (req->saved_errno == 0 && -res != ECANCELED) {
                                    req->saved_errno = -res;
                                    req->failed_syscall = "read";
                                }
                            } else {
                                req->offset += static_cast<size_t>(res);
                                req->size = req->offset;
                            }
                        } else if (cqe_idx == 1) {
                            if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
                                req->saved_errno = -res;
                                req->failed_syscall = "close";
                            }
                        }

                        if (req->pending_linked_cqes == 0) {
                            req->is_linked_chain = false;
                            if (res < 0 && -res == ECANCELED) {
                                req->stage = STAGE_CLOSE_DIRECT;
                                ScheduleStage(req);
                            } else {
                                FreeDirectSlot(req->direct_slot);
                                req->direct_slot = -1;
                                finished_requests.push_back(req);
                            }
                        }
                    }
                    continue;
                }
            }

            switch (req->stage) {
                case STAGE_OPEN: {
                    if (res < 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = (req->op == OP_COPY_FILE) ? "copyfile" : "open";
                        finished_requests.push_back(req);
                    } else {
                        req->fd = res;
                        if (req->op == OP_READ_FILE) {
                            if (req->optimistic_read_size > 0) {
                                req->buffer = AcquireReadBuffer(req->optimistic_read_size);
                                if (!req->buffer) {
                                    req->saved_errno = ENOMEM;
                                    req->failed_syscall = "read";
                                    EnqueueAsyncClose(req->fd);
                                    req->fd = -1;
                                    finished_requests.push_back(req);
                                } else {
                                    req->buffer_capacity = req->optimistic_read_size;
                                    req->size = req->optimistic_read_size;
                                    req->offset = 0;
                                    req->optimistic_read = true;
                                    req->stage = STAGE_READ;
                                    ScheduleStage(req);
                                }
                            } else {
                                req->stage = STAGE_STATX;
                                ScheduleStage(req);
                            }
                        } else if (req->op == OP_COPY_FILE) {
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

                    // OP_READ_FILE statx completion (either after optimistic read overflow or classic fallback)
                    if (res < 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = "fstat";
                        if (req->direct_slot >= 0) {
                            EnqueueAsyncCloseDirect(req->direct_slot);
                            req->direct_slot = -1;
                        } else {
                            EnqueueAsyncClose(req->fd);
                            req->fd = -1;
                        }
                        finished_requests.push_back(req);
                    } else if (S_ISDIR(req->stx.stx_mode)) {
                        req->saved_errno = EISDIR;
                        req->failed_syscall = "read";
                        if (req->direct_slot >= 0) {
                            EnqueueAsyncCloseDirect(req->direct_slot);
                            req->direct_slot = -1;
                        } else {
                            EnqueueAsyncClose(req->fd);
                            req->fd = -1;
                        }
                        finished_requests.push_back(req);
                    } else if (req->buffer != nullptr && req->offset > 0) {
                        size_t total_size = static_cast<size_t>(req->stx.stx_size);
                        if (total_size <= req->offset) {
                            req->size = req->offset;
                            if (req->direct_slot >= 0) {
                                EnqueueAsyncCloseDirect(req->direct_slot);
                                req->direct_slot = -1;
                            } else {
                                EnqueueAsyncClose(req->fd);
                                req->fd = -1;
                            }
                            finished_requests.push_back(req);
                        } else {
                            char* new_buf = static_cast<char*>(std::realloc(req->buffer, total_size));
                            if (!new_buf) {
                                req->saved_errno = ENOMEM;
                                req->failed_syscall = "read";
                                if (req->direct_slot >= 0) {
                                    EnqueueAsyncCloseDirect(req->direct_slot);
                                    req->direct_slot = -1;
                                } else {
                                    EnqueueAsyncClose(req->fd);
                                    req->fd = -1;
                                }
                                finished_requests.push_back(req);
                            } else {
                                req->buffer = new_buf;
                                req->buffer_capacity = total_size;
                                req->size = total_size;
                                if (req->direct_slot >= 0) {
                                    req->stage = STAGE_READ_DIRECT_PAIR2;
                                } else {
                                    req->stage = STAGE_READ;
                                }
                                ScheduleStage(req);
                            }
                        }
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
                                fcntl(req->pipefd[1], F_SETPIPE_SZ, MAX_SPLICE_CHUNK);
                            }
                            req->offset = 0;
                            req->write_offset = 0;
                            req->splice_in_pipe = 0;
                            req->stage = STAGE_COPY_SPLICE_IN;
                            ScheduleStage(req);
                        } else {
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

                case STAGE_READ_DIRECT_PAIR2:
                    break;

                case STAGE_READ: {
                    if (res < 0) {
                        if (-res == EINTR || -res == EAGAIN) {
                            ScheduleStage(req);
                        } else {
                            req->saved_errno = -res;
                            req->failed_syscall = (req->op == OP_COPY_FILE) ? "copyfile" : "read";
                            if (req->direct_slot >= 0) {
                                EnqueueAsyncCloseDirect(req->direct_slot);
                                req->direct_slot = -1;
                            } else {
                                EnqueueAsyncClose(req->fd);
                                req->fd = -1;
                            }
                            if (req->dest_fd >= 0) {
                                EnqueueAsyncClose(req->dest_fd);
                                req->dest_fd = -1;
                            }
                            finished_requests.push_back(req);
                        }
                    } else if (req->optimistic_read) {
                        req->offset += static_cast<size_t>(res);
                        if (static_cast<size_t>(res) < req->optimistic_read_size) {
                            req->size = req->offset;
                            req->optimistic_read = false;
                            EnqueueAsyncClose(req->fd);
                            req->fd = -1;
                            finished_requests.push_back(req);
                        } else {
                            req->optimistic_read = false;
                            req->stage = STAGE_STATX;
                            ScheduleStage(req);
                        }
                    } else if (res == 0) {
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

                case STAGE_CLOSE_DIRECT: {
                    if (res < 0 && req->saved_errno == 0) {
                        req->saved_errno = -res;
                        req->failed_syscall = "close";
                    }
                    FreeDirectSlot(req->direct_slot);
                    req->direct_slot = -1;
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
                        } else if (req->size <= 16384 && req->buffer_capacity > 0 && req->buffer_capacity == default_optimistic_read_size) {
                            Napi::Buffer<char> out = Napi::Buffer<char>::Copy(req->env, req->buffer, req->size);
                            req->deferred.Resolve(out);
                        } else {
                            char* raw_buf = req->buffer;
                            size_t len = req->size;
                            if (req->buffer_capacity > len) {
                                char* shrunk = static_cast<char*>(std::realloc(raw_buf, len));
                                if (shrunk) {
                                    raw_buf = shrunk;
                                }
                            }
                            req->buffer = nullptr; // Transfer ownership to V8 GC (zero-copy)
                            req->buffer_capacity = 0;
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

    DrainPendingQueue();
    FlushSubmissions();

    if (pending_queue.empty() && pending_pair2_queue.empty() && unsubmitted_sqes == 0) {
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
    size_t optimisticSize = default_optimistic_read_size;
    if (info.Length() >= 2 && info[1].IsNumber()) {
        int64_t val = info[1].As<Napi::Number>().Int64Value();
        optimisticSize = val <= 0 ? 0 : static_cast<size_t>(val);
    }

    IORequest* req = new IORequest(env, OP_READ_FILE, STAGE_OPEN, filePath);
    req->open_flags = O_RDONLY;
    req->optimistic_read_size = optimisticSize;
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

Napi::Value SetOptimisticReadSize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected a non-negative number of bytes").ThrowAsJavaScriptException();
        return env.Null();
    }
    int64_t val = info[0].As<Napi::Number>().Int64Value();
    default_optimistic_read_size = val <= 0 ? 0 : static_cast<size_t>(val);
    return Napi::Number::New(env, static_cast<double>(default_optimistic_read_size));
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
    obj.Set("pendingOverflowQueue", Napi::Number::New(env, static_cast<double>(pending_queue.size() + pending_pair2_queue.size())));
    obj.Set("totalRequests", Napi::Number::New(env, static_cast<double>(stats.total_requests)));
    obj.Set("totalSqesPrepared", Napi::Number::New(env, static_cast<double>(stats.total_sqes_prepared)));
    obj.Set("totalSubmitSyscalls", Napi::Number::New(env, static_cast<double>(stats.total_submit_syscalls)));
    obj.Set("totalCqesReaped", Napi::Number::New(env, static_cast<double>(stats.total_cqes_reaped)));
    obj.Set("peakInFlight", Napi::Number::New(env, static_cast<double>(stats.peak_in_flight)));
    obj.Set("overflowQueued", Napi::Number::New(env, static_cast<double>(stats.overflow_queued)));
    obj.Set("credentialResets", Napi::Number::New(env, static_cast<double>(stats.credential_resets)));
    obj.Set("optimisticReadSize", Napi::Number::New(env, static_cast<double>(default_optimistic_read_size)));
    obj.Set("directFdsSupported", Napi::Boolean::New(env, direct_fds_supported));
    obj.Set("directFdTableSize", Napi::Number::New(env, DIRECT_FD_TABLE_SIZE));
    obj.Set("directFdsInUse", Napi::Number::New(env, direct_fds_supported ? (DIRECT_FD_TABLE_SIZE - direct_fd_free_list.size()) : 0));
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
    ClearOptimisticBufferPool();
    direct_fd_free_list.clear();
    direct_fds_supported = false;
    if (ring_supported) {
        io_uring_queue_exit(&ring);
        ring_supported = false;
    }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    if (!handles_initialized && !ring_supported && unsupported_reason.empty()) {
#ifdef __GLIBC__
        mallopt(M_MMAP_THRESHOLD, 4 * 1024 * 1024);
#endif
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

            InitDirectFdTable();

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
    exports.Set("setOptimisticReadSize", Napi::Function::New(env, SetOptimisticReadSize));
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
