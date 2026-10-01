# 数据内核设计（一期，最高优先）

目标：剧本、分镜（镜头）、时间线、画布四种视图读写**同一份项目图**；任何视图里的修改，其余三个视图立刻正确、无需拷贝数据。依据：技术篇「项目图数据模型」「依赖失效」「模式切换」三节，时间线是合成节点的投影。

## 1. 决策

| 问题 | 决定 | 理由 |
|---|---|---|
| 现有 episodes / storyboards / timelines 表怎么办 | **项目图为唯一可写源；旧表变成由图生成的物化投影 + 一次性导入** | 旧页面（D05 工作台、F03 编辑器、G02 渲染计划）继续读旧表，不用重写；保留旧表主键作为 `legacy_id`，队列任务、花费记录、场景缓存键都不失效；单向物化避免双写漂移 |
| 内核放哪 | 新包 `packages/kernel`（纯 JS、零依赖、不碰数据库和网络） | 渲染进程、本地服务、测试都能用同一份逻辑 |
| 存储 | 本地 SQLite：`project_graphs`（快照）+ `graph_ops`（只追加的事务日志，tx_id 唯一） | 崩溃后用快照 + 日志重放；txId 幂等 |
| 顺序 | 全项目只有一份顺序：场景组内 `children` 数组 = 镜头顺序 = 时间线顺序 | 避免“分镜顺序”和“时间线顺序”两份数据 |

## 2. 数据模型

```
Graph {
  version: 1, project_id,
  nodes:  { [id]: Node },
  edges:  [ { id, from:{node,port}, to:{node,port}, type } ],
  groups: { [id]: { id, title, children: [nodeId...] } },   // 场景；children 有序
  group_order: [groupId...],
  layout: { [nodeId]: {x,y} },                             // 只给画布用，不进 cacheKey，不进撤销之外的失效计算
  versions: { [nodeId]: [ NodeVersion... ] },              // 不可变
  adopted: { [nodeId]: versionId }
}
Node { id, type, params, legacy_id? }
```

节点类型（一期）：

| type | 含义 | 关键 params | 输入边 |
|---|---|---|---|
| `script_line` | 剧本里的一行（旁白、对白、动作、场景标题） | `kind`, `speaker`, `text` | — |
| `shot` | 一个镜头（分镜行） | `title, description, location, time, shot_type, angle, movement, image_prompt, video_prompt, characters[], duration_ms` | 来自若干 `script_line` 的 `derives` 边 |
| `image` | 首帧图生成 | `model, seed`；生成输入 `reference_hashes[]`（可选，锁定参考图哈希，有序） | 来自 `shot` |
| `video` | 视频生成 | `model, seed`；生成输入 `tail_frame_hash`（可选） | 来自 `image` 和 `shot` |
| `narration` | 配音 | `voice, speed` | 来自 `script_line` |
| `compose` | 合成（每集一个） | `segments[]`, `music[]`, `fps`, `size`, `aigc_label` | 来自各镜头的 `video`、`narration` |

唯一事实原则（每个事实只存一处）：

- 对白文字：只在 `script_line.text`。镜头视图的“对白”= 关联行文字拼接，不另存。
- 镜头时长：`shot.params.duration_ms`（生成时长）。时间线上的裁剪存在 `compose.segments[]`：`{ id, shot_id, in_ms, out_ms, gap_before_ms, transition }`，一个镜头可以有多个片段（时间线切分得到）。
- 时间线片段的起点不存，由顺序 + `gap_before_ms` + 时长累加算出。
- 字幕轨：由关联行文字 + 其镜头起点算出；用户手工改的字幕样式存 `compose.params.subtitle_overrides[lineId]`。
- 画布坐标：只在 `layout`。

## 3. 操作（op）与事务

- 原子 op：`addNode, removeNode, setParam(node, path, value), connect, disconnect, addGroup, removeGroup, setChildren(group, ids), setGroupOrder, setLayout, addVersion, adoptVersion, setComposeSegments`。
- 事务 `Tx { tx_id, label, ops[] }`：全有或全无；应用时生成逆 op（前后值），整事务一次撤销；同一 `tx_id` 重放是空操作。
- 校验：端口类型、环检测、节点存在、`layout` 坐标为有限数、`children` 无重复、每个 shot 在且仅在一个 group 里、compose 的 segments 引用的 shot 必须存在、片段区间合法。
- 意图层（每个视图一组，只产出事务，不直接改图）：
  - 剧本：`rewriteLine, insertLine, deleteLine, splitLine, mergeLines, reorderLines`
  - 分镜：`setShotField, splitShot, mergeShots, reorderShots, moveShotToGroup, addShot, deleteShot, regenerateShot`
  - 时间线：`trimSegment, moveSegment（跨镜头边界 = 改镜头顺序，同镜头内 = 改 gap）, splitSegment, deleteSegment, setTransition, addMusic`
  - 画布：`moveNode（只改 layout）, setNodeParam（属性面板改参数）, connectNodes, disconnectNodes, addNodeAt, deleteNode`
  - 生成输入（服务内部用，不对 REST 放行）：`setShotReferences`，见 §13
- `regenerateShot` = 给 image/video 节点换种子（`setParam seed`），下游变过期，不覆盖旧版本。
- `splitShot` 现实：克隆镜头及其 image/video/narration，行按位置分配，两边的 video 都变过期（需重新生成，要花钱）；文档里写明，不假装能复用同一段视频。

## 4. 失效

`cacheKey(node) = sha256(canonical{ type, node_version, params, inputs:[ (port, cacheKey(上游)) 按端口排序 ] })`。`layout` 不参与。`compose` 的 key 还包含各 segments 和全项目镜头顺序（K3：重排镜头必须让合成过期）。

- 过期 = 没有采用版本，或采用版本的 `cacheKey` ≠ 当前 key。
- `staleSet(graph)` 为纯函数；每次事务返回 `{ invalidated: [...], revalidated: [...] }`（相对事务前）。
- 场景缓存键（对接 G02）：`sceneKey(shot)` = 该镜头各视频片段按 plan.rs 场景键字段取的摘要（素材 hash、in/out、烧进画面的字幕文字与样式、旁白素材与相对时间）；音乐、gap、转场不在其中。以 §13 的对照为准，早期写法（含转场、不含字幕）已作废。

