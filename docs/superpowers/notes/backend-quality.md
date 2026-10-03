# 后端：草稿 / 成片质量档（四视图改造 Task 4）

规格：spec §10.2。实现：`packages/local/src/generation/qualityProfiles.js`（档位表）、`generation/service.js`（应用档位、重跑）、`routes/qualityRerun.js`、`routes/drama.js`（`PUT /dramas/:id/quality`）。测试：`packages/local/test/qualityTier.test.js`。

## 档位表与依据

档位只改“这一次发给服务商的请求”，不是节点参数，**不进 cacheKey**；记在新版本的 `metadata.quality`。表里只放有依据的取值，没有依据的写 `null`（= 这种请求没有已验证的更便宜选项，照成片档走）。

| 服务商 | 请求形态 | 草稿档 | 依据 |
|---|---|---|---|
| bailian | 出图，不带参考图 | `model: z-image-turbo` | 真 Key 跑通过（`test/fixtures/live_image_zimage.json`，`docs/bailian-flow-coverage.md` 第 2 行）。价目表 0.1 元/张，但标的是占位价（`verified:false`）；成片档 `wan2.6-t2i` 0.2 元/张（`verified:true`）。**省不省钱取决于占位价是否属实** |
| bailian | 出图，带 1-4 张参考图 | 无（照成片档 `wan2.6-image`） | `wan2.6-image` 是唯一验证过的带参考图出图模型 |
| bailian | 视频，有首帧 | `wan2.2-kf2v-flash`，`480P` | 真 Key 跑通过（`live_video_kf2v`，flow-coverage 第 6 行）。**这就是成片档本来的选择，适配器默认就是 480P**，所以请求和成片档完全一致，没有节省（见下） |
| bailian | 视频，纯文生视频 | 无（照成片档 `wan2.6-t2v`） | 只验证过 `wan2.6-t2v` 720P，文生视频 480P 的尺寸写法没有验证过，不猜 |
| ark | 出图 | 无 | 方舟适配器没有任何一项经真 Key 验证（`providers/ark/index.js` 头注释） |
| ark | 视频（有 / 无首帧） | 只加 `resolution: 480p`（`--rs 480p`），不换模型 | 适配器已支持该标志，价目表里 480p 是最低档；**未经真 Key 验证** |

### 如实的结论：百炼上草稿档真正有差别的只有“不带参考图的出图”

- 首帧视频：成片档本来就是 `wan2.2-kf2v-flash` 480P，草稿档请求完全相同，所以不降档，版本元数据记 `final`（`applyQuality` 在“档位分辨率等于该模型的适配器默认值”时不再显式带参数）。
- 文生视频、带参考图的出图：没有已验证的更便宜选项，同样记 `final`。
- 因此在百炼上，“草稿”实际只省出图那一步（`z-image-turbo` vs `wan2.6-t2i`）；视频成本不变。要让草稿视频更便宜，需要有人用真 Key 验证一个更低价的视频模型，或文生视频的 480P 尺寸写法，再往 `PROFILES` 里加一行（只改数据表）。
- 与 `docs/bailian-flow-coverage.md` 的差异：该文档把 `z-image-turbo` 只当作“也可用”的出图模型；本任务把它用作草稿档出图。该文档没有可选的更低视频档，所以没有新增。

## 行为

- **档位存放**：`dramas.quality TEXT DEFAULT 'final'`（`db/migrate.js` 的 `ensureColumns`，旧库自动补列，非法值按 final）。`GET /dramas/:id` 带回 `quality`；`PUT /dramas/:id/quality` body `{ quality: 'draft'|'final' }` → `{ quality }`，非法值 400，不存在 404。
- **应用位置**：只在 `planGraph` 构造发给服务商的 spec 时套用。节点参数里的 `image.model` / `video.model` 仍是成片档的自动选择（同步事务照旧写入），cacheKey 不变，所以切档位不会让任何产物过期，也不会写内核。
- **版本元数据**：`metadata.quality`（`draft`|`final`，**实际生效**的档位）、`resolution`、`size`（有就记）、`rerun_of`（重跑时被替换的草稿版本 id）。
- **用户显式选的模型优先**：节点上的模型与自动挑的不同才算显式（`applyQuality` 纯函数有测试）。注意：现状下 `syncTx` 每次生成前都会把节点模型改写成自动挑的结果，所以通过现有流程**到不了**“显式模型”分支；已保存的服务商配置的默认模型也被当成自动挑的一部分，草稿档会覆盖它（仅限档位表里有取值的形态）。要让节点级显式模型真正生效，需要先有“节点上选模型”的入口，那是另一个任务。
- **成片版本优先**：缓存命中（`cacheVersion`）在同 key 下优先选非草稿版本。

## 重跑草稿

- `GET /episodes/:id/quality/draft-nodes` → `{ count, nodes: [{ node, kind, shot }], estimate: { amount, max, currency }, allowed, refusal }`。只含**当前采用版本是草稿档产出、且 cacheKey 等于当前 key（新鲜）**的 image / video 节点；已过期的走普通生成。
- `POST /episodes/:id/quality/rerun`：没有草稿时什么都不做（不做快照）；额度不够整批 402 `SPEND_LIMIT`（不做快照、不建任务）；否则先 `backupHooks.beforeDestructive(episodeId, 'quality-rerun')`，再对这批节点以 `final` 档入队，返回 `{ count, nodes, estimate, tasks }`。
- 重跑用**同一个 cacheKey** 再出一个成片版本并用 `addVersion + adoptVersion` 采用（草稿版本保留在版本历史里），因此过期集合不变；幂等键里带被替换的草稿版本 id（`rerun`），不影响普通任务的旧键。
- 估价与入队同源：`draftNodes` 和 `rerunDrafts` 用同一套 `planGraph(force, only)`；测试断言“估价 = 入队任务的 `spend.checkBatch` 合计”。
- 首帧和视频都是草稿时：首帧任务带 `then_video_force`，成片首帧落地后 `chainVideo` 对视频节点同样 force 重出。

## 已知限制

- 重跑进行中，`GET .../generation/status` 里该节点仍显示 `fresh`（图是新鲜的，只是还在换更好的版本），不显示 `running`；任务在任务中心里可见。
- 重跑某镜头的首帧后，已有的成片视频不重做（cacheKey 不变，视频不过期），它仍是用旧草稿首帧生成的。要让视频跟着重做，需要该视频本身是草稿版本，或用普通“重新生成”。
- 百炼的草稿视频没有节省（见上），ark 的草稿视频分辨率未经真 Key 验证。
