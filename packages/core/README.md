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
| `licence.status` | 已实现 | 校验 ES256 JWT 授权令牌，见下文 |
| `media.probe` | 已实现 | 调用 ffprobe 解析媒体信息 |
| `encoder.detect` | 已实现 | 检测 H.264 编码器可用性并给出推荐顺序 |
| `render.plan` | 已实现 | 将时间线拆分为场景，计算确定性 sceneKey 并检测缓存命中 |
| `render.start` | 已实现 | 异步渲染任务，返回 `jobId`；进度通过 `render.status` 轮询或 `render.progress` 通知 |
| `render.status` | 已实现 | 查询任务状态/百分比/结果/错误 |
| `render.cancel` | 已实现 | 取消任务并终止 ffmpeg 子进程 |

### licence.status

参数：`{"token":"<JWT>","jwks":{"keys":[...]}`（或单个 `"publicKey":{JWK}`）`,"graceDays":14（可选）,"issuer":"（可选）","nowSec":（可选，覆盖当前时间）}`。公钥由客户端从云端 `/.well-known/licence-jwks.json` 取得并缓存后传入，lycore 不联网。

只接受 `alg=ES256`（拒绝 none/HS256）；头部有 `kid` 时必须在 JWKS 中匹配，无 `kid` 则逐个尝试。声明字段：`sub`、`did`、`plan`、`entitlements`、`graceDays`、`exp`、`iss`（云端 `licence.service.ts`），另支持可选 `nbf`。

`result`：`{"valid":bool,"plan":"test"|null,"expires":"ISO8601 UTC"|null,"reason":"...","expiresAt","graceEndsAt","entitlements","accountId","deviceId"}`。

| reason | valid | 含义 |
| --- | --- | --- |
| `ok` | true | 未过期 |
| `grace` | true | 已过 `exp` 但在离线宽限期内（宽限天数：参数 `graceDays` > 令牌 `graceDays` > 默认 14） |
| `expired` | false | 超出宽限期 |
| `not_yet_valid` | false | `nbf` 在未来 |
| `bad_signature` / `unknown_kid` / `unsupported_alg` / `malformed` / `missing_exp` / `issuer_mismatch` / `no_token` | false | 校验失败；不抛 RPC 错误 |

缺少 `jwks`/`publicKey` 返回 -32602。

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
| -32030 | ffmpeg 缺少 libass 的 `subtitles` 滤镜，无法烧录字幕；`error.data` 含 `recoverable:true`、`action:"reinstall"` |
| -32031 | 素材文件缺失；`error.data.missingAssets` |
| -32032 | 渲染失败（所有编码器均失败）；`error.data.attempts`、`stderr` |
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

## 渲染（render.start / render.status / render.cancel）

### render.start

参数：`{"timeline":{...}, "output":{"width","height","fps","encoder"}, "cacheDir":"...", "outputPath":"...mp4", "ffmpegDir":"（可选）", "hashContent":false, "fallbackEncoders":["（可选）"], "mix":{"loudnorm":true,"ducking":{"enabled":true,"gain":0.25,"rampMs":200}}}`。`width`/`height` 必须为偶数。参数无效返回 -32602，ffmpeg 缺失返回 -32020；校验通过后**立即**返回 `{"jobId":"job-..."}`，渲染在后台进行。

`render.status`（`{"jobId"}`）与 `render.progress` 通知（无 `id` 的 JSON-RPC 通知，`params` 与 status 结果相同）的载荷：

```json
{"jobId":"job-..","status":"queued|running|done|failed|cancelled","percent":42.5,"stage":"segment 2/3|final|done","encoder":"libx264","attempt":1,
 "error":null,"result":{"outputPath","durationMs","encoder","scenesTotal","scenesRendered","scenesCached","attempts":[],"elapsedMs"}}
```

`percent` 来自 ffmpeg `-progress pipe:1` 的 `out_time_us`：按时长加权，各待渲染场景占其时长，最终合成占总时长的 30%；运行中最大 99.5，完成时为 100。通知在百分比变化 ≥0.5 或阶段/状态变化时发送，终态必发。`render.cancel`（`{"jobId"}`）→ `{"jobId","status","cancelRequested"}`；取消会 kill 正在运行的 ffmpeg 子进程，清理临时文件，状态变为 `cancelled`；对已结束任务是无操作。未知 `jobId` 返回 -32602。

### 流水线

