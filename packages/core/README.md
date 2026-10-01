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
| `render.plan` | 已实现 | 将时间线拆分为场景，计算确定性 sceneKey 并检测缓存命中 |
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

### render.plan

参数：`{"timeline": {"tracks":[...]}, "output": {"width":1920,"height":1080,"fps":30,"encoder":"libx264"}, "cacheDir": "<缓存目录>", "hashContent": false（可选）}`

`timeline` 即本地服务存储的四轨模型（`video` / `subtitle` / `narration` / `music`，clip 字段 `start_ms`、`duration_ms`、`src_in_ms`、`src_out_ms`、`asset_ref`、`asset_kind`、`volume`、`text`、`style`；轨道有 `volume`、`muted`）。`output` 也可放在 `timeline.output`。参数缺失或无效返回 -32602。

`result`：`{"rendererVersion","durationMs","scenes":[{"index","kind":"video|gap","clipId","startMs","durationMs","sceneKey","cacheHit","cachePath"}],"toRender":[场景下标],"music":[...],"missingAssets":[...]}`。

#### 场景划分

- 每个视频 clip 一个场景；视频轨空隙（含第一个 clip 之前、以及最后一个视频 clip 之后到字幕/旁白/音乐末尾）为 `gap` 场景（黑画面 + 静音，仍可承载字幕与旁白）。
- `durationMs` = 所有轨道 clip 结束时间的最大值；空时间线为 0、无场景。
- 视频 clip 重叠时（正常情况下模型不允许），后一个 clip 的起点被截到前一个的终点，`src_in` 相应后移。
- clip 按 (`start_ms`, `duration_ms`, `id`) 排序，因此输入顺序不影响结果。
- `toRender` 为未命中缓存的场景下标；同一 sceneKey 只列第一个（相同场景只需渲染一次）。命中判断：`<cacheDir>/<sceneKey>.mp4` 是否为文件。

#### sceneKey 与规范化 JSON 规则

`sceneKey = sha256( canonical_json(payload) )`，小写十六进制 64 位。规则：

1. 编码为 UTF-8，无任何空白；对象键按字典序递归排序；数组保持顺序（字幕/旁白按开始时间排序）。
2. 键中不出现浮点数：音量换算为整数“万分比”（`round(volume*10000)`，已乘入轨道音量，轨道静音为 0）；帧率为整数 `fpsMilli`（`round(fps*1000)`）；时间均为整数毫秒。
3. 所有时间用**场景相对时间**（字幕/旁白相对场景起点），因此整体平移一个场景不会改变其 key；仅场景时长变化才会改变。
4. `style` 若为 JSON 字符串则先解析为对象再规范化（字符串与对象写法等价）；无法解析时按原字符串。缺失值为 `null`。
5. payload 内容：`rendererVersion`（常量 `RENDERER_VERSION`，当前 `r1`，渲染结果可能变化时必须递增）、`kind`、`durMs`、`output`（宽、高、`fpsMilli`、编码器）、`video`（源文件标识、`assetKind`、`srcInMs`/`srcOutMs`（已按重叠裁剪）、音量）、`subtitles`（与场景重叠的字幕片段：相对起止、文本、样式）、`narration`（与场景重叠的旁白：相对起点、时长、源文件标识、源内偏移、音量）。
6. 源文件标识：默认 `{path,size,mtimeMs}`；`hashContent:true` 时为 `{sha256}`（仅内容，路径与 mtime 不参与）；文件不存在为 `{path,missing:true}`，同时列入 `missingAssets`（仍返回计划）。

#### 音乐轨的处理（决定）

音乐轨**不参与任何场景 key**：场景缓存只含画面 + 字幕 + 视频原声 + 旁白；音乐在最终合成阶段整体混音，计划通过 `music` 返回（起止、素材、源内偏移、已乘轨道音量的 `gain`）。因此修改音乐只需重做最终混音，不会使任何场景缓存失效。编码器与分辨率/帧率属于输出设置，改动会使所有场景 key 变化。

## 开发与测试

```
cd packages/core
cargo build --release
cargo test
node client/test.js   # 集成测试：启动二进制，用临时目录中的假 ffmpeg/ffprobe（LYCORE_FFMPEG_DIR）测试 core.hello / media.probe / encoder.detect
```

Node 客户端助手位于 `client/index.js`（CommonJS，无依赖）：`connectRetry(endpoint)` 返回带 `call` / `hello` / `close` 的对象。

解析器的单元测试使用 `src/fixtures/` 下的 ffprobe/ffmpeg 输出样本。
