#ifndef URING_FS_INTERNAL_RING_LOOP_HPP
#define URING_FS_INTERNAL_RING_LOOP_HPP

#include "completions_stages.hpp"

static inline void RejectWithPendingExceptionOrErrno(IORequest* req, const char* syscall) {
    if (req->env.IsExceptionPending()) {
        Napi::Error err = req->env.GetAndClearPendingException();
        if (!err.IsEmpty()) {
            req->deferred.Reject(err.Value());
            return;
        }
    }
    req->deferred.Reject(CreateErrnoError(req->env, ENOMEM, syscall, req->path, req->dest_path));
}

static inline void ResolveFinishedRequests(std::vector<IORequest*>& finished_requests) {
    if (finished_requests.empty()) return;

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
                case OP_READ_FILE:
                case OP_READ_AT:
                case OP_FH_READ_AT: {
                    if (req->size == 0 || !req->buffer) {
                        Napi::Buffer<char> out = Napi::Buffer<char>::New(req->env, 0);
                        if (req->env.IsExceptionPending()) {
                            RejectWithPendingExceptionOrErrno(req, "read");
                        } else {
                            req->deferred.Resolve(out);
                        }
                    } else if (req->buffer_capacity > 0 &&
                               req->buffer_capacity == default_optimistic_read_size &&
                               req->size <= default_optimistic_read_size) {
                        Napi::Buffer<char> out = Napi::Buffer<char>::Copy(req->env, req->buffer, req->size);
                        if (req->env.IsExceptionPending()) {
                            RejectWithPendingExceptionOrErrno(req, "read");
                        } else {
                            req->deferred.Resolve(out);
                        }
                    } else {
                        char* raw_buf = req->buffer;
                        size_t len = req->size;
                        if (req->buffer_capacity > len) {
                            char* shrunk = static_cast<char*>(std::realloc(raw_buf, len));
                            if (shrunk) {
                                raw_buf = shrunk;
                                req->buffer = shrunk;
                                req->buffer_capacity = len;
                            }
                        }
                        Napi::Buffer<char> out = Napi::Buffer<char>::New(
                            req->env, raw_buf, len, [](Napi::Env, char* data) { std::free(data); }
                        );
                        if (req->env.IsExceptionPending()) {
                            RejectWithPendingExceptionOrErrno(req, "read");
                        } else {
                            req->buffer = nullptr;
                            req->buffer_capacity = 0;
                            req->deferred.Resolve(out);
                        }
                    }
                    break;
                }
                case OP_READ_BATCH_AT: {
                    Napi::Array arr = Napi::Array::New(req->env, req->batch_slices.size());
                    bool failed = false;
                    for (size_t i = 0; i < req->batch_slices.size(); ++i) {
                        const auto& s = req->batch_slices[i];
                        Napi::Buffer<char> slice_buf = (s.bytes_read == 0 || !s.buffer)
                            ? Napi::Buffer<char>::New(req->env, 0)
                            : Napi::Buffer<char>::Copy(req->env, s.buffer, s.bytes_read);
                        if (req->env.IsExceptionPending()) {
                            RejectWithPendingExceptionOrErrno(req, "read");
                            failed = true;
                            break;
                        }
                        arr.Set(static_cast<uint32_t>(i), slice_buf);
                    }
                    if (!failed) {
                        req->deferred.Resolve(arr);
                    }
                    break;
                }
                case OP_FH_OPEN: {
                    Napi::Object handleObj = Napi::Object::New(req->env);
                    handleObj.Set("fd", Napi::Number::New(req->env, req->fd));
                    handleObj.Set("directSlot", Napi::Number::New(req->env, req->direct_slot));
                    req->deferred.Resolve(handleObj);
                    break;
                }
                case OP_WRITE_FILE:
                case OP_WRITEV:
                case OP_READV:
                case OP_FH_READ:
                case OP_FH_WRITE:
                case OP_FH_READV:
                case OP_FH_WRITEV:
                    req->deferred.Resolve(Napi::Number::New(req->env, static_cast<double>(req->size)));
                    break;
                case OP_STAT:
                case OP_LSTAT:
                    req->deferred.Resolve(BuildStatObject(req->env, req->stx));
                    break;
                default:
                    req->deferred.Resolve(req->env.Undefined());
                    break;
            }
        }

        delete req;
        if (active_requests > 0) {
            active_requests--;
        }
    }
}

