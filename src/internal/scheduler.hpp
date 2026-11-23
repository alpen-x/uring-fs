#ifndef URING_FS_INTERNAL_SCHEDULER_HPP
#define URING_FS_INTERNAL_SCHEDULER_HPP

#include "ring_state.hpp"

static void PrepSqeBody(struct io_uring_sqe* sqe, IORequest* req, RequestStage stage) {
    switch (stage) {
        case STAGE_OPEN:
            io_uring_prep_openat(sqe, AT_FDCWD, req->path.c_str(), req->open_flags | O_CLOEXEC, req->mode);
            break;
        case STAGE_OPEN_DIRECT: {
            int open_flags = req->open_flags & ~O_CLOEXEC;
            io_uring_prep_openat_direct(sqe, AT_FDCWD, req->path.c_str(), open_flags, req->mode, static_cast<unsigned>(req->direct_slot));
            break;
        }
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
            } else if (req->op == OP_ACCESS) {
                unsigned int mask = (req->access_mode & (R_OK | W_OK | X_OK))
                    ? (STATX_MODE | STATX_UID | STATX_GID)
                    : STATX_TYPE;
                io_uring_prep_statx(sqe, AT_FDCWD, req->path.c_str(), 0, mask, &req->stx);
            } else if (req->direct_slot >= 0) {
                io_uring_prep_statx(sqe, AT_FDCWD, req->path.c_str(), 0, STATX_SIZE | STATX_MODE, &req->stx);
            } else {
                io_uring_prep_statx(sqe, req->fd, "", AT_EMPTY_PATH, STATX_SIZE | STATX_MODE, &req->stx);
            }
            break;
        case STAGE_READ: {
            size_t remaining = req->size - req->offset;
            unsigned int chunk = remaining > MAX_IO_CHUNK ? static_cast<unsigned int>(MAX_IO_CHUNK) : static_cast<unsigned int>(remaining);
            if (chunk == 0 && (req->op == OP_READ_AT || req->op == OP_FH_READ_AT || req->op == OP_READ_BATCH_AT)) {
                chunk = 1;
            }
            uint64_t read_offset = (req->file_offset == static_cast<uint64_t>(-1))
                ? static_cast<uint64_t>(-1)
                : (req->file_offset + req->offset);
            if (req->direct_slot >= 0) {
                io_uring_prep_read(sqe, req->direct_slot, req->buffer + req->offset, chunk, read_offset);
                sqe->flags |= IOSQE_FIXED_FILE;
            } else {
                io_uring_prep_read(sqe, req->fd, req->buffer + req->offset, chunk, read_offset);
            }
            break;
        }
        case STAGE_READ_DIRECT_PAIR2:
            break;
        case STAGE_READV: {
            int target = (req->direct_slot >= 0) ? req->direct_slot : req->fd;
            io_uring_prep_readv(sqe, target, req->iovecs.data(), static_cast<unsigned>(req->iovecs.size()), req->file_offset);
            if (req->direct_slot >= 0) {
                sqe->flags |= IOSQE_FIXED_FILE;
            }
            break;
        }
        case STAGE_WRITE: {
            size_t remaining = req->size - req->offset;
            unsigned int chunk = remaining > MAX_IO_CHUNK ? static_cast<unsigned int>(MAX_IO_CHUNK) : static_cast<unsigned int>(remaining);
            uint64_t write_offset = (req->open_flags & O_APPEND || req->file_offset == static_cast<uint64_t>(-1))
                ? static_cast<uint64_t>(-1)
                : (req->file_offset + req->offset);
            if (req->direct_slot >= 0 && req->op != OP_COPY_FILE) {
                io_uring_prep_write(sqe, req->direct_slot, req->write_ptr + req->offset, chunk, write_offset);
                sqe->flags |= IOSQE_FIXED_FILE;
            } else {
                int target_fd = (req->op == OP_COPY_FILE) ? req->dest_fd : req->fd;
                io_uring_prep_write(sqe, target_fd, req->write_ptr + req->offset, chunk, write_offset);
            }
            break;
        }
        case STAGE_WRITEV: {
            int target = (req->direct_slot >= 0) ? req->direct_slot : req->fd;
            uint64_t write_offset = (req->open_flags & O_APPEND || req->file_offset == static_cast<uint64_t>(-1))
                ? static_cast<uint64_t>(-1)
                : req->file_offset;
            io_uring_prep_writev(sqe, target, req->iovecs.data(), static_cast<unsigned>(req->iovecs.size()), write_offset);
            if (req->direct_slot >= 0) {
                sqe->flags |= IOSQE_FIXED_FILE;
            }
            break;
        }
        case STAGE_FALLOCATE: {
            int target = (req->direct_slot >= 0) ? req->direct_slot : req->fd;
            io_uring_prep_fallocate(sqe, target, req->falloc_mode, req->file_offset, req->size);
            if (req->direct_slot >= 0) {
                sqe->flags |= IOSQE_FIXED_FILE;
            }
            break;
        }
        case STAGE_FADVISE: {
            int target = (req->direct_slot >= 0) ? req->direct_slot : req->fd;
            off_t fadv_len = req->size > 0xffffffffULL ? static_cast<off_t>(0xffffffffULL) : static_cast<off_t>(req->size);
            io_uring_prep_fadvise(sqe, target, req->file_offset, fadv_len, req->fadvise_advice);
            if (req->direct_slot >= 0) {
                sqe->flags |= IOSQE_FIXED_FILE;
            }
            break;
        }
        case STAGE_COPY_SPLICE_IN: {
            size_t remaining = req->size - req->offset;
            unsigned int chunk = remaining > MAX_SPLICE_CHUNK ? MAX_SPLICE_CHUNK : static_cast<unsigned int>(remaining);
            io_uring_prep_splice(sqe, req->fd, static_cast<int64_t>(req->offset), req->pipefd[1], -1, chunk, SPLICE_F_MOVE);
            break;
        }
        case STAGE_COPY_SPLICE_OUT: {
            io_uring_prep_splice(
                sqe,
                req->pipefd[0],
                -1,
                req->dest_fd,
                static_cast<int64_t>(req->write_offset),
                static_cast<unsigned int>(req->splice_in_pipe),
                SPLICE_F_MOVE
            );
            break;
        }
        case STAGE_FSYNC:
            if (req->direct_slot >= 0) {
                io_uring_prep_fsync(sqe, req->direct_slot, req->fsync_flags);
                sqe->flags |= IOSQE_FIXED_FILE;
            } else {
                io_uring_prep_fsync(sqe, req->fd, req->fsync_flags);
            }
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
        case STAGE_RMDIR:
            io_uring_prep_unlinkat(sqe, AT_FDCWD, req->path.c_str(), AT_REMOVEDIR);
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
}

