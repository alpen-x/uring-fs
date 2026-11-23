#ifndef URING_FS_INTERNAL_NAPI_OPS_PATH_HPP
#define URING_FS_INTERNAL_NAPI_OPS_PATH_HPP

#include <climits>
#include "ring_loop.hpp"

#ifndef IOV_MAX
#define IOV_MAX 1024
#endif

static inline Napi::Value DispatchPathRequest(IORequest* req, const std::string& dest = "") {
    Napi::Promise promise = req->deferred.Promise();
    if (!EnsureCredentialsSafe()) {
        req->deferred.Reject(CreateErrnoError(req->env, EPERM, "io_uring", req->path, dest));
        delete req;
        return promise;
    }
    active_requests++;
    stats.total_requests++;
    RefEventLoopIfNeeded();
    ScheduleStage(req);
    return promise;
}

static inline Napi::Value SubmitSinglePathOp(
    const Napi::CallbackInfo& info,
    OperationType op,
    RequestStage stage
) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "The 'path' argument must be a string").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    return DispatchPathRequest(new IORequest(env, op, stage, std::move(filePath)));
}

static inline Napi::Value SubmitDualPathOp(
    const Napi::CallbackInfo& info,
    OperationType op,
    RequestStage stage,
    const char* err_msg
) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, err_msg).ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string firstPath = info[0].As<Napi::String>().Utf8Value();
    std::string secondPath = info[1].As<Napi::String>().Utf8Value();
    IORequest* req = new IORequest(env, op, stage, std::move(firstPath));
    req->dest_path = secondPath;
    return DispatchPathRequest(req, secondPath);
}

static inline bool ExtractArrayBufferView(Napi::Value item, char** out_ptr, size_t* out_len) {
    if (item.IsDataView()) {
        Napi::DataView dv = item.As<Napi::DataView>();
        char* ptr = static_cast<char*>(dv.Data());
        size_t len = dv.ByteLength();
        if (len > 0 && ptr == nullptr) return false;
#if NAPI_VERSION >= 7
        if (len == 0 && dv.ArrayBuffer().IsDetached()) return false;
#endif
        *out_ptr = ptr;
        *out_len = len;
        return true;
    }
    if (item.IsBuffer()) {
        Napi::Buffer<char> b = item.As<Napi::Buffer<char>>();
        char* ptr = b.Data();
        size_t len = b.Length();
        if (len > 0 && ptr == nullptr) return false;
#if NAPI_VERSION >= 7
        if (len == 0 && b.ArrayBuffer().IsDetached()) return false;
#endif
        *out_ptr = ptr;
        *out_len = len;
        return true;
    }
    if (item.IsTypedArray()) {
        Napi::TypedArray ta = item.As<Napi::TypedArray>();
        Napi::ArrayBuffer ab = ta.ArrayBuffer();
        void* base = ab.Data();
        size_t len = ta.ByteLength();
        if (len > 0 && base == nullptr) return false;
#if NAPI_VERSION >= 7
        if (len == 0 && ab.IsDetached()) return false;
#endif
        *out_ptr = (base != nullptr) ? (static_cast<char*>(base) + ta.ByteOffset()) : nullptr;
        *out_len = len;
        return true;
    }
    return false;
}

static inline void ThrowDetachedViewError(Napi::Env env) {
    Napi::Error err = Napi::Error::New(env, "Cannot perform I/O on a detached ArrayBufferView");
    err.Set("code", Napi::String::New(env, "EINVAL"));
    err.Set("errno", Napi::Number::New(env, -EINVAL));
    err.ThrowAsJavaScriptException();
}

static inline bool PopulateIovecs(Napi::Env env, const Napi::Array& bufs, IORequest* req) {
    uint32_t count = bufs.Length();
    if (count > IOV_MAX) {
        Napi::RangeError err = Napi::RangeError::New(env, "The number of buffers exceeds IOV_MAX (1024)");
        err.Set("code", Napi::String::New(env, "ERR_OUT_OF_RANGE"));
        err.Set("errno", Napi::Number::New(env, -EINVAL));
        err.ThrowAsJavaScriptException();
        return false;
    }
    req->iovecs.reserve(count);
    req->iovec_refs.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
        Napi::Value item = bufs.Get(i);
        if (env.IsExceptionPending()) {
            return false;
        }
        char* buf_ptr = nullptr;
        size_t buf_len = 0;
        if (!ExtractArrayBufferView(item, &buf_ptr, &buf_len)) {
            if (item.IsBuffer() || item.IsTypedArray() || item.IsDataView()) {
                ThrowDetachedViewError(env);
            } else {
                Napi::TypeError::New(env, "All elements of buffers array must be Buffers, TypedArrays, or DataViews").ThrowAsJavaScriptException();
            }
            return false;
        }
        struct iovec iov;
        iov.iov_base = buf_ptr;
        iov.iov_len = buf_len;
        req->iovecs.push_back(iov);
        req->iovec_refs.push_back(Napi::Reference<Napi::Object>::New(item.As<Napi::Object>(), 1));
    }
    return true;
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
        if (val <= 0) {
            optimisticSize = 0;
        } else if (static_cast<uint64_t>(val) > MAX_IO_CHUNK) {
            optimisticSize = static_cast<size_t>(MAX_IO_CHUNK);
        } else {
            optimisticSize = static_cast<size_t>(val);
        }
    }

    IORequest* req = new IORequest(env, OP_READ_FILE, STAGE_OPEN, std::move(filePath));
    req->open_flags = O_RDONLY;
    req->optimistic_read_size = optimisticSize;
    return DispatchPathRequest(req);
}

