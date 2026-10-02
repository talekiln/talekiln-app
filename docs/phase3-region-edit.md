# P3-R 选镜改片

对一个镜头**已采用**的视频，框一个时间段（入点 / 出点）和一块画面区域，用一句话说明要改成什么，只重做这一段；结果作为该视频节点的**新版本**入图，旧版本保留，A/B 对比后再决定采用。估价只按重做的那一段算，比整镜重做便宜。

分支 `p3-region-edit`。涉及：`packages/kernel`（意图）、`packages/local`（迁移 29、服务、路由、能力位）、`packages/plugin-sdk`（能力常量）、`apps/renderer`（分镜工作台）。

## 1. 做了什么

### 内核（packages/kernel）

- video 节点新增可选参数 `edit`（`NODE_PARAM_RULES.video.edit`，校验见 `graph.js` 的 `checkEdit` / `normalizeRect`）：
  `{ base: <采用的版本 id>, mode: 'region'|'segment', t0_ms, t1_ms, rect: {x,y,w,h}（0..1，四位小数）, prompt }`。
  它是节点参数，所以**进 cacheKey**：同一段同一句话 = 同一个 key；换了基准版本（`base`）、入出点、区域或提示词 = 不同的 key；清除 `edit` 后 key 回到整镜生成时的值。
- 意图 `shot.editShotRegion(g, shotId, { t0_ms, t1_ms, rect, prompt, mode })`：校验（有已采用且带资产的视频；`0 <= t0 < t1 <= 片长`，片长取采用版本的 `metadata.duration_ms`，没有则取镜头 `duration_ms`；提示词非空；矩形在画面内；`segment` 模式缺省整幅画面），产出只写 `video.edit` 的事务，`tx.meta = { node, edit }`。效果：该镜头的 video + 合成过期；首帧图、配音、其它镜头不动；可撤销。
- 意图 `shot.adoptShotVersion(g, shotId, { version_id })`：采用某个视频版本，并让 `edit` 参数跟随该版本的 `metadata.edit`（有则写入，没有则清除）。这样采用改片结果后节点新鲜（key 含该 edit），采用回原版本也新鲜（key 回到原值），不会因为切换版本而误报过期。注意：版本历史抽屉里裸的 `adoptVersion` op 不会跟随参数，在改片结果和原版本之间切换时会显示过期；工作台用的是本意图（经 `POST /shots/:id/adopt-version`）。
- REST 白名单（`routes/kernel.js` INTENTS）放行 `shot.editShotRegion`；一致性套件 `roundtrip.test.js` 登记了两个意图的写足迹。

### 本地服务（packages/local）

- 迁移 `migrations/29_edit_regions.sql`：表 `edit_regions`（分集、节点、基准版本、入出点、区域、提示词、模式、策略、任务 id、结果版本 id、状态、估价（分）、错误、时间）。内核侧的事实是版本与参数；这张表只记流程状态。
- 错误码（`errors/error-codes.json`）：`REGION_EDIT_NO_VIDEO`（409）、`REGION_EDIT_BASE_MISSING`（409）、`REGION_EDIT_FFMPEG`（500）。
- 服务 `src/regionEdit/`：
  - `prompt.js` 纯逻辑：整秒换算（重做段向上取整，1..15 秒）、策略选择、降级路径的提示词拼接（“只修改画面上方（约占画面 20%）：…，其余保持不变”）、分换算、拼接时的缩放比例。
  - `ffmpeg.js`：`ffprobe` 探测（时长 / 尺寸 / 帧率 / 有无音轨）、截帧（PNG）、拼接参数构造（纯函数）与执行；可执行路径沿用 `utils/ffmpegPath.js`。
  - `service.js`：`estimate` / `submit` / `listRegions` / `adoptVersion` / `onTaskFinished` / `recoverFinished`。
