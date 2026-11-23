#include "internal/uring_compat.hpp"
#include "internal/ring_types.hpp"
#include "internal/ring_state.hpp"
#include "internal/scheduler.hpp"
#include "internal/completions_linked.hpp"
#include "internal/completions_stages.hpp"
#include "internal/ring_loop.hpp"
#include "internal/napi_ops_path.hpp"
#include "internal/napi_ops_handle.hpp"

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), ring_supported);
}

Napi::Value GetUnsupportedReason(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), unsupported_reason);
}

Napi::Value SetFaultInjection(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    FaultInjectionConfig next;
    if (info.Length() >= 1 && !info[0].IsNull() && !info[0].IsUndefined()) {
        if (!info[0].IsObject()) {
            Napi::TypeError::New(env, "Expected an options object for setFaultInjection").ThrowAsJavaScriptException();
            return env.Null();
        }
        Napi::Object opts = info[0].As<Napi::Object>();
        if (opts.Has("nextCqe1Errno")) {
            Napi::Value v = opts.Get("nextCqe1Errno");
            if (v.IsNumber()) {
                int32_t val = v.As<Napi::Number>().Int32Value();
                next.next_cqe1_errno = val > 0 ? val : 0;
            }
        }
        if (opts.Has("nextWriteShortBytes")) {
            Napi::Value v = opts.Get("nextWriteShortBytes");
            if (v.IsNumber()) {
                int32_t val = v.As<Napi::Number>().Int32Value();
                next.next_write_short_bytes = val > 0 ? val : 0;
            }
        }
        if (opts.Has("nextWriteZero")) {
            Napi::Value v = opts.Get("nextWriteZero");
            if (v.IsBoolean()) {
                next.next_write_zero = v.As<Napi::Boolean>().Value();
            }
        }
        if (opts.Has("nextPair2ShortBytes")) {
            Napi::Value v = opts.Get("nextPair2ShortBytes");
            if (v.IsNumber()) {
                int32_t val = v.As<Napi::Number>().Int32Value();
                next.next_pair2_short_bytes = val > 0 ? val : 0;
            }
        }
        if (opts.Has("nextReadAtShortBytes")) {
            Napi::Value v = opts.Get("nextReadAtShortBytes");
            if (v.IsNumber()) {
                int32_t val = v.As<Napi::Number>().Int32Value();
                next.next_read_at_short_bytes = val > 0 ? val : 0;
            }
        }
    }
    next.UpdateActive();
    fault_injection = next;

    Napi::Object out = Napi::Object::New(env);
    out.Set("active", Napi::Boolean::New(env, fault_injection.active));
    out.Set("nextCqe1Errno", Napi::Number::New(env, fault_injection.next_cqe1_errno));
    out.Set("nextWriteShortBytes", Napi::Number::New(env, fault_injection.next_write_short_bytes));
    out.Set("nextWriteZero", Napi::Boolean::New(env, fault_injection.next_write_zero));
    out.Set("nextPair2ShortBytes", Napi::Number::New(env, fault_injection.next_pair2_short_bytes));
    out.Set("nextReadAtShortBytes", Napi::Number::New(env, fault_injection.next_read_at_short_bytes));
    return out;
}

Napi::Value SetRestrictionsConfig(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBoolean()) {
        Napi::TypeError::New(env, "Expected a boolean for setRestrictionsConfig").ThrowAsJavaScriptException();
        return env.Null();
    }
    restrictions_enabled_config = info[0].As<Napi::Boolean>().Value();
    return Napi::Boolean::New(env, restrictions_enabled_config);
}

