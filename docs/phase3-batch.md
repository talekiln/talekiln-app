# P3-B 批量生成：一次排多集，按服务商并发与总预算调度

状态：云端会话完成，本地与渲染层自动化测试全部通过（假厂商、假时钟、假定时器）。**没有用真 Key 在 Windows 真机跑过多集批次，批次页也没有在浏览器里打开过**，见第 7 节。

## 1. 结构

| 位置 | 作用 |
|---|---|
| `packages/local/migrations/30_batch_jobs.sql` | `batch_jobs`（批次）与 `batch_items`（每集一行）两张表，金额一律存整数「分」 |
| `packages/local/src/batch/policy.js` | 纯函数：kinds / 失败策略 / 并发 / 预算的校验与归一化、夜间时段判断、元分换算、`BatchError` |
| `packages/local/src/batch/service.js` | 批次服务：建批次（逐集估算）、`tick()` 调度一轮、暂停 / 继续 / 取消 / 重试失败集、批次视图 |
| `packages/local/src/batch/scheduler.js` | 定时器：有批次在跑每 2 秒 `tick` 一次，否则 15 秒；挂在队列 worker 的 `start/stop` 上 |
| `packages/local/src/routes/batches.js` | REST（见第 2 节），在 `routes/index.js` 末尾以 `// P3-B` 块挂载 |
| `packages/local/src/app.js` | 组装：`createBatchService` + `createBatchScheduler` + `attachToWorker`；任务结束回调里顺带通知批次 |
| `packages/local/src/generation/service.js` | 唯一改动：`create(ep, spec, { batch })` 把 `_batch` 写进任务 params，首帧完成后自动接上的视频任务也带同样标记（`_` 前缀参数不会发给厂商） |
| `packages/local/src/errors/error-codes.json` | 新增 `BATCH_BUDGET_EXCEEDED`、`BATCH_NOTHING_TO_DO`、`BATCH_STATE` |
| `apps/renderer/src/views/BatchPage.vue` | 批次页 `/project/:dramaId/batch`：建批次面板 + 批次列表（汇总卡片、每集进度、单集重试）（2026-10-03：路由改为 `/p/:dramaId/batch`，由生成菜单「多集批量生成…」进入，旧路径重定向） |
| `apps/renderer/src/utils/batchView.js` | 页面用到的纯函数（金额文案、并发钳制、策略校验、状态标签、轮询间隔、汇总卡片） |
| `apps/renderer/src/api/batches.js` | axios 封装 |
| `apps/renderer/src/router/index.js`、`utils/builtinCommands.js` | 路由与命令面板「批量生成」，均放在末尾的 `// P3-B` 块 |
| `apps/renderer/src/views/StoryboardPage.vue`、`DramaDetail.vue` | 页头各加一个「批量生成」按钮进入批次页（2026-10-03：`DramaDetail.vue` 已随四视图统一删除；入口现为生成菜单「多集批量生成…」和侧栏「多集批量生成」，旧路径 `/project/:dramaId/batch` 重定向到 `/p/:dramaId/batch`。） |
| `packages/local/test/batch.test.js`、`apps/renderer/test/batchView.test.js` | 测试（第 6 节） |

批次不自己提交任务：每个镜头仍然通过现有的生成服务 `generation.create` 进持久队列 `ai_tasks`，由队列 worker 提交、轮询、下载、写回。批次只决定**什么时候**把下一个镜头放进队列，以及把任务结果汇总成每集的状态。所以任务中心、花费统计、重试 / 取消单个任务等现有功能对批次任务照常可用。

## 2. REST

| 方法 / 路径 | 作用 |
|---|---|
| `POST /batches` | 建批次，201 返回批次视图；`dry_run: true` 时 200 返回估算（不落库） |
| `GET /batches?drama_id=` | `{ items, provider_limits, providers, currency }`，`items` 为批次视图数组（新的在前） |
| `GET /batches/:id` | 批次视图（含每集进度） |
| `POST /batches/:id/pause` | 暂停：不再建新任务，已在跑的继续 |
| `POST /batches/:id/resume` | 继续；body 可带 `{ budget_cap_cents }` 顺手提高预算 |
| `POST /batches/:id/cancel` | 取消：还在排队的任务取消，已提交给厂商的跑完照常写回 |
| `POST /batches/:id/retry-failed` | 失败的集重新排进去；body `{ episode_ids?: [] }` 只重试其中几集 |