- 厂商能力位 `video.edit`（`providers/capabilities.js`、`plugin-sdk` 常量与类型，SDK 1.1.0，只加字段）。`queue/providerAdapter.js`：视频任务参数带 `edit` 时走 `facade.video.edit`，否则 `video.submit`；适配器没有该能力时任务失败为可读的 `CAPABILITY_NOT_SUPPORTED`。**百炼 / 方舟都没有实现 `video.edit`**（没有查证到带遮罩的视频编辑模型，不编造模型名），所以现在一律走降级路径。
- 路由（`routes/index.js` 末尾 `// P3-R` 块）：`POST /shots/:id/edit-region`、`GET /shots/:id/edit-regions`、`POST /shots/:id/adopt-version`。`app.js` 把服务挂到队列的 `onTaskFinished`（在生成服务之后），启动时 `recoverFinished()`。

### 渲染进程（apps/renderer）

- 分镜工作台 `ShotWorkbench.vue`：
  - 「选镜改片」面板：片段条（点击定位播放头）、设入点 (I) / 设出点 (O)（取播放头位置）、秒数输入、模式（只改框选区域 / 整段重做）、「框选区域」后在播放器画面上拖出矩形（贴在画面实际显示区域上，黑边不算）、提示词、去抖估算（显示“只改这 N 秒约 ¥x（整镜重做约 ¥y，省 z%）”与策略说明）、「确认改片」、改片记录列表（排队中 / 生成中 / 已完成 / 失败，完成的可一键采用结果）。
  - 版本列表改为**内核版本** V1..Vn（`GET /episodes/:id/versions` 里该镜头的 video 节点项，拿不到时用改片接口附带的那份），改片结果带“改片”标签和入出点 / 区域 / 提示词摘要；A/B 对比与 Alt+1..4 采用都基于内核版本（经 `adopt-version`）。旧流程候选保留在「候选（旧流程）」页签；没有内核版本的项目 Alt+N 仍采用旧候选。
- 快捷键：工作台作用域新增 `shot.markIn`（I）、`shot.markOut`（O）；`buildWorkbenchHandlers` 接入（没传处理函数的页面按 I / O 不报错）。
- 纯逻辑 `utils/regionEdit.js`（矩形归一化 / 拖拽换算 / contain 布局的画面区域、入出点裁剪与互推、整秒计费、费用文案、请求体、改片记录摘要、内核版本的 V 标签 / 默认 A/B / 采用提示）；`api/regionEdit.js`；`versionHistory.js` 认得 `region-edit:<id>` 来源与 `editShotRegion` / `adoptShotVersion` 标签。
- 没有新页面，路由与命令面板未改。

## 2. 流程

```
估算  POST /shots/:id/edit-region (confirm=false)
      resolveShot -> openGraph -> editShotRegion 在副本上演算 -> 改片后的 cacheKey
      -> 策略（适配器有 video.edit ? provider_mask : segment_splice）
      -> spend.checkBatch([{provider, kind:'video', params:{prompt, duration: 重做段整秒, model}}])
      -> 对比整镜：spend.estimate(duration = 整条整秒)
提交  confirm=true
      超额度 -> 402 SPEND_LIMIT，什么都不写；没 Key -> 400 INVALID_API_KEY
      segment_splice：原片必须有本地文件（否则 409 REGION_EDIT_BASE_MISSING）
                      ffmpeg 截入点 / 出点两帧 -> 内容寻址目录（出点在片尾取最后一帧）
                      任务参数 { prompt: 降级提示词, duration, firstFrameUrl, lastFrameUrl, model(按“有首帧”选), _gen, _edit }
      provider_mask： 任务参数 { prompt, videoUrl: 原片引用, edit:{t0_ms,t1_ms,rect,mode}, duration, model?, _gen, _edit }
      记一行 edit_regions（status queued）+ 入队（幂等键 edit:<ep>:<node>:<key32>:<extra12>，同配方再点复用 / 失败重试）
      图不动：等待期间原视频仍“新鲜”，不会被批量生成误当成过期整镜重做
完成  worker onTaskFinished（只认 edit: 前缀；生成服务只认 gen:，互不干扰）
      segment_splice：ffmpeg 拼接 [0,t0) 原片 + 新片段（setpts 缩放到 t1-t0，缩放到原片尺寸，重采样到原帧率，裁到精确时长）+ [t1,end) 原片，
                      原片音轨（若有）原样铺回整条；libx264 crf20 重新编码；结果进内容寻址目录
      provider_mask： 服务商给的整条直接用
      一次 commit：addVersion { id: t_<task>, cache_key: 提交时算出的改片后 key, asset, metadata: { edit 配方, duration_ms, strategy, base_version_id, task_id, provider, model, inputs }, source: region-edit:<row> }
      不自动采用；edit_regions 行 status=done, result_version_id
      失败 -> 图不动，行 status=failed + 错误；再点一次 = 重试同一任务（已有厂商任务号的续轮询，绝不二次提交）
采用  POST /shots/:id/adopt-version { version_id }
      adoptShotVersion：edit 参数跟随版本配方 + adoptVersion；采用改片结果后节点新鲜、合成过期；切回原版本也新鲜；已采用且参数一致 = 不写日志
恢复  启动 recoverFinished：已成功但没写回的补写（tx_id 固定，重复为空操作）；已失败但行还在排队的改成失败
```

