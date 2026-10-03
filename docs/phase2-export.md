# P2-E 导出到剪映 / Premiere / FCPXML 与平台尺寸预设

状态：云端会话完成并通过自动化测试；**三种工程文件都没有在真实的剪映、Premiere、Final Cut 里打开过**，见“必须真机验证的清单”。

## 1. 结构

| 位置 | 作用 |
|---|---|
| `packages/local/src/export/exporters/` | 纯函数导出器，零网络、零文件系统：`jianying.js`、`xmeml.js`、`fcpxml.js`、`presets.js`、`paths.js`、`common.js` |
| `packages/local/src/export/mediaExport.js` | 服务层：读内核 `timelineView`（只读）、解析素材路径并校验、调用导出器、写目录 |
| `packages/local/src/routes/export.js` | `POST /export/jianying`、`POST /export/fcpxml`（不依赖渲染核心 lycore，核心没启动也能用） |
| `apps/renderer/src/views/ExportPage.vue`、`utils/exportJob.js` | 尺寸预设下拉与“导出到剪映 / Premiere”面板（2026-10-03：`ExportPage.vue` 已随四视图统一改为导出对话框，由导出菜单或时间线页的「导出」打开。） |
| `packages/local/test/exportMedia.test.js` | 3 个样例项目的结构断言（见第 6 节） |

输入是 `kernel.timelineView(graph)` 的投影：`video / subtitle / narration / music` 四轨，毫秒整数，素材 `asset_ref` 在服务层被转成本机绝对路径。导出不写图、不改内核语义（测试里断言导出前后图快照与日志不变）。

## 2. REST

两个接口的请求体相同：

```json
{
  "episode_id": 5,
  "output_dir": "D:\\导出 文件夹",
  "name": "第一集",
  "preset": "douyin-9x16",
  "width": 1080, "height": 1920, "fps": 30,
  "overwrite": false,
  "dry_run": false
}
```

- `preset` 与 `width/height/fps` 二选一（给了 `preset` 就用预设的尺寸与帧率）；都不给则 1920×1080、30 fps。
- `name` 缺省取剧集标题，再缺省 `episode-<id>`；非法文件名字符替换为 `_`，中文和空格保留。
- `/export/fcpxml` 另有 `format`：`xmeml`（默认，Premiere）或 `fcpxml`。
- `dry_run: true`：做完全部校验与估算（片段数、字幕数、会写哪些文件、警告），不写任何文件。界面上是“仅检查素材”。
- 产物写入 `<output_dir>/<name>/`（剪映）、`<output_dir>/<name>_premiere/`（xmeml）、`<output_dir>/<name>_fcpxml/`（fcpxml）。每个文件先写 `.tmp` 再改名。已有同名文件时返回 409，`overwrite: true` 才覆盖（只覆盖本次要写的文件名，不删文件夹里别的东西）。

返回：`{ format, name, output_dir, files, stats, warnings, width, height, fps, written }`。

### 错误码（已加入 `packages/local/src/errors/error-codes.json`，`errorCodes.test.js` 通过）

| 码 | HTTP | 含义 |
|---|---|---|
| `EXPORT_ASSETS` | 400 | 素材文件不存在 / 是网络地址 / 路径越界；`details.problems[]` 列出每个片段（`clip_id`、`storyboard_id`、`asset_ref`、`error: missing|remote|outside`）。此码原先只在代码里使用、没进错误码表，这次补进 |
| `EXPORT_MEDIA_NOT_GENERATED` | 400 | 视频轨上有镜头还没有生成视频或图片 |
| `EXPORT_NO_TIMELINE` | 404 | 剧集没有项目图或视频轨为空 |
| `EXPORT_BAD_FORMAT` | 400 | 预设不存在、宽高不是 320–7680 的偶数、帧率不是 1–120 的整数、格式名未知 |
| `EXPORT_BAD_OUTPUT_DIR` | 400 | 目录为空 / 不是绝对路径 / 含控制字符 / 指向一个文件 |
| `EXPORT_OUTPUT_EXISTS` | 409 | 同名文件已存在 |
| `EXPORT_WRITE_FAILED` | 500 | 写盘失败（权限、空间） |

缺文件优先于“未生成”报告，且任何校验失败都不会写出半成品。

### 路径含中文和空格

