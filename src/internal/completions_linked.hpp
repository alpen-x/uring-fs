#ifndef URING_FS_INTERNAL_COMPLETIONS_LINKED_HPP
#define URING_FS_INTERNAL_COMPLETIONS_LINKED_HPP

#include "scheduler.hpp"

static inline void FinishLinkedWithSlot(IORequest* req, std::vector<IORequest*>& finished_requests) {
    FreeDirectSlot(req->direct_slot);
    req->direct_slot = -1;
    finished_requests.push_back(req);
}

static inline void RetryLinkedViaUnlinkedOpen(IORequest* req) {
    if (req->direct_slot >= 0) {
        if (req->close_canceled) {
            EnqueueAsyncCloseDirect(req->direct_slot);
        } else {
            FreeDirectSlot(req->direct_slot);
        }
        req->direct_slot = -1;
    }
    req->skip_linked = true;
    req->stage = STAGE_OPEN;
    ScheduleStage(req);
}

static inline void FinalizeLinkedChain(
    IORequest* req,
    std::vector<IORequest*>& finished_requests
) {
    if (!req->open_succeeded) {
        FinishLinkedWithSlot(req, finished_requests);
    } else if (req->close_canceled) {
        req->stage = STAGE_CLOSE_DIRECT;
        ScheduleStage(req);
    } else {
        FinishLinkedWithSlot(req, finished_requests);
    }
}

static inline void RecordLinkedOpenResult(IORequest* req, int res) {
    if (res < 0) {
        req->saved_errno = -res;
        req->failed_syscall = "open";
    } else {
        req->open_succeeded = true;
    }
}

static inline void RecordLinkedCloseResult(IORequest* req, int res) {
    if (res < 0) {
        if (-res == ECANCELED) {
            req->close_canceled = true;
        } else if (req->saved_errno == 0) {
            req->saved_errno = -res;
            req->failed_syscall = "close";
        }
    }
}

static inline void ClassifyLinkedMiddleError(IORequest* req, int res, const char* syscall) {
    if (req->saved_errno != 0) return;
    if (-res == ECANCELED || -res == EINTR || -res == EAGAIN) {
        req->needs_retry = true;
    } else {
        req->saved_errno = -res;
        req->failed_syscall = syscall;
    }
}

static inline void HandleLinkedWriteFile(
    IORequest* req,
    int cqe_idx,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    int close_idx = (req->size == 0)
        ? (req->flush_after_write ? 2 : 1)
        : (req->flush_after_write ? 3 : 2);

    if (cqe_idx == 0) {
        RecordLinkedOpenResult(req, res);
    } else if (req->size > 0 && cqe_idx == 1) {
        if (res < 0) {
            ClassifyLinkedMiddleError(req, res, "write");
        } else if (res == 0) {
            if (req->saved_errno == 0) {
                req->saved_errno = EIO;
                req->failed_syscall = "write";
            }
        } else {
            req->offset += static_cast<size_t>(res);
        }
    } else if (req->flush_after_write && cqe_idx == close_idx - 1) {
        if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
            req->saved_errno = -res;
            req->failed_syscall = (req->fsync_flags & IORING_FSYNC_DATASYNC) ? "fdatasync" : "fsync";
        }
    } else if (cqe_idx == close_idx) {
        RecordLinkedCloseResult(req, res);
    }

    if (req->pending_linked_cqes > 0) return;

    req->is_linked_chain = false;
    if (req->open_succeeded && req->saved_errno == 0 && (req->needs_retry || req->offset < req->size)) {
        req->needs_retry = false;
        if (req->close_canceled) {
            req->stage = STAGE_WRITE;
            ScheduleStage(req);
        } else {
            req->open_flags = O_WRONLY | (req->open_flags & (O_APPEND | O_SYNC | O_DSYNC));
            int next_slot = direct_slots.supported ? AllocateDirectSlot() : -1;
            if (next_slot >= 0) {
                FreeDirectSlot(req->direct_slot);
                req->direct_slot = next_slot;
                req->skip_linked = true;
                req->stage = STAGE_OPEN_DIRECT;
                ScheduleStage(req);
            } else {
                RetryLinkedViaUnlinkedOpen(req);
            }
        }
        return;
    }
    FinalizeLinkedChain(req, finished_requests);
}

