#ifndef URING_FS_INTERNAL_NAPI_OPS_HANDLE_HPP
#define URING_FS_INTERNAL_NAPI_OPS_HANDLE_HPP

#include "napi_ops_path.hpp"

static inline bool ParseHandleAndInitRequest(
    const Napi::CallbackInfo& info,
    int min_args,
    const char* err_msg,
    OperationType op,
    RequestStage stage,
    IORequest** out_req
) {
    Napi::Env env = info.Env();
    if (static_cast<int>(info.Length()) < min_args || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, err_msg).ThrowAsJavaScriptException();
        return false;
    }
    int fd = info[0].As<Napi::Number>().Int32Value();
    int directSlot = info[1].As<Napi::Number>().Int32Value();
    IORequest* req = new IORequest(env, op, stage, "");
    req->fd = fd;
    req->direct_slot = directSlot;
    req->owns_descriptor = false;
    *out_req = req;
    return true;
}

static inline Napi::Value DispatchHandleRequest(IORequest* req) {
    Napi::Promise promise = req->deferred.Promise();
    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);
    return promise;
}

Napi::Value OpenHandleUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "The 'path' argument must be a string").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    int openFlags = (info.Length() >= 2 && info[1].IsNumber()) ? info[1].As<Napi::Number>().Int32Value() : O_RDONLY;
    mode_t mode = (info.Length() >= 3 && info[2].IsNumber()) ? static_cast<mode_t>(info[2].As<Napi::Number>().Uint32Value()) : 0666;

    if (!EnsureCredentialsSafe()) {
        Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
        deferred.Reject(CreateErrnoError(env, EPERM, "io_uring", filePath));
        return deferred.Promise();
    }

    IORequest* req = new IORequest(env, OP_FH_OPEN, STAGE_OPEN, std::move(filePath));
    req->open_flags = openFlags;
    req->mode = mode;

    if (direct_slots.supported && direct_slots.FreeCount() > MAX_HANDLE_DIRECT_SLOTS) {
        int slot = AllocateDirectSlot();
        if (slot >= 0) {
            req->direct_slot = slot;
            req->stage = STAGE_OPEN_DIRECT;
        }
    }
    return DispatchHandleRequest(req);
}

static inline IORequest* ParseFhRwArgs(
    const Napi::CallbackInfo& info,
    OperationType op,
    RequestStage stage,
    const char* type_err_msg,
    const char* range_err_msg,
    char** out_data_ptr
) {
    Napi::Env env = info.Env();
    char* targetData = nullptr;
    size_t targetBufLen = 0;
    if (info.Length() < 5 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[3].IsNumber() || !info[4].IsNumber() ||
        !ExtractArrayBufferView(info[2], &targetData, &targetBufLen)) {
        if (info.Length() >= 3 && (info[2].IsBuffer() || info[2].IsTypedArray() || info[2].IsDataView())) {
            ThrowDetachedViewError(env);
        } else {
            Napi::TypeError::New(env, type_err_msg).ThrowAsJavaScriptException();
        }
        return nullptr;
    }

    int64_t rawOffset = info[3].As<Napi::Number>().Int64Value();
    int64_t rawLen = info[4].As<Napi::Number>().Int64Value();
    if (rawOffset < 0 || rawLen < 0 ||
        static_cast<size_t>(rawOffset) > targetBufLen ||
        static_cast<size_t>(rawLen) > targetBufLen - static_cast<size_t>(rawOffset)) {
        Napi::RangeError::New(env, range_err_msg).ThrowAsJavaScriptException();
        return nullptr;
    }

    IORequest* req = nullptr;
    ParseHandleAndInitRequest(info, 5, "", op, stage, &req);
    size_t bufOffset = static_cast<size_t>(rawOffset);
    size_t length = static_cast<size_t>(rawLen);
    int64_t position = (info.Length() >= 6 && info[5].IsNumber()) ? info[5].As<Napi::Number>().Int64Value() : -1;

    *out_data_ptr = targetData + bufOffset;
    req->size = length;
    req->offset = 0;
    req->file_offset = (position >= 0) ? static_cast<uint64_t>(position) : static_cast<uint64_t>(-1);
    req->write_buf_ref.Reset(info[2].As<Napi::Object>(), 1);
    return req;
}