- 素材路径用 `resolveAssetRef`（与渲染导出同一套），支持相对存储根、`/static/…`、同机 URL、绝对路径，拒绝 `..` 越界和远程地址。
- 剪映草稿里保持原始 Unicode，Windows 反斜杠改正斜杠。
- xmeml / FCPXML 的 `file://localhost/…` URL 逐段 UTF-8 百分号编码，盘符冒号编码为 `%3A`；UNC 路径单独处理。
- 输出目录用 `path.join`，不拼接 shell 命令，所以中文和空格不需要转义。

## 3. 尺寸预设

| key | 平台 | 尺寸 | 帧率 | 建议码率 |
|---|---|---|---|---|
| `douyin-9x16` | 抖音 | 1080×1920 | 30 | 8000 kbps |
| `shipinhao-3x4` | 视频号 | 1080×1440 | 30 | 8000 kbps |
| `shipinhao-9x16` | 视频号 | 1080×1920 | 30 | 8000 kbps |
| `landscape-16x9` | 通用横屏 | 1920×1080 | 30 | 10000 kbps |

接入方式：`GET /export/options` 多返回 `platform_presets`；界面把它们并入分辨率下拉（“平台预设”分组），选中预设时帧率一并切换，`POST /export/start` 仍然只收 `width/height/fps`，所以渲染接口未改。

**码率只是建议值，没有真正生效**：lycore 目前只用 CRF（libx264 crf 20），不接受码率参数，我没有改渲染核心（超出本包范围，也会动渲染缓存键）。建议码率来自常见平台经验，不是各平台官方硬性要求，发布前以平台后台说明为准。如果要让码率生效，需要 `packages/core` 加 `-b:v/-maxrate` 并升 `RENDERER_VERSION`。

## 4. 格式说明

### 4.1 剪映草稿（`jianying.js`）

**依据**：剪映没有官方草稿规范。实现依据我所知的社区公开逆向结构（pyJianYingDraft 一类开源项目描述的“未加密、5.x 时代”的 `draft_content.json` / `draft_meta_info.json`），字段取 `new_version: "110.0.0"`、`version: 360000`、`app_version: "5.9.0"` 这一代。我没有在任何剪映版本里验证过输出。

写出的文件：`draft_content.json`、`draft_meta_info.json`、`draft_virtual_store.json`、`draft_agency_config.json`、`key_value.json`、`timeline_layout.json`。

内容映射：

- 时间单位：草稿内部是微秒，`µs = ms × 1000`。
- 视频轨 1 条（`type: video`）；旁白、音乐各 1 条音频轨（`type: audio`，`name` 为 `narration` / `music`）；字幕 1 条文本轨（`type: text`）。没有的轨不生成。
- 每个时间线片段一个 segment：`target_timerange`（时间线位置）与 `source_timerange`（素材内取值，对应裁剪）。图片素材用 `type: photo`，素材内起点为 0。
- 素材按路径去重，一个路径一份 material；视频进 `materials.videos`，音频进 `materials.audios`，字幕进 `materials.texts`（`content` 是 JSON 字符串，含文字、颜色、字号）。每个 segment 带 `speeds / canvases / sound_channel_mappings / vocal_separations` 的 `extra_material_refs`。
- 所有 id 是由内容派生的大写 UUID，同样输入两次导出逐字节相同。
- 字幕位置：`clip.transform.y = -0.8`（画面下方）。词级字幕块已经是多条字幕片段，原样导出。

**哪些字段是推测（真机必须核对）**：