Napi::Value ReadAtUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "Expected arguments: (path: string, offset: number, length: number)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    int64_t fileOffsetVal = info[1].As<Napi::Number>().Int64Value();
    int64_t lengthVal = info[2].As<Napi::Number>().Int64Value();
    if (fileOffsetVal < 0) {
        Napi::RangeError::New(env, "The 'offset' argument must be >= 0").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (lengthVal < 0) {
        Napi::RangeError::New(env, "The 'length' argument must be >= 0").ThrowAsJavaScriptException();
        return env.Null();
    }

    IORequest* req = new IORequest(env, OP_READ_AT, STAGE_OPEN, std::move(filePath));
    req->open_flags = O_RDONLY;
    req->file_offset = static_cast<uint64_t>(fileOffsetVal);
    req->size = static_cast<size_t>(lengthVal);
    req->offset = 0;
    return DispatchPathRequest(req);
}

Napi::Value SetOptimisticReadSize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected a non-negative number of bytes").ThrowAsJavaScriptException();
        return env.Null();
    }
    int64_t val = info[0].As<Napi::Number>().Int64Value();
    if (val <= 0) {
        default_optimistic_read_size = 0;
    } else if (static_cast<uint64_t>(val) > MAX_IO_CHUNK) {
        default_optimistic_read_size = static_cast<size_t>(MAX_IO_CHUNK);
    } else {
        default_optimistic_read_size = static_cast<size_t>(val);
    }
    return Napi::Number::New(env, static_cast<double>(default_optimistic_read_size));
}

Napi::Value WriteFileUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() ||
        (!info[1].IsString() && !info[1].IsBuffer() && !info[1].IsTypedArray() && !info[1].IsDataView())) {
        Napi::TypeError::New(env, "Expected arguments: (path: string, data: string | Buffer | ArrayBufferView, flags?: number, mode?: number, flush?: boolean)").ThrowAsJavaScriptException();
        return env.Null();
    }

    char* view_ptr = nullptr;
    size_t view_len = 0;
    bool is_view = !info[1].IsString();
    if (is_view && !ExtractArrayBufferView(info[1], &view_ptr, &view_len)) {
        ThrowDetachedViewError(env);
        return env.Null();
    }

    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    int openFlags = (info.Length() >= 3 && info[2].IsNumber()) ? info[2].As<Napi::Number>().Int32Value() : (O_WRONLY | O_CREAT | O_TRUNC);
    mode_t mode = (info.Length() >= 4 && info[3].IsNumber()) ? static_cast<mode_t>(info[3].As<Napi::Number>().Uint32Value()) : 0666;
    bool flushAfterWrite = (info.Length() >= 5 && info[4].IsBoolean()) && info[4].As<Napi::Boolean>().Value();

    IORequest* req = new IORequest(env, OP_WRITE_FILE, STAGE_OPEN, std::move(filePath));
    req->open_flags = openFlags;
    req->mode = mode;
    req->flush_after_write = flushAfterWrite;
    if (is_view) {
        req->write_ptr = view_ptr;
        req->size = view_len;
        req->write_buf_ref = Napi::Persistent(info[1].As<Napi::Object>());
    } else {
        req->write_str_holder = info[1].As<Napi::String>().Utf8Value();
        req->write_ptr = req->write_str_holder.data();
        req->size = req->write_str_holder.size();
    }
    return DispatchPathRequest(req);
}

Napi::Value CopyFileUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "Expected arguments: (src: string, dest: string, flags?: number)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string srcPath = info[0].As<Napi::String>().Utf8Value();
    std::string destPath = info[1].As<Napi::String>().Utf8Value();
    int copyFlags = (info.Length() >= 3 && info[2].IsNumber()) ? info[2].As<Napi::Number>().Int32Value() : 0;

    IORequest* req = new IORequest(env, OP_COPY_FILE, STAGE_OPEN, std::move(srcPath));
    req->dest_path = destPath;
    req->open_flags = O_RDONLY;
    req->copy_flags = copyFlags;
    return DispatchPathRequest(req, destPath);
}

