#ifndef URING_FS_INTERNAL_RING_TYPES_HPP
#define URING_FS_INTERNAL_RING_TYPES_HPP

#include "uring_compat.hpp"

enum OperationType {
    OP_READ_FILE,
    OP_READ_AT,
    OP_READ_BATCH_AT,
    OP_READV,
    OP_WRITEV,
    OP_FALLOCATE,
    OP_FADVISE,
    OP_FH_OPEN,
    OP_FH_READ,
    OP_FH_READ_AT,
    OP_FH_WRITE,
    OP_FH_READV,
    OP_FH_WRITEV,
    OP_FH_FSYNC,
    OP_FH_FALLOCATE,
    OP_FH_FADVISE,
    OP_FH_CLOSE,
    OP_WRITE_FILE,
    OP_COPY_FILE,
    OP_STAT,
    OP_LSTAT,
    OP_UNLINK,
    OP_RMDIR,
    OP_MKDIR,
    OP_RENAME,
    OP_SYMLINK,
    OP_LINK,
    OP_FSYNC,
    OP_ACCESS
};

enum RequestStage {
    STAGE_OPEN,
    STAGE_OPEN_DIRECT,
    STAGE_STATX,
    STAGE_OPEN_DEST,
    STAGE_READ,
    STAGE_READ_DIRECT_PAIR2,
    STAGE_READV,
    STAGE_WRITE,
    STAGE_WRITEV,
    STAGE_FALLOCATE,
    STAGE_FADVISE,
    STAGE_COPY_SPLICE_IN,
    STAGE_COPY_SPLICE_OUT,
    STAGE_FSYNC,
    STAGE_CLOSE,
    STAGE_CLOSE_DIRECT,
    STAGE_UNLINK,
    STAGE_RMDIR,
    STAGE_MKDIR,
    STAGE_RENAME,
    STAGE_SYMLINK,
    STAGE_LINK
};

struct BatchSlice {
    uint64_t file_offset;
    size_t size;
    size_t bytes_read;
    char* buffer;
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
    int access_mode;
    unsigned int fsync_flags;
    bool flush_after_write;
    mode_t mode;

    int direct_slot;
    bool is_linked_chain;
    uint32_t pending_linked_cqes;
    int linked_stage_index;
    bool open_succeeded;
    bool needs_retry;
    bool skip_linked;
    bool close_canceled = false;
    bool continue_short_read = false;

    bool owns_descriptor;
    bool buffer_is_external;

    bool optimistic_read;
    size_t optimistic_read_size;

    char* buffer;
    size_t buffer_capacity;
    const char* write_ptr;
    std::string write_str_holder;
    Napi::ObjectReference write_buf_ref;

    size_t size;
    size_t offset;
    uint64_t file_offset;
    size_t write_offset;
    size_t splice_in_pipe;

    int falloc_mode;
    int fadvise_advice;
    std::vector<struct iovec> iovecs;
    std::vector<Napi::Reference<Napi::Object>> iovec_refs;

    std::vector<BatchSlice> batch_slices;
    size_t current_slice_idx;

    int saved_errno;
    const char* failed_syscall;
    struct statx stx;

    inline IORequest(Napi::Env e, OperationType o, RequestStage initial_stage, std::string p);

    ~IORequest();
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

#endif // URING_FS_INTERNAL_RING_TYPES_HPP