1. 整体能否被剪映当前版本识别。**剪映 6.0 起官方客户端会加密保存 `draft_content.json`**，较新版本是否仍能读取明文草稿、是否要求特定版本号，我无法确定；很可能新版本打开明文草稿会失败或提示版本不兼容。
2. `new_version`、`version`、`app_version`、`app_id: 3704`、`app_source: "lv"` 的取值与是否被校验。
3. `draft_meta_info.json` 的素材清单格式：`draft_materials[0].value[]` 里 `file_Path`（注意大小写）、`metetype`（`video`/`photo`/`music`，拼写沿用社区写法）、`roughcut_time_range` 等；`draft_root_path` 只写了导出目录，剪映是否要求它等于草稿根目录未知。
4. 路径分隔符：Windows 下用正斜杠 `D:/…` 是否被接受（我认为是，未验证）；macOS 路径原样。
5. 文本素材 `content` 的样式结构、`font_size` 单位（剪映字号不是像素）、`text_color`，以及字幕 `y = -0.8` 的坐标约定。
6. `render_index`（字幕写 14000）、`track_render_index` 的取值是否影响层级显示。
7. 音频 material 的 `type: "extract_music"`、`duration` 必须等于真实时长吗（见下“素材时长”）。
8. 缺少 `draft_cover.jpg` 时草稿列表是否正常显示（封面没生成）。
9. 剪映草稿目录位置：用户需要把生成的文件夹手动放进剪映的草稿目录（默认在 `…\JianyingPro Drafts\`，路径随版本、安装方式不同），剪映才会在草稿列表里出现；是否需要重启剪映、是否需要 `root_meta_info.json` 里登记也未验证。

### 4.2 Premiere：为什么选 xmeml（`xmeml.js`）

选 **xmeml（Final Cut Pro 7 XML，version 4）**，不是 FCPXML。理由：Premiere 的“文件 > 导入”原生支持 xmeml `.xml`；FCPXML（`.fcpxml`，FCP X 的格式）Premiere 不原生支持，需要第三方转换工具。FCPXML 仍作为可选格式提供，给 Final Cut / DaVinci Resolve 用（`format: "fcpxml"`，版本 1.9）。

- 时间单位：帧，`timebase = fps`，`ntsc FALSE`（只支持整数帧率，界面的 24/25/30/60 都是）。起点与终点各自四舍五入成帧再相减，所以投影里首尾相接的片段在帧上也无缝。
- 视频 1 轨；旁白、音乐各 1 条音频轨（立体声，素材音量不是 1 时写 Audio Levels 滤镜）。同一素材只定义一次 `<file>`，之后以 `<file id=…/>` 引用。
- 字幕不写进 xmeml / FCPXML，而是随工程附带 `subtitles.srt`（UTF-8，毫秒 `HH:MM:SS,mmm`）。理由：xmeml 的文字生成器在 Premiere 里很脆弱，SRT 导入成字幕轨最稳。需要手动导入并拖上时间线。
- FCPXML 的结构：spine 里一个覆盖全长的 gap，所有片段作为 gap 的连接片段（lane 1 视频，-1 旁白，-2 音乐）。这是为了让 offset 直接等于序列时间；剪辑上视频不在主故事线，在 FCP 里是“连接片段”。

**哪些细节是推测（真机核对）**：

1. Premiere 对 xmeml 元素的容忍度：`<pathurl>` 用 `file://localhost/C%3A/…`（盘符冒号编码为 `%3A`，Premiere 自己导出是小写 `%3a`，推测大小写不敏感）；`premiereChannelType="stereo"`、`sourcetrack` 的写法；视频素材 `<file>` 里没有写音频 `<media><audio>`，意味着视频素材自带的声音不会被导入（AI 生成视频通常用旁白轨，这是有意的取舍）。
2. 图片素材：`<duration>` 取 10800 秒（3 小时）并按普通视频素材写，没有 `stillframe` 标记，Premiere 可能把它当成视频文件而非静帧，或提示媒体时长。
3. 素材时长：导出器拿不到素材真实时长（不调 ffprobe，保持纯函数），用“时间线用到的最大 `src_out`”近似作 `<file><duration>`。真实素材更长时无影响，但如果素材其实比用到的更短（不应出现），会超出。后续可以让服务层探测时长后经 `mediaDurations` 传入，导出器已支持该入参。
4. FCPXML 1.9：`asset` 的 `src` 属性写法（1.10 起改 `media-rep`）、`tcFormat`、`colorSpace` 字符串、gap 上连接片段的 lane 约定、`adjust-volume` 的 dB 换算，均未在 Final Cut / DaVinci 里验证。

### 4.3 共同的信息损失（三种格式都一样）