## 3. API

`:id` 为 `storyboards.id`（数字）；也接受镜头节点 id，此时需给 `episode_id`（body 或 query）。

### `POST /shots/:id/edit-region`

请求：`{ t0_ms, t1_ms, rect?: {x,y,w,h}, prompt, mode?: 'region'|'segment', confirm?: bool, episode_id? }`（毫秒允许数字字符串 / 小数，四舍五入；`segment` 模式 `rect` 缺省整幅）。

`confirm=false`（默认）只估算：

```json
{
  "episode_id": 1, "shot_id": "shot_1", "storyboard_id": 12, "node": "video_shot_1", "confirmed": false,
  "base_version_id": "t_abc", "total_ms": 5000,
  "edit": { "base": "t_abc", "mode": "region", "t0_ms": 1000, "t1_ms": 2500, "rect": { "x": 0.25, "y": 0.1, "w": 0.5, "h": 0.4 }, "prompt": "把伞换成红色" },
  "strategy": "segment_splice", "provider": "bailian", "provider_ready": true, "model": "wan2.2-kf2v-flash",
  "segment": { "t0_ms": 1000, "t1_ms": 2500, "seconds": 2 },
  "estimate": { "cents": 20, "total": 0.2, "max": 0.3, "currency": "CNY", "basis": "2s x 0.1", "known": true, "sample_prices": true,
                "full": { "cents": 50, "total": 0.5, "seconds": 5 } },
  "cap": { "...": "同生成接口" }, "allowed": true, "refusal": null
}
```

`confirm=true` 另带：`confirmed: true, outcome: created|already_queued|already_done|retried|uncertain, task: { id, state }, region: { id, status, strategy, t0_ms, t1_ms, rect, prompt, mode, task_id, result_version_id, cost_estimate_cents, error, ... }`。

错误：400 `BAD_REQUEST`（入出点 / 区域 / 提示词不合法，附内核校验原文）、404 `NOT_FOUND`、409 `REGION_EDIT_NO_VIDEO`（镜头没有已采用的视频）、409 `REGION_EDIT_BASE_MISSING`（原片没有本地文件）、402 `SPEND_LIMIT`、400 `INVALID_API_KEY`、500 `REGION_EDIT_FFMPEG`。

### `GET /shots/:id/edit-regions?episode_id=`

`{ episode_id, shot_id, storyboard_id, node, seq, total_ms, adopted, strategy, provider, provider_ready, items: [改片记录，新的在前，status 由任务状态折算：queued / running（含成功但写回中）/ done / failed], versions: GET /episodes/:id/versions 里该视频节点的那一项 }`。

### `POST /shots/:id/adopt-version`

请求 `{ version_id, episode_id?, tx_id? }`。响应 `{ applied, tx_id, seq, version_id, node, invalidated, revalidated, stale, can_undo, can_redo }`；已采用且参数一致时 `applied:false`，不写日志。404 版本不存在。

### 厂商能力 `video.edit`（可选）

`video.edit({ model?, prompt, videoUrl, edit: { t0_ms, t1_ms, rect, mode }, duration?, resolution?, signal? }) -> { taskId }`，之后与 `video.submit` 一样用 `video.poll` 轮询（插件清单里声明 `video.edit` 必须同时声明 `video.poll`）。`videoUrl` 是原片的 `/static/...` 引用：本地文件厂商取不到，实现该能力的适配器要自己上传（未验证）。