## 5. 投影（纯函数 graph → 视图模型）

- `scriptView(g)`：场景组 → 有序行；每行带关联镜头 id 列表。
- `shotView(g)`：场景组 → 有序镜头；每个镜头带关联行文字（对白）、使用时长（来自 segments）、image/video 状态（none/stale/fresh）、cacheKey 摘要。
- `timelineView(g)`：与 F02 同形的四轨 JSON（`video/subtitle/narration/music`，毫秒整数，`storyboard_id` = `shot.legacy_id`），可直接交给 G02。
- `canvasView(g)`：节点（含 layout、stale 标记）、边、分组、折叠摘要。
- `toLegacyRows(g)`：生成 storyboards 行与 timelines 行，供物化写回旧表。

## 6. 旧表适配

- `importLegacy(db, episodeId)`：episodes.script_content 按行切成 `script_line`；storyboards → `shot`（带 `legacy_id`）；对白文字切回 `script_line` 并连 `derives` 边；已有的 video_url/image 作为采用版本；timelines → `compose.segments`。幂等：已有图则不覆盖。
- `materialize(db, graph)`：每次事务提交后，在同一 SQLite 事务里把投影写回 storyboards / timelines / timeline_* 表（只写由图派生的列），旧页面读到的永远和图一致。旧 REST 写接口在迁移期改为调用意图层。

## 7. 一致性套件（验收标准，不是截图）

放在 `packages/kernel/test/conformance/`，用 `node --test`。

1. 不变量（每个场景每一步之后都检查）：
   - I1 每个 shot 在 shotView、timelineView（未被删）、canvasView 各出现一次，顺序一致；
   - I2 每个 script_line 在 scriptView 出现一次；镜头对白 = 关联行文字拼接；
   - I3 timelineView 总时长 = 片段时长与 gap 之和；
   - I4 只改 layout 的事务，`staleSet` 与 cacheKey 完全不变；
   - I5 `staleSet` 与“把图序列化再重建后从零计算”的结果一致（独立预言机）；
   - I6 撤销再重做，图与四个投影都逐字节相同；
   - I7 崩溃重载：快照 + 日志重放得到的图与内存图相同；同 tx_id 重放无副作用；
   - I8 物化后的旧表与 `toLegacyRows` 一致。
2. 场景（每个场景分别从能做该操作的每个视图出发各跑一遍）：改一行台词、拆/合/排镜头、时间线裁剪、时间线拆分、时间线跨镜头移动、画布移动节点、画布连线/删节点、单镜头重新生成、换音色、批量撤销重做、崩溃中途重载。
3. 来回一圈：剧本 → 生成分镜 → 时间线 → 画布 → 用各视图做一次“恒等编辑”回到剧本，图不变（无损）。
4. 样例：10 个样例故事（优先复用联网会话 scriptgen 的 10 个样例输出；没有则用手写的确定性夹具，并明确标注），每个故事把全部场景跑一遍。

## 8. 明确不在这次范围

- 三个现有页面（D05 工作台、F03 编辑器、D03 分镜表）改为只调意图层：内核验收通过后再做。
- 多人协作、画布 UI（React Flow 版）、导演模式：二期之后。
- 拆分镜头后复用已生成视频：不做。

## 9. K1 实现备注（`packages/kernel` 中对规格歧义的取舍）

- **依赖**：零第三方依赖；`sha256` 用 node 内置 `crypto.createHash`（纯计算，不算 IO）。
- **组内顺序**：`group.children` 同时放 `script_line` 与 `shot`，两类各自的顺序 = 该数组按类型过滤后的子序列（仍是“一份顺序”）。校验：每个 `script_line` 和每个 `shot` 在且仅在一个组里。
- **narration 的输入**：规格写“来自 script_line”，实现为只存一条 `shot → narration` 的 `binds` 边（表示归属，不进 cacheKey），配音的行输入由绑定镜头的 `derives` 边推导并计入 key。这样“镜头含哪些行”只存一处，改画面提示词不会让配音过期。`compose` 的输入边为 `video/narration` 的 `feeds` 边。
- **端口表**：`shot.lines`（多）、`image.shot`、`video.image`、`video.shot`、`narration.shot`、`compose.video`（多）、`compose.narration`（多）；输出端口恒为 `out`；端口规则本身是分层 DAG，环检测作为纵深防御保留。
- **“生成类”节点**：`image/video/narration/compose`。过期 = 无采用版本或采用版本的 cacheKey ≠ 当前 key，所以新建图里它们全是过期（状态 `none`）。`node_version` 取每个节点类型的实现版本常量 `NODE_TYPE_VERSION`。
- **invalidated / revalidated**：只统计事务前后都存在的生成类节点；新建、删除的节点不计入。
- **segments**：存于 `compose.params.segments`，数组内跨镜头的相对顺序无意义，时间线顺序 = 镜头顺序，同一镜头内按数组顺序；`transition` 表示“进入该片段的转场”。校验要求有 compose 时每个镜头至少一个片段，且 `0 <= in < out <= shot.duration_ms`。
- **镜头对白/字幕/配音文字**：只取 `kind` 为 `narration` / `dialogue` 的行，按剧本顺序以换行拼接；`action`、`scene_heading` 不进对白（`action` 进旧表 `action` 列）。
- **时间线字幕**：每个镜头一条字幕（与 F02 `assembleFromStoryboard` 同），起点 = 该镜头第一个片段起点，时长覆盖到最后一个片段终点；`subtitle_overrides` 以镜头里第一个有声行的 id 为键取样式。时间线视图的轨道 id、片段 id 是确定性的（`track_<kind>`、片段用 segment id、`sub_<shot>`、`nar_<shot>`），转场放在视频片段的 `style.transition`。
- **时长联动**：`setShotField(duration_ms)` 同事务内让片段跟随：未裁剪的整段延长，被裁过的片段裁到新时长内；`mergeShots` 的合并时长 = 两者之和。
- **splitShot**：行按剧本顺序，前 `atLineIndex` 行留在原镜头；新镜头克隆参数与生成节点参数（含种子），无采用版本；新镜头得到一个整段片段，原镜头片段不动；没有按行数拆时长。
- **时间线 deleteSegment**：删到某镜头的最后一个片段 = 删除整个镜头（四个视图一起消失，行保留）；`moveSegment` 目标在另一镜头时整个镜头连同全部片段移动（可跨组）。
- **画布**：`compose` 不允许从画布删除；`connectNodes` 对单连接端口替换旧边，连同一条边是空事务；未给坐标的新节点不写 `layout`，画布视图用确定性自动布局补显示位置（`layout_auto: true`，不写回图）。
- **removeNode 级联**：移除节点同时清理其边、`layout`、`versions`、`adopted` 与组成员，逆 op（`restoreNode`）原样放回；`applyTx` 返回的 `inverse` 即撤销用的 op 序列，一个 tx 一个撤销步。
- **幂等与历史**：`applyTx` 为纯函数，`opts.applied`（Set）里已有的 `tx_id` 为空操作；`History` 在撤销时把 `tx_id` 移出生效集合、重做时放回。事务可带非规格字段 `meta`（如新建节点 id），应用时忽略。
- **视图 `params`**：视图里输出的 params 是键排序副本，保证快照重载（规范 JSON）前后视图逐字节相同。
- **已拆出的后续任务**：持久化（`project_graphs` / `graph_ops`）、REST、`importLegacy` / `materialize` 见 §10；一致性套件见 [kernel-conformance.md](kernel-conformance.md)，结果与缺口都写在那里。