static void ProcessCompletions() {
    if (in_poll_callback || !ring_supported) {
        return;
    }
    in_poll_callback = true;

    std::vector<IORequest*> finished_requests;
    finished_requests.reserve(128);
    int passes = 0;

    while (io_uring_cq_ready(&ring) > 0 && passes < 64) {
        passes++;
        struct io_uring_cqe* cqe;
        unsigned head;
        unadvanced_cqes = 0;

        io_uring_for_each_cqe(&ring, head, cqe) {
            unadvanced_cqes++;
            if (in_flight_sqes > 0) in_flight_sqes--;
            stats.total_cqes_reaped++;

            uint64_t raw_data = io_uring_cqe_get_data64(cqe);
            if (raw_data == 0) continue;
            if (raw_data & 1ULL) {
                FreeDirectSlot(static_cast<int>(raw_data >> 1));
                continue;
            }

            IORequest* req = reinterpret_cast<IORequest*>(static_cast<uintptr_t>(raw_data));
            int res = cqe->res;
            if (__builtin_expect(fault_injection.active, 0)) {
                if (fault_injection.next_cqe1_errno != 0 &&
                    req->is_linked_chain &&
                    req->linked_stage_index == 1) {
                    res = -fault_injection.next_cqe1_errno;
                    fault_injection.next_cqe1_errno = 0;
                    fault_injection.UpdateActive();
                } else if (fault_injection.next_write_zero &&
                           ((req->is_linked_chain && req->linked_stage_index == 1 &&
                             ((req->op == OP_WRITE_FILE && req->size > 0) || req->op == OP_WRITEV)) ||
                            (!req->is_linked_chain && (req->stage == STAGE_WRITE || req->stage == STAGE_WRITEV)))) {
                    res = 0;
                    fault_injection.next_write_zero = false;
                    fault_injection.UpdateActive();
                } else if (fault_injection.next_write_short_bytes > 0 &&
                           ((req->is_linked_chain && req->op == OP_WRITE_FILE && req->size > 0 && req->linked_stage_index == 1) ||
                            (!req->is_linked_chain && req->op == OP_WRITE_FILE && req->stage == STAGE_WRITE)) &&
                           res > fault_injection.next_write_short_bytes) {
                    res = fault_injection.next_write_short_bytes;
                    fault_injection.next_write_short_bytes = 0;
                    fault_injection.UpdateActive();
                } else if (fault_injection.next_pair2_short_bytes > 0 &&
                           req->is_linked_chain &&
                           req->op == OP_READ_FILE &&
                           req->stage == STAGE_READ_DIRECT_PAIR2 &&
                           req->linked_stage_index == 0 &&
                           res > fault_injection.next_pair2_short_bytes) {
                    res = fault_injection.next_pair2_short_bytes;
                    fault_injection.next_pair2_short_bytes = 0;
                    fault_injection.UpdateActive();
                } else if (fault_injection.next_read_at_short_bytes > 0 &&
                           ((req->is_linked_chain && req->op == OP_READ_AT && req->linked_stage_index == 1) ||
                            (!req->is_linked_chain && (req->op == OP_READ_AT || req->op == OP_FH_READ_AT) && req->stage == STAGE_READ)) &&
                           res > fault_injection.next_read_at_short_bytes) {
                    res = fault_injection.next_read_at_short_bytes;
                    req->continue_short_read = true;
                    fault_injection.next_read_at_short_bytes = 0;
                    fault_injection.UpdateActive();
                }
            }
            if (req->is_linked_chain) {
                HandleLinkedCqe(req, res, finished_requests);
            } else {
                HandleUnlinkedStage(req, res, finished_requests);
            }
        }

        if (unadvanced_cqes > 0) {
            io_uring_cq_advance(&ring, unadvanced_cqes);
            unadvanced_cqes = 0;
        }
        DrainPendingQueue();
        FlushSubmissions();
    }

    ResolveFinishedRequests(finished_requests);

    DrainPendingQueue();
    FlushSubmissions();

    if (pending_queue.empty() && pending_pair2_queue.empty() && unsubmitted_sqes == 0) {
        DisarmPrepareHookIfNeeded();
    } else {
        ArmPrepareHookIfNeeded();
    }

    UnrefEventLoopIfIdle();
    in_poll_callback = false;
}

static void OnPollReadable(uv_poll_t* handle, int status, int events) {
    (void)handle;
    (void)events;
    if (status < 0) return;
    ProcessCompletions();
}

#endif // URING_FS_INTERNAL_RING_LOOP_HPP