- **转场不导出**，每个有转场的片段给一条警告。剪映转场需要素材库资源 id，xmeml/FCPXML 转场需要效果 uid，内核里只存了转场名字符串，没有可靠映射。
- 字幕样式：只带文字、时间；剪映额外带 `size` 与 `color`，其余样式（描边、字体）不导出。
- 视频素材的原声、画面运动（缩放/位移）：内核里没有，不导出。
- 旁白/音乐的淡入淡出、混音与闪避设置（`settings.mix`）：不导出。
- 渲染时叠加的“AI生成”水印与元数据标识：**不会出现在工程里**（它们是导出渲染阶段加的）。在剪映/Premiere 里重新渲染成片时，**发布者需要自己重新加上 AI 生成标识**，标识义务见 `docs/aigc-marking.md`。这一点界面上还没有提示，建议后续在导出面板加一行说明。

## 5. 已知限制与没做的事

- 没有真机验证（见下一节），尤其剪映草稿，可能完全打不开。
- 码率预设不控制实际码率（见第 3 节）。
- 不探测素材真实时长；不复制素材（工程引用原文件路径，素材被移动/删除后需重新链接）。
- 只导出当前内核时间线的最终状态；不导出多条备选时间线或版本历史。
- 不支持非整数帧率（29.97 等）。
- 界面只做了导出入口与预设，没有做导出后的“打开所在文件夹”（现有 `open-folder` 接口按渲染任务 id 工作，不适用）。
- 没有改 `apps/desktop`、没有改渲染核心、没有改内核。

## 6. 测试

- `packages/local/test/exportMedia.test.js`：预设、路径转换、时间换算、3 个样例项目 × 3 种格式的结构断言、服务层写盘与错误码、REST 路由。
- 3 个样例都由 `packages/kernel/test/helpers.js` 的确定性故事夹具（手写，非真实 AI 输出）加编辑构造：
  1. 「雨夜」：4 镜头、整段视频、旁白、1 条音乐；
  2. 「剪辑过」：切分、裁剪、gap、转场、仅有图片的镜头、词级字幕、2 条重叠音乐，24 fps；
  3. 「特殊字符」：删一个镜头、字幕含 `& < > " '`、竖屏 1080×1920、工程名含 `/ 空格`。
- 断言内容：轨道数；每个片段的起点与时长（剪映按微秒，xmeml/FCPXML 按帧，逐条对照投影）；素材内裁剪起点；字幕条数与文字（剪映 `texts`、SRT）；总时长；素材路径转换（剪映路径、xmeml 解码后的 `pathurl`、FCPXML `src`）；素材去重；id 唯一且引用完整；同输入两次输出相同。
- XML 用 `packages/local/test/helpers/xmlLite.js` 校验良构。仓库没有 XML 依赖，也不为测试新增依赖，所以写了一个严格的小解析器（单根、标签配对、属性带引号且不重复、实体合法、无裸 `<`/`&`、无非法控制字符）。它只检查良构，**不检查是否符合 xmeml / FCPXML 的 DTD**。
- `apps/renderer/test/exportJob.test.js`：预设兜底与后端一致（防漂移）、请求体构造、表单校验。

## 7. 必须真机验证的清单

1. **剪映（最新版，Windows 和 macOS 各一次）**：把导出的文件夹放进剪映草稿目录，能否出现在草稿列表、能否打开；时间线上视频、旁白、音乐、字幕是否都在且对齐；素材是否显示为“已链接”而非“素材丢失”；字幕位置与字号；中文和空格路径下是否正常。若新版剪映不识别明文草稿，需要决定替代方案（例如只支持固定的旧版本剪映，或改为导出 xmeml/素材包让用户手动导入）。
2. **Premiere（最新版）**：导入 xmeml，序列尺寸与帧率是否正确；视频衔接有无缝隙；旁白与音乐位置、音量；素材是否自动链接（路径含中文和空格）；图片镜头的表现；`subtitles.srt` 能否导入为字幕轨。
3. **Final Cut Pro / DaVinci Resolve**：导入 `.fcpxml`，连接片段的 lane 与偏移是否正确。
4. **平台上传**：抖音、视频号实际上传 1080×1920、1080×1440 的成片，确认比例和清晰度，确认建议码率是否合适（并确认码率是否需要真正控制）。
5. **Windows 路径**：`D:\我的 项目\素材 1.mp4`、UNC 路径、含 `#`、`%`、`&` 的文件名，在三种格式里是否都能被软件正确定位。自动化测试只在 Linux 上跑，Windows 路径是纯字符串转换的单元测试，没有在 Windows 上端到端跑过。