## 4. 降级策略与取舍

- **何时降级**：按已启用的视频服务商的适配器是否声明 `video.edit` 决定（不联网，只看能力表）。现在百炼 / 方舟都没有，所以一律 `segment_splice`。
- **只重做一段**：取入点帧与出点帧（出点在片尾时取最后一帧，避免越过片尾截不到画面），用首尾帧生视频模型重做这一段。模型按“有首帧”的规则选（节点里保存的整镜模型可能是文生视频的，不适用）；时长按整秒向上取整。提示词把“改哪里（画面位置 + 占比）、改成什么、其余保持不变、与前后连贯”写成文字 —— 首尾帧生视频没有遮罩，**区域只能靠文字约束**，这是降级路径的本质局限。
- **拼回去**：生成片段通常比入出点差多出零点几秒（整秒出片），用 `setpts` 缩放到精确时长，再缩放到原片尺寸、重采样到原帧率、`trim` 到精确时长；头尾取原片；统一重新编码（libx264，crf 20）。原片音轨原样铺回整条（画面改动不碰声音）。自动化测试用 lavfi 合成的 3 秒样例断言拼接后时长与原片相差不超过一帧（带 AAC 音轨时容器时长多出约 18 ms，仍在一帧内）。
- **图不动直到结果落地**：提交时只在副本上算 key，不把 `edit` 写进图。否则等待期间原视频显示过期，批量生成会把它当成需要整镜重做。结果版本记的是“改片后的 key”，采用时由 `adoptShotVersion` 让参数跟随，节点才变成这个 key。
- **估价**：`provider_mask` 的价格按同一张每秒价格表算（厂商真实编辑价格未知）；`segment_splice` 按首尾帧模型的每秒价格 × 重做秒数。两者都给出整镜重做的价格作对比。
- **幂等**：幂等键由改片后的 key + 服务商 / 策略 / 模型 / 两帧哈希 / 时长派生；同配方再点复用任务（不花钱），失败的重试（有厂商任务号的只续轮询）。

## 5. 未验证

- 百炼（或方舟）是否有带遮罩的视频编辑模型：没有查证，`video.edit` 在两个适配器里都未实现，不编造模型名。接入时在适配器 `capabilities` 里加 `'video.edit'`，并处理 `videoUrl` 为本地文件的上传。
- 降级路径的**接缝效果**（新片段与原片在入出点处的画面连续性、文字约束区域的效果）只能真机、真 Key 看。
- 拼接时的时长缩放比例（`setpts` 乘数）对动作节奏的影响（厂商整秒出片，缩放最多约 1 秒内）。
- Windows 打包环境下 `ffmpeg` / `ffprobe` 路径（沿用 `utils/ffmpegPath.js` 的查找规则，未在真机跑）。
- 工作台框选层在 `object-fit: contain` 下按视频真实宽高算画面区域，竖屏视频只在浏览器里推过，未在真机核对。

## 6. 怎么测

```
pnpm --filter ./packages/kernel test        # 含一致性套件；test/regionEdit.test.js 为意图 / 失效 / 预言机
pnpm --filter ./packages/local test         # test/regionEdit.test.js：估算 / 校验 / 额度 / 提交 / 拼接 / 采用 / 失败 / 恢复 / provider_mask / 队列适配 / REST
pnpm --filter ./packages/plugin-sdk test    # video.edit 能力常量与清单规则
pnpm --filter ./apps/renderer test          # test/regionEdit.test.js 纯逻辑；shotWorkbench.test.js 的 I / O 键
```

本机没有 `ffmpeg` / `ffprobe` 时，local 里依赖它们的用例（截帧、拼接、片尾出点、REST 的提交分支）自动跳过，其余照跑。测试全部用假的服务商门面，不联网；生成片段也是 lavfi 合成的小视频。

手工（真机、真 Key）：在分镜工作台对一个已采用视频的镜头，设入点 / 出点，框一块区域，写一句话，看估算（应小于整镜），确认；任务中心看任务；完成后版本列表出现“改片”版本（不自动采用），A/B 对比后采用；再切回原版本，两边都应显示“最新”；时间线 / 导出用的是采用的那一版。