static void PrepSqeForRequest(struct io_uring_sqe* sqe, IORequest* req) {
    PrepSqeBody(sqe, req, req->stage);
    io_uring_sqe_set_data(sqe, req);
    unsubmitted_sqes++;
    in_flight_sqes++;
    stats.total_sqes_prepared++;
}

static bool HasSqSpaceForChain(uint32_t num_sqes) {
    if (in_flight_sqes + num_sqes > stats.queue_depth) {
        return false;
    }
    if (io_uring_sq_space_left(&ring) < num_sqes && unsubmitted_sqes > 0) {
        FlushSubmissions();
    }
    return io_uring_sq_space_left(&ring) >= num_sqes;
}

static void InitLinkedChainSqes(
    IORequest* req,
    uint32_t num_sqes,
    int slot,
    int open_flags,
    mode_t open_mode,
    struct io_uring_sqe** out_sqes
) {
    for (uint32_t i = 0; i < num_sqes; ++i) {
        out_sqes[i] = io_uring_get_sqe(&ring);
        io_uring_sqe_set_data(out_sqes[i], req);
    }

    req->direct_slot = slot;
    req->is_linked_chain = true;
    req->pending_linked_cqes = num_sqes;
    req->linked_stage_index = 0;
    req->open_succeeded = false;
    req->needs_retry = false;
    req->close_canceled = false;

    io_uring_prep_openat_direct(
        out_sqes[0], AT_FDCWD, req->path.c_str(), open_flags & ~O_CLOEXEC, open_mode, static_cast<unsigned>(slot)
    );
    out_sqes[0]->flags |= IOSQE_IO_LINK;
    io_uring_prep_close_direct(out_sqes[num_sqes - 1], static_cast<unsigned>(slot));
}

