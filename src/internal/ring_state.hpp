#ifndef URING_FS_INTERNAL_RING_STATE_HPP
#define URING_FS_INTERNAL_RING_STATE_HPP

#include "ring_types.hpp"

struct DirectSlotTable {
    bool supported = false;
    std::vector<int> free_list;
    bool allocated[DIRECT_FD_TABLE_SIZE] = { false };

    DirectSlotTable() = default;
    ~DirectSlotTable() = default;
    DirectSlotTable(const DirectSlotTable&) = delete;
    DirectSlotTable& operator=(const DirectSlotTable&) = delete;
    DirectSlotTable(DirectSlotTable&&) = delete;
    DirectSlotTable& operator=(DirectSlotTable&&) = delete;

    inline void Reset() {
        supported = false;
        free_list.clear();
        for (int i = 0; i < DIRECT_FD_TABLE_SIZE; ++i) {
            allocated[i] = false;
        }
    }

    inline void Init(struct io_uring* r) {
        Reset();
        if (r == nullptr) {
            return;
        }
        int ret = io_uring_register_files_sparse(r, DIRECT_FD_TABLE_SIZE);
        if (ret == 0) {
            supported = true;
            free_list.reserve(DIRECT_FD_TABLE_SIZE);
            for (int i = DIRECT_FD_TABLE_SIZE - 1; i >= 0; --i) {
                free_list.push_back(i);
            }
        }
    }

    inline int Allocate() {
        if (!supported || free_list.empty()) {
            return -1;
        }
        int slot = free_list.back();
        free_list.pop_back();
        allocated[slot] = true;
        return slot;
    }

    inline void Free(int slot) {
        if (slot >= 0 && slot < DIRECT_FD_TABLE_SIZE && allocated[slot]) {
            allocated[slot] = false;
            free_list.push_back(slot);
        }
    }

    inline size_t InUse() const {
        return supported ? (static_cast<size_t>(DIRECT_FD_TABLE_SIZE) - free_list.size()) : 0;
    }

    inline size_t FreeCount() const {
        return supported ? free_list.size() : 0;
    }

    inline bool AnyInUse() const {
        return supported && free_list.size() < static_cast<size_t>(DIRECT_FD_TABLE_SIZE);
    }
};

static_assert(
    !std::is_copy_constructible<DirectSlotTable>::value &&
    !std::is_copy_assignable<DirectSlotTable>::value &&
    !std::is_move_constructible<DirectSlotTable>::value &&
    !std::is_move_assignable<DirectSlotTable>::value,
    "DirectSlotTable must be non-copyable and non-movable"
);

struct OptimisticBufferPool {
    std::vector<char*> buffers;
    size_t pooled_size = 0;

    OptimisticBufferPool() = default;
    ~OptimisticBufferPool() {
        Clear();
    }
    OptimisticBufferPool(const OptimisticBufferPool&) = delete;
    OptimisticBufferPool& operator=(const OptimisticBufferPool&) = delete;
    OptimisticBufferPool(OptimisticBufferPool&&) = delete;
    OptimisticBufferPool& operator=(OptimisticBufferPool&&) = delete;

    inline void Clear() {
        for (char* buf : buffers) {
            std::free(buf);
        }
        buffers.clear();
    }

    inline char* Acquire(size_t size, size_t default_size) {
        if (size > 0 && size == default_size) {
            if (pooled_size != default_size) {
                Clear();
                pooled_size = default_size;
            }
            if (!buffers.empty()) {
                char* buf = buffers.back();
                buffers.pop_back();
                return buf;
            }
        }
        return static_cast<char*>(std::malloc(size));
    }

    inline void Release(char* buf, size_t capacity, size_t default_size) {
        if (!buf) return;
        if (capacity > 0 &&
            capacity == default_size &&
            pooled_size == default_size &&
            buffers.size() < MAX_POOLED_BUFFERS &&
            (buffers.size() + 1) * capacity <= MAX_POOLED_BYTES) {
            buffers.push_back(buf);
        } else {
            std::free(buf);
        }
    }
};

static_assert(
    !std::is_copy_constructible<OptimisticBufferPool>::value &&
    !std::is_copy_assignable<OptimisticBufferPool>::value &&
    !std::is_move_constructible<OptimisticBufferPool>::value &&
    !std::is_move_assignable<OptimisticBufferPool>::value,
    "OptimisticBufferPool must be non-copyable and non-movable"
);

static struct io_uring ring;
static bool ring_supported = false;
static bool restrictions_enabled_config = true;
static bool ring_restrictions_supported = false;
static uint32_t restricted_opcodes_count = 0;
static DirectSlotTable direct_slots;
static size_t default_optimistic_read_size = DEFAULT_OPTIMISTIC_READ_SIZE;
static OptimisticBufferPool optimistic_pool;

