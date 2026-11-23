#ifndef URING_FS_INTERNAL_COMPLETIONS_STAGES_HPP
#define URING_FS_INTERNAL_COMPLETIONS_STAGES_HPP

#include "completions_linked.hpp"

static inline void CloseRequestDescriptor(IORequest* req) {
    if (req->direct_slot >= 0) {
        EnqueueAsyncCloseDirect(req->direct_slot);
        req->direct_slot = -1;
    } else if (req->fd >= 0) {
        EnqueueAsyncClose(req->fd);
        req->fd = -1;
    }
}

static inline void FailAndCloseCopy(
    IORequest* req,
    int err,
    std::vector<IORequest*>& finished_requests
) {
    req->saved_errno = err;
    req->failed_syscall = "copyfile";
    CloseCopyPipes(req);
    EnqueueAsyncClose(req->fd);
    EnqueueAsyncClose(req->dest_fd);
    req->fd = -1;
    req->dest_fd = -1;
    finished_requests.push_back(req);
}

static inline bool AdvanceBatchSlice(IORequest* req) {
    auto& s = req->batch_slices[req->current_slice_idx];
    size_t alloc_sz = s.size > 0 ? s.size : 1;
    s.buffer = static_cast<char*>(std::malloc(alloc_sz));
    if (!s.buffer) {
        req->saved_errno = ENOMEM;
        req->failed_syscall = "read";
        CloseRequestDescriptor(req);
        req->buffer = nullptr;
        return false;
    }
    req->buffer = s.buffer;
    req->buffer_capacity = alloc_sz;
    req->buffer_is_external = true;
    req->size = s.size;
    req->offset = 0;
    req->file_offset = s.file_offset;
    req->stage = STAGE_READ;
    ScheduleStage(req);
    return true;
}

