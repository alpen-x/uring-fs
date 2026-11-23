#if defined(__GNUC__) || defined(__clang__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wconversion"
#pragma GCC diagnostic ignored "-Wsign-conversion"
#pragma GCC diagnostic ignored "-Wshadow"
#endif
#include <napi.h>
#if defined(__GNUC__) || defined(__clang__)
#pragma GCC diagnostic pop
#endif

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), false);
}

Napi::Value GetUnsupportedReason(const Napi::CallbackInfo& info) {
#ifdef __linux__
    return Napi::String::New(
        info.Env(),
        "Compiled without liburing headers (install liburing-dev and run 'npm rebuild uring-fs' to enable native io_uring)"
    );
#else
    return Napi::String::New(
        info.Env(),
        "io_uring is a Linux-specific kernel interface (using configured fallback backend)"
    );
#endif
}

Napi::Value SetOptimisticReadSize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected a non-negative number of bytes").ThrowAsJavaScriptException();
        return env.Null();
    }
    int64_t val = info[0].As<Napi::Number>().Int64Value();
    size_t clamped = 0;
    if (val > 0) {
        clamped = static_cast<uint64_t>(val) > 0x7ffff000ULL ? static_cast<size_t>(0x7ffff000ULL) : static_cast<size_t>(val);
    }
    return Napi::Number::New(env, static_cast<double>(clamped));
}

Napi::Value SetFaultInjection(const Napi::CallbackInfo& info) {
    return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isSupported", Napi::Function::New(env, IsSupported));
    exports.Set("getUnsupportedReason", Napi::Function::New(env, GetUnsupportedReason));
    exports.Set("setOptimisticReadSize", Napi::Function::New(env, SetOptimisticReadSize));
    exports.Set("setFaultInjection", Napi::Function::New(env, SetFaultInjection));
    return exports;
}

NODE_API_MODULE(uring_fs, Init)