static bool ReserveLinkedChain(
    IORequest* req,
    uint32_t num_sqes,
    int open_flags,
    mode_t open_mode,
    struct io_uring_sqe** out_sqes
) {
    if (!direct_slots.supported || !HasSqSpaceForChain(num_sqes)) {
        return false;
    }
    int slot = AllocateDirectSlot();
    if (slot < 0) {
        return false;
    }
    InitLinkedChainSqes(req, num_sqes, slot, open_flags, open_mode, out_sqes);
    return true;
}

static void CommitLinkedSqes(uint32_t num_sqes) {
    unsubmitted_sqes += num_sqes;
    in_flight_sqes += num_sqes;
    stats.total_sqes_prepared += num_sqes;
    ArmPrepareHookIfNeeded();
}

static bool TryScheduleLinkedWrite(IORequest* req) {
    if (req->size > MAX_IO_CHUNK) return false;
    uint32_t needed = (req->size == 0)
        ? (req->flush_after_write ? 3 : 2)
        : (req->flush_after_write ? 4 : 3);
    struct io_uring_sqe* sqes[4];
    if (!ReserveLinkedChain(req, needed, req->open_flags, req->mode, sqes)) {
        return false;
    }
    uint32_t idx = 1;
    if (req->size > 0) {
        uint64_t write_offset = (req->open_flags & O_APPEND) ? static_cast<uint64_t>(-1) : 0;
        io_uring_prep_write(sqes[idx], req->direct_slot, req->write_ptr, static_cast<unsigned>(req->size), write_offset);
        sqes[idx]->flags |= IOSQE_FIXED_FILE | IOSQE_IO_HARDLINK;
        idx++;
    }
    if (req->flush_after_write) {
        io_uring_prep_fsync(sqes[idx], req->direct_slot, req->fsync_flags);
        sqes[idx]->flags |= IOSQE_FIXED_FILE | IOSQE_IO_HARDLINK;
    }
    CommitLinkedSqes(needed);
    return true;
}

static bool TryScheduleLinked3Sqe(
    IORequest* req,
    RequestStage mid_stage,
    int open_flags,
    mode_t open_mode = 0
) {
    struct io_uring_sqe* sqes[3];
    if (!ReserveLinkedChain(req, 3, open_flags, open_mode, sqes)) {
        return false;
    }
    PrepSqeBody(sqes[1], req, mid_stage);
    sqes[1]->flags |= IOSQE_FIXED_FILE | IOSQE_IO_HARDLINK;
    CommitLinkedSqes(3);
    return true;
}