Napi::Value ProbeDisallowedOpcode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object out = Napi::Object::New(env);
    if (!ring_supported) {
        out.Set("restricted", Napi::Boolean::New(env, false));
        out.Set("blockedSocketErrno", Napi::Number::New(env, -ENOSYS));
        return out;
    }

    if (unsubmitted_sqes > 0) {
        FlushSubmissions();
    }

    static constexpr uint8_t PROBE_OP_SOCKET = 45;
    struct io_uring_sqe* sqe = io_uring_get_sqe(&ring);
    if (!sqe) {
        out.Set("restricted", Napi::Boolean::New(env, false));
        out.Set("blockedSocketErrno", Napi::Number::New(env, -EAGAIN));
        return out;
    }

    io_uring_prep_rw(PROBE_OP_SOCKET, sqe, AF_UNSPEC, nullptr, static_cast<unsigned>(0), static_cast<__u64>(SOCK_STREAM));

    int res = -EIO;
    if (in_flight_sqes == 0 && io_uring_cq_ready(&ring) == 0) {
        io_uring_sqe_set_data64(sqe, 0ULL);
        int sub_ret = io_uring_submit_and_wait(&ring, 1);
        if (sub_ret < 0) {
            out.Set("restricted", Napi::Boolean::New(env, false));
            out.Set("blockedSocketErrno", Napi::Number::New(env, sub_ret));
            return out;
        }
        struct io_uring_cqe* cqe = nullptr;
        int wait_ret = io_uring_wait_cqe(&ring, &cqe);
        if (wait_ret == 0 && cqe != nullptr) {
            res = cqe->res;
            io_uring_cqe_seen(&ring, cqe);
        } else if (wait_ret < 0) {
            res = wait_ret;
        }
    } else {
        probe_pending = true;
        probe_last_res = -EIO;
        io_uring_sqe_set_data64(sqe, PROBE_SENTINEL_DATA);
        in_flight_sqes++;
        int sub_ret = io_uring_submit_and_wait(&ring, 1);
        if (sub_ret < 0) {
            probe_pending = false;
            if (in_flight_sqes > 0) in_flight_sqes--;
            out.Set("restricted", Napi::Boolean::New(env, false));
            out.Set("blockedSocketErrno", Napi::Number::New(env, sub_ret));
            return out;
        }
        bool prev_in_poll = in_poll_callback;
        in_poll_callback = false;
        for (int tries = 0; tries < 1024 && probe_pending; ++tries) {
            ProcessCompletions();
            if (probe_pending) {
                struct io_uring_cqe* wait_cqe = nullptr;
                int wret = io_uring_wait_cqe(&ring, &wait_cqe);
                if (wret < 0 && wret != -EINTR) {
                    break;
                }
            }
        }
        in_poll_callback = prev_in_poll;
        if (probe_pending) {
            probe_pending = false;
        } else {
            res = probe_last_res;
        }
    }

    out.Set("restricted", Napi::Boolean::New(env, res == -EACCES));
    out.Set("blockedSocketErrno", Napi::Number::New(env, res));
    return out;
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
    obj.Set("directFdsSupported", Napi::Boolean::New(env, direct_slots.supported));
    obj.Set("directFdTableSize", Napi::Number::New(env, DIRECT_FD_TABLE_SIZE));
    obj.Set("directFdsInUse", Napi::Number::New(env, static_cast<double>(direct_slots.InUse())));
    obj.Set("restrictionsSupported", Napi::Boolean::New(env, ring_restrictions_supported));
    obj.Set("allowedOpcodesCount", Napi::Number::New(env, restricted_opcodes_count));
    obj.Set("cqSize", Napi::Number::New(env, (ring_supported && ring.cq.kring_entries) ? static_cast<double>(*ring.cq.kring_entries) : 0.0));
    obj.Set("cqOverflows", Napi::Number::New(env, static_cast<double>(stats.cq_overflows)));
    return obj;
}