Napi::Value FhReadUring(const Napi::CallbackInfo& info) {
    char* dataPtr = nullptr;
    IORequest* req = ParseFhRwArgs(
        info,
        OP_FH_READ,
        STAGE_READ,
        "Expected arguments: (fd: number, directSlot: number, buffer: Buffer | ArrayBufferView, offset: number, length: number, position?: number)",
        "offset + length is out of range for target buffer",
        &dataPtr
    );
    if (!req) return info.Env().Null();
    req->buffer = dataPtr;
    req->buffer_capacity = req->size;
    req->buffer_is_external = true;
    return DispatchHandleRequest(req);
}

Napi::Value FhReadAtUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4 || !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env, "Expected arguments: (fd: number, directSlot: number, offset: number, length: number)").ThrowAsJavaScriptException();
        return env.Null();
    }
    IORequest* req = nullptr;
    if (!ParseHandleAndInitRequest(
            info, 4, "Expected arguments: (fd: number, directSlot: number, offset: number, length: number)",
            OP_FH_READ_AT, STAGE_READ, &req)) {
        return env.Null();
    }

    int64_t offset = info[2].As<Napi::Number>().Int64Value();
    int64_t length = info[3].As<Napi::Number>().Int64Value();
    if (length < 0) length = 0;

    req->file_offset = offset >= 0 ? static_cast<uint64_t>(offset) : 0;
    req->size = static_cast<size_t>(length);
    req->offset = 0;

    if (!AllocateReadBuffer(req)) {
        delete req;
        Napi::Error::New(env, "Failed to allocate read buffer").ThrowAsJavaScriptException();
        return env.Null();
    }
    return DispatchHandleRequest(req);
}

Napi::Value FhWriteUring(const Napi::CallbackInfo& info) {
    char* dataPtr = nullptr;
    IORequest* req = ParseFhRwArgs(
        info,
        OP_FH_WRITE,
        STAGE_WRITE,
        "Expected arguments: (fd: number, directSlot: number, buffer: Buffer | ArrayBufferView, offset: number, length: number, position?: number, openFlags?: number)",
        "offset + length is out of range for data buffer",
        &dataPtr
    );
    if (!req) return info.Env().Null();
    int openFlags = (info.Length() >= 7 && info[6].IsNumber()) ? info[6].As<Napi::Number>().Int32Value() : 0;
    req->write_ptr = dataPtr;
    req->open_flags = openFlags;
    return DispatchHandleRequest(req);
}

Napi::Value FhReadvUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[2].IsArray()) {
        Napi::TypeError::New(env, "Expected arguments: (fd: number, directSlot: number, buffers: Buffer[], position?: number)").ThrowAsJavaScriptException();
        return env.Null();
    }
    IORequest* req = nullptr;
    if (!ParseHandleAndInitRequest(
            info, 3, "Expected arguments: (fd: number, directSlot: number, buffers: Buffer[], position?: number)",
            OP_FH_READV, STAGE_READV, &req)) {
        return env.Null();
    }
    Napi::Array bufs = info[2].As<Napi::Array>();
    if (bufs.Length() == 0) {
        delete req;
        Napi::Promise::Deferred def = Napi::Promise::Deferred::New(env);
        def.Resolve(Napi::Number::New(env, 0));
        return def.Promise();
    }
    int64_t position = (info.Length() >= 4 && info[3].IsNumber()) ? info[3].As<Napi::Number>().Int64Value() : -1;
    req->file_offset = (position >= 0) ? static_cast<uint64_t>(position) : static_cast<uint64_t>(-1);
    if (!PopulateIovecs(env, bufs, req)) {
        delete req;
        return env.Undefined();
    }
    return DispatchHandleRequest(req);
}