## 10. K2 实现备注（持久化、旧表适配、REST）

代码：`packages/local/migrations/27_project_graphs.sql`、`src/kernel/{store,legacy}.js`、`src/routes/kernel.js`；测试 `test/kernelStore.test.js`、`test/kernelRoutes.test.js`。`packages/local` 通过 `@talekiln/kernel`（workspace 依赖）使用内核。

### 10.1 存储

- 表：`project_graphs(episode_id PK, snapshot, snapshot_seq, updated_at)`、`graph_ops(seq AUTOINCREMENT, episode_id, tx_id, tx, created_at, UNIQUE(episode_id, tx_id))`；另加 `graph_legacy_map(episode_id, node_id, storyboard_id)`，记录图里新建的镜头在旧表分到的行，撤销再重做时复用同一行。
- 快照内容 = 规范 JSON 的 `{graph, past, future}`（撤销/重做栈随快照保存，撤销栈最多保留 200 步）。每 `snapshotEvery`（默认 20）条日志写一次快照；打开项目 = 读快照 + 按 seq 重放其后的日志。
- 日志条目 `kind`：`apply`（原事务）、`undo`（目标 tx_id + 逆 op）、`redo`（目标 tx_id + 原 op）。undo/redo 各有自己的 tx_id（可由调用方指定作为幂等键），重放时用同一个 `History`，所以图与撤销栈都能精确复原；重放时核对目标 tx_id，对不上视为日志损坏。
- `commit` 在**一个** better-sqlite3 事务里依次：加载状态 → 同 tx_id 已在日志则空操作 → 应用事务 → 物化到旧表 → 写日志 → 视情况写快照。任一步抛错整体回滚，图、日志、快照、旧表都不变。意图类提交用 `commit(db, ep, (graph) => tx, {tx_id})`，在事务里基于最新图构造，避免读-改-写竞态。
- 物化可能给新镜头分配 `storyboards.id`：这些绑定（`shot_id -> legacy_id`）写进同一条日志的 `binds` 字段，并在重放时回放到节点上，所以重载后 `shot.legacy_id` 与活图一致。
- 持久性：与队列一致，依赖连接的 WAL；要断电级保证由调用方把 `synchronous` 设为 FULL（store 不改 pragma）。

### 10.2 导入（`importLegacy`）

- 已有项目图则原样返回（`created:false`），不覆盖。
- `episodes.script_content` 用 `parseScript` 按行切成 `script_line`；与某镜头的 dialogue / narration / action 列逐字相同的行并入该镜头的行（不重复），其余放进首个“剧本”组。
- 镜头按 `storyboard_number` 排序，连续且 `(segment_index, segment_title)` 相同的归为一个场景组（组名 = `segment_title`）。每个镜头的 `action`、`narration`、`dialogue` 列按换行切成 `action`/`narration`/`dialogue` 行并连 `derives` 边；对白行保留整行文字（含“说话人：”），`speaker` 另存，物化时逐字写回。
- `video_url`、`local_path || image_url`、`narration_audio_local_path || audio_local_path` 导入为 image/video/narration 的采用版本（cacheKey 取导入时的当前值，所以是 fresh；`asset.hash` 是引用字符串的摘要，不读文件）。
- 旧时间线的视频轨 → `compose.segments`（片段 id = 旧 clip id，起点差折成 `gap_before_ms`，裁剪区间取 `src_in/out` 并夹到镜头时长内，转场取 `style.transition`），音乐轨 → `compose.music`；没有旧时间线的镜头得到整段片段。

### 10.3 物化（`materialize`）

- 只写由图派生的列：`storyboard_number, segment_index, segment_title, title, description, location, time, duration, dialogue, narration, action, atmosphere, image_prompt, video_prompt, characters, shot_type, angle, movement`，以及 `video_url`（仅在图有采用视频且不同时）、`status`、`deleted_at`。没有变化的行不写（`updated_at` 也不动）。
- 图里已不存在的镜头 → `deleted_at` 软删除；撤销后同一行取消软删除。新镜头插入新行并绑定 `legacy_id`。
- `dialogue/narration/action` 列由各自 `kind` 的行拼接（与内核 `shotDialogue` 不同：后者把旁白也算对白，写回旧表会污染 `dialogue` 列）。
- 时间线：用 `timelineView` 重写 `timelines/timeline_tracks/timeline_clips`（保留轨道行、音量、静音和 `settings.mix`），内容无变化则不写。`timeline_clips.id` 是全库主键，内核确定性 id 加 `e<episode_id>_` 前缀，旧 UUID 片段 id 原样保留。
- 状态映射：旧表 `status` 取值有 `draft`（schema 默认）、`pending`（服务层新建）、`processing`/`completed`/`failed`（生成流程）。图只表达“有无采用产物”：有 → `completed`；无且旧值为 `completed` → `pending`；`processing`/`failed` 是队列运行态，原样保留；其余不动。缺口：图的 `stale`（有产物但已过期）在旧表无对应值，旧页面仍显示 `completed`，过期信息只在内核视图里；`error_msg` 不由图管理。

