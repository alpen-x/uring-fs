{
  "variables": {
    "has_liburing%": "<!(node -p \"require('fs').existsSync('/usr/include/liburing.h') || require('fs').existsSync('/usr/local/include/liburing.h') ? 'true' : 'false'\")"
  },
  "targets": [
    {
      "target_name": "uring_fs",
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='linux' and has_liburing=='true'", {
          "sources": [ "src/addon.cc" ],
          "libraries": [ "-luring" ],
          "cflags_cc": [ "-std=c++17", "-O3", "-Wall", "-Wextra", "-Wno-unused-parameter" ]
        }],
        ["OS!='linux' or has_liburing!='true'", {
          "sources": [ "src/addon_stub.cc" ],
          "cflags_cc": [ "-std=c++17", "-O2" ]
        }]
      ]
    }
  ]
}