static void CleanupModule(void* arg) {
    if (handles_initialized) {
        DisarmPrepareHookIfNeeded();
        uv_close(reinterpret_cast<uv_handle_t*>(&prepare_handle), nullptr);
        uv_close(reinterpret_cast<uv_handle_t*>(&check_handle), nullptr);
        ClosePollHandle();
        handles_initialized = false;
    }
    pending_pair2_queue.clear();
    pending_queue.clear();
    while (live_requests_head != nullptr) {
        delete live_requests_head;
    }
    if (async_context != nullptr && arg != nullptr) {
        napi_async_destroy(static_cast<napi_env>(arg), async_context);
        async_context = nullptr;
    }
    active_requests = 0;
    in_flight_sqes = 0;
    unsubmitted_sqes = 0;
    unadvanced_cqes = 0;
    probe_pending = false;
    fault_injection = FaultInjectionConfig{};
    optimistic_pool.Clear();
    direct_slots.Reset();
    ring_restrictions_supported = false;
    restricted_opcodes_count = 0;
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
        const char* env_restr = std::getenv("URING_FS_RESTRICTIONS");
        if (env_restr != nullptr && std::strcmp(env_restr, "0") == 0) {
            restrictions_enabled_config = false;
        }

        uint32_t depth = DEFAULT_QUEUE_DEPTH;
        int ret = InitRingWithRestrictionsAndBestFlags(depth, &ring);
        if (ret < 0) {
            depth = FALLBACK_QUEUE_DEPTH;
            ret = InitRingWithRestrictionsAndBestFlags(depth, &ring);
        }

        if (ret < 0) {
            ring_supported = false;
            unsupported_reason = std::string(uv_strerror(ret)) + " (errno " + std::to_string(-ret) + ")";
        } else {
            ring_supported = true;
            stats.queue_depth = depth;
            ring_euid = geteuid();
            ring_egid = getegid();

            uv_loop_t* loop;
            napi_get_uv_event_loop(env, &loop);

            poll_refd = false;
            InitPollHandle(loop);

            uv_prepare_init(loop, &prepare_handle);
            uv_unref(reinterpret_cast<uv_handle_t*>(&prepare_handle));

            uv_check_init(loop, &check_handle);
            uv_unref(reinterpret_cast<uv_handle_t*>(&check_handle));
            flush_hooks_active = false;

            napi_async_init(env, exports, Napi::String::New(env, "uring-fs"), &async_context);

            handles_initialized = true;
            napi_add_env_cleanup_hook(env, CleanupModule, static_cast<napi_env>(env));
        }
    }

    exports.Set("readFile", Napi::Function::New(env, ReadFileUring));
    exports.Set("readAt", Napi::Function::New(env, ReadAtUring));
    exports.Set("setOptimisticReadSize", Napi::Function::New(env, SetOptimisticReadSize));
    exports.Set("writeFile", Napi::Function::New(env, WriteFileUring));
    exports.Set("copyFile", Napi::Function::New(env, CopyFileUring));
    exports.Set("stat", Napi::Function::New(env, StatUring));
    exports.Set("lstat", Napi::Function::New(env, LstatUring));
    exports.Set("access", Napi::Function::New(env, AccessUring));
    exports.Set("unlink", Napi::Function::New(env, UnlinkUring));
    exports.Set("rmdir", Napi::Function::New(env, RmdirUring));
    exports.Set("mkdir", Napi::Function::New(env, MkdirUring));
    exports.Set("rename", Napi::Function::New(env, RenameUring));
    exports.Set("symlink", Napi::Function::New(env, SymlinkUring));
    exports.Set("link", Napi::Function::New(env, LinkUring));
    exports.Set("fsync", Napi::Function::New(env, FsyncUring));
    exports.Set("readBatchAt", Napi::Function::New(env, ReadBatchAtUring));
    exports.Set("readv", Napi::Function::New(env, ReadvUring));
    exports.Set("writev", Napi::Function::New(env, WritevUring));
    exports.Set("fallocate", Napi::Function::New(env, FallocateUring));
    exports.Set("fadvise", Napi::Function::New(env, FadviseUring));
    exports.Set("openHandle", Napi::Function::New(env, OpenHandleUring));
    exports.Set("fhRead", Napi::Function::New(env, FhReadUring));
    exports.Set("fhReadAt", Napi::Function::New(env, FhReadAtUring));
    exports.Set("fhWrite", Napi::Function::New(env, FhWriteUring));
    exports.Set("fhReadv", Napi::Function::New(env, FhReadvUring));
    exports.Set("fhWritev", Napi::Function::New(env, FhWritevUring));
    exports.Set("fhSync", Napi::Function::New(env, FhSyncUring));
    exports.Set("fhFallocate", Napi::Function::New(env, FhFallocateUring));
    exports.Set("fhFadvise", Napi::Function::New(env, FhFadviseUring));
    exports.Set("fhClose", Napi::Function::New(env, FhCloseUring));
    exports.Set("POSIX_FADV_NORMAL", Napi::Number::New(env, POSIX_FADV_NORMAL));
    exports.Set("POSIX_FADV_RANDOM", Napi::Number::New(env, POSIX_FADV_RANDOM));
    exports.Set("POSIX_FADV_SEQUENTIAL", Napi::Number::New(env, POSIX_FADV_SEQUENTIAL));
    exports.Set("POSIX_FADV_WILLNEED", Napi::Number::New(env, POSIX_FADV_WILLNEED));
    exports.Set("POSIX_FADV_DONTNEED", Napi::Number::New(env, POSIX_FADV_DONTNEED));
    exports.Set("POSIX_FADV_NOREUSE", Napi::Number::New(env, POSIX_FADV_NOREUSE));
    exports.Set("isSupported", Napi::Function::New(env, IsSupported));
    exports.Set("getUnsupportedReason", Napi::Function::New(env, GetUnsupportedReason));
    exports.Set("getRingStats", Napi::Function::New(env, GetRingStats));
    exports.Set("setFaultInjection", Napi::Function::New(env, SetFaultInjection));
    exports.Set("probeDisallowedOpcode", Napi::Function::New(env, ProbeDisallowedOpcode));
    exports.Set("setRestrictionsConfig", Napi::Function::New(env, SetRestrictionsConfig));
    return exports;
}

NODE_API_MODULE(uring_fs, Init)