Napi::Value StatUring(const Napi::CallbackInfo& info) {
    return SubmitSinglePathOp(info, OP_STAT, STAGE_STATX);
}

Napi::Value LstatUring(const Napi::CallbackInfo& info) {
    return SubmitSinglePathOp(info, OP_LSTAT, STAGE_STATX);
}

Napi::Value AccessUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "The 'path' argument must be a string").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    int mode = (info.Length() >= 2 && info[1].IsNumber()) ? info[1].As<Napi::Number>().Int32Value() : F_OK;
    if ((mode & ~(F_OK | R_OK | W_OK | X_OK)) != 0) {
        Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
        deferred.Reject(CreateErrnoError(env, EINVAL, "access", filePath));
        return deferred.Promise();
    }
    IORequest* req = new IORequest(env, OP_ACCESS, STAGE_STATX, std::move(filePath));
    req->access_mode = mode;
    return DispatchPathRequest(req);
}

Napi::Value UnlinkUring(const Napi::CallbackInfo& info) {
    return SubmitSinglePathOp(info, OP_UNLINK, STAGE_UNLINK);
}

Napi::Value RmdirUring(const Napi::CallbackInfo& info) {
    return SubmitSinglePathOp(info, OP_RMDIR, STAGE_RMDIR);
}

Napi::Value MkdirUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "The 'path' argument must be a string").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string dirPath = info[0].As<Napi::String>().Utf8Value();
    mode_t mode = (info.Length() >= 2 && info[1].IsNumber()) ? static_cast<mode_t>(info[1].As<Napi::Number>().Uint32Value()) : 0777;
    IORequest* req = new IORequest(env, OP_MKDIR, STAGE_MKDIR, std::move(dirPath));
    req->mode = mode;
    return DispatchPathRequest(req);
}

Napi::Value RenameUring(const Napi::CallbackInfo& info) {
    return SubmitDualPathOp(info, OP_RENAME, STAGE_RENAME, "Expected arguments: (oldPath: string, newPath: string)");
}

Napi::Value SymlinkUring(const Napi::CallbackInfo& info) {
    return SubmitDualPathOp(info, OP_SYMLINK, STAGE_SYMLINK, "Expected arguments: (target: string, path: string)");
}

Napi::Value LinkUring(const Napi::CallbackInfo& info) {
    return SubmitDualPathOp(info, OP_LINK, STAGE_LINK, "Expected arguments: (existingPath: string, newPath: string)");
}

Napi::Value FsyncUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "The 'path' argument must be a string").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    bool datasyncOnly = (info.Length() >= 2 && info[1].IsBoolean() && info[1].As<Napi::Boolean>().Value());

    IORequest* req = new IORequest(env, OP_FSYNC, STAGE_OPEN, std::move(filePath));
    req->open_flags = O_RDONLY;
    req->fsync_flags = datasyncOnly ? IORING_FSYNC_DATASYNC : 0;
    return DispatchPathRequest(req);
}

Napi::Value ReadBatchAtUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsArray() || !info[2].IsArray()) {
        Napi::TypeError::New(env, "Expected arguments: (path: string, offsets: number[], lengths: number[])").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    Napi::Array offsets = info[1].As<Napi::Array>();
    Napi::Array lengths = info[2].As<Napi::Array>();
    uint32_t count = offsets.Length();
    if (count != lengths.Length()) {
        Napi::RangeError::New(env, "The 'offsets' and 'lengths' arrays must have the same length").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (count == 0) {
        Napi::Promise::Deferred def = Napi::Promise::Deferred::New(env);
        def.Resolve(Napi::Array::New(env, 0));
        return def.Promise();
    }

    std::vector<BatchSlice> slices;
    slices.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
        Napi::Value offVal = offsets.Get(i);
        if (env.IsExceptionPending()) {
            return env.Undefined();
        }
        Napi::Value lenVal = lengths.Get(i);
        if (env.IsExceptionPending()) {
            return env.Undefined();
        }
        if (!offVal.IsNumber() || !lenVal.IsNumber()) {
            Napi::TypeError::New(env, "All elements of 'offsets' and 'lengths' must be numbers").ThrowAsJavaScriptException();
            return env.Null();
        }
        int64_t off = offVal.As<Napi::Number>().Int64Value();
        int64_t len = lenVal.As<Napi::Number>().Int64Value();
        if (off < 0 || len < 0) {
            Napi::RangeError::New(env, "All offsets and lengths must be non-negative").ThrowAsJavaScriptException();
            return env.Null();
        }
        slices.push_back({ static_cast<uint64_t>(off), static_cast<size_t>(len), 0, nullptr });
    }

    IORequest* req = new IORequest(env, OP_READ_BATCH_AT, STAGE_OPEN, std::move(filePath));
    req->open_flags = O_RDONLY;
    req->batch_slices = std::move(slices);
    return DispatchPathRequest(req);
}