static inline void HandleUnlinkedOpen(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (res < 0) {
        req->saved_errno = -res;
        req->failed_syscall = (req->op == OP_COPY_FILE) ? "copyfile" : "open";
        finished_requests.push_back(req);
        return;
    }
    req->fd = res;
    switch (req->op) {
        case OP_READ_FILE:
            if (req->buffer != nullptr && req->size > req->offset) {
                req->stage = STAGE_READ;
                ScheduleStage(req);
            } else if (req->optimistic_read_size > 0) {
                req->buffer = AcquireOptimisticBuffer(req->optimistic_read_size);
                if (!req->buffer) {
                    req->saved_errno = ENOMEM;
                    req->failed_syscall = "read";
                    CloseRequestDescriptor(req);
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
            break;
        case OP_COPY_FILE:
            req->stage = STAGE_STATX;
            ScheduleStage(req);
            break;
        case OP_FSYNC:
            req->stage = STAGE_FSYNC;
            ScheduleStage(req);
            break;
        case OP_READ_AT:
            if (req->buffer == nullptr) {
                if (!AllocateReadBuffer(req)) {
                    req->saved_errno = ENOMEM;
                    req->failed_syscall = "read";
                    CloseRequestDescriptor(req);
                    finished_requests.push_back(req);
                    return;
                }
                req->offset = 0;
            }
            req->stage = STAGE_READ;
            ScheduleStage(req);
            break;
        case OP_WRITE_FILE:
            req->stage = (req->size == 0)
                ? (req->flush_after_write ? STAGE_FSYNC : STAGE_CLOSE)
                : STAGE_WRITE;
            ScheduleStage(req);
            break;
        case OP_FH_OPEN:
            req->owns_descriptor = false;
            finished_requests.push_back(req);
            break;
        case OP_READ_BATCH_AT:
            if (req->batch_slices.empty()) {
                CloseRequestDescriptor(req);
                finished_requests.push_back(req);
            } else {
                req->current_slice_idx = 0;
                if (!AdvanceBatchSlice(req)) {
                    finished_requests.push_back(req);
                }
            }
            break;
        case OP_READV:
            req->stage = STAGE_READV;
            ScheduleStage(req);
            break;
        case OP_WRITEV:
            req->stage = STAGE_WRITEV;
            ScheduleStage(req);
            break;
        case OP_FALLOCATE:
            req->stage = STAGE_FALLOCATE;
            ScheduleStage(req);
            break;
        case OP_FADVISE:
            req->stage = STAGE_FADVISE;
            ScheduleStage(req);
            break;
        default:
            break;
    }
}

static inline void HandleUnlinkedStatx(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (req->op == OP_STAT || req->op == OP_LSTAT) {
        if (res < 0) {
            req->saved_errno = -res;
            req->failed_syscall = (req->op == OP_LSTAT) ? "lstat" : "stat";
        }
        finished_requests.push_back(req);
        return;
    }
    if (req->op == OP_ACCESS) {
        if (res < 0) {
            req->saved_errno = -res;
            req->failed_syscall = "access";
        } else if (!CheckAccessPermissions(req->stx, req->access_mode, ring_euid, ring_egid)) {
            req->saved_errno = EACCES;
            req->failed_syscall = "access";
        }
        finished_requests.push_back(req);
        return;
    }
    if (req->op == OP_COPY_FILE) {
        if (res < 0) {
            req->saved_errno = -res;
            req->failed_syscall = "copyfile";
            CloseRequestDescriptor(req);
            finished_requests.push_back(req);
        } else if (S_ISDIR(req->stx.stx_mode)) {
            req->saved_errno = EISDIR;
            req->failed_syscall = "copyfile";
            CloseRequestDescriptor(req);
            finished_requests.push_back(req);
        } else {
            req->size = static_cast<size_t>(req->stx.stx_size);
            req->mode = req->stx.stx_mode & 0777;
            req->stage = STAGE_OPEN_DEST;
            ScheduleStage(req);
        }
        return;
    }

    // OP_READ_FILE statx completion (either after optimistic read overflow or classic fallback)
    if (res < 0) {
        req->saved_errno = -res;
        req->failed_syscall = "fstat";
        CloseRequestDescriptor(req);
        finished_requests.push_back(req);
    } else if (S_ISDIR(req->stx.stx_mode)) {
        req->saved_errno = EISDIR;
        req->failed_syscall = "read";
        CloseRequestDescriptor(req);
        finished_requests.push_back(req);
    } else if (req->buffer != nullptr && req->offset > 0) {
        size_t total_size = static_cast<size_t>(req->stx.stx_size);
        if (total_size <= req->offset) {
            req->size = req->offset;
            CloseRequestDescriptor(req);
            finished_requests.push_back(req);
        } else {
            char* new_buf = static_cast<char*>(std::realloc(req->buffer, total_size));
            if (!new_buf) {
                req->saved_errno = ENOMEM;
                req->failed_syscall = "read";
                CloseRequestDescriptor(req);
                finished_requests.push_back(req);
            } else {
                req->buffer = new_buf;
                req->buffer_capacity = total_size;
                req->size = total_size;
                req->stage = (req->direct_slot >= 0) ? STAGE_READ_DIRECT_PAIR2 : STAGE_READ;
                ScheduleStage(req);
            }
        }
    } else {
        req->size = static_cast<size_t>(req->stx.stx_size);
        if (req->size == 0) {
            CloseRequestDescriptor(req);
            finished_requests.push_back(req);
        } else {
            req->buffer = static_cast<char*>(std::malloc(req->size));
            if (!req->buffer) {
                req->saved_errno = ENOMEM;
                req->failed_syscall = "read";
                CloseRequestDescriptor(req);
                finished_requests.push_back(req);
            } else {
                req->buffer_capacity = req->size;
                req->offset = 0;
                req->stage = STAGE_READ;
                ScheduleStage(req);
            }
        }
    }
}

static inline void HandleUnlinkedRead(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (res < 0) {
        if (-res == EINTR || -res == EAGAIN) {
            ScheduleStage(req);
            return;
        }
        req->saved_errno = -res;
        req->failed_syscall = (req->op == OP_COPY_FILE) ? "copyfile" : "read";
        if (req->op != OP_FH_READ && req->op != OP_FH_READ_AT) {
            CloseRequestDescriptor(req);
        }
        if (req->dest_fd >= 0) {
            EnqueueAsyncClose(req->dest_fd);
            req->dest_fd = -1;
        }
        finished_requests.push_back(req);
        return;
    }

    if (req->op == OP_FH_READ) {
        req->size = static_cast<size_t>(res);
        finished_requests.push_back(req);
        return;
    }
    if (req->op == OP_FH_READ_AT) {
        if (req->size == 0) {
            finished_requests.push_back(req);
            return;
        }
        if (res > 0) {
            req->offset += static_cast<size_t>(res);
            if (req->offset > req->size) req->offset = req->size;
            if (req->offset < req->size &&
                (static_cast<size_t>(res) == MAX_IO_CHUNK || req->continue_short_read)) {
                req->continue_short_read = false;
                ScheduleStage(req);
                return;
            }
        }
        req->size = req->offset;
        finished_requests.push_back(req);
        return;
    }
    if (req->op == OP_READ_BATCH_AT) {
        if (res > 0 && req->size > 0) {
            req->offset += static_cast<size_t>(res);
            if (req->offset > req->size) req->offset = req->size;
        }
        if (res > 0 && req->offset < req->size) {
            ScheduleStage(req);
            return;
        }
        req->batch_slices[req->current_slice_idx].bytes_read = req->size > 0 ? req->offset : 0;
        req->current_slice_idx++;
        if (req->current_slice_idx < req->batch_slices.size()) {
            if (!AdvanceBatchSlice(req)) {
                finished_requests.push_back(req);
            }
        } else {
            CloseRequestDescriptor(req);
            req->buffer = nullptr;
            finished_requests.push_back(req);
        }
        return;
    }
    if (req->optimistic_read) {
        req->offset += static_cast<size_t>(res);
        if (static_cast<size_t>(res) < req->optimistic_read_size) {
            req->size = req->offset;
            req->optimistic_read = false;
            CloseRequestDescriptor(req);
            finished_requests.push_back(req);
        } else {
            req->optimistic_read = false;
            req->stage = STAGE_STATX;
            ScheduleStage(req);
        }
        return;
    }

    bool eof = (res == 0);
    if (!eof && req->size > 0) {
        req->offset += static_cast<size_t>(res);
    }
    if (!eof && req->offset < req->size) {
        ScheduleStage(req);
        return;
    }
    if (eof) {
        req->size = req->offset;
    }
    CloseRequestDescriptor(req);
    if (req->op == OP_COPY_FILE) {
        req->write_ptr = req->buffer;
        req->offset = 0;
        req->stage = STAGE_WRITE;
        ScheduleStage(req);
    } else {
        finished_requests.push_back(req);
    }
}

static inline void HandleStageOpenDirect(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (res < 0) {
        req->saved_errno = -res;
        req->failed_syscall = "open";
        FreeDirectSlot(req->direct_slot);
        req->direct_slot = -1;
        finished_requests.push_back(req);
        return;
    }
    req->open_succeeded = true;
    if (req->op == OP_WRITE_FILE) {
        req->stage = (req->offset >= req->size)
            ? (req->flush_after_write ? STAGE_FSYNC : STAGE_CLOSE_DIRECT)
            : STAGE_WRITE;
        ScheduleStage(req);
    } else {
        req->owns_descriptor = false;
        finished_requests.push_back(req);
    }
}

static inline void ScheduleCopyReadFallback(
    IORequest* req,
    std::vector<IORequest*>& finished_requests
) {
    req->buffer = static_cast<char*>(std::malloc(req->size));
    if (!req->buffer) {
        FailAndCloseCopy(req, ENOMEM, finished_requests);
        return;
    }
    req->buffer_capacity = req->size;
    req->offset = 0;
    req->stage = STAGE_READ;
    ScheduleStage(req);
}

static inline void FinishCopyToClose(IORequest* req) {
    CloseCopyPipes(req);
    EnqueueAsyncClose(req->fd);
    req->fd = req->dest_fd;
    req->dest_fd = -1;
    req->stage = STAGE_CLOSE;
    ScheduleStage(req);
}

static inline void HandleStageOpenDest(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (res < 0) {
        req->saved_errno = -res;
        req->failed_syscall = "copyfile";
        CloseRequestDescriptor(req);
        finished_requests.push_back(req);
        return;
    }
    req->dest_fd = res;
    if (req->size == 0) {
        EnqueueAsyncClose(req->fd);
        req->fd = req->dest_fd;
        req->dest_fd = -1;
        req->stage = STAGE_CLOSE;
        ScheduleStage(req);
    } else if (pipe2(req->pipefd, O_CLOEXEC) == 0) {
        if (req->size > 65536) {
            (void)fcntl(req->pipefd[1], F_SETPIPE_SZ, MAX_SPLICE_CHUNK);
        }
        req->offset = 0;
        req->write_offset = 0;
        req->splice_in_pipe = 0;
        req->stage = STAGE_COPY_SPLICE_IN;
        ScheduleStage(req);
    } else {
        ScheduleCopyReadFallback(req, finished_requests);
    }
}

static inline void HandleStageCopySpliceIn(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (res < 0) {
        if (-res == EINTR || -res == EAGAIN) {
            ScheduleStage(req);
        } else if ((-res == EINVAL || -res == ENOSYS) && req->offset == 0) {
            CloseCopyPipes(req);
            ScheduleCopyReadFallback(req, finished_requests);
        } else {
            FailAndCloseCopy(req, -res, finished_requests);
        }
        return;
    }
    if (res == 0) {
        FinishCopyToClose(req);
        return;
    }
    req->offset += static_cast<size_t>(res);
    req->splice_in_pipe = static_cast<size_t>(res);
    req->stage = STAGE_COPY_SPLICE_OUT;
    ScheduleStage(req);
}

static inline void HandleStageCopySpliceOut(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (res <= 0) {
        if (res < 0 && (-res == EINTR || -res == EAGAIN)) {
            ScheduleStage(req);
        } else {
            FailAndCloseCopy(req, (res < 0) ? -res : EIO, finished_requests);
        }
        return;
    }
    req->write_offset += static_cast<size_t>(res);
    req->splice_in_pipe -= static_cast<size_t>(res);
    if (req->splice_in_pipe > 0) {
        ScheduleStage(req);
    } else if (req->write_offset < req->size) {
        req->stage = STAGE_COPY_SPLICE_IN;
        ScheduleStage(req);
    } else {
        FinishCopyToClose(req);
    }
}

static inline void TransitionWriteToNextStage(IORequest* req, RequestStage next_stage) {
    if (req->op == OP_COPY_FILE) {
        req->fd = req->dest_fd;
        req->dest_fd = -1;
    }
    req->stage = next_stage;
    ScheduleStage(req);
}

static inline void HandleStageWrite(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    RequestStage close_stage = (req->direct_slot >= 0) ? STAGE_CLOSE_DIRECT : STAGE_CLOSE;
    if (res < 0) {
        if (-res == EINTR || -res == EAGAIN) {
            ScheduleStage(req);
            return;
        }
        req->saved_errno = -res;
        req->failed_syscall = (req->op == OP_COPY_FILE) ? "copyfile" : "write";
        if (req->op == OP_FH_WRITE) {
            finished_requests.push_back(req);
        } else {
            TransitionWriteToNextStage(req, close_stage);
        }
        return;
    }
    if (req->op == OP_FH_WRITE) {
        req->size = static_cast<size_t>(res);
        finished_requests.push_back(req);
        return;
    }
    if (res == 0 && req->size > 0) {
        req->saved_errno = EIO;
        req->failed_syscall = (req->op == OP_COPY_FILE) ? "copyfile" : "write";
        TransitionWriteToNextStage(req, close_stage);
        return;
    }
    if (req->size > 0) {
        req->offset += static_cast<size_t>(res);
    }
    if (req->offset < req->size) {
        ScheduleStage(req);
    } else {
        TransitionWriteToNextStage(req, req->flush_after_write ? STAGE_FSYNC : close_stage);
    }
}

static inline void HandleStageVectoredOrHint(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    bool is_fh = (req->op == OP_FH_READV || req->op == OP_FH_WRITEV ||
                  req->op == OP_FH_FALLOCATE || req->op == OP_FH_FADVISE);
    if (res < 0) {
        if (-res == EINTR || -res == EAGAIN) {
            ScheduleStage(req);
            return;
        }
        req->saved_errno = -res;
        req->failed_syscall = (req->stage == STAGE_READV) ? "readv"
            : (req->stage == STAGE_WRITEV) ? "writev"
            : (req->stage == STAGE_FALLOCATE) ? "fallocate" : "fadvise";
        if (is_fh) {
            finished_requests.push_back(req);
        } else {
            req->stage = (req->direct_slot >= 0) ? STAGE_CLOSE_DIRECT : STAGE_CLOSE;
            ScheduleStage(req);
        }
        return;
    }
    if (req->stage == STAGE_READV || req->stage == STAGE_WRITEV) {
        req->size = static_cast<size_t>(res);
    }
    if (is_fh) {
        finished_requests.push_back(req);
    } else {
        req->stage = (req->stage == STAGE_WRITEV && req->flush_after_write)
            ? STAGE_FSYNC
            : ((req->direct_slot >= 0) ? STAGE_CLOSE_DIRECT : STAGE_CLOSE);
        ScheduleStage(req);
    }
}

static inline void HandleStageFsync(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (res < 0 && req->saved_errno == 0) {
        req->saved_errno = -res;
        req->failed_syscall = (req->fsync_flags & IORING_FSYNC_DATASYNC) ? "fdatasync" : "fsync";
    }
    if (req->op == OP_FH_FSYNC) {
        finished_requests.push_back(req);
    } else {
        req->stage = (req->direct_slot >= 0) ? STAGE_CLOSE_DIRECT : STAGE_CLOSE;
        ScheduleStage(req);
    }
}

static inline void HandleStageClose(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (res < 0 && req->saved_errno == 0) {
        req->saved_errno = -res;
        req->failed_syscall = "close";
    }
    if (req->stage == STAGE_CLOSE_DIRECT) {
        FreeDirectSlot(req->direct_slot);
        req->direct_slot = -1;
    } else {
        req->fd = -1;
    }
    finished_requests.push_back(req);
}

static inline void HandleStageSimpleMeta(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    if (res < 0) {
        req->saved_errno = -res;
        req->failed_syscall = (req->stage == STAGE_UNLINK) ? "unlink"
            : (req->stage == STAGE_RMDIR) ? "rmdir"
            : (req->stage == STAGE_MKDIR) ? "mkdir"
            : (req->stage == STAGE_RENAME) ? "rename"
            : (req->stage == STAGE_SYMLINK) ? "symlink" : "link";
    }
    finished_requests.push_back(req);
}

static inline void HandleUnlinkedStage(
    IORequest* req,
    int res,
    std::vector<IORequest*>& finished_requests
) {
    switch (req->stage) {
        case STAGE_OPEN_DIRECT:       HandleStageOpenDirect(req, res, finished_requests); break;
        case STAGE_OPEN:              HandleUnlinkedOpen(req, res, finished_requests); break;
        case STAGE_STATX:             HandleUnlinkedStatx(req, res, finished_requests); break;
        case STAGE_OPEN_DEST:         HandleStageOpenDest(req, res, finished_requests); break;
        case STAGE_COPY_SPLICE_IN:    HandleStageCopySpliceIn(req, res, finished_requests); break;
        case STAGE_COPY_SPLICE_OUT:   HandleStageCopySpliceOut(req, res, finished_requests); break;
        case STAGE_READ_DIRECT_PAIR2: break;
        case STAGE_READ:              HandleUnlinkedRead(req, res, finished_requests); break;
        case STAGE_WRITE:             HandleStageWrite(req, res, finished_requests); break;
        case STAGE_READV:
        case STAGE_WRITEV:
        case STAGE_FALLOCATE:
        case STAGE_FADVISE:           HandleStageVectoredOrHint(req, res, finished_requests); break;
        case STAGE_FSYNC:             HandleStageFsync(req, res, finished_requests); break;
        case STAGE_CLOSE:
        case STAGE_CLOSE_DIRECT:      HandleStageClose(req, res, finished_requests); break;
        case STAGE_UNLINK:
        case STAGE_RMDIR:
        case STAGE_MKDIR:
        case STAGE_RENAME:
        case STAGE_SYMLINK:
        case STAGE_LINK:              HandleStageSimpleMeta(req, res, finished_requests); break;
    }
}

#endif // URING_FS_INTERNAL_COMPLETIONS_STAGES_HPP
