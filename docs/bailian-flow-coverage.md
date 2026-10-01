# 百炼全流程覆盖审计

范围：故事 -> 脚本/分镜 -> 首帧图（带角色参考图）-> 旁白 TTS -> 视频（文生视频、首帧生视频）-> 字幕 -> 时间线 -> 导出。服务商只看阿里云百炼（见 `provider-extension.md`，其余服务商默认隐藏）。

状态说明：

| 记号 | 含义 |
|---|---|
| 真实验证 | 用真 Key 跑通过，录制数据在 `packages/local/test/fixtures/bailian/live_*`，来源 `联网验证进度.md` |
| 仅夹具 | 只对着录制或模拟数据测过，没有真 Key 跑过 |
| 缺 | 没有实现，或实现了但没有接进队列/界面 |

先说结论：**适配器层的五个能力里，文本、文生图、图生图（1-4 张参考图）、CosyVoice（含逐字时间戳）、文生视频（wan2.6-t2v）、首帧生视频（wan2.2-kf2v-flash）都已真实验证；流程粘合层大多没有接**。新的持久化队列（`/ai-tasks`，带花费守卫、断点下载、崩溃恢复）只能通过 REST 调用，界面上的出图、出视频按钮走的是原来的同步服务（`services/imageService.js`、`videoService.js`，没有花费守卫、不进任务中心）；队列任务的结果也不会自动写回分镜表。`scripts/bailian-e2e.mjs` 里的“回写分镜”阶段就是在补这段粘合，用真 Key 跑它才能把整条链路坐实。


## 2026-10-01 Windows 真 Key 端到端（11/11 阶段通过）

Jay 在本机 Windows 用真 Key 跑 `scripts/bailian-e2e.mjs`（结果见 `windows-test-results/2026-10-01.md`）：故事->脚本分镜、角色参考图、带参考图的首帧图、CosyVoice 旁白（逐字时间戳 3/3）、文生视频（真实下载 5.77MB）、首帧生视频 x2、回写分镜、时间线+字幕、lycore 导出（final.mp4，15.02 秒）全部通过。估算花费 4.605 元（示例价，以百炼账单为准）。

据此，下面各表里这几项已升级为“真实验证（Windows）”：真实 `video_url` 下载、首帧图带角色参考图的链路、导出（Windows 管道 + lycore，QSV 编码）。仍未验证：`data:` URI 作参考图/首帧、其他音色、`wan2.6-i2v-flash`/`wan2.6-r2v-flash`、~~桌面主进程拉起 lycore~~（已接入，见 Task 1）、托盘/通知。注意这是脚本粘合出来的链路，界面按钮走的仍是旧路径（见上文）。

## 逐步骤覆盖表