Napi::Value ReadvUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "Expected arguments: (path: string, buffers: Buffer[], position?: number)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    Napi::Array bufs = info[1].As<Napi::Array>();
    if (bufs.Length() == 0) {
        Napi::Promise::Deferred def = Napi::Promise::Deferred::New(env);
        def.Resolve(Napi::Number::New(env, 0));
        return def.Promise();
    }
    int64_t position = (info.Length() >= 3 && info[2].IsNumber()) ? info[2].As<Napi::Number>().Int64Value() : -1;

    IORequest* req = new IORequest(env, OP_READV, STAGE_OPEN, std::move(filePath));
    req->open_flags = O_RDONLY;
    req->file_offset = position >= 0 ? static_cast<uint64_t>(position) : 0;
    if (!PopulateIovecs(env, bufs, req)) {
        delete req;
        return env.Undefined();
    }
    return DispatchPathRequest(req);
}

Napi::Value WritevUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "Expected arguments: (path: string, buffers: Buffer[], position?: number, openFlags?: number, mode?: number, flush?: boolean)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    Napi::Array bufs = info[1].As<Napi::Array>();
    if (bufs.Length() == 0) {
        Napi::Promise::Deferred def = Napi::Promise::Deferred::New(env);
        def.Resolve(Napi::Number::New(env, 0));
        return def.Promise();
    }

    int64_t position = (info.Length() >= 3 && info[2].IsNumber()) ? info[2].As<Napi::Number>().Int64Value() : -1;
    int openFlags = (info.Length() >= 4 && info[3].IsNumber()) ? info[3].As<Napi::Number>().Int32Value() : (O_WRONLY | O_CREAT | O_TRUNC);
    mode_t mode = (info.Length() >= 5 && info[4].IsNumber()) ? static_cast<mode_t>(info[4].As<Napi::Number>().Uint32Value()) : 0666;
    bool flush = (info.Length() >= 6 && info[5].IsBoolean()) && info[5].As<Napi::Boolean>().Value();

    IORequest* req = new IORequest(env, OP_WRITEV, STAGE_OPEN, std::move(filePath));
    req->open_flags = openFlags;
    req->mode = mode;
    req->flush_after_write = flush;
    req->file_offset = (openFlags & O_APPEND)
        ? static_cast<uint64_t>(-1)
        : (position >= 0 ? static_cast<uint64_t>(position) : 0);
    if (!PopulateIovecs(env, bufs, req)) {
        delete req;
        return env.Undefined();
    }
    return DispatchPathRequest(req);
}

Napi::Value FallocateUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "Expected arguments: (path: string, offset: number, length: number, mode?: number)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    int64_t offset = info[1].As<Napi::Number>().Int64Value();
    int64_t length = info[2].As<Napi::Number>().Int64Value();
    int mode = (info.Length() >= 4 && info[3].IsNumber()) ? info[3].As<Napi::Number>().Int32Value() : 0;

    IORequest* req = new IORequest(env, OP_FALLOCATE, STAGE_OPEN, std::move(filePath));
    req->open_flags = O_RDWR | O_CREAT;
    req->mode = 0666;
    req->file_offset = offset >= 0 ? static_cast<uint64_t>(offset) : 0;
    req->size = length >= 0 ? static_cast<size_t>(length) : 0;
    req->falloc_mode = mode;
    return DispatchPathRequest(req);
}

Napi::Value FadviseUring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber()) {
        Napi::TypeError::New(env, "Expected arguments: (path: string, offset: number, length: number, advice: number)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    int64_t offset = info[1].As<Napi::Number>().Int64Value();
    int64_t length = info[2].As<Napi::Number>().Int64Value();
    int advice = info[3].As<Napi::Number>().Int32Value();

    IORequest* req = new IORequest(env, OP_FADVISE, STAGE_OPEN, std::move(filePath));
    req->open_flags = O_RDONLY;
    req->mode = 0666;
    req->file_offset = offset >= 0 ? static_cast<uint64_t>(offset) : 0;
    req->size = length >= 0 ? static_cast<size_t>(length) : 0;
    req->fadvise_advice = advice;
    return DispatchPathRequest(req);
}

#endif // URING_FS_INTERNAL_NAPI_OPS_PATH_HPP
