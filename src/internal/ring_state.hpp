#ifndef URING_FS_INTERNAL_RING_STATE_HPP
#define URING_FS_INTERNAL_RING_STATE_HPP

#include "ring_types.hpp"

static struct io_uring ring;
static bool ring_supported = false;
static bool direct_fds_supported = false;
static std::vector<int> direct_fd_free_list;
static bool direct_slot_allocated[DIRECT_FD_TABLE_SIZE] = { false };
static size_t default_optimistic_read_size = DEFAULT_OPTIMISTIC_READ_SIZE;

static std::vector<char*> optimistic_buffer_pool;
static size_t pooled_buffer_size = 0;

static uv_poll_t* poll_handle = nullptr;
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
static unsigned unadvanced_cqes = 0;

static std::deque<IORequest*> pending_queue;
static std::deque<IORequest*> pending_pair2_queue;
static std::unordered_set<IORequest*> live_requests;
static RingStats stats;

struct FaultInjectionConfig {
    bool active = false;
    int next_cqe1_errno = 0;
    int next_write_short_bytes = 0;
    bool next_write_zero = false;
    int next_pair2_short_bytes = 0;
    int next_read_at_short_bytes = 0;

    inline void UpdateActive() {
        active = (next_cqe1_errno != 0) ||
                 (next_write_short_bytes > 0) ||
                 next_write_zero ||
                 (next_pair2_short_bytes > 0) ||
                 (next_read_at_short_bytes > 0);
    }
};

static FaultInjectionConfig fault_injection;

static void OnPollReadable(uv_poll_t* handle, int status, int events);
static void OnPrepareFlush(uv_prepare_t* handle);
static void OnCheckFlush(uv_check_t* handle);
static void ScheduleStage(IORequest* req);
static void DrainPendingQueue();

static void InitDirectFdTable() {
    direct_fd_free_list.clear();
    for (int i = 0; i < DIRECT_FD_TABLE_SIZE; ++i) {
        direct_slot_allocated[i] = false;
    }
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
    direct_slot_allocated[slot] = true;
    return slot;
}

static void FreeDirectSlot(int slot) {
    if (slot >= 0 && slot < DIRECT_FD_TABLE_SIZE) {
        if (direct_slot_allocated[slot]) {
            direct_slot_allocated[slot] = false;
            direct_fd_free_list.push_back(slot);
        }
    }
}

static void ClearOptimisticBufferPool() {
    for (char* buf : optimistic_buffer_pool) {
        std::free(buf);
    }
    optimistic_buffer_pool.clear();
}