| # | 步骤 | 代码路径 | 真实验证的百炼能力 | 仅夹具 | 缺 / 没接上 |
|---|---|---|---|---|---|
| 1 | 故事 -> 脚本/分镜 | `scriptgen/generate.js`（模板、JSON 修复重试、校验）；`services/scriptgenService.js`（`resolveProvider` 从已保存的文本配置取 Key）；`POST /scriptgen/projects`；界面 `NewProject.vue` | 文本：兼容模式聊天 + SSE，`qwen-plus` 跑 10 个样例全部合格（1 个经修复重试）；`qwen-flash` 连通 | 校验器、模板对各样例的修复分支用录制的回复回放 | 产品种草模板偶尔补出素材里没有的话（模型问题，未修）。同步生成，无进度流。文本调用不计入花费，也不走队列。~~角色只写进 `dramas.metadata.characters`~~（I2 已修：同一事务里写 `characters` + `episode_characters` 并初始化项目图，见 kernel-design §11） |
| 2 | 角色参考图 | 新：队列 `kind: image` -> `queue/providerAdapter.js` -> `providers/bailian` `image.generate`。旧：`routes/characters.js` `generate-image` -> `characterGenerationService` -> `imageClient`（DashScope 协议，同步） | `wan2.6-t2i` 文生图；`z-image-turbo` 也可用 | 旧路径的 DashScope 请求体（沿用上游代码，适配器就是照它写的，但旧路径本身没用真 Key 跑过） | 界面按钮走旧路径（无花费守卫、不进任务中心）。队列结果落在 `blobs/` 里，没有任何代码把它写回角色（`characters.image_url`）。向导只建了文本配置，旧路径出图还要另建图像配置；队列路径已改为同一 Key 自动复用 |
| 3 | 首帧图（带角色参考图） | 队列 `kind: image` + `referenceImages` -> `image.generate` 的 `wan2.6-image` 分支。旧：`imageService`（按分镜 `characters` 找角色参考图、base64 内联）-> `imageClient` | `wan2.6-image` 只能带 1-4 张参考图做图生图（不带会报错，已按此写）；参考图用公网 URL | 本地文件作参考图：队列路径现在会把存储目录里的本地图内联成 `data:` URI（本次新增，有单测），百炼是否接受该 data URI 未真实验证；旧路径的 base64 同理 | 没有任何代码根据分镜（`characterIds`、画幅 -> 尺寸、`imagePrompt`）去批量创建首帧图任务；只有 e2e 脚本里有这段粘合。队列结果不回写 `storyboards.image_url`。上限 4 张参考图，多角色镜头超出部分被截掉，无提示 |
| 4 | 旁白 TTS | 新：队列 `kind: tts` -> `tts.synthesize`（CosyVoice，WebSocket，`wordTimestamps`）；`voiceover/index.js` 的 `voiceShots` 逐镜配音并切字幕 | `cosyvoice-v2` + `longxiaochun_v2`，逐字时间戳（毫秒），2 条分镜实测字幕与语音误差 <= 1 帧；鉴权失败、模型不存在的错误映射；必须 terminate 连接否则残留约 2 分钟（已处理） | 音色清单只有 `longxiaochun_v2` 验证过，其他音色名没试 | ~~`voiceShots` 没有被任何路由调用~~（I2 已接：`POST /episodes/:id/voiceover`，估价后确认，直接走 provider 门面，成功后经内核 recordGeneration 写回，时间线编辑器有“旁白配音”抽屉，见 kernel-design §11；仍不进队列/任务中心）。旧的 `ttsService` 只支持 MiniMax 和 OpenAI 兼容，不认 CosyVoice，旧的旁白后处理（`narrationVideoPostProcess`）因此用不了百炼。队列的配音结果（音频 blob + 时间戳 blob）不回写 `narration_audio_local_path`。角色 -> 音色没有界面。台词比镜头长时只返回 `overrunMs`，没有人处理。队列以前要求单独的 tts 配置，一键配置通义也不建，现在改为复用同一 Key |
| 5 | 视频：文生视频 | 队列 `kind: video` -> `video.submit` / `video.poll`（异步任务 + 轮询）-> 下载到 `blobs/`；旧：`videoService` -> `videoClient`（DashScope 协议） | `wan2.6-t2v` 720P 5 秒，任务 PENDING -> SUCCEEDED，用量里带计费时长；任务级失败映射；`video_url` 24 小时过期 | 队列的崩溃恢复、429 退避、断点续传下载（模拟数据）；`video.submit` 对非法参数也会先建任务，所以不能“免费”测参数 | **下载真实 `video_url` 没有验证**：云端沙箱访问不了 OSS 域名，只有用户电脑上才能验证；24 小时内必须下完。`resolution` 参数对文生视频不生效（尺寸由 `size` 决定），花费估算按 `resolution` 取价，不指定时按默认价。5 秒以外的时长、480P 文生视频尺寸没验证。没有路由或界面批量创建视频任务，队列结果不回写 `storyboards.video_url` |
| 6 | 视频：首帧生视频 | 同上，`model: wan2.2-kf2v-flash`，`firstFrameUrl`（尾帧缺省等于首帧） | `wan2.2-kf2v-flash` 480P 5 秒，首帧用公网 URL | `wan2.6-i2v-flash`、`wan2.6-r2v-flash` 的请求体（照上游代码写，没跑过）；首帧用 `data:` URI（见第 3 行） | 适配器的尾帧缺省等于首帧（传了 `lastFrameUrl` 才用它）；没有代码把分镜里设的尾帧（`last_frame_*`）填进任务，所以实际总是首尾同帧。队列默认模型现在按请求形态调整（有首帧用 kf2v，没有则文生视频），但界面没有地方选 |
| 7 | 字幕 | `subtitles/index.js`（`splitCues`：按逐字时间戳切分，吸附到整帧；SRT/ASS 输出）；时间线字幕轨 | 逐字时间戳来自真实 CosyVoice；字幕与语音误差 <= 1 帧（2 条真实配音） | 渲染端烧录字幕靠 lycore + libass，Linux 上用合成素材验证 | ~~应用里没有任何地方生成按词对齐的字幕~~（I2 已修：配音写回时把 splitCues 的字幕块存进旁白版本，timelineView 在旁白新鲜时按块出字幕，台词一改退回整镜文字字幕）。旧说明：`assembleFromStoryboard` 只按分镜 `dialogue` 文本生成覆盖整镜的字幕块。词级字幕要靠 `voiceShots` + `splitCues`，目前只有 e2e 脚本把它写进时间线。字幕样式（字体、位置）无界面 |
| 8 | 时间线 | `timeline/service.js`（四轨模型、校验、`assembleFromStoryboard`、切分/裁剪）；`routes/timelines.js`；编辑器 `TimelineEditor.vue` | 无（纯本地逻辑，不涉及百炼） | 单测齐全；与真实 lycore 联测用的是合成素材，没用百炼产出的视频 | ~~装配时镜头时长取分镜的 `duration`~~（I2 已修：内核投影读视频采用版本 `metadata.duration_ms`，没有再退回目标时长；`timeline/kernelAssemble.js` 供旧装配路由改调）。旧说明：百炼视频固定约 5 秒，而分镜常是 6-10 秒，装配出来的片段会超出素材长度（e2e 脚本把 `duration` 改成 5 来规避）。`asset_ref` 必须是本地文件，百炼返回的网络地址要先下载，否则导出报“是网络地址”。编辑器缺波形、缩略图、旁白/音乐播放（F03 已知缺口） |
| 9 | 背景音乐 | `music/`（音乐库：用户导入 + 程序合成的示例配乐）；`POST /timelines/:id/music`；混音（压低、响度）写入时间线 | **百炼没有音乐生成能力**，不存在百炼来源 | 导入、铺满、压低、响度在 Linux 真 lycore + ffmpeg 上验证 | 只能用户自己导入；示例配乐是占位。e2e 脚本不含音乐 |
| 10 | 导出 | `export/service.js` -> lycore `render.start`（场景缓存、AIGC 水印与元数据）；`/export/*`；`ExportPage.vue` | 无（纯本地） | Linux 真 lycore + 真 ffmpeg 联测通过（合成素材）；本次新增的 e2e 模拟测试也用真 lycore 导出了 3 段素材拼出的成片 | 桌面主进程已拉起 lycore 并设置 `LYCORE_ENDPOINT`，ffmpeg 随包内置；打包版经接口实测导出成功。Windows 管道、硬件编码器、取消需 Windows 真机 |
| 横切 | 花费守卫与估算 | `spend/index.js`；`/ai-tasks` 创建时 `check`，队列提交时再 `guardTask`；`SpendPage.vue` | 价格表里的模型名与真实验证过的模型一致 | 守卫的上限逻辑有完整单测 | 价格表是**示例价**。`spend_log.actual` 永远为空：任务结果里的用量（视频计费时长、配音字数）被丢弃，实测花费只能是估算。旧的同步出图/出视频不过守卫。界面没有“提交前花费确认”弹窗，`/spend/estimate` 没人调 |
| 横切 | 错误映射 | `providers/bailian` 的 `mapError`；`providers/errors.js` | 无效 Key（含 WebSocket 握手无状态码，靠探测 `/models` 区分）、模型不存在、任务级失败 | 余额不足、模型未开通的错误字符串按公开文档匹配，当前 Key 无法触发 | — |
| 横切 | 连通测试与向导 | `providers.probe`（C05，百炼已真实验证，图像、视频零费用）；向导 `Onboarding.vue` + `onboardingService` | 探测本身已真实验证 | 向导的“连通测试”调的是旧的 `aiConfigService.testConnection`，不是 `providers.probe`，所以真 Key 联通未验证 | 向导只创建一份文本配置；图像/视频/配音依赖队列的“同一 Key 复用”才能工作，旧路径仍需手动加配置 |

