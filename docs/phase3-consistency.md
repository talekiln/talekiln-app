# P3-C 角色一致性

状态：云端会话完成并通过自动化测试（Rust / 本机服务 / 内核 / 渲染端）。评分算法只衡量色彩与构图，**认不出“是不是同一张脸”**；真 Key 出图出视频后的分数分布、Windows 真机都没有跑过，见第 7 节。

## 1. 做了什么

| 位置 | 作用 |
|---|---|
| `packages/core/src/consistency.rs` | lycore 新方法 `consistency.score`、`consistency.pick_reference`：ffmpeg 抽帧成 rgb24 后算感知哈希（DCT pHash）、RGB/HSV 直方图交集、主色调距离；清晰度用拉普拉斯方差。纯函数全部用合成帧单测 |
| `packages/core/src/ffmpeg.rs` | 新增 `run_raw`（保留 stdout 字节，供抽帧用），`run` 改为其包装 |
| `packages/core/client/index.js` | 客户端助手 `consistencyScore(params)`、`pickReference(params)` |
| `packages/local/migrations/28_consistency_scores.sql` | `consistency_scores` 表：版本 × 参考实体 唯一，重评覆盖 |
| `packages/local/src/consistency/index.js` | 服务：评分器可注入（默认经 lycore JSON-RPC，没有内核时静默不评分）；`onAdopted` 钩子、分集报告、重评、角色参考图自动挑选 |
| `packages/local/src/routes/consistency.js` | 三个 REST 接口（在 `routes/index.js` 末尾以 `// P3-C` 块挂载） |
| `packages/local/src/generation/service.js` | 新增 `onAdopted` 钩子（版本写进图之后调用，失败只记日志）；**视频请求补带锁定参考图 `referenceUrls`** |
| `packages/local/src/kernel/inputs.js`、`packages/kernel` | 视频节点新增可选参数 `reference_hashes`（意图 `setShotReferences` 的 `video_reference_hashes`），锁定参考图的变化让视频也过期 |
| `packages/local/configs/config.yaml` | `consistency.enabled / min_score / sample_frames` |
| `packages/local/src/errors/error-codes.json` | `CONSISTENCY_UNAVAILABLE`（503）、`CONSISTENCY_FAILED`、`NO_REFERENCE_CANDIDATES`（400） |
| `apps/renderer/src/utils/consistencyView.js`、`api/consistency.js` | 芯片 / 建议文案 / 估价文案 / 自动挑选结果的纯函数与接口封装 |
| `apps/renderer/src/views/ShotWorkbench.vue`、`StoryboardPage.vue` | 只读的「一致性 NN」芯片（悬停看建议与重做估价） |
| `apps/renderer/src/views/ReferenceLibrary.vue` | 角色页「自动挑选参考图」按钮（可勾选挑完自动锁定第一名；排好的候选显示在下方，可手动锁定其它张） |

## 2. 评分规则

目标（首帧图或视频）与**镜头里每张锁定参考图**（场景在前、角色按镜头顺序）各评一次，0–100：

| 部分 | 权重 | 算法 |
|---|---|---|
| 感知哈希 | 0.5 | 32×32 灰度 DCT 取 8×8 低频，中位数二值化成 64 位；汉明距离 24 位以上记 0 |
| 色彩直方图 | 0.3 | 64×64 中心正方形裁剪，RGB 3×8 bins 与 HSV 16/4/4 bins 的直方图交集取平均 |
| 主色调 | 0.2 | 每通道 4 级量化后取前 5 色，对称最近色距离加权，归一化距离 0.25 以上记 0 |

视频按 `sample_frames`（默认 5）均匀抽帧，每帧单独评分后取平均。建议：`score ≥ min_score` → `ok`；`score < min_score - 20` → `retry`（附重做估价）；其间 → `check`。

本机真 ffmpeg 跑合成图的参考数值（64×64 彩色图案）：同图 100；亮度 +0.15 → 80；色相偏 40° → 57；高斯噪声 → 1；完全不同的测试图 → 48；同一素材做的运动视频对比首帧 → 47（哈希 0、直方图 96、主色 90）。也就是说：**换色、换构图能抓到，同构图不同脸抓不到**。

参考图自动挑选（`pick_reference`）：清晰度（拉普拉斯方差，组内相对值）、分辨率（`min(1, √(w·h)/1024)`）、与锚图（四视图）的相似度；权重 0.4 / 0.2 / 0.4，没有锚图时 0.65 / 0.35。

## 3. REST

- `GET /api/v1/episodes/:id/consistency`

  ```json
  {
    "episode_id": 5, "enabled": true, "available": true, "min_score": 60,
    "shots": [{
      "shot_id": "shot_xxx", "storyboard_id": 12, "number": 1, "scored": true,
      "best": 90, "worst": 35, "suggestion": "retry",
      "entity": { "type": "character", "id": 3, "name": "李雷" },
      "image": { "version_id": "t_…", "scored": true, "best": 90, "worst": 35, "suggestion": "retry", "entity": {…}, "scores": [{ "entity_type": "scene", "entity_id": 77, "entity_name": "场景 77", "score": 90, "parts": {…}, "suggestion": "ok", "created_at": "…" }] },
      "video": null,
      "regenerate": { "kind": "both", "estimate": 0.5, "max": 0.6, "currency": "CNY", "known": true, "allowed": true }
    }],
    "counts": { "ok": 0, "check": 0, "retry": 1, "unscored": 4 }
  }
  ```

  `available=false` 表示内核不可用（社区版没有渲染核心）；`regenerate` 按建议估价：首帧图差 → 图 + 视频一起重做，只有视频差 → 只重做视频，都合格 → `null`。估价只算不建任务，走生成服务的估算（花费上限照查，`allowed`）。

