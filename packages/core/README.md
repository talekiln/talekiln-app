# lycore（闭源核心骨架）

Rust crate `lycore`：以本地 JSON-RPC 2.0 服务形式运行的核心进程。当前仅为骨架，业务方法后续补充。

## 本地接口 v1

- **传输**：Windows 命名管道（如 `\\.\pipe\lycore-<id>`）；Linux/CI 开发环境回退为 Unix domain socket（路径即端点）。
- **帧格式**：换行分隔的 JSON（一行一条消息，UTF-8），协议为 JSON-RPC 2.0。
- **启动**：`lycore --pipe <端点> [--log-dir <日志目录>]`。日志通过 `tracing` 按日滚动写入 `<日志目录>/lycore.log.*`。

### 方法

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| `core.hello` | 已实现 | 握手与版本协商 |
| `licence.status` | 占位 | 返回 not implemented |
| `media.probe` | 已实现 | 调用 ffprobe 解析媒体信息 |
| `encoder.detect` | 已实现 | 检测 H.264 编码器可用性并给出推荐顺序 |
| `render.start` | 占位 | 返回 not implemented |

### core.hello

请求：`{"jsonrpc":"2.0","id":1,"method":"core.hello","params":{"apiVersions":[1]}}`

`apiVersions` 为客户端支持的 API 版本整数数组；服务端选取双方共同支持的最高版本。

成功响应 `result`：`{"name":"lycore","version":"0.1.0","apiVersion":1,"build":"..."}`
（`build` 可在编译时通过环境变量 `LYCORE_BUILD` 注入。）

### 错误码

| code | 含义 |
| --- | --- |
| -32700 | 解析错误 |
| -32600 | 无效请求 |
| -32601 | 方法不存在 |
| -32602 | 参数无效（如缺少 `apiVersions`） |
| -32001 | 方法尚未实现（not implemented） |
| -32020 | ffmpeg/ffprobe 缺失或损坏；`error.data` 含 `recoverable:true`、`action:"reinstall"`、`tool`、`searched`。Node 侧应显示为“可恢复：请重新安装” |
| -32021 | ffmpeg/ffprobe 执行失败（如文件无法读取）；`error.data.stderr` 为末尾输出，`exitCode` 为退出码 |
| -32022 | 子进程超时（已被终止）；`error.data.timeoutSec` |
| -32023 | 无法解析 ffprobe/ffmpeg 的输出 |
| -32010 | API 版本不兼容；`error.data` 含 `serverApiVersions` 与 `clientApiVersions` |

### ffmpeg 定位

按以下顺序查找 `ffmpeg` / `ffprobe`（Windows 下依次尝试 `.exe`、`.cmd`、`.bat`）：

1. 请求参数 `ffmpegDir`（可选）；
2. 环境变量 `LYCORE_FFMPEG_DIR`；
3. `lycore` 可执行文件同级的 `ffmpeg/`（或 `ffmpeg/bin/`）目录；
4. `PATH`。

若第 1 或第 2 项已配置，则以其为准，找不到即报 -32020，不再回退。所有子进程均为异步启动并带超时，超时后被终止。

### media.probe

参数：`{"path": "<媒体文件>", "timeoutSec": 30（可选，1–600）, "ffmpegDir": "（可选）"}`

内部执行 `ffprobe -v error -print_format json -show_format -show_streams -i <path>`。`result`：

```json
{
  "path": "clip.mp4", "durationSec": 63.52, "formatName": "mov,mp4,...", "sizeBytes": 18734021, "bitRate": 2359400,
  "hasVideo": true, "hasAudio": true,
  "video": {"index":0,"type":"video","codec":"h264","width":1920,"height":1080,"fps":29.97,"pixFmt":"yuv420p","durationSec":63.4965,"bitRate":2310455,"attachedPic":false},
  "audio": {"index":1,"type":"audio","codec":"aac","sampleRate":48000,"channels":2,"durationSec":63.519,"bitRate":128012},
  "streams": ["...所有流，字段同上..."]
}
```

`video` / `audio` 取第一个视频（忽略封面图 attached_pic）/ 音频流；缺失字段为 `null`（解析容错，数值字符串会被转换）。`fps` 优先 `avg_frame_rate`，无效时回退 `r_frame_rate`。时长优先取容器时长，否则取最长的流时长。缺少 `path` 返回 -32602；文件不存在或无法读取返回 -32021。

### encoder.detect

参数：`{"timeoutSec": 15（可选，每次子进程超时，1–120）, "ffmpegDir": "（可选）"}`

先运行 `ffmpeg -hide_banner -encoders` 得到已编译的编码器，再对其中的每个候选（按顺序 `h264_nvenc`、`h264_qsv`、`h264_amf`、`h264_mf`、`libx264`）依次对 1 秒 lavfi `testsrc`（640x360@30）做实际试编码（输出到 null）。`result`：

```json
{
  "encoders": [
    {"name":"h264_nvenc","vendor":"nvidia","hardware":true,"listed":true,"available":false,"reason":"Cannot load libcuda.so.1"},
    {"name":"libx264","vendor":"software","hardware":false,"listed":true,"available":true,"reason":"test encode succeeded"}
  ],
  "recommended": ["h264_mf", "libx264"],
  "best": "h264_mf"
}
```

`recommended` 为可用编码器按偏好排序（硬件优先，`libx264` 作为软件兜底在末尾）；无可用编码器时为空数组且 `best` 为 `null`。未编译进 ffmpeg 的编码器 `listed:false`、`available:false`。失败的 `reason` 取自试编码 stderr 中最有信息量的一行。

## 开发与测试

```
cd packages/core
cargo build --release
cargo test
node client/test.js   # 集成测试：启动二进制，用临时目录中的假 ffmpeg/ffprobe（LYCORE_FFMPEG_DIR）测试 core.hello / media.probe / encoder.detect
```

Node 客户端助手位于 `client/index.js`（CommonJS，无依赖）：`connectRetry(endpoint)` 返回带 `call` / `hello` / `close` 的对象。

解析器的单元测试使用 `src/fixtures/` 下的 ffprobe/ffmpeg 输出样本。