### 2.1 建批次请求体

```json
{
  "drama_id": 1,
  "episode_ids": [3, 4, 5],
  "kinds": "both",
  "concurrency": { "bailian": 2, "ark": 1 },
  "budget_cap_cents": 5000,
  "failure_policy": { "retry": 1, "on_fail": "skip", "night": { "start": "22:00", "end": "06:00" } },
  "dry_run": false
}
```

- `kinds`：`both`（默认）/ `image` / `video`，或数组。
- `concurrency`：按服务商的并发上限，缺省 = 该服务商队列上限（`config.ai_queue.limits`，默认 `{ default: 2, bailian: 3, ark: 3 }`），**超过队列上限会被钳制到上限**（再多队列自己也会卡住）。可用 `default` 给所有服务商统一值。
- `budget_cap_cents`：整数分，`null` / 缺省 = 不限制。
- `failure_policy.retry`：每个任务失败后自动重试次数，0–10，默认 1；`on_fail`：`skip`（默认，这一集标失败、其余继续）或 `pause`（整批暂停）；`night`：只在该时段内提交新任务，`HH:MM`，跨午夜按 `[start, 24:00) ∪ [00:00, end)` 算，`null` = 随时。

### 2.2 批次视图

```json
{
  "id": "b_…", "drama_id": 1, "status": "running",
  "kinds": ["image", "video"], "episode_ids": [3, 4, 5],
  "concurrency": { "bailian": 2 }, "provider_limits": { "bailian": 3 },
  "budget_cap_cents": 5000, "failure_policy": { "retry": 1, "on_fail": "skip", "night": null },
  "currency": "CNY", "sample_prices": true, "warnings": ["…"],
  "totals": { "estimate_min_cents": 1200, "estimate_max_cents": 1440, "spent_cents": 300, "in_flight_max_cents": 120, "remaining_min_cents": 800, "remaining_max_cents": 960 },
  "progress": { "items_total": 3, "items_done": 1, "items_succeeded": 1, "items_failed": 0, "items_running": 1, "shots_total": 15, "shots_done": 6, "tasks": { "total": 7, "queued": 1, "running": 1, "succeeded": 5, "failed": 0, "cancelled": 0 } },
  "waiting": "concurrency",
  "error": null, "started_at": 1, "finished_at": null, "elapsed_ms": 60000,
  "items": [
    { "episode_id": 3, "episode_number": 1, "title": "第一集", "position": 0, "status": "succeeded", "attempts": 0, "error": null,
      "shots_total": 5, "shots_enqueued": 5, "shots_done": 5, "blocked": 0, "tasks": { "…": 0 },
      "spent_cents": 300, "estimate_min_cents": 300, "estimate_max_cents": 360, "remaining_min_cents": 0, "remaining_max_cents": 0 }
  ]
}
```

- `status`：`queued`（排队，等前面的批次）/ `running` / `paused` / `completed` / `failed`（所有集都失败）/ `cancelled`。
- 每集 `status`：`pending` / `running` / `succeeded` / `failed` / `cancelled`。
- `waiting`：上一轮没能继续建任务的原因，`night`（不在夜间时段）/ `concurrency`（在途已到上限）/ `budget`（再建一个会超预算）/ `turn`（等前面的批次跑完）/ `null`。
- `spent_cents` 来自 `spend_log` 按任务 id 汇总（`COALESCE(actual, estimated)`），包括 retry-failed 之前那一轮的任务。
- `estimate_*` 来自建批次时逐集估算之和（`generation.estimate` → 价格表的 `估价 × max_factor`），`remaining_*` 只算还没进队列的镜头。
- `sample_prices: true` 表示价格表还是样例价，`warnings` 里会提醒。

### 2.3 `dry_run`

同一个请求体加 `dry_run: true`，返回 `{ dry_run: true, allowed, refusal: { code, message }, totals, per_episode, warnings, concurrency, provider_limits, … }`，不建批次、不抛错：预算或月度额度不够时 `allowed=false`，`refusal.code` 为 `BATCH_BUDGET_EXCEEDED` / `SPEND_LIMIT` / `BATCH_NOTHING_TO_DO`。页面用它在表单变化时实时显示「全部完成预计 ¥x–y（最多 ¥z）」。

### 2.4 错误码