### 10.4 REST（`/api/v1`，令牌由 app 级 `localTokenGuard` 统一校验）

| 方法 路径 | 说明 |
|---|---|
| `GET /episodes/:id/graph` | 全图 + `stale` 集合 + `seq` + `can_undo/can_redo` |
| `GET /episodes/:id/views/{script,shots,timeline,canvas}` | 四个视图（`shot` 同 `shots`） |
| `POST /episodes/:id/tx` | `{tx_id, label, ops}` 原始 op 事务 |
| `POST /episodes/:id/intent` | `{view, name, args, tx_id?}`；只放行规格 §3 的 26 个意图（K4 起含 `canvas.setNodeParam`），`setVoice`/`recordGeneration`/`setShotReferences`/`moveNodes` 等未放行 |
| `POST /episodes/:id/undo`、`/redo` | `{tx_id?}` |
| `POST /episodes/:id/import-legacy` | 首次 201，已存在 200 |
| `GET /episodes/:id/versions` | 只读（P2-D）：每个生成类节点的版本列表，含采用标记、是否匹配当前输入（`current`）、产生时间（取自加入该版本的日志，导入版本为 null）、资产与元数据摘要 |
| `GET /episodes/:id/history?limit=` | 只读（P2-D）：`graph_ops` 日志（新在前，默认 200、最多 1000），每个事务带 `state`（applied / undone / discarded，取自真实撤销栈）与回到该步所需的 `undo_steps` / `redo_steps`，undo/redo 记录本身为 `event` |

返回体为 `{applied, tx_id, seq, invalidated, revalidated, stale, can_undo, can_redo, meta?}`（`meta` 带新建节点 id）。错误：内核错误码原样返回（`INVALID_OP`/`VALIDATION`/`INTENT` → 400，`NOT_FOUND`/`GRAPH_NOT_FOUND` → 404，`NOTHING_TO_UNDO`/`NOTHING_TO_REDO` → 409），均已进错误码表。`addShot` 的 `legacy_id` 参数被丢弃（只由物化分配）。

### 10.5 仍绕过内核的旧写路径（后续要改成调意图层）

> 状态更新：镜头与时间线的编辑类写接口已在 §12 改道经内核；本节原清单保留作历史记录，现状以 §12.5「剩余绕过内核的写入」为准。

下列接口仍直接写旧表，之后内核提交的物化会按图覆盖其派生列，或图感知不到这些变化：

- 镜头增删改：`POST/PUT/DELETE /storyboards`、`/storyboards/:id/insert-before`、`PUT /episodes/:id/storyboards/order`、`POST /storyboards/batch-infer-params`、`split-by-audio`、各类 polish / prompt 接口；
- 整集重建：`POST /episodes/:id/storyboards`（生成分镜，整体替换）、`scriptgen` 的 createProject、`dramaImport`/`novelImport`、`PUT /dramas/:id/episodes`（改 `script_content`）；
- 时间线：`PUT /timelines/:id`、`POST /timelines/:id/clips`、`PATCH /timelines/:id/clips/:clip_id`、`POST /timelines/episode/:id/assemble`、`POST /timelines/:id/music`（F02/F05 编辑器）；
- 生成结果落库：图片/视频/配音流程直接写 `storyboards.video_url / local_path / image_url / *_audio_local_path / status`，工作台 `adopt-video` 写 `adopted_video_id`。这些应改为 `recordGeneration`（新增版本并采用）；在此之前物化对 `video_url` 只增不清，不会抹掉旧流程写入的视频，但图里看不到它；
  - **I1 已处理（图片/视频）**：经队列的出图/出视频任务成功后由 `generation/service.js` 在一次 commit 里 `addVersion + adoptVersion`（cacheKey 取建任务时的值），物化 `video_url / local_path / image_url / status`；旧的同步 `/videos`、`/images` 路由仍直接写旧列（界面默认不再调用，`generation.legacy_enabled` 默认关）。配音（narration）与工作台 `adopt-video` 仍未接。
- `episodes.script_content` 不由物化写回（剧本行改动只在图里）。

### 10.6 已知取舍

- 导入后旧页面的字幕轨会多出“旁白镜头”的字幕（旧装配只取 `dialogue` 列，内核把旁白行也算字幕）。
- `segment_index` 物化为“含镜头的场景组在全项目的序号”，与旧值同序同分组，但绝对值可能不同。
- 旧时间线里手工编辑过的字幕文字/样式不导入（字幕由行文字推导）；视频片段顺序与 `storyboard_number` 不一致时以镜头顺序为准。
- 每次 `commit` 都从快照 + 日志重放，没有进程内缓存（日志最多 `snapshotEvery` 条，成本可控）。

## 11. I2 实现备注（生成项目建图、旁白写回、词级字幕、真实片长）

代码：`services/scriptgenService.js`、`voiceover/service.js`、`routes/voiceover.js`、`timeline/kernelAssemble.js`、`packages/kernel/src/projections.js`、`kernel/legacy.js`；测试 `local/test/narrationFlow.test.js`、`kernel/test/realDuration.test.js`。