static constexpr uint64_t PROBE_SENTINEL_DATA = 0xFFFFFFFFFFFFFFFEULL;
static bool probe_pending = false;
static int probe_last_res = 0;

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
static bool creds_checked_this_tick = false;

static uint64_t active_requests = 0;
static uint32_t in_flight_sqes = 0;
static uint32_t unsubmitted_sqes = 0;
static unsigned unadvanced_cqes = 0;

static std::deque<IORequest*> pending_queue;
static std::deque<IORequest*> pending_pair2_queue;
static IORequest* live_requests_head = nullptr;
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

static inline void InitDirectFdTable() {
    if (!ring_supported) {
        direct_slots.Reset();
        return;
    }
    direct_slots.Init(&ring);
}

static inline int AllocateDirectSlot() {
    return direct_slots.Allocate();
}

static inline void FreeDirectSlot(int slot) {
    direct_slots.Free(slot);
}

static inline void ClearOptimisticBufferPool() {
    optimistic_pool.Clear();
}

static inline char* AcquireOptimisticBuffer(size_t size) {
    return optimistic_pool.Acquire(size, default_optimistic_read_size);
}

static inline void ReleaseOptimisticBuffer(char* buf, size_t capacity) {
    optimistic_pool.Release(buf, capacity, default_optimistic_read_size);
}

static inline int InitRingWithRestrictionsAndBestFlags(unsigned depth, struct io_uring* r) {
    ring_restrictions_supported = false;
    restricted_opcodes_count = 0;
    direct_slots.Reset();

    if (restrictions_enabled_config) {
        int ret = InitRingWithBestFlags(depth, r, IORING_SETUP_R_DISABLED);
        if (ret == 0) {
            int rret = ApplyRingRestrictions(r);
            if (rret == 0) {
                ring_restrictions_supported = true;
                restricted_opcodes_count = ALLOWED_URING_FS_OPCODES_COUNT;
                direct_slots.Init(r);
                return 0;
            }
            io_uring_queue_exit(r);
            direct_slots.Reset();
        }
    }

    int ret = InitRingWithBestFlags(depth, r, 0);
    if (ret == 0) {
        direct_slots.Init(r);
    }
    return ret;
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
    prev_live = nullptr;
    next_live = live_requests_head;
    if (live_requests_head != nullptr) {
        live_requests_head->prev_live = this;
    }
    live_requests_head = this;
}

inline IORequest::~IORequest() {
    if (prev_live != nullptr) {
        prev_live->next_live = next_live;
    } else if (live_requests_head == this) {
        live_requests_head = next_live;
    }
    if (next_live != nullptr) {
        next_live->prev_live = prev_live;
    }
    prev_live = nullptr;
    next_live = nullptr;
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
    creds_checked_this_tick = false;
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

// Safely tears down and re-initializes the io_uring instance if no operations or live direct-FD
// handles are active. Used both for credential resets (CVE-2024-22017) and runtime configure({ restrictions }).
static bool ReinitIdleRing(bool is_credential_reset = false) {
    if (!ring_supported) return false;
    creds_checked_this_tick = false;

    if (unsubmitted_sqes > 0) {
        FlushSubmissions();
    }

    if (active_requests > 0 || in_flight_sqes > 0 || direct_slots.AnyInUse()) {
        return false;
    }

    uv_loop_t* loop = (poll_handle != nullptr) ? poll_handle->loop : uv_default_loop();
    ClosePollHandle();
    io_uring_queue_exit(&ring);

    int ret = InitRingWithRestrictionsAndBestFlags(stats.queue_depth, &ring);
    if (ret < 0) {
        ring_supported = false;
        ring_restrictions_supported = false;
        restricted_opcodes_count = 0;
        direct_slots.Reset();
        if (is_credential_reset) {
            unsupported_reason = std::string("Failed to reinitialize io_uring after UID/GID change: ") + uv_strerror(ret);
        }
        return false;
    }

    ring_euid = geteuid();
    ring_egid = getegid();
    if (is_credential_reset) {
        stats.credential_resets++;
    }

    InitPollHandle(loop);
    return true;
}

// Mitigates CVE-2024-22017: If the process changed UID/GID (e.g. via setuid/setgid) and no operations
// or live direct-FD handles are active, tears down and re-initializes the io_uring instance.
static bool EnsureCredentialsSafe() {
    if (!ring_supported) return false;

    if (__builtin_expect(creds_checked_this_tick, 1)) {
        return true;
    }

    uid_t cur_uid = geteuid();
    gid_t cur_gid = getegid();
    if (cur_uid == ring_euid && cur_gid == ring_egid) {
        creds_checked_this_tick = true;
        return true;
    }

    bool ok = ReinitIdleRing(true);
    if (ok) {
        creds_checked_this_tick = true;
    }
    return ok;
}

#endif // URING_FS_INTERNAL_RING_STATE_HPP