1. 内部调用与 `render.plan` 相同的规划（`plan()` 的每个 scene 额外带 `detail`：真实素材路径、裁剪、音量、字幕、旁白，**不参与 sceneKey**），素材缺失直接失败（-32031，不重试）。
2. 对 `toRender` 中每个场景运行一次 ffmpeg，输出**统一参数**的片段：所选 H.264 编码器、输出分辨率与帧率、`yuv420p`、AAC 48kHz 立体声 192k、`-video_track_timescale 90000`。视频按 `src_in`/时长裁剪，`scale…force_original_aspect_ratio=decrease` + `pad` 居中黑边，素材过短时 `tpad` 复制末帧补足；图片素材（`asset_kind:"image"`）循环为静态画面；视频原声乘 `volume`；旁白经 `atrim`/`adelay`/`volume` 与原声 `amix`（`normalize=0`）混合；空隙场景为黑画面 + `anullsrc` 静音。写入 `<cache>/<sceneKey>.<jobId>.tmp`（`-f mp4`），成功后原子 `rename` 为 `<cache>/<sceneKey>.mp4`，失败/取消时删除临时文件。
3. 字幕：用字幕片段生成 ASS 文件（场景相对时间；PlayRes 等于输出分辨率）并以 libass `subtitles` 滤镜烧录。ASS 文件放在任务临时目录，ffmpeg 以该目录为工作目录，滤镜只引用相对文件名，避免 Windows 盘符/反斜杠转义问题。样式字段（均可选，对象或 JSON 字符串）：`font`（默认 Arial）、`size`（输出像素，默认高度/18）、`color`/`outlineColor`（`#RRGGBB`）、`outline`、`bold`、`position`（`bottom|middle|top`）、`marginV`。若 ffmpeg 无 `subtitles` 滤镜（`ffmpeg -filters` 检查）返回 -32030。
4. 合并：concat demuxer（`-f concat -safe 0`，视频 `-c:v copy`）读取所有场景片段（命中缓存与新渲染的混合）。音乐轨只在此阶段混一次：每个音乐片段 `atrim`/`volume`（已含轨道音量）/`adelay` 后 `amix`，再对旁白时间段做**音量自动化闪避**（`volume='…':eval=frame`，闪避到 `ducking.gain`，默认 0.25，两端 `rampMs` 渐变，重叠的旁白区间先合并；选择音量自动化而非 sidechaincompress，是因为各场景音频已混合成单一轨道，无法单独取出旁白作侧链），然后与场景音频 `amix`，最后 `loudnorm=I=-16:TP=-1.5:LRA=11`（单遍；`mix.loudnorm:false` 可关闭）。输出先写 `<outputPath>.<jobId>.tmp` 再原子 `rename` 到 `outputPath`。
5. 编码器与重试：先用请求的 `output.encoder`；ffmpeg 非零退出时**同一编码器重试一次**，仍失败则按 `fallbackEncoders`（缺省为 `encoder.detect` 的 `recommended` 顺序）换下一个编码器并整体重渲（编码器属于 sceneKey，因此回退后会重新生成片段），`libx264` 始终排在最后。全部失败返回 -32032（`error.data.attempts` 记录每次失败的 stderr 末尾）。取消、素材缺失、-32030、ffmpeg 缺失不重试。

说明：片段统一编码保证 concat 流拷贝可用；片段 AAC 拼接处可能存在极短的静音间隙，最终音频会重新编码并整体 loudnorm。

## 开发与测试

```
cd packages/core
cargo build --release
cargo test
node client/test.js   # 集成测试：启动二进制，用临时目录中的假 ffmpeg/ffprobe（LYCORE_FFMPEG_DIR）测试 core.hello / media.probe / encoder.detect / render.*
```

Node 客户端助手位于 `client/index.js`（CommonJS，无依赖）：`connectRetry(endpoint)` 返回带 `call` / `hello` / `close` 的对象。

渲染测试（`src/render/tests.rs`）：参数构造为纯函数单元测试；若 PATH 上有真实 `ffmpeg`/`ffprobe`（需含 libass），则用 lavfi 生成素材做端到端渲染、缓存命中、编码器回退测试，否则自动跳过；另有记录参数的假 ffmpeg 脚本（仅 unix）测试重试/回退顺序、原子重命名与取消。

客户端：`renderStart(params)` / `renderStatus(id)` / `renderCancel(id)` / `renderWait(id, onProgress)` / `onNotification(fn)`。

## 进程守护（桌面主进程）

`client/supervisor.js`（经 `require('@talekiln/core').createSupervisor` 导出）：

```js
const sup = createSupervisor({ bin, endpoint, logDir, env: { LYCORE_FFMPEG_DIR }, maxRestarts: 5,
  backoff: { baseMs: 500, factor: 2, maxMs: 30000 }, healthIntervalMs: 5000, healthFailures: 3 });
sup.on('restart', ({ attempt, delayMs, reason }) => {});
sup.on('failed', ({ restarts, reason }) => { /* 超过上限：提示用户，不再重试 */ });
await sup.start();            // 首次 core.hello 成功后 resolve；超过重启上限则 reject
await sup.call('media.probe', { path });
await sup.stop();             // 关连接 -> SIGTERM（Windows 为终止进程）-> 超时强杀
```

- 状态：`stopped → starting → running → backoff → starting …`，超过 `maxRestarts` 进入 `failed`；`stop()` 经 `stopping` 回到 `stopped`。
- 健康探测：每 `healthIntervalMs` 调一次 `core.hello`（超时 `healthTimeoutMs`），连续 `healthFailures` 次失败视为挂死，杀掉后走重启。
- 退避：第 n 次重启前等待 `baseMs * factor^(n-1)`，上限 `maxMs`；稳定运行超过 `resetAfterMs`（默认 60 秒）后计数清零。
- 重启后 RPC 连接会重建，进行中的调用以 `connection closed` 失败，渲染任务需由上层按 `jobId` 重新发起。
- 测试：`client/supervisor.test.js`（假子进程 + 假连接）、`client/supervisor.integration.test.js`（真实二进制，强杀后恢复）。

## ffmpeg 供应

`client/ffmpeg-provision.js`：`provision({ appDataDir, baseUrl? })` 把 LGPL 构建的 ffmpeg/ffprobe 下载到 `<appDataDir>/ffmpeg/<版本>/`，按 `ffmpeg-manifest.json` 里固定的 SHA-256 校验，支持断点续传，不一致即拒绝；返回目录用作 `LYCORE_FFMPEG_DIR`。默认下载地址是占位值，须由 `baseUrl` 或环境变量 `LYCORE_FFMPEG_BASE_URL` 配置；清单现为 TODO 占位，填入真实值前会直接拒绝。LGPL 合规与声明文本见 `docs/ffmpeg-lgpl.md`。测试：`client/ffmpeg-provision.test.js`。

解析器的单元测试使用 `src/fixtures/` 下的 ffprobe/ffmpeg 输出样本。