- **scriptgen 落库**：`persist` 在同一个 SQLite 事务里写 drama / episode / storyboards / `characters`（按名去重）/ `episode_characters`，随后 `importLegacy` 建项目图，所以每个生成的项目一开始就有 script_line、shot、group、compose；返回体多 `character_ids` 与 `graph` 计数。路由/服务可注入 `{ resolveProvider, createProviders }`，测试用假文本模型。
- **配音** `POST /api/v1/episodes/:id/voiceover` `{ shots:[镜头图 id 或旧分镜 id] | all:true, voice?, force?, confirm? }`；`GET /voiceover/voices`。不带 `confirm`：只估价（`confirm_required`、`estimate`、`max`、`chars`、`allowed`，价格仍是示例价），不合成不写图。`confirm:true`：先对总字数过 `spend.check`（超限 402 `SPEND_LIMIT`），再逐镜合成（并发 2）。`all` 跳过旁白已新鲜且音色相同的镜头，`force:true` 全部重做。单镜失败不影响其他镜头；全部失败 502 `VOICEOVER_FAILED`。成功后在 `spend_log` 记 `voiceover:*` 估算行（直接走门面，不进 ai_tasks / 任务中心）。
- **配音文字**：只取 script_line（旁白/对白；对白行去掉“说话人：”前缀），不另存。音色经 `setVoice` 写进 narration 节点参数（所以换音色会让旧旁白过期），再合成，再在一个事务里基于最新图 `recordGeneration`；合成期间台词或音色被改过则不采用（`STALE_INPUT`）。
- **旁白版本** = `asset { ref:'audio/narration/…', hash, kind:'audio' }` + `metadata { duration_ms, voice, format, text_sha, words, cues, aspect_ratio }`；`recordGeneration` 新增可选 `metadata` 入参（video 版本用 `metadata.duration_ms` 记真实片长）。物化把采用的旁白 ref 写进 `storyboards.narration_audio_local_path`（只增不清，导入来的版本不回写）。
- **词级字幕**：不新增第二份事实源，也不放进 `compose.params`：字幕块（相对镜头起点的 `{start_ms,end_ms,text}`，由 `splitCues(words)` 算出）是那次配音的产物，存在旁白版本 metadata 里。`timelineView` 只在旁白新鲜（采用版本 cacheKey = 当前 key，即行文字、音色没变）时按块输出 `sub_<shot>_<n>`，否则退回整镜一条 `sub_<shot>`（文字取自行）。`subtitle_overrides[lineId]` 的样式对所有块生效。字幕块被夹到镜头时间范围内；旁白片段时长取 `min(镜头跨度, 音频时长)`。
- **真实片长**：`effectiveSegments`（只读投影）——采用的 video 版本带正整数 `metadata.duration_ms`（R）时，到末尾的片段（out == 目标时长）伸缩到 R，其余裁到 R 以内；存储的 `shot.duration_ms` 与 `compose.segments` 不变。`timelineView`、`shotView.used_ms` 用它，`shotView` 另给 `real_ms`。物化后旧时间线表同步。注意：改写镜头目标时长会改 shot 的 cacheKey 进而让图/视频过期，所以不用“回写 duration_ms”的办法。
- **装配**：`timeline/kernelAssemble.js` 的 `assembleFromKernel(db, ep, {replace})` 与 `assembleFromStoryboard` 同语义（已存在且未 replace -> 409），但经内核；`replace` 重置片段为整段、清字幕样式覆盖（音乐保留）。旧路由 `POST /timelines/episode/:id/assemble` 尚未改调（路由归 I3）。
- **未做**：配音进队列/任务中心；多说话人分别配不同音色（现在一个镜头一个音色）；台词比镜头长只返回时间不处理（`timelineView` 会夹掉越界字幕）；除 `longxiaochun_v2` 外音色未实测；字幕样式界面。

## 12. 旧写接口改道（I3）：兼容层与剩余绕过

代码：`packages/local/src/kernel/compat.js`；测试 `test/kernelCompat.test.js`。URL 与返回形状不变，实现改为：确保该剧集有图（没有就自动 `importLegacy`）-> 把请求翻译成内核意图/事务 -> `store.commit`（同一 SQLite 事务里物化回旧表）-> 从物化后的旧表读出响应。图里没有的列（见 12.5）仍照旧直接写，但与图的提交放在同一个 SQLite 事务里；任何一步失败整体回滚，图、日志、旧表都不变。

### 12.1 改道的接口

| 接口 | 翻译成 |
|---|---|
| `POST /storyboards` | `insertLine`（新镜头的台词/旁白/动作行）+ `addShot`；`storyboard_number` = 插在全局第 n 个位置；`segment_title` 命中已有段落则放进该段落；`scene_id`、`result` 直接写 |
| `POST /storyboards/:id/insert-before` | `addShot`（目标镜头前、同段落） |
| `PUT /storyboards/:id` | 镜头字段 -> `setShotField`（`duration` 秒 -> `duration_ms`，片段随之联动）；`dialogue/narration/action` -> 对应 kind 的行：按位置 `rewriteLine`，多删少补；`segment_title` -> `moveShotToGroup`；其余列直接写 |
| `DELETE /storyboards/:id` | `deleteShot`（旧表软删除；台词行留在剧本里） |
| `PUT /episodes/:id/storyboards/order` | 全局重排 `setChildren`（见 11.2） |
| `POST /storyboards/batch-infer-params` | `movement` -> `setShotField`（一个事务）；`lighting_style`、`depth_of_field` 直接写 |
| 提示词润色 / 重建 / 角色补全 | `video_prompt`（`polishClassicVideoPromptStream`、`rebuildVideoPromptForStoryboard`）、`characters`（图生流程补全角色）-> `compat.setShotFields`；`polished_prompt`、`universal_segment_text`、`continuity_snapshot` 不在图里，仍直接写 |
| `POST /storyboards/:id/split-by-audio` | 第一个方案改写原镜头（行重写、时长/标题/景别/运镜随之变、解除视频与配音的采用版本），其余方案 `addShot` 在其后；新镜头克隆图里的参数；`result`、`scene_id` 等图外列直接写 |
| `POST /timelines/episode/:id/assemble` | 先把旧表里新生成但图里还没采用的素材补成采用版本，再把每个镜头的片段重置为整段（gap 0、无转场），清空音乐与字幕样式覆盖（一个事务）；没有 `replace` 且已有时间线 -> 409 `CONFLICT`；没有分镜 -> 400 `NO_STORYBOARDS` |
| `PUT /timelines/:id` | 把完整时间线与当前图比对，翻译成 `setComposeSegments` / 镜头重排 / `deleteShot` / 行改写 / `subtitle_overrides` / `music`（见 11.2） |
| `POST /timelines/:id/clips`、`PATCH …/clips/:clip_id`（move / trim / split / delete）、`POST /timelines/:id/music` | 在内存里用与旧实现相同的变换（`timeline.transforms.*`）算出新时间线，再走与 PUT 同一条翻译，所以校验与报错（400、404、409 `OVERLAP`）与旧行为一致 |