// Unified Optimization #1 + #2:
// - When optimistic_read_size > 0: links OPENAT_DIRECT(slot) -> READ(slot, optimistic_read_size) in a single submission.
// - When optimistic_read_size == 0: links OPENAT_DIRECT(slot) -> STATX(path) in Pair 1, then READ(slot) -> CLOSE_DIRECT(slot) in Pair 2.
static bool TryScheduleLinkedReadPair1(IORequest* req) {
    if (!direct_slots.supported || !HasSqSpaceForChain(2)) {
        return false;
    }
    int slot = AllocateDirectSlot();
    if (slot < 0) {
        return false;
    }
    if (req->optimistic_read_size > 0) {
        req->buffer = AcquireOptimisticBuffer(req->optimistic_read_size);
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
    req->pending_linked_cqes = 2;
    req->linked_stage_index = 0;
    req->open_succeeded = false;
    req->needs_retry = false;
    req->close_canceled = false;

    struct io_uring_sqe* sqe0 = io_uring_get_sqe(&ring);
    io_uring_prep_openat_direct(sqe0, AT_FDCWD, req->path.c_str(), req->open_flags & ~O_CLOEXEC, req->mode, static_cast<unsigned>(slot));
    sqe0->flags |= IOSQE_IO_LINK;
    io_uring_sqe_set_data(sqe0, req);

    struct io_uring_sqe* sqe1 = io_uring_get_sqe(&ring);
    if (req->optimistic_read) {
        size_t opt_len = req->optimistic_read_size > MAX_IO_CHUNK ? static_cast<size_t>(MAX_IO_CHUNK) : req->optimistic_read_size;
        io_uring_prep_read(sqe1, slot, req->buffer, static_cast<unsigned>(opt_len), 0);
        sqe1->flags |= IOSQE_FIXED_FILE;
    } else {
        io_uring_prep_statx(sqe1, AT_FDCWD, req->path.c_str(), 0, STATX_SIZE | STATX_MODE, &req->stx);
    }
    io_uring_sqe_set_data(sqe1, req);

    CommitLinkedSqes(2);
    return true;
}

static bool TryScheduleLinkedReadAt(IORequest* req) {
    if (!direct_slots.supported || req->size > MAX_IO_CHUNK || !HasSqSpaceForChain(3)) {
        return false;
    }
    int slot = AllocateDirectSlot();
    if (slot < 0) {
        return false;
    }
    if (!AllocateReadBuffer(req)) {
        FreeDirectSlot(slot);
        return false;
    }
    struct io_uring_sqe* sqes[3];
    InitLinkedChainSqes(req, 3, slot, req->open_flags, req->mode, sqes);
    req->offset = 0;
    unsigned int chunk = req->size > 0 ? static_cast<unsigned int>(req->size) : 1;
    io_uring_prep_read(sqes[1], req->direct_slot, req->buffer, chunk, req->file_offset);
    sqes[1]->flags |= IOSQE_FIXED_FILE | IOSQE_IO_HARDLINK;
    CommitLinkedSqes(3);
    return true;
}

static bool TryScheduleLinkedReadPair2(IORequest* req) {
    if (!HasSqSpaceForChain(2)) {
        return false;
    }
    req->is_linked_chain = true;
    req->pending_linked_cqes = 2;
    req->linked_stage_index = 0;
    req->needs_retry = false;
    req->close_canceled = false;

    size_t remaining = req->size - req->offset;
    unsigned int chunk = remaining > MAX_IO_CHUNK ? static_cast<unsigned int>(MAX_IO_CHUNK) : static_cast<unsigned int>(remaining);

    struct io_uring_sqe* sqe0 = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe0, req->direct_slot, req->buffer + req->offset, chunk, req->file_offset + req->offset);
    sqe0->flags |= IOSQE_FIXED_FILE | IOSQE_IO_LINK;
    io_uring_sqe_set_data(sqe0, req);

    struct io_uring_sqe* sqe1 = io_uring_get_sqe(&ring);
    io_uring_prep_close_direct(sqe1, static_cast<unsigned>(req->direct_slot));
    io_uring_sqe_set_data(sqe1, req);

    CommitLinkedSqes(2);
    return true;
}