## 汇总

| 步骤 | 真实验证 | 仅夹具 | 缺 |
|---|---|---|---|
| 1 脚本/分镜 | 文本 `qwen-plus` | 修复重试分支 | 角色未入库、无进度流 |
| 2 角色参考图 | `wan2.6-t2i`、`z-image-turbo` | 旧路径请求体 | 结果不回写角色、界面走旧路径 |
| 3 首帧图（带参考图） | `wan2.6-image`（1-4 张 URL 参考图） | 本地图内联 data URI | 没有按分镜批量建任务的代码 |
| 4 旁白 TTS | CosyVoice + 逐字时间戳 | 其他音色 | `voiceShots` 未接入任何路由/界面；旧 TTS 不认百炼 |
| 5 文生视频 | `wan2.6-t2v` 720P 5 秒；真实视频下载（Windows，5.77MB） | 崩溃恢复、续传下载 | 无批量建任务 |
| 6 首帧生视频 | `wan2.2-kf2v-flash` 480P 5 秒 | `wan2.6-i2v-flash`、`wan2.6-r2v-flash`、data URI 首帧 | 分镜尾帧没有传给任务 |
| 7 字幕 | 逐字时间戳切分（2 条真实配音） | libass 烧录（合成素材） | 应用内不生成词级字幕 |
| 8 时间线 | — | 全部（本地逻辑） | 装配时长与视频实际时长不一致 |
| 9 背景音乐 | — | 导入/混音 | 百炼无来源，只能用户导入 |
| 10 导出 | Windows 真 lycore 导出 15 秒成片（e2e 脚本里单独起 lycore） | Linux 真 lycore | 桌面主进程已启动 lycore（打包版接口实测导出通过） |