### 12.2 时间线翻译规则（`translateTimeline`）

- **视频轨 = `compose.segments`**。起点由“顺序 + `gap_before_ms`”累加，所以任意不重叠的绝对起点都能表达：`gap = 起点 - 上一片段终点`。移动某片段会同时调整它后面的 gap，其余片段的绝对位置不变（与旧行为一致）。
- 片段顺序里镜头首次出现的次序 = 镜头顺序。组内重排 = `setChildren`；跨段落移动的镜头并入它新位置前一个镜头所在的段落（最长不降子序列里的镜头保持原段落）。`PUT order` 同此规则，所以旧的“任意全排列”仍可用，但被移动的镜头会换段落（旧实现里段落标记留在原行上）。
- 某镜头一个视频片段都不剩 = 删除该镜头（内核 `deleteSegment` 的语义，四个视图一起消失，台词行保留，可撤销）。旧实现只是把片段从时间线移走、分镜还在。
- 没有素材的片段（`src_in/out` 为空）：裁剪只改时长（`in` 不变）；新拆出的片段从同镜头上一片段的终点开始。
- 字幕轨由台词行推导：接受文字修改（行数与台词行数一致时逐行改写；该镜头没有台词行时新建旁白行）与样式修改（写 `compose.params.subtitle_overrides[首个有声行 id]`）；字幕/配音的起止时间忽略，永远跟随视频片段。
- 音乐轨 = `compose.params.music`，整体替换（绝对起点，可重叠）；音乐片段的 `text`（曲目名）不进图。
- 轨道音量、静音、混音（`timelines.settings.mix`）不在图里，保存时直接写时间线表（见 12.5）。
- 每次 PUT / 片段编辑仍保证 `version` +1（图没变化时补一次），旧编辑器的乐观并发不变。

### 12.3 拒绝与近似的情形（全部有错误码表条目）

| 情形 | 结果 |
|---|---|
| 视频片段没有 `storyboard_id` 或指向不存在的分镜 | 409 `GRAPH_UNSUPPORTED_EDIT` |
| 手改视频片段的素材（`asset_ref`）、音量、`style` 里除 `transition` 以外的键，或把片段改属于另一个分镜 | 409 `GRAPH_UNSUPPORTED_EDIT` |
| 同一分镜的片段被别的分镜的片段隔开 | 409 `TIMELINE_ORDER_UNSUPPORTED` |
| 字幕：删除、同一分镜多条（拆分）、无对应分镜、行数与台词行数对不上 | 409 `GRAPH_UNSUPPORTED_EDIT` |
| 配音：改素材/音量、单独删除 | 409 `GRAPH_UNSUPPORTED_EDIT` |
| `PUT /storyboards/:id` 的 `segment_title` 指向不存在的段落 | 409 `GRAPH_UNSUPPORTED_EDIT`（镜头只能在已有段落间移动） |
| 片段超出镜头生成时长、`duration` 为负/非数字等 | 400 `VALIDATION` / `INTENT`（整体回滚） |
| 近似：`duration` 为 0/空 -> 5 秒默认；`segment_index` 忽略（由段落顺序推出）；`storyboard_number` 物化后重排为 1..N 连续；字幕/配音起止时间忽略；音乐片段曲目名丢失；`dialogue/narration/action` 列由行文字拼接，行内换行规则同导入；被多个镜头共用的行改写时对该镜头断开再新建，不牵连别的镜头 | — |
| 旧规则照旧：重叠 409 `OVERLAP`、非法值 400、版本过期 409 `CONFLICT`、片段不存在 404 | — |

### 12.4 其它行为变化

- `assemble`：字幕轨现在由台词行推导（旁白行也出字幕，见 §10.6），不再只取 `dialogue` 列；片段 id 为 `seg_N`。
- 整集重建分镜（`generateStoryboard`，流式增量入库）直接重写 `storyboards` 行：这些入口在软删除旧行处调用 `compat.resetGraph` 丢弃旧图（撤销历史随之清空），下次写入从新分镜重新导入，避免旧图在下次物化时把新行软删除。
- 旧生成流程直接写的素材列图里不知情：`assemble` 时补成采用版本；其余时候以旧表为准（物化对 `video_url` 只增不清）。
- `splitStoryboardByAudio` / `rebuildVideoPromptForStoryboard` 在仓库里引用了未定义的函数（`parseDialogueToEntries`、`charSpeechWeight`、`inferPrimaryOnScreenCharacter`、`loadCharactersForStoryboardPrompt`、`buildCharacterAppearanceText`、`buildVoiceAnchorMap`、`buildCharacterVoiceAnchors`），与本改动无关，调用即抛 ReferenceError；本次只改了它们的写入路径，图写入部分由 `compat.splitShotByPlans` 的测试覆盖。

### 12.5 剩余绕过内核的写入

下面这些仍直接写旧表（物化只写“由图派生的列”，不会覆盖它们；但图和视图看不到它们）：