- `POST /api/v1/shots/:id/consistency/rescore`：`:id` 为旧表 storyboard id；也可用镜头节点 id，此时请求体带 `episode_id`。重评当前采用的首帧图与视频版本（覆盖旧行），返回该镜头的报告项 + `rescored: { image, video }`、`reasons`。内核不可用 → 503 `CONSISTENCY_UNAVAILABLE`。
- `POST /api/v1/characters/:id/references/auto-pick`，请求体 `{ "lock": true }`：候选 = 角色主图、`extra_images`、已完成的 `image_generations`（都要在本机存储目录里；远程 URL 不下载，列在 `skipped`），锚图 = 四视图。返回 `{ anchor, ranked: [{ local_path, image_url, source_image_id, source, score, sharpness, width, height, similarity }], skipped, picked, locked, lock, synced }`。`lock=true` 时经 `referenceLockService.setLock` 锁定第一名并 `syncReferences` 同步进内核（用到该角色的镜头立即过期），与 `PUT /reference-locks` 一致。没有候选 → 400 `NO_REFERENCE_CANDIDATES`。

lycore 侧的参数、返回与错误码见 `packages/core/README.md` 的 `consistency.score` / `consistency.pick_reference` 节。

## 4. 触发时机与存储

生成服务 `adoptTask` 把版本写进图后调用 `onAdopted({ task, episode_id, shot_id, node, kind, version_id, adopted })`，一致性服务对该版本与镜头的每张锁定参考图各评一次写入 `consistency_scores`（`episode_id, node_id, version_id, entity_type, entity_id` 唯一）。钩子的 Promise 记入生成服务的 `pending`，`idle()` 会等它；失败只记日志，不影响写回。连不上内核时 30 秒内不再重连（避免每个任务都等一次连接超时）。只有本机存储目录里的文件才评分（参考图不在本机 → 该实体跳过并标 `reference_not_local`）。

## 5. 新生成路径的缺口

旧流程 `videoService` 出视频会带 `reference_urls`，新的队列路径只给出图带了参考图。现在 `buildParams('video')` 也带 `referenceUrls`（百炼适配器按模型取用：目前只有 `wan2.6-r2v-flash` 用它，首帧模型不受影响），哈希经 `setShotReferences` 的 `video_reference_hashes` 记进视频节点参数与版本 `metadata.inputs.reference_hashes`。参数缺省不写，已有项目的 cacheKey 不变。测试：`generation.test.js`「视频：锁定的参考图也进视频请求」。

## 6. 配置

```yaml
consistency:
  enabled: true      # false 时生成后不自动评分（手动重评仍可用）
  min_score: 60      # 0–100，非法值回退 60
  sample_frames: 5   # 视频均匀抽帧数，1–30
```

## 7. 未验证

- 真 Key 出图 / 出视频后的分数分布：阈值 60 / 重试线 40 是按合成图定的，真实素材可能整体偏低或偏高，要按实际再调。
- `referenceUrls` 进视频请求后，百炼 `wan2.6-r2v-flash` 之外的模型是否需要带参考图、是否会因此报参数错误（适配器只对 r2v 取用，其它模型忽略）。
- Windows 真机：ffmpeg 定位（`ffmpegDir` / `LYCORE_FFMPEG_DIR` / exe 旁 / PATH）与路径里的中文、空格。
- 人脸级一致性：现算法认不出同构图不同脸；要不要引入小模型由你决定。
- 渲染端只做了 vite 构建与纯函数测试，页面没有在真机点过。

## 8. 怎么测

```bash
cd packages/core && cargo test                 # 含 consistency 单测；有 ffmpeg 时跑 real_ffmpeg_end_to_end
cd packages/core && node client/test.js        # 假 ffmpeg 的客户端集成（consistencyScore / pickReference）
pnpm --filter ./packages/kernel test           # video.reference_hashes 的一致性套件
pnpm --filter ./packages/local test            # consistency.test.js（假评分器）、generation.test.js、errorCodes.test.js
pnpm --filter ./apps/renderer test             # consistencyView.test.js
```

手动：锁定一个角色 / 场景的参考图 → 生成该镜头 → 分镜表状态列出现「一致性 NN」芯片，悬停看建议；工作台首帧面板下有同样一行；角色库角色页点「自动挑选参考图」。

## 9. 决定

- 评分与挑选都放在 lycore（Rust，无模型依赖），本机服务只做编排与存储；社区版没有内核时报告 `available=false`，界面不显示芯片。
- 内核扩展保持最小：只给视频节点加可选参数 `reference_hashes`，默认不写。
- 内核错误码（如 `-32020` 缺 ffmpeg）原样作为字符串错误码带回（错误码表已有文案），不另起新码。