static inline void HandleLinkedReadAt(
    IORequest* req,
    int cqe_idx,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (cqe_idx == 0) {
        RecordLinkedOpenResult(req, res);
    } else if (cqe_idx == 1) {
        if (res < 0) {
            ClassifyLinkedMiddleError(req, res, "read");
        } else if (req->size > 0) {
            req->offset += static_cast<size_t>(res);
        }
    } else if (cqe_idx == 2) {
        RecordLinkedCloseResult(req, res);
    }

    if (req->pending_linked_cqes > 0) return;

    req->is_linked_chain = false;
    bool short_read_cont = (req->offset > 0 && req->offset < req->size &&
                            (req->offset == MAX_IO_CHUNK || req->continue_short_read));
    if (req->open_succeeded && req->saved_errno == 0 && (req->needs_retry || short_read_cont)) {
        req->needs_retry = false;
        req->continue_short_read = false;
        if (req->close_canceled) {
            req->stage = STAGE_READ;
            ScheduleStage(req);
        } else {
            RetryLinkedViaUnlinkedOpen(req);
        }
        return;
    }
    if (req->open_succeeded && req->saved_errno == 0) {
        req->size = req->offset;
    }
    FinalizeLinkedChain(req, finished_requests);
}

static inline void HandleLinkedReadFile(
    IORequest* req,
    int cqe_idx,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (req->optimistic_read) {
        if (cqe_idx == 0) {
            RecordLinkedOpenResult(req, res);
        } else if (cqe_idx == 1) {
            if (res < 0) {
                ClassifyLinkedMiddleError(req, res, "read");
            } else {
                req->offset = static_cast<size_t>(res);
            }
        }

        if (req->pending_linked_cqes > 0) return;

        req->is_linked_chain = false;
        req->optimistic_read = false;

        if (!req->open_succeeded) {
            FinishLinkedWithSlot(req, finished_requests);
        } else if (req->saved_errno != 0) {
            EnqueueAsyncCloseDirect(req->direct_slot);
            req->direct_slot = -1;
            finished_requests.push_back(req);
        } else if (req->needs_retry) {
            req->needs_retry = false;
            req->close_canceled = true; // No CLOSE_DIRECT SQE in optimistic Pair 1; async-close the open slot
            if (req->buffer) {
                ReleaseOptimisticBuffer(req->buffer, req->buffer_capacity);
                req->buffer = nullptr;
                req->buffer_capacity = 0;
            }
            req->size = 0;
            req->offset = 0;
            RetryLinkedViaUnlinkedOpen(req);
        } else if (req->offset < req->optimistic_read_size) {
            req->size = req->offset;
            EnqueueAsyncCloseDirect(req->direct_slot);
            req->direct_slot = -1;
            finished_requests.push_back(req);
        } else {
            req->stage = STAGE_STATX;
            ScheduleStage(req);
        }
        return;
    }

    if (req->stage == STAGE_OPEN) {
        if (cqe_idx == 0) {
            RecordLinkedOpenResult(req, res);
        } else if (cqe_idx == 1) {
            if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
                req->saved_errno = -res;
                req->failed_syscall = "stat";
            }
        }

        if (req->pending_linked_cqes > 0) return;

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
                req->buffer_capacity = req->size;
                req->offset = 0;
                req->stage = STAGE_READ_DIRECT_PAIR2;
                ScheduleStage(req);
            }
        }
        return;
    }

    // Pair 2: 0: read(remainder), 1: close_direct
    if (cqe_idx == 0) {
        if (res < 0) {
            ClassifyLinkedMiddleError(req, res, "read");
        } else if (res == 0) {
            req->size = req->offset;
        } else {
            req->offset += static_cast<size_t>(res);
        }
    } else if (cqe_idx == 1) {
        RecordLinkedCloseResult(req, res);
    }

    if (req->pending_linked_cqes > 0) return;

    req->is_linked_chain = false;
    if (req->saved_errno == 0 && (req->needs_retry || req->offset < req->size)) {
        req->needs_retry = false;
        if (req->close_canceled) {
            req->stage = STAGE_READ_DIRECT_PAIR2;
            ScheduleStage(req);
        } else {
            RetryLinkedViaUnlinkedOpen(req);
        }
        return;
    }
    if (req->saved_errno == 0) {
        req->size = req->offset;
    }
    FinalizeLinkedChain(req, finished_requests);
}