static bool TryScheduleLinkedReadBatchAt(IORequest* req) {
    if (!direct_slots.supported || req->batch_slices.empty() || req->batch_slices.size() > 30) {
        return false;
    }
    for (const auto& s : req->batch_slices) {
        if (s.size > MAX_IO_CHUNK) return false;
    }
    uint32_t needed = 2 + static_cast<uint32_t>(req->batch_slices.size());
    if (!HasSqSpaceForChain(needed)) {
        return false;
    }
    int slot = AllocateDirectSlot();
    if (slot < 0) {
        return false;
    }
    for (size_t i = 0; i < req->batch_slices.size(); ++i) {
        if (req->batch_slices[i].buffer == nullptr) {
            size_t alloc_sz = req->batch_slices[i].size > 0 ? req->batch_slices[i].size : 1;
            req->batch_slices[i].buffer = static_cast<char*>(std::malloc(alloc_sz));
            if (!req->batch_slices[i].buffer) {
                for (size_t j = 0; j < i; ++j) {
                    std::free(req->batch_slices[j].buffer);
                    req->batch_slices[j].buffer = nullptr;
                }
                FreeDirectSlot(slot);
                return false;
            }
        }
    }
    struct io_uring_sqe* sqes[32];
    InitLinkedChainSqes(req, needed, slot, req->open_flags, req->mode, sqes);
    for (size_t i = 0; i < req->batch_slices.size(); ++i) {
        unsigned int chunk = req->batch_slices[i].size > 0 ? static_cast<unsigned int>(req->batch_slices[i].size) : 1;
        io_uring_prep_read(sqes[1 + i], req->direct_slot, req->batch_slices[i].buffer, chunk, req->batch_slices[i].file_offset);
        sqes[1 + i]->flags |= IOSQE_FIXED_FILE | IOSQE_IO_HARDLINK;
    }
    CommitLinkedSqes(needed);
    return true;
}

static bool TryScheduleLinkedWritev(IORequest* req) {
    uint32_t needed = req->flush_after_write ? 4 : 3;
    struct io_uring_sqe* sqes[4];
    if (!ReserveLinkedChain(req, needed, req->open_flags, req->mode, sqes)) {
        return false;
    }
    uint64_t write_offset = (req->open_flags & O_APPEND || req->file_offset == static_cast<uint64_t>(-1))
        ? static_cast<uint64_t>(-1)
        : req->file_offset;
    io_uring_prep_writev(sqes[1], req->direct_slot, req->iovecs.data(), static_cast<unsigned>(req->iovecs.size()), write_offset);
    sqes[1]->flags |= IOSQE_FIXED_FILE | IOSQE_IO_HARDLINK;
    if (req->flush_after_write) {
        io_uring_prep_fsync(sqes[2], req->direct_slot, req->fsync_flags);
        sqes[2]->flags |= IOSQE_FIXED_FILE | IOSQE_IO_HARDLINK;
    }
    CommitLinkedSqes(needed);
    return true;
}

static bool TryScheduleLinkedForOpen(IORequest* req, bool* should_wait_for_direct) {
    *should_wait_for_direct = false;
    if (req->stage != STAGE_OPEN || req->skip_linked) {
        return false;
    }
    switch (req->op) {
        case OP_WRITE_FILE:
            *should_wait_for_direct = direct_slots.supported;
            return TryScheduleLinkedWrite(req);
        case OP_FSYNC:
            *should_wait_for_direct = direct_slots.supported;
            return TryScheduleLinked3Sqe(req, STAGE_FSYNC, req->open_flags, req->mode);
        case OP_READ_FILE:
            *should_wait_for_direct = direct_slots.supported;
            return TryScheduleLinkedReadPair1(req);
        case OP_READ_AT:
            *should_wait_for_direct = direct_slots.supported && req->size <= MAX_IO_CHUNK;
            return TryScheduleLinkedReadAt(req);
        case OP_READ_BATCH_AT:
            *should_wait_for_direct = direct_slots.supported && req->batch_slices.size() <= 30;
            return TryScheduleLinkedReadBatchAt(req);
        case OP_READV:
            *should_wait_for_direct = direct_slots.supported;
            return TryScheduleLinked3Sqe(req, STAGE_READV, req->open_flags, req->mode);
        case OP_WRITEV:
            *should_wait_for_direct = direct_slots.supported;
            return TryScheduleLinkedWritev(req);
        case OP_FALLOCATE:
            *should_wait_for_direct = direct_slots.supported;
            return TryScheduleLinked3Sqe(req, STAGE_FALLOCATE, req->open_flags, req->mode);
        case OP_FADVISE:
            *should_wait_for_direct = direct_slots.supported;
            return TryScheduleLinked3Sqe(req, STAGE_FADVISE, req->open_flags, req->mode);
        default:
            return false;
    }
}

