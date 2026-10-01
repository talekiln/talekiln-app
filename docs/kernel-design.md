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
| `image` | 首帧图生成 | `model, seed` | 来自 `shot` |
| `video` | 视频生成 | `model, seed` | 来自 `image` 和 `shot` |
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
- 校验：端口类型、环检测、节点存在、`children` 无重复、每个 shot 在且仅在一个 group 里、compose 的 segments 引用的 shot 必须存在、片段区间合法。
- 意图层（每个视图一组，只产出事务，不直接改图）：
  - 剧本：`rewriteLine, insertLine, deleteLine, splitLine, mergeLines, reorderLines`
  - 分镜：`setShotField, splitShot, mergeShots, reorderShots, moveShotToGroup, addShot, deleteShot, regenerateShot`
  - 时间线：`trimSegment, moveSegment（跨镜头边界 = 改镜头顺序，同镜头内 = 改 gap）, splitSegment, deleteSegment, setTransition, addMusic`
  - 画布：`moveNode（只改 layout）, connectNodes, disconnectNodes, addNodeAt, deleteNode`
- `regenerateShot` = 给 image/video 节点换种子（`setParam seed`），下游变过期，不覆盖旧版本。
- `splitShot` 现实：克隆镜头及其 image/video/narration，行按位置分配，两边的 video 都变过期（需重新生成，要花钱）；文档里写明，不假装能复用同一段视频。

## 4. 失效

`cacheKey(node) = sha256(canonical{ type, node_version, params, inputs:[ (port, cacheKey(上游)) 按端口排序 ] })`。`layout` 不参与。`compose` 的 key 还包含各 segments。

- 过期 = 没有采用版本，或采用版本的 `cacheKey` ≠ 当前 key。
- `staleSet(graph)` 为纯函数；每次事务返回 `{ invalidated: [...], revalidated: [...] }`（相对事务前）。
- 场景缓存键（对接 G02）：`sceneKey(shot) = sha256{ 采用的 video 版本资产 hash, 该镜头所有 segments 的 in/out/transition, 旁白采用版本 hash }`；音乐不在其中。

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