| 码 | HTTP | 含义 |
|---|---|---|
| `BAD_REQUEST` | 400 | 参数非法（集数为空、不属于该项目、kinds / 并发 / 策略 / 预算格式） |
| `NOT_FOUND` | 404 | 项目、分集或批次不存在 |
| `INVALID_API_KEY` | 400 | 所选镜头要用的服务商没配置或没 Key |
| `BATCH_NOTHING_TO_DO` | 400 | 所选分集没有需要生成的镜头（已是最新，或没有分镜 / 提示词） |
| `BATCH_BUDGET_EXCEEDED` | 402 | 预算上限低于预计最低费用，批次未创建（`details` 带预计区间与预算） |
| `SPEND_LIMIT` | 402 | 现有花费服务的月度 / 单次上限不够（沿用其文案） |
| `BATCH_STATE` | 409 | 当前状态不允许该操作（例如已取消的批次再暂停） |

## 3. 调度规则

调度器每轮 `tick()` 做四件事：结算在跑的集 → 按规则建下一批任务 → 刷新汇总 → 判断批次是否结束。

1. **一次只跑一个批次**：取最早的 `queued` / `running` 批次，其余排队（视图里 `waiting: 'turn'`）。
2. **按集顺序、按镜头顺序**：建批次时逐集估算，得到每集的「镜头 × 种类」计划（已是最新的镜头跳过；缓存命中算 0 元；缺提示词等被阻塞的镜头计入 `blocked` 不建任务）。运行时按计划顺序逐个镜头 `generation.create`，一集的镜头排完才轮到下一集，但**前一集不必跑完**——只要并发还有余量就继续排后面的集。
3. **并发上限**：对每个镜头要用到的服务商，批次内该服务商「非终态」任务数（排队 + 提交中 + 轮询 + 下载）必须 < 批次上限，否则本轮停止建任务（`waiting: 'concurrency'`）。首帧图完成后自动接上的视频任务带 `_batch` 标记，同样计入在途。
4. **预算上限**：`已花费 + 在途任务的最高估价 + 下一镜头最高估价 > 预算` 就不建。如果此时没有任何在途任务，批次直接**暂停**并写明原因（「预算上限 ¥x 不足以继续：已花费 ¥…，下一镜头最高 ¥…。提高预算后可继续」），用户在页面上「继续」时可以直接填新预算。在途最高估价按价格表的 `max_factor`（样例价 1.2×）算，所以**预算正好等于预计最低值时，最后一两个镜头会因为保守估计而停下**，页面提示预算建议不低于「最多」值。
5. **夜间时段**：不在时段内不建新任务（`waiting: 'night'`），已在跑的照常完成写回。时间用本地时钟的「当天第几分钟」判断，测试里注入假时钟。
6. **失败策略**：任务失败 → 若该任务重试次数 < `retry`，走 `aiTaskStore.retry` 原地重试（不新建任务，重试计数记在集的 `retries` 里，不依赖会被重置的 `task.attempts`）；超过次数 → `on_fail = skip` 时这一集标失败、其余继续；`on_fail = pause` 时整批暂停并写明「第 N 集生成失败，已按策略暂停」。队列的费用守卫拒绝（`SPEND_LIMIT`）不算失败、不烧重试次数，直接暂停批次。
7. **完成判定**：一集的镜头全部排完且没有非终态任务后，再向 `generation.status` 核对每个计划镜头是否 `fresh`；不新鲜（运行期间镜头被改过）则这一集按失败处理（不重试）。全部集结束：有成功的 → `completed`，全失败 → `failed`。
8. **暂停 / 取消**：暂停只停止建新任务；取消只取消还在 `queued` 的任务，已提交给厂商的跑完照常写回（钱已经花了）。
9. **重试失败集**：失败的集回到 `pending`，之前的任务 id 挪到 `prior_task_ids`（花费继续计入），批次回到 `queued`。
10. **计时器**：`createBatchScheduler` 以 `setTimer/clearTimer` 注入，`tick` 返回 `{ active }` 决定下一次间隔（2 秒 / 15 秒）；建批次、继续、重试会立即 `wake`；队列的任务结束回调也会 `wake`。调度器跟随队列 worker 的 `start/stop`（`attachToWorker`），桌面主进程无需改动。

## 4. 批次页

`/project/:dramaId/batch`，从剧集管理页、分镜表页头的「批量生成」按钮或命令面板「批量生成」进入。（2026-10-03：入口见上，`DramaDetail` 已删除。）