static bool TryScheduleSingleSqe(IORequest* req) {
    if (in_flight_sqes + 1 > stats.queue_depth) {
        return false;
    }
    struct io_uring_sqe* sqe = io_uring_get_sqe(&ring);
    if (!sqe && unsubmitted_sqes > 0) {
        FlushSubmissions();
        sqe = io_uring_get_sqe(&ring);
    }
    if (!sqe) {
        return false;
    }
    PrepSqeForRequest(sqe, req);
    return true;
}

static void ScheduleStage(IORequest* req) {
    if (req->stage == STAGE_READ_DIRECT_PAIR2) {
        if (pending_pair2_queue.empty() && TryScheduleLinkedReadPair2(req)) {
            return;
        }
        pending_pair2_queue.push_back(req);
        stats.overflow_queued++;
        ArmPrepareHookIfNeeded();
        return;
    }

    if (req->stage == STAGE_CLOSE_DIRECT || (req->stage == STAGE_STATX && req->direct_slot >= 0)) {
        if (pending_pair2_queue.empty() && TryScheduleSingleSqe(req)) {
            ArmPrepareHookIfNeeded();
            return;
        }
        pending_pair2_queue.push_back(req);
        stats.overflow_queued++;
        ArmPrepareHookIfNeeded();
        return;
    }

    if (pending_queue.empty()) {
        bool wait_unused = false;
        if (TryScheduleLinkedForOpen(req, &wait_unused)) {
            return;
        }
        if (TryScheduleSingleSqe(req)) {
            ArmPrepareHookIfNeeded();
            return;
        }
    }

    pending_queue.push_back(req);
    stats.overflow_queued++;
    ArmPrepareHookIfNeeded();
}

static void DrainPendingQueue() {
    while (!pending_pair2_queue.empty()) {
        IORequest* req = pending_pair2_queue.front();
        if (req->stage == STAGE_READ_DIRECT_PAIR2) {
            if (TryScheduleLinkedReadPair2(req)) {
                pending_pair2_queue.pop_front();
                continue;
            }
            break;
        }
        if (req->stage == STAGE_CLOSE_DIRECT || (req->stage == STAGE_STATX && req->direct_slot >= 0)) {
            if (TryScheduleSingleSqe(req)) {
                pending_pair2_queue.pop_front();
                continue;
            }
            break;
        }
        pending_pair2_queue.pop_front();
    }

    while (!pending_queue.empty()) {
        IORequest* req = pending_queue.front();
        bool should_wait = false;
        if (TryScheduleLinkedForOpen(req, &should_wait)) {
            pending_queue.pop_front();
            continue;
        }
        if (should_wait) {
            break;
        }
        if (!TryScheduleSingleSqe(req)) {
            break;
        }
        pending_queue.pop_front();
    }
}

static void OnPrepareFlush(uv_prepare_t* handle) {
    (void)handle;
    DrainPendingQueue();
    FlushSubmissions();
    if (pending_queue.empty() && pending_pair2_queue.empty() && unsubmitted_sqes == 0) {
        DisarmPrepareHookIfNeeded();
    }
}

static void OnCheckFlush(uv_check_t* handle) {
    (void)handle;
    DrainPendingQueue();
    FlushSubmissions();
    if (pending_queue.empty() && pending_pair2_queue.empty() && unsubmitted_sqes == 0) {
        DisarmPrepareHookIfNeeded();
    }
}

#endif // URING_FS_INTERNAL_SCHEDULER_HPP