- **生成结果列（归生成编排 I1，应改为 `recordGeneration`）**：`storyboards.video_url / local_path / image_url / audio_local_path / narration_audio_local_path / status / error_msg / adopted_video_id / first_frame_image_id / last_frame_*`、`composed_image`、`main_panel_idx`（`videoService`、`imageService`、`routes/audio.js`、工作台 `adopt-video`、`upscale`、`tailFrameLinkService`、`storyboardFrameBinding`、`dramaImportService` 的图片绑定）。在此之前：图里的采用版本不更新、`assemble` 才会同步素材、`status` 里 `processing/failed` 仍是队列运行态。
- **`episodes.script_content`（归剧本/配音/字幕 I2）**：`PUT /dramas/:id/episodes`（`dramaService`）、`scriptgen` 建项目、`dramaImport` / `novelImport`；剧本行改动只在图里，物化不写回此列。
- **图外的分镜列与关联表**：`scene_id`、`result`、`polished_prompt`、`continuity_snapshot`、`universal_segment_text`、`creation_mode`、`layout_description`、`lighting_style`、`depth_of_field`、`angle_h/v/s`；`frame_prompts`、`storyboard_characters`、`storyboard_props`。
- **新剧集的初次入库**：`scriptgenService.persist`、`sampleProjectService`、`dramaImportService` 与服务层 `storyboardService.createStoryboard/updateStoryboard` 在图还不存在时直接写行，首次经 REST 写入时才导入；若对已有图的剧集调用它们，图会在下次物化时盖掉这些行——此类入口应走 `compat`。
- **时间线表里图不管的部分**：轨道 `volume/muted`、`timelines.settings.mix`（`PUT /timelines/:id` 直接写）；服务层 `timeline.saveTimeline/addClip/…/assembleFromStoryboard` 保留为库函数（仅测试与兼容使用，生产路由已不再调用）。
- **整集重建分镜**：直接写行，靠 `compat.resetGraph` 作废旧图（见 11.4），不经意图层。

## 13. U1 四视图界面（剧本 / 分镜 / 时间线 / 画布）

代码：`apps/renderer/src/stores/projectViews.js`（共享 store）、`utils/projectViews.js`（纯逻辑，`test/projectViews.test.js`）、`components/ViewSwitcher.vue`、`views/ScriptView.vue`、`views/CanvasView.vue`、`components/canvas/*`；浏览器端到端 `apps/renderer/test/e2e/fourViews.e2e.mjs`（缺 Chromium 时跳过；`--shots docs/screenshots` 重新截图）。

- 路由：`/episodes/:id/script`、`/episodes/:id/canvas`、`/episodes/:id/storyboard`（查出项目后跳到 `/project/:dramaId/storyboard?episode=`）、既有 `/episodes/:id/timeline`；入口在项目列表卡片「四视图」与剧集卡片。
- 共享 store 只存服务端数据（graph / stale / seq / can_undo / can_redo + 四个视图投影）和两项 UI 状态（选择、播放头）。所有编辑 `POST /intent`（画布属性面板里没有意图的字段用 `POST /tx` 的 `setParam`），返回后整体回读；失败时显示内核的错误文案并回读。
- 选择 `{kind: line|shot|segment|node, id}` 切换视图时不变，各视图用 `focusIn(view, selection)` 找对应对象（行 → 第一个关联镜头 → 第一个视频片段 → 画布节点）。
- 顶栏撤销 / 重做 / Ctrl+Z / Ctrl+Shift+Z = 内核历史；时间线页保留编辑器自己的 Ctrl+Z（走 `PUT /timelines` 改道后同样进内核历史）。分镜表、时间线编辑器保存完成后刷新共享 store，被顶栏撤销 / 重做后重新读取各自的旧表数据。
- 局限：画布没有新增节点 / 场景组改名的界面；分镜页与时间线页的内部数据仍来自旧表（物化），不是投影直读；画布未存 layout 的节点用显示用的自动布局（不写回图）。

## 14. K4：生成输入进 cacheKey、画布改参数意图、sceneKey 对照 G02

代码：`packages/kernel/src/{graph,projections}.js`、`intents/{canvas,shot,util}.js`、`packages/local/src/kernel/inputs.js`、`generation/service.js`；测试：一致性套件新增 4 个场景、`kernel/test/sceneKeyG02.test.js`、`local/test/generation.test.js` 新增一组。

### 14.1 生成输入是节点参数
- 以前锁定的参考图、尾帧、所选模型只进队列幂等键，不进 cacheKey，改了它们新鲜的节点仍显示“新鲜”。现在是节点自己的参数：`image.model`、`image.reference_hashes[]`、`video.model`、`video.tail_frame_hash`（后两个可选参数，空 = 参数不存在，所以与旧图的 cacheKey 完全兼容，设置再清除回到原 key）。**不是特例**：和 `seed`、`voice` 一样走 `params -> cacheKey`，预言机（嵌套签名里本来就含 params）自动覆盖。
- 意图 `shot.setShotReferences(shot, { image_model, video_model, reference_hashes, tail_frame_hash })`：没给的字段不动，空数组 / null / 空串 = 清除，值没变不产生 op。校验表 `NODE_PARAM_RULES`（graph.js）与画布共用。
- 效果（一致性场景 `change_references / change_tail_frame / change_image_model / change_video_model`，分镜入口 `setShotReferences`、画布入口 `setNodeParam`，两入口终态必须相同）：改参考图或出图模型 -> 该镜头 image + video + 合成过期；改尾帧或视频模型 -> video + 合成过期；其余镜头、配音不动；生成一次后改回去，cacheKey 回到最初的值，最初的版本 v_1 直接重新采用（不新增版本 = 零成本）。
- 写入方：生成服务在估算/建任务前同步（估算只在副本上演算，建任务前提交一个事务）：先写参考图哈希与出图模型，在这张图上做计划得到首帧形态（决定尾帧是否生效、选哪种视频模型），再写尾帧与视频模型。参考图锁定/解除（`PUT/DELETE /reference-locks/:type/:id`）和尾帧绑定（`bindStoryboardFrameImage` 的尾帧分支）在改完旧表后调 `syncReferences`，所以界面上的“过期”立刻出现（只写参考图与尾帧，不碰模型）。其余直接写 `last_frame_*` 列的入口（见 12.5）不同步，由下次估算/建任务前的同步兜底。
- 任务 `_gen.inputs` 记录建任务时的输入，写回时进版本的 `metadata.inputs`。
- **模型基线**：改动之前导入/生成的版本不知道当时用了哪个模型。首次把“所选模型”记进参数时，原本新鲜的采用版本被改记到新 key（别名版本 `rb_<key前12位>`，`source:'rebase'`，`rebased_from`，资产与元数据照搬，`metadata.inputs.model` 记下现值），不会让已有素材平白过期、白白重做花钱；版本已记录模型后，换模型一律是真实变化。参考图与尾帧的变化永远是真实变化（旧素材没带过这些输入）。没有记录模型的旧版本，在提示词/上游/参考图/尾帧与现在一致时也算缓存命中（采用时同样改记成别名）。
- 顺带修了 I1 的一个字段名错误：生成服务写版本元数据用的是 `meta`，内核（真实片长投影）读的是 `metadata`，所以生成视频的真实时长一直没进时间线；现统一为 `metadata`。