- 建批次面板：分集多选（全选 / 清空）、生成内容（首帧 + 视频 / 只首帧 / 只视频）、每个已启用服务商的并发输入框（最大值 = 队列上限，旁边标「队列上限 n」）、预算（元，留空不限）、失败策略（重试次数、失败后跳过 / 暂停、夜间时段开关 + 起止时间）。表单变化后 400 ms 调一次 `dry_run`，显示「全部完成预计 ¥x–y（最多 ¥z）」或拒绝原因；点「开始批量生成」前再确认一次。
- 批次列表：每个批次一个面板，状态标签、操作按钮（暂停 / 继续 / 重试失败的集 / 取消），错误提示或等待原因，四张汇总卡片（进度、已花费、预计区间、已用时），进度条，每集表格（分集、状态、镜头 x/y、任务统计、花费、预计、说明、操作：重试本集 / 去分镜表）。
- 有活动批次时每 3 秒轮询，否则 15 秒。

## 5. 设计取舍

- **镜头级游标而不是整集一次性入队**：这样「每个服务商并发 ≤ n」才是真约束；整集入队后队列自己只能按全局上限跑。
- **批次标记走任务 params 的 `_batch`**：首帧完成后链出的视频任务在生成服务内部创建，批次拿不到它的 id；用 `_batch` + `idempotency_key LIKE 'gen:<ep>:%'` 在结算时发现并认领。`_` 前缀参数被 `providerAdapter.vendorParams` 过滤，不会发给厂商。
- **不改队列**：`queue/aiTaskQueue.js` 零改动；生成服务只加了透传 `batch` 的三行。
- **预算用分、整数**：价格表是元的小数，边界处 `Math.round(yuan × 100)`，避免浮点累加误差。
- **完成以「最新版本」为准**而不是以任务成功为准：写回失败或运行期间镜头被修改都能被发现。

## 6. 测试

```
pnpm --filter ./packages/local test      # 含 test/batch.test.js，21 个用例
pnpm --filter ./apps/renderer test       # 含 test/batchView.test.js，7 个用例
```

`batch.test.js` 用假厂商（`hold` / `release` 控制每个任务何时完成、`shouldFail` 控制失败）、假时钟与假 `minutesOfDay`、假定时器，不发任何网络请求，覆盖：

- 创建与校验：逐集估算求和、并发钳制、参数校验、预算 / 月度额度 / 无事可做三种拒绝、`dry_run`。
- 调度：并发上限（每轮断言每个服务商在途数 ≤ 上限）、预算停止与提高预算后继续、夜间时段、`skip` 策略（重试 1 次后标失败 + retry-failed 重新排）、只重试部分集、`retry 2` 重试成功、`pause` 策略、全失败 → `failed`、`SPEND_LIMIT` → 暂停、取消、暂停 / 继续、多批次排队、首帧 + 视频链式任务的发现与计费、运行期间修改镜头。
- 纯函数：夜间时段（同日与跨午夜）、策略 / 并发 / kinds 归一化。
- 调度器：假定时器下的间隔切换、`wake`、`stop`、与 worker 生命周期的挂接顺序。
- REST：全部七个接口与错误码（`errorCodes.test.js` 会校验新错误码已登记）。

渲染层 `batchView.test.js` 覆盖金额与估算文案、并发钳制、策略校验、请求体构造、状态标签与可用操作、进度百分比、轮询间隔、汇总卡片。`BatchPage.vue` 通过了 `vite build`（SFC 编译 + 引用解析）。

## 7. 未验证 / 需要真机确认

1. **真 Key 跑一次多集批次**（¥ 限额内，Windows 真机）：确认夜间时段用本机时区、首帧 → 视频链式任务在真厂商下也被认领、花费汇总与花费统计页一致。
2. **批次页没有在浏览器里打开过**：布局、Element Plus 组件在深色 / 窄窗口下的表现、轮询对任务中心的影响都未看过。
3. **预算的保守估计**（第 3 节第 4 条）：预算正好等于预计最低值时会在最后一两个镜头前暂停，这是按「宁可停、不可超」设计的，真机上看是否需要放宽到按估价而不是最高估价判断。
4. 队列 worker 在桌面端是否一定先于批次建立就 `start`：`attachToWorker` 只在 `worker.start()` 后启动调度器；若桌面端有不经 `start` 直接跑 `runOnce` 的路径，批次不会自动推进（REST 调用仍会 `wake` 一次）。