static char* AcquireOptimisticBuffer(size_t size) {
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

static void ReleaseOptimisticBuffer(char* buf, size_t capacity) {
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

static inline bool AllocateReadBuffer(IORequest* req) {
    if (req->buffer != nullptr) {
        return true;
    }
    if (req->size <= default_optimistic_read_size && default_optimistic_read_size > 0) {
        req->buffer = AcquireOptimisticBuffer(default_optimistic_read_size);
        req->buffer_capacity = req->buffer ? default_optimistic_read_size : 0;
    } else {
        size_t alloc_size = req->size > 0 ? req->size : 1;
        req->buffer = static_cast<char*>(std::malloc(alloc_size));
        req->buffer_capacity = req->buffer ? alloc_size : 0;
    }
    return req->buffer != nullptr;
}

inline IORequest::IORequest(Napi::Env e, OperationType o, RequestStage initial_stage, std::string p)
    : env(e),
      deferred(Napi::Promise::Deferred::New(e)),
      op(o),
      stage(initial_stage),
      path(std::move(p)),
      fd(-1),
      dest_fd(-1),
      open_flags(0),
      copy_flags(0),
      access_mode(0),
      fsync_flags(0),
      flush_after_write(false),
      mode(0666),
      direct_slot(-1),
      is_linked_chain(false),
      pending_linked_cqes(0),
      linked_stage_index(0),
      open_succeeded(false),
      needs_retry(false),
      skip_linked(false),
      owns_descriptor(true),
      buffer_is_external(false),
      optimistic_read(false),
      optimistic_read_size(0),
      buffer(nullptr),
      buffer_capacity(0),
      write_ptr(nullptr),
      size(0),
      offset(0),
      file_offset(0),
      write_offset(0),
      splice_in_pipe(0),
      falloc_mode(0),
      fadvise_advice(0),
      current_slice_idx(0),
      saved_errno(0),
      failed_syscall(nullptr) {
    pipefd[0] = -1;
    pipefd[1] = -1;
    stx.stx_mask = 0;
    stx.stx_mode = 0;
    stx.stx_size = 0;
    live_requests.insert(this);
}

inline IORequest::~IORequest() {
    live_requests.erase(this);
    if (owns_descriptor) {
        if (direct_slot >= 0) {
            FreeDirectSlot(direct_slot);
            direct_slot = -1;
        }
        if (fd >= 0) {
            close(fd);
            fd = -1;
        }
    }
    if (dest_fd >= 0) {
        close(dest_fd);
        dest_fd = -1;
    }
    if (buffer && !buffer_is_external) {
        ReleaseOptimisticBuffer(buffer, buffer_capacity);
        buffer = nullptr;
        buffer_capacity = 0;
    }
    for (auto& s : batch_slices) {
        if (s.buffer) {
            std::free(s.buffer);
            s.buffer = nullptr;
        }
    }
    batch_slices.clear();
    for (auto& ref : iovec_refs) {
        if (!ref.IsEmpty()) {
            ref.Reset();
        }
    }
    iovec_refs.clear();
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

static void FlushSubmissions() {
    if (unadvanced_cqes > 0 && ring_supported) {
        io_uring_cq_advance(&ring, unadvanced_cqes);
        unadvanced_cqes = 0;
    }
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

static void ArmPrepareHookIfNeeded() {
    if (!in_poll_callback && !flush_hooks_active && handles_initialized) {
        uv_prepare_start(&prepare_handle, OnPrepareFlush);
        uv_check_start(&check_handle, OnCheckFlush);
        flush_hooks_active = true;
    }
}

static void DisarmPrepareHookIfNeeded() {
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
        int empty_fd = -1;
        io_uring_register_files_update(&ring, static_cast<unsigned>(slot), &empty_fd, 1);
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

static void ClosePollHandle() {
    if (poll_handle != nullptr) {
        uv_poll_t* old_poll = poll_handle;
        poll_handle = nullptr;
        uv_poll_stop(old_poll);
        uv_close(reinterpret_cast<uv_handle_t*>(old_poll), [](uv_handle_t* h) {
            delete reinterpret_cast<uv_poll_t*>(h);
        });
    }
}

static void InitPollHandle(uv_loop_t* loop) {
    poll_handle = new uv_poll_t();
    uv_poll_init(loop, poll_handle, ring.ring_fd);
    uv_poll_start(poll_handle, UV_READABLE, OnPollReadable);
    if (!poll_refd) {
        uv_unref(reinterpret_cast<uv_handle_t*>(poll_handle));
    }
}

static void RefEventLoopIfNeeded() {
    if (!poll_refd && handles_initialized && poll_handle != nullptr) {
        uv_ref(reinterpret_cast<uv_handle_t*>(poll_handle));
        poll_refd = true;
    }
    if (active_requests > stats.peak_in_flight) {
        stats.peak_in_flight = active_requests;
    }
}

static void UnrefEventLoopIfIdle() {
    if (active_requests == 0 && in_flight_sqes == 0 && poll_refd && handles_initialized && poll_handle != nullptr) {
        uv_unref(reinterpret_cast<uv_handle_t*>(poll_handle));
        poll_refd = false;
    }
}

// Mitigates CVE-2024-22017: If the process changed UID/GID (e.g. via setuid/setgid) and no operations
// or live direct-FD handles are active, tears down and re-initializes the io_uring instance.
static bool EnsureCredentialsSafe() {
    if (!ring_supported) return false;

    uid_t cur_uid = geteuid();
    gid_t cur_gid = getegid();
    if (cur_uid == ring_euid && cur_gid == ring_egid) {
        return true;
    }

    if (unsubmitted_sqes > 0) {
        FlushSubmissions();
    }

    if (active_requests > 0 || in_flight_sqes > 0 ||
        (direct_fds_supported && direct_fd_free_list.size() < static_cast<size_t>(DIRECT_FD_TABLE_SIZE))) {
        return false;
    }

    uv_loop_t* loop = (poll_handle != nullptr) ? poll_handle->loop : uv_default_loop();
    ClosePollHandle();
    io_uring_queue_exit(&ring);

    int ret = InitRingWithBestFlags(stats.queue_depth, &ring);
    if (ret < 0) {
        ring_supported = false;
        direct_fds_supported = false;
        direct_fd_free_list.clear();
        for (int i = 0; i < DIRECT_FD_TABLE_SIZE; ++i) direct_slot_allocated[i] = false;
        unsupported_reason = std::string("Failed to reinitialize io_uring after UID/GID change: ") + uv_strerror(ret);
        return false;
    }

    InitDirectFdTable();

    ring_euid = cur_uid;
    ring_egid = cur_gid;
    stats.credential_resets++;

    InitPollHandle(loop);
    return true;
}

#endif // URING_FS_INTERNAL_RING_STATE_HPP
