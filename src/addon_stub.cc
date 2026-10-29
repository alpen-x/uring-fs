#include <napi.h>

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
        return Napi::Number::New(env, 65536);
    }
    return info[0];
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isSupported", Napi::Function::New(env, IsSupported));
    exports.Set("getUnsupportedReason", Napi::Function::New(env, GetUnsupportedReason));
    exports.Set("setOptimisticReadSize", Napi::Function::New(env, SetOptimisticReadSize));
    return exports;
}

NODE_API_MODULE(uring_fs, Init)