## 本次顺手修的小接线问题（均有测试）

1. **只存了文本配置也能跑图像/视频/配音**：`queue/providerAdapter.js` 新增 `pickSharedKeyConfig`。首次引导向导只建一份文本配置，原先队列任务因找不到 image/video/tts 配置而报“未配置 Key”。现在同一服务商下任意已启用且有 Key 的配置都能借用，但**不借用它的模型名**（方舟语音的 Token 是独立凭据，不借用）。
2. **默认模型与请求形态不匹配**：一键配置通义把图像默认模型设成了 `wan2.6-image`，而它必须带参考图，所以不带参考图的文生图任务会直接报“需要 1-4 张参考图”。`modelFitsRequest` 在没有参考图时让适配器自己选 `wan2.6-t2i`；视频同理（没有首帧不用 kf2v / i2v，有首帧不用 t2v）。显式传入的 `params.model` 不受影响。
3. **本地图片当参考图/首帧**：`inlineLocalMedia` 把存储目录里的本地图（相对路径、`/static/…`、目录内绝对路径）内联成 `data:` URI（按文件头判断类型，上限 10MB，目录外的路径不读）。任务表里仍存路径，不存 base64。
4. 模型目录映射：AI 配置里的 `dashscope` 与目录里的 `bailian` 对不上，目录补充模型原先永远空；现在 `SceneModelMap` 通过开关接口的别名表映射。
5. 适配器里一条过时注释（“CosyVoice 报文 UNVERIFIED”）改为已验证。

## 没改、需要另行排期的缺口

- 把队列接进界面：出图、出视频、配音都应该走 `/ai-tasks`（花费守卫、任务中心、断点恢复），并在任务完成时写回分镜、角色。
- ~~`scriptgen` 持久化写角色表~~、~~词级字幕与旁白写回~~、~~装配用视频实际时长~~：I2 已做（旧 `/timelines/episode/:id/assemble` 路由改调 `assembleFromKernel` 由 I3 接）。
- 配音还没进队列/任务中心；`spend_log.actual` 仍为空；其余音色未实测。
- ~~把队列接进界面（出图、出视频）~~ **I1 已做**：`POST /episodes/:id/generate`（先估算、再确认建任务、首帧图完成后自动接着出视频）+ `GET .../generation/status`，任务成功后写回内核并物化旧列，真实时长写进视频版本 `meta.duration_ms`；分镜表与镜头工作台已改用，旧同步按钮在 `generation.legacy_enabled` 之后。**仍缺**：配音走队列并写回、角色参考图结果回写角色、时间线装配改用 `meta.duration_ms`（`timeline/service.js` 由别的任务负责）。
- `scriptgen` 持久化时写角色表，让角色库和参考图锁定可用。
- 调用 `voiceShots` + `splitCues`，把词级字幕和旁白音频写进分镜与时间线；装配时用视频实际时长。
- 把任务结果里的用量写入 `spend_log.actual`。
- 向导的连通测试改用 `providers.probe`。
- 真 Key 跑 `scripts/bailian-e2e.mjs`，验证真实视频下载、data URI 首帧、完整导出；跑完把本表“仅夹具”相应项更新为真实验证。