static inline void HandleLinkedBatchAt(
    IORequest* req,
    int cqe_idx,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (cqe_idx == 0) {
        RecordLinkedOpenResult(req, res);
    } else if (cqe_idx <= static_cast<int>(req->batch_slices.size())) {
        size_t slice_idx = static_cast<size_t>(cqe_idx - 1);
        if (res < 0) {
            ClassifyLinkedMiddleError(req, res, "read");
        } else {
            req->batch_slices[slice_idx].bytes_read = (req->batch_slices[slice_idx].size == 0) ? 0 : static_cast<size_t>(res);
        }
    } else {
        RecordLinkedCloseResult(req, res);
    }

    if (req->pending_linked_cqes > 0) return;

    req->is_linked_chain = false;
    if (req->open_succeeded && req->saved_errno == 0 && req->needs_retry) {
        req->needs_retry = false;
        for (auto& s : req->batch_slices) {
            if (s.buffer) {
                std::free(s.buffer);
                s.buffer = nullptr;
            }
            s.bytes_read = 0;
        }
        RetryLinkedViaUnlinkedOpen(req);
        return;
    }
    FinalizeLinkedChain(req, finished_requests);
}

static inline void HandleLinkedSimpleOp(
    IORequest* req,
    int cqe_idx,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    int close_idx = (req->op == OP_WRITEV && req->flush_after_write) ? 3 : 2;

    if (cqe_idx == 0) {
        RecordLinkedOpenResult(req, res);
    } else if (cqe_idx == 1) {
        if (res < 0) {
            const char* syscall = "io_uring";
            switch (req->op) {
                case OP_FSYNC:
                    syscall = (req->fsync_flags & IORING_FSYNC_DATASYNC) ? "fdatasync" : "fsync";
                    break;
                case OP_READV:
                    syscall = "readv";
                    break;
                case OP_WRITEV:
                    syscall = "writev";
                    break;
                case OP_FALLOCATE:
                    syscall = "fallocate";
                    break;
                case OP_FADVISE:
                    syscall = "fadvise";
                    break;
                default:
                    break;
            }
            ClassifyLinkedMiddleError(req, res, syscall);
        } else if (req->op == OP_READV || req->op == OP_WRITEV) {
            req->size = static_cast<size_t>(res);
        }
    } else if (req->op == OP_WRITEV && req->flush_after_write && cqe_idx == 2) {
        if (res < 0 && req->saved_errno == 0 && -res != ECANCELED) {
            req->saved_errno = -res;
            req->failed_syscall = (req->fsync_flags & IORING_FSYNC_DATASYNC) ? "fdatasync" : "fsync";
        }
    } else if (cqe_idx == close_idx) {
        RecordLinkedCloseResult(req, res);
    }

    if (req->pending_linked_cqes > 0) return;

    req->is_linked_chain = false;
    if (req->open_succeeded && req->saved_errno == 0 && req->needs_retry) {
        req->needs_retry = false;
        RetryLinkedViaUnlinkedOpen(req);
        return;
    }
    FinalizeLinkedChain(req, finished_requests);
}

static inline void HandleLinkedCqe(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    int cqe_idx = req->linked_stage_index++;
    req->pending_linked_cqes--;

    switch (req->op) {
        case OP_WRITE_FILE:
            HandleLinkedWriteFile(req, cqe_idx, res, finished_requests);
            break;
        case OP_READ_AT:
            HandleLinkedReadAt(req, cqe_idx, res, finished_requests);
            break;
        case OP_READ_FILE:
            HandleLinkedReadFile(req, cqe_idx, res, finished_requests);
            break;
        case OP_READ_BATCH_AT:
            HandleLinkedBatchAt(req, cqe_idx, res, finished_requests);
            break;
        default:
            HandleLinkedSimpleOp(req, cqe_idx, res, finished_requests);
            break;
    }
}

#endif // URING_FS_INTERNAL_COMPLETIONS_LINKED_HPP