Napi::Value FhWritevUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[2].IsArray()) {
        Napi::TypeError::New(env, "Expected arguments: (fd: number, directSlot: number, buffers: Buffer[], position?: number, openFlags?: number)").ThrowAsJavaScriptException();
        return env.Null();
    }
    IORequest* req = nullptr;
    if (!ParseHandleAndInitRequest(
            info, 3, "Expected arguments: (fd: number, directSlot: number, buffers: Buffer[], position?: number, openFlags?: number)",
            OP_FH_WRITEV, STAGE_WRITEV, &req)) {
        return env.Null();
    }
    Napi::Array bufs = info[2].As<Napi::Array>();
    if (bufs.Length() == 0) {
        delete req;
        Napi::Promise::Deferred def = Napi::Promise::Deferred::New(env);
        def.Resolve(Napi::Number::New(env, 0));
        return def.Promise();
    }
    int64_t position = (info.Length() >= 4 && info[3].IsNumber()) ? info[3].As<Napi::Number>().Int64Value() : -1;
    int openFlags = (info.Length() >= 5 && info[4].IsNumber()) ? info[4].As<Napi::Number>().Int32Value() : 0;

    req->open_flags = openFlags;
    req->file_offset = (position >= 0) ? static_cast<uint64_t>(position) : static_cast<uint64_t>(-1);
    if (!PopulateIovecs(env, bufs, req)) {
        delete req;
        return env.Undefined();
    }
    return DispatchHandleRequest(req);
}

Napi::Value FhSyncUring(const Napi::CallbackInfo& info) {
    IORequest* req = nullptr;
    if (!ParseHandleAndInitRequest(
            info, 2, "Expected arguments: (fd: number, directSlot: number, datasyncOnly?: boolean)",
            OP_FH_FSYNC, STAGE_FSYNC, &req)) {
        return info.Env().Null();
    }
    bool datasyncOnly = (info.Length() >= 3 && info[2].IsBoolean() && info[2].As<Napi::Boolean>().Value());
    req->fsync_flags = datasyncOnly ? IORING_FSYNC_DATASYNC : 0;
    return DispatchHandleRequest(req);
}

Napi::Value FhFallocateUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5 || !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber()) {
        Napi::TypeError::New(env, "Expected arguments: (fd: number, directSlot: number, mode: number, offset: number, length: number)").ThrowAsJavaScriptException();
        return env.Null();
    }
    IORequest* req = nullptr;
    if (!ParseHandleAndInitRequest(
            info, 5, "Expected arguments: (fd: number, directSlot: number, mode: number, offset: number, length: number)",
            OP_FH_FALLOCATE, STAGE_FALLOCATE, &req)) {
        return env.Null();
    }
    int mode = info[2].As<Napi::Number>().Int32Value();
    int64_t offset = info[3].As<Napi::Number>().Int64Value();
    int64_t length = info[4].As<Napi::Number>().Int64Value();

    req->falloc_mode = mode;
    req->file_offset = offset >= 0 ? static_cast<uint64_t>(offset) : 0;
    req->size = length >= 0 ? static_cast<size_t>(length) : 0;
    return DispatchHandleRequest(req);
}

Napi::Value FhFadviseUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5 || !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber()) {
        Napi::TypeError::New(env, "Expected arguments: (fd: number, directSlot: number, offset: number, length: number, advice: number)").ThrowAsJavaScriptException();
        return env.Null();
    }
    IORequest* req = nullptr;
    if (!ParseHandleAndInitRequest(
            info, 5, "Expected arguments: (fd: number, directSlot: number, offset: number, length: number, advice: number)",
            OP_FH_FADVISE, STAGE_FADVISE, &req)) {
        return env.Null();
    }
    int64_t offset = info[2].As<Napi::Number>().Int64Value();
    int64_t length = info[3].As<Napi::Number>().Int64Value();
    int advice = info[4].As<Napi::Number>().Int32Value();

    req->file_offset = offset >= 0 ? static_cast<uint64_t>(offset) : 0;
    req->size = length >= 0 ? static_cast<size_t>(length) : 0;
    req->fadvise_advice = advice;
    return DispatchHandleRequest(req);
}

Napi::Value FhCloseUring(const Napi::CallbackInfo& info) {
    IORequest* req = nullptr;
    if (!ParseHandleAndInitRequest(
            info, 2, "Expected arguments: (fd: number, directSlot: number)",
            OP_FH_CLOSE, STAGE_CLOSE, &req)) {
        return info.Env().Null();
    }
    req->stage = (req->direct_slot >= 0) ? STAGE_CLOSE_DIRECT : STAGE_CLOSE;
    req->owns_descriptor = true;
    return DispatchHandleRequest(req);
}

#endif // URING_FS_INTERNAL_NAPI_OPS_HANDLE_HPP