### 14.2 `canvas.setNodeParam(g, nodeId, path, value)`
- 只允许该节点类型白名单里的顶层参数（`NODE_PARAM_RULES`：script_line 的 kind/speaker/text；shot 的各文字字段、characters、duration_ms；image 的 model/seed/reference_hashes；video 的 model/seed/tail_frame_hash；narration 的 voice/speed；compose 的 fps/size/aigc_label）并校验取值；`segments / music / subtitle_overrides` 拒绝（有时间线意图）。可选参数用 `null` 清除，必填参数清除或类型不对 -> `INTENT`（REST 400）。值没变 = 空事务。镜头 `duration_ms` 委托给 `setShotField`（片段联动）。事务标签 `setNodeParam`。
- REST `POST /episodes/:id/intent` 白名单加入 `canvas.setNodeParam`（args：`node_id, path, value`），错误码沿用 `INTENT`，错误码表无需新增。一致性套件的 `canvasEdit` 已改为调用它（原来是一条裸 `setParam` 事务）。

### 14.3 sceneKey 对照真实 G02 渲染计划
`render.plan`（`packages/core/src/plan.rs`）按**视频片段**切场景；场景键 = 渲染器版本 + 输出设置 + 视频（素材身份、srcIn/srcOut、音量）+ 与该场景时间重叠的字幕（相对起止、文字、样式）+ 重叠的旁白（相对起点、时长、素材身份、srcIn、音量）。对照后的发现与修正：

| 发现 | 处理 |
|---|---|
| 字幕文字、样式**会**进 G02 场景键（字幕是烧进画面的），旧 sceneKey 不含 -> 改字幕文字/样式后内核说“场景没变”，G02 其实要重渲染 | 内核 sceneKey 纳入字幕文字、样式与相对时间 |
| 转场（`style.transition`）G02 完全不读，渲染器也没实现转场；旧 sceneKey 含转场 -> 内核说变了，G02 没变 | 转场移出 sceneKey；等渲染器实现转场时，plan.rs 与内核要同时加回（并升 `RENDERER_VERSION`） |
| G02 用片段的有效 in/out（已按真实片长伸缩），旧 sceneKey 用存储的 segments | 改用 `effectiveSegments` 同一份时间线推导 |
| 旧 sceneKey 只看 video 资产，时间线在没有视频时用首帧图当素材 | 与 `timelineView` 同规则：视频，否则图片 |
| G02 是每片段一个场景键，内核是每镜头一个键 | 镜头键 = 它所有片段场景键依据字段的摘要；对照测试逐镜头比较“变没变”，不要求键值相同 |
| gap 是 G02 里独立的“空场景”，不属于任何镜头 | gap 不进镜头键；对照测试显示改 gap 不改任何镜头的两种键 |

对照测试 `kernel/test/sceneKeyG02.test.js`：用真实 `lycore` 二进制（`cargo build` 得到 `packages/core/target/*/lycore`）的 `render.plan`，素材换成内容 = `asset.hash` 的临时文件（`hashContent` 模式）。17 种编辑，两边逐镜头一致：对白文字、对白改动作行、字幕样式、裁剪、切分、改时长、重新生成视频、重新配音 -> 两边都变；音乐、画布移动、转场、镜头标题、生成输入参数、语速参数、镜头重排、改别的镜头的 gap、删别的镜头 -> 两边都不变。没有二进制时只跑按 plan.rs 字段写的 JS 移植；有二进制时还校验该移植与真实 `render.plan` 逐键一致。

## 15. P2-D：命令面板、键位预设、版本历史界面

代码：`apps/renderer/src/{utils/commandRegistry.js,utils/builtinCommands.js,components/CommandPalette.vue}`、`utils/keymapPresets.js`、`components/VersionHistoryDrawer.vue`、`utils/versionHistory.js`；后端只读接口见 §10.4；浏览器检查 `test/e2e/{commandPalette,versionHistory}.e2e.mjs`（`--shots docs/screenshots`）。

- 命令面板：全局组件（App.vue），Ctrl+K 打开（动作 `palette.open`，全局作用域，可改键）。命令来自注册表（`registerCommand` / `registerCommandProvider`，返回卸载函数，同 id 覆盖，预留给插件）；内置命令按当前路由是否在剧集页面显示；镜头与台词行由 provider 按输入搜索（只认子串）。最近使用存 localStorage（最多 8 条）。
- 键位：全局作用域动作与任意作用域的同一组合键算冲突；预设 = 对默认（剪映）键位的整体替换表，自定义是预设之上的覆盖项；导出 / 导入 JSON（`format: talekiln-keymap`）。Premiere 预设里切分是 Ctrl+K，所以命令面板在该预设下改为 Ctrl+Shift+P。
- 版本历史（顶栏“历史”按钮或命令面板打开的抽屉）：节点版本页列出版本并可采用；操作历史页列出 `graph_ops` 并可回到 / 恢复到某一步。**写入路径**：采用版本 = `POST /tx` 的 `adoptVersion` op（内核已有，REST 白名单里没有对应意图，所以没有新增意图或写入旁路；一步可撤销）；回到 / 恢复 = 连续调用现有 `undo` / `redo`。
- 局限：版本没有“预览视频”；缩略图只有图片版本；历史只显示最近 200 条日志；撤销栈最多保留 200 步（更早的步骤标为已被覆盖，不可跳转）；macOS 上 Ctrl 与 ⌘ 视同一个键（沿用 keymap.js 既有约定），未在真机验证。
