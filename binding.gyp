{
  "variables": {
    "has_liburing%": "<!(node -p \"require('fs').existsSync('/usr/include/liburing.h') || require('fs').existsSync('/usr/local/include/liburing.h') ? 'true' : 'false'\")",
    "has_static_liburing%": "<!(node -p \"process.env.URING_FS_SHARED_LIBURING !== '1' && ['/usr/lib/x86_64-linux-gnu/liburing.a', '/usr/lib/aarch64-linux-gnu/liburing.a', '/usr/lib/liburing.a', '/usr/local/lib/liburing.a', '/usr/lib64/liburing.a'].some(p => require('fs').existsSync(p)) ? 'true' : 'false'\")",
    "march_native%": "<!(node -p \"process.env.URING_FS_MARCH_NATIVE === '1' || process.env.npm_config_march_native === 'true' ? 'true' : 'false'\")"
  },
  "targets": [
    {
      "target_name": "uring_fs",
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='linux' and has_liburing=='true' and has_static_liburing=='true'", {
          "sources": [ "src/addon.cc" ],
          "libraries": [ "-Wl,-Bstatic", "-luring", "-Wl,-Bdynamic" ],
          "ldflags": [ "-Wl,--exclude-libs,ALL" ],
          "cflags_cc": [ "-std=c++17", "-O3", "-Wall", "-Wextra", "-Wconversion", "-Wsign-conversion", "-Wshadow", "-Wformat=2", "-Wundef", "-fvisibility=hidden" ],
          "conditions": [
            ["march_native=='true'", {
              "cflags_cc": [ "-march=native", "-mtune=native" ]
            }]
          ]
        }],
        ["OS=='linux' and has_liburing=='true' and has_static_liburing!='true'", {
          "sources": [ "src/addon.cc" ],
          "libraries": [ "-luring" ],
          "cflags_cc": [ "-std=c++17", "-O3", "-Wall", "-Wextra", "-Wconversion", "-Wsign-conversion", "-Wshadow", "-Wformat=2", "-Wundef", "-fvisibility=hidden" ],
          "conditions": [
            ["march_native=='true'", {
              "cflags_cc": [ "-march=native", "-mtune=native" ]
            }]
          ]
        }],
        ["OS!='linux' or has_liburing!='true'", {
          "sources": [ "src/addon_stub.cc" ],
          "cflags_cc": [ "-std=c++17", "-O2", "-Wall", "-Wextra", "-Wconversion", "-Wsign-conversion", "-Wshadow", "-Wformat=2", "-Wundef", "-fvisibility=hidden" ]
        }]
      ]
    }
  ]
}
