# 数据内核一致性验收报告

> 由 `node packages/kernel/test/conformance/report.js` 生成（2026-10-02），请勿手改；规格见 [kernel-design.md](kernel-design.md) 第 7 节。

## 1. 结论

- 场景 × 入口视图 × 故事共 **1027** 次执行（39 个场景，13 个样例故事，另有 228 次“不同入口终态必须一致”的等价性比较），**失败 0**，另有 26 次因故事形状不适用而跳过（见第 4 节）。
- 每次执行的**每一步**之后检查 I1–I8，并做逐步撤销/重做、重复 tx_id、独立预言机比对；执行结束再做整段撤销重做链和“每个事务边界崩溃重放”。
- 套件抓到 **2 个内核缺陷**，均已修复并各有回归测试（第 6 节）。
- 其余套件：来回一圈 + 意图足迹 + 携带表 0/0；事务原子性 + 意图错误处理 0/0；随机会话（3 个种子 × 13 故事 × 18 步） 0/0；套件自检（变异）与缺陷回归 0/0。

## 2. 每一步检查的不变量

| 编号 | 检查内容 | 怎么检查（独立性） |
|---|---|---|
| I1 | 每个镜头在 shotView / timelineView / canvasView 各出现一次，顺序一致，同镜头片段连续，clip 的 storyboard_id = legacy_id | 期望顺序由 `oracle.js` 直接遍历 group_order / children 得出，不用内核的 orderOf |
| I2 | 每行在 scriptView 出现一次；line↔shot 关联双向一致；镜头对白 = 关联旁白/对白行拼接；画布上的 line→shot 边与剧本关联一一对应；字幕轨 = 对白文字 | 关联与对白由 oracle 直接读 edges 重新推导 |
| I3 | 时间线总时长 = 片段与 gap 之和；每个片段起点逐个独立累加比对；无重叠；毫秒整数 | 起点在 `invariants.js` 里自己累加 |
| I4 | 只含 setLayout 的事务：cacheKey、staleSet、场景缓存键、除 layout 外的图、script/shot/timeline 三个视图逐字节不变 | 事务前后对比 |
| I5 | staleSet 与“序列化→重建→从零计算”一致；四个视图与重建图的视图逐字节相同；**独立预言机**与内核逐节点一致，且 tx.invalidated/revalidated 与预言机差异一致 | 预言机 `oracle.js`：自己的嵌套签名 + sha1，产出内容签名写进 asset.hash，不读内核 cache_key |
| I6 | 每步：逆 op 还原到事务前逐字节相同（含四个视图）、重做回到事务后、撤销恰好使“该事务让其过期的节点”重新新鲜；会话结束：撤销链/重做链在每个边界与记录的状态逐字节相同 | |
| I7 | 每个事务边界崩溃：快照 + 日志尾重放 = 内存图（含四视图）；日志里每条重复一次/最后一条重复无副作用；快照已含前 k 个事务而日志从头重放（applied 集合）无副作用；同 tx_id 重复提交为空操作；会话中途崩溃后继续编辑 | |
| I8 | `toLegacyRows` 内部一致：storyboards 行 ↔ shotView（对白、时长、状态、video_url、场景归属、动作列）↔ timeline clips 的 storyboard_id（同一 legacy_id 的片段数与总时长）；旧表时间线 = timelineView。**注意：未做 materialize 到 SQLite（持久化在另一条任务线），所以这里只验证纯内核一致，不验证“物化后的旧表”。** | |
| 写入范围 | 场景步骤声明“这次编辑允许改哪些图路径”，实际改动路径必须落在其中（防止一个视图的编辑悄悄改了它不携带的数据） | `oracle.changedPaths` 拍平对比 |

## 3. 场景 × 入口视图 × 故事 矩阵

单元格 = 通过次数/执行次数（跨 13 个故事）；`—` 表示该视图无法表达这个场景；`equiv` 列 = 各入口终态必须相同（按场景声明：`graph` 逐字节相同，`graph-no-layout` 忽略画布坐标）。

| 场景 | 说明 | script | shot | timeline | canvas | equiv |
|---|---|---|---|---|---|---|
| `rewrite_line` | 改写一行台词（旁白/对白） | 13/13<br>`rewriteLine` | 13/13<br>`rewriteLine` | 13/13<br>`rewriteLine` | 13/13<br>`setNodeParam` | 13/13<br>`graph` |
| `change_line_kind` | 把台词行改成动作行（对白 -> action） | 13/13<br>`rewriteLine` | 13/13<br>`rewriteLine` | 13/13<br>`rewriteLine` | 13/13<br>`setNodeParam` | 13/13<br>`graph` |
| `split_line` | 拆一行台词为两行 | 13/13<br>`splitLine` | — | — | — | — |
| `merge_lines` | 合并两行相邻台词 | 12/12（1 个故事不适用）<br>`mergeLines` | — | — | — | — |
| `reorder_lines` | 反转一个场景里的行顺序 | 12/12（1 个故事不适用）<br>`reorderLines` | — | — | — | — |
| `delete_line` | 删除一行台词 | 13/13<br>`deleteLine` | — | — | 13/13<br>`deleteNode` | 13/13<br>`graph` |
| `insert_line` | 在场景里新增一行并挂到镜头 | 13/13<br>`insertLine` | — | — | 13/13<br>`addNodeAt+connectNodes` | 13/13<br>`graph-no-layout` |
| `split_shot` | 拆分镜头 | — | 13/13<br>`splitShot` | — | — | — |
| `merge_shots` | 合并两个相邻镜头 | — | 12/12（1 个故事不适用）<br>`mergeShots` | — | — | — |
| `reorder_shots_swap` | 交换同场景相邻两个镜头（分镜重排 = 移动到组 = 时间线跨镜头边界移动） | — | 22/22（4 个故事不适用）<br>`reorderShots` `moveShotToGroup` | 11/11（2 个故事不适用）<br>`moveSegment(cross-boundary)` | — | 11/11<br>`graph` |
| `move_shot_across_scenes_neutral` | 跨场景移动镜头（全局顺序不变：A 的末尾镜头 -> B 的开头） | — | 12/12（1 个故事不适用）<br>`moveShotToGroup` | 12/12（1 个故事不适用）<br>`moveSegment(cross-scene)` | — | 12/12<br>`graph` |
| `move_shot_across_scenes` | 跨场景移动镜头（全局顺序改变：A 的首个镜头 -> B 的末尾） | — | 12/12（1 个故事不适用）<br>`moveShotToGroup` | 12/12（1 个故事不适用）<br>`moveSegment(cross-scene)` | — | 12/12<br>`graph` |
| `delete_shot` | 删除一个镜头（分镜删除 = 画布删节点 = 时间线删最后一个片段） | — | 13/13<br>`deleteShot` | 26/26<br>`deleteSegment(last)` `splitSegment+deleteSegment×2` | 13/13<br>`deleteNode(shot)` | 13/13<br>`graph` |
| `add_shot` | 新增镜头（分镜新增 = 画布新建节点） | — | 13/13<br>`addShot` | — | 13/13<br>`addNodeAt(shot)` | 13/13<br>`graph-no-layout` |
| `set_shot_title` | 改镜头字段（标题/画面提示词） | — | 13/13<br>`setShotField` | — | 13/13<br>`setNodeParam` | 13/13<br>`graph` |
| `set_shot_duration` | 改镜头时长（片段跟随；被裁过的片段裁进新时长） | — | 39/39<br>`grow-then-shrink` `shrink-with-split-segments` `shrink-under-trimmed-segment` | — | — | — |
| `regenerate_shot` | 单镜头重新生成（只有该镜头的 image/video 链 + 合成过期，旧版本保留） | — | 13/13<br>`regenerateShot` | — | 13/13<br>`setNodeParam(seed)` | 13/13<br>`graph` |
| `regenerate_video_only` | 只重新生成视频（图片保持新鲜） | — | 13/13<br>`regenerateShot(video)` | — | 13/13<br>`setNodeParam(seed)` | 13/13<br>`graph` |
| `change_voice` | 换音色（只有该镜头的配音 + 合成过期） | — | 13/13<br>`setVoice` | — | 13/13<br>`setNodeParam(voice)` | 13/13<br>`graph` |
| `timeline_trim` | 时间线裁剪片段 | — | — | 13/13<br>`trimSegment` | — | — |
| `timeline_split_segment` | 时间线切分片段 / 删除其中一半 | — | — | 13/13<br>`splitSegment+deleteSegment` | — | — |
| `timeline_reorder_within_shot` | 切分后在同一镜头内交换两个片段 | — | — | 13/13<br>`splitSegment+moveSegment` | — | — |
| `timeline_gap` | 时间线改片段前空隙（gap） | — | — | 12/12（1 个故事不适用）<br>`moveSegment(gap)` | — | — |
| `timeline_transition` | 设置/清除转场 | — | — | 13/13<br>`setTransition` | — | — |
| `timeline_add_music` | 加音乐（不影响场景缓存键） | — | — | 13/13<br>`addMusic` | — | — |
| `canvas_move_node` | 画布移动节点（不得改变过期集合 / cacheKey / 其它视图） | — | — | — | 39/39<br>`moveNode` `moveNodes(多选)` `move compose + line + generated` | — |
| `canvas_connect_disconnect` | 画布连线 / 断线 | — | — | — | 39/39<br>`line->shot 断开再连回` `image->video 断开再连回` `连线替换单连接端口` | — |
| `canvas_rename_group` | 画布场景组改名（只写 groups.<id>.title，不影响过期集合 / 其它视图内容） | — | — | — | 13/13<br>`renameGroup` | — |
| `canvas_delete_node` | 画布删除生成节点（image / video / narration） | — | — | — | 39/39<br>`deleteNode(image)` `deleteNode(video)` `deleteNode(narration)` | — |
| `canvas_rewire` | 画布重连：删 image、新建 image、接回 shot 和 video | — | — | — | 13/13<br>`delete+addNodeAt+connect×2` | — |
| `change_references` | 改锁定的参考图（只有该镜头的 image + video + 合成过期；改回去零成本重新采用旧版本） | — | 13/13<br>`setShotReferences` | — | 13/13<br>`setNodeParam` | 13/13<br>`graph` |
| `change_tail_frame` | 改尾帧（只有该镜头的 video + 合成过期，首帧图保持新鲜） | — | 13/13<br>`setShotReferences` | — | 13/13<br>`setNodeParam` | 13/13<br>`graph` |
| `change_image_model` | 换出图模型（该镜头的 image + video + 合成过期） | — | 13/13<br>`setShotReferences` | — | 13/13<br>`setNodeParam` | 13/13<br>`graph` |
| `change_video_model` | 换视频模型（只有该镜头的 video + 合成过期） | — | 13/13<br>`setShotReferences` | — | 13/13<br>`setNodeParam` | 13/13<br>`graph` |
| `adopt_old_version` | 采用旧版本（版本回退）：版本不被覆盖，采用旧版本后按 key 判断新鲜 | — | 13/13<br>`regenerate+generate+adoptVersion` | — | — | — |
| `reorder_after_split` | 先切分片段，再跨镜头边界重排（时间线）或改镜头顺序（分镜）：多片段镜头整体移动 | — | 11/11（2 个故事不适用）<br>`splitSegment(timeline)+reorderShots` | 11/11（2 个故事不适用）<br>`splitSegment+moveSegment(cross-boundary)` | — | 11/11<br>`graph` |
| `compose_created_late` | 项目还没有合成节点时先编辑，再从画布新建 compose（片段补齐、接线补齐） | 13/13<br>`rewriteLine -> addNodeAt(compose)` | 13/13<br>`addShot -> addNodeAt(compose)` | 13/13<br>`addNodeAt(compose) -> trim/split/music` | 13/13<br>`deleteNode(narration) -> addNodeAt(compose)` | — |
| `mixed_session_undo_redo` | 四种视图混合编辑的会话 + 批量撤销/重做（分四种起手视图） | 12/12（1 个故事不适用）<br>`lead:script` | 12/12（1 个故事不适用）<br>`lead:shot` | 12/12（1 个故事不适用）<br>`lead:timeline` | 12/12（1 个故事不适用）<br>`lead:canvas` | — |
| `crash_reload_mid_session` | 会话中途崩溃重载（快照 + 日志重放）后继续编辑（分四种起手视图） | 12/12（1 个故事不适用）<br>`lead:script` | 12/12（1 个故事不适用）<br>`lead:shot` | 12/12（1 个故事不适用）<br>`lead:timeline` | 12/12（1 个故事不适用）<br>`lead:canvas` | — |

按入口视图的执行次数：script 126，shot 327，timeline 212，canvas 362（合计 1027）。

## 4. 不适用（跳过）

| 场景 | 原因 | 故事 |
|---|---|---|
| `merge_lines` | 没有相邻行 | edge-single |
| `reorder_lines` | 没有可重排的场景 | edge-single |
| `merge_shots` | 需要至少 2 个镜头 | edge-single |
| `reorder_shots_swap` | 没有含 2 个镜头的场景 | edge-single、ke-03 |
| `move_shot_across_scenes_neutral` | 需要两个含镜头的场景 | edge-single |
| `move_shot_across_scenes` | 需要两个含镜头的场景 | edge-single |
| `timeline_gap` | 需要至少 2 个镜头 | edge-single |
| `reorder_after_split` | 没有含 2 个镜头的场景 | edge-single、ke-03 |
| `mixed_session_undo_redo` | 需要至少 3 个镜头 | edge-single |
| `crash_reload_mid_session` | 需要至少 3 个镜头 | edge-single |

## 5. 样例故事

10 个是联网会话里 D02 分镜生成（scriptgen，qwen-plus）的**真实输出**（原件 `packages/local/test/fixtures/scriptgen/recorded/`，经固定规则转成场景/行/镜头，见 `fixtures/stories/README.md`），另有 3 个**手写**边界故事（一场一镜、一镜多行/未挂行/空场景/长独白、纯旁白）。

| 故事 | 来源 | 场景数 | 行数 | 镜头数 |
|---|---|---|---|---|
| edge-multiline | 手写 | 3 | 9 | 4 |
| edge-narration | 手写 | 3 | 9 | 9 |
| edge-single | 手写 | 1 | 1 | 1 |
| gf-01 | 真实 AI 输出 | 2 | 13 | 9 |
| gf-02 | 真实 AI 输出 | 4 | 15 | 9 |
| gf-03 | 真实 AI 输出 | 2 | 9 | 6 |
| gf-04 | 真实 AI 输出 | 2 | 11 | 8 |
| ke-01 | 真实 AI 输出 | 3 | 9 | 5 |
| ke-02 | 真实 AI 输出 | 5 | 14 | 7 |
| ke-03 | 真实 AI 输出 | 4 | 9 | 4 |
| ps-01 | 真实 AI 输出 | 3 | 9 | 5 |
| ps-02 | 真实 AI 输出 | 3 | 11 | 6 |
| ps-03 | 真实 AI 输出 | 2 | 14 | 9 |

## 6. 套件抓到的内核缺陷（均已修复，带回归测试）

1. **重排镜头不会让合成过期**（`src/invalidation.js`）。`compose` 的 cacheKey 只含 params（片段数组里跨镜头的相对顺序无意义，顺序存在 `group.children`）和上游 key，所以 `reorderShots` / `moveShotToGroup` / 时间线跨镜头 `moveSegment` 之后，已渲染好的合成仍显示“新鲜”，但成片镜头顺序已变。修复：compose 的 key 增加全项目镜头顺序 `shot_order`。回归：`selftest.test.js` “重排镜头必须让合成过期”，以及场景 `reorder_shots_swap` / `move_shot_across_scenes` / `reorder_after_split` / `timeline_reorder_within_shot`。跨场景移动但全局顺序不变时合成保持新鲜（`move_shot_across_scenes_neutral`）。
2. **图校验接受非有限的画布坐标**（`src/graph.js`）。原始 `setLayout` 带 `NaN`/`Infinity` 通过 `validateGraph`（只检查 `typeof === number`），但规范 JSON 对非有限数抛错，等于事务提交后图无法落盘。`canvas.moveNode` 意图自己检查了，原始 op 没有。修复：校验用 `Number.isFinite`。回归：`atomicity.test.js`（`b14`/`b15`）。

另：旧表 `storyboards.duration` 是浮点秒（`duration_ms / 1000`），个别毫秒值乘回 1000 会出现 `8164.999999999999`；I8 按四舍五入还原。这不是缺陷，但物化写回旧表时要注意不要拿它做相等比较。

## 7. 数据在四个视图里的携带关系（`roundtrip.test.js` 断言）

对每类事实直接改原始图，看哪个视图的投影变了，要求与声明完全一致；每类事实至少一个视图可见，画布视图携带全部。结合“意图足迹”测试（每个内核意图只写它声明的路径，且导出的每个意图都必须有声明），证明经任何一个视图编辑不会丢掉它不携带的事实。

| 事实 | script | shot | timeline | canvas |
|---|---|---|---|---|
| 行文字 line.text | ✓ | ✓ | ✓ | ✓ |
| 行说话人 / 行类型 | ✓ | （摘要） |  | ✓ |
| 场景标题 group.title | ✓ | ✓ |  | ✓ |
| 镜头标题/描述/提示词/角色/时长 |  | ✓ |  | ✓ |
| image/video/narration 参数（种子、音色） |  | （摘要） |  | ✓ |
| 生成输入：模型、锁定参考图哈希、尾帧哈希（K4 起是节点参数，进 cacheKey） |  | （摘要） |  | ✓ |
| 片段 in/out |  | （用时） | ✓ | ✓ |
| 片段 gap_before_ms |  |  | ✓ | ✓ |
| 片段转场（G02 不渲染转场，不进场景缓存键） |  |  | ✓ | ✓ |
| 音乐 |  |  | ✓ | ✓ |
| compose.fps / size / aigc_label |  |  |  | ✓ |
| 字幕样式覆盖 |  | （场景缓存键） | ✓ | ✓ |
| 画布坐标 layout |  |  |  | ✓ |
| 镜头顺序（group.children） | ✓ | ✓ | ✓ | ✓ |

“摘要”= 视图只通过 cacheKey 摘要/状态间接反映变化，不携带内容本身。

## 8. 覆盖了什么、没覆盖什么（诚实清单）

**覆盖**：
- 全部 4 个视图的全部意图至少各被执行过一次（足迹测试要求每个导出的意图都有声明）；
- 任务要求的场景：改台词、拆/合/排镜头、跨场景移动、时间线裁剪/切分/跨镜头边界移动、转场、加音乐、画布移动（不改过期集合）、连线/断线/删节点、单镜头重新生成（只有该镜头链 + 合成过期，旧版本保留）、换音色、改锁定参考图 / 尾帧 / 换出图模型 / 换视频模型（只让该镜头对应的节点 + 合成过期，改回去零成本命中旧版本）、混合会话撤销重做（四种起手视图）、中途崩溃重载（四种起手视图）；另有版本回退、没有 compose 时先编辑再新建 compose、先切分再重排；
- 同一件事从不同视图做必须得到同一张图（镜头重排 = 移动到组 = 时间线跨边界移动；删镜头 = 画布删节点 = 时间线删最后一个片段；改台词 = 四个视图入口；重新生成/换音色/改镜头字段/生成输入 = 分镜意图 = 画布 `canvas.setNodeParam`）；
- 事务原子性、对乱参数只抛 KernelError、随机会话（3 个种子，另在开发时用同一随机驱动额外跑过种子 4–18，均通过）。

**没覆盖 / 已知缺口**：
- **没有验证物化后的旧表**（I8 只验证 `toLegacyRows` 内部一致）：`materialize` / `importLegacy` / SQLite 快照与日志表在 `packages/local/src/kernel` 另一条任务线，这里是纯内核，快照/日志用“规范 JSON + 事务数组”模拟，没有真实的磁盘写入、事务中途断电、并发写入；
- 画布属性面板编辑（K4 已补）：正式意图 `canvas.setNodeParam`（白名单 + 取值校验，带标签的事务），套件里的 `canvasEdit` 只是把一次面板编辑的多个参数合进一个事务；`segments / music / subtitle_overrides` 不能从这里改（有各自的时间线意图）；
- 视图是**数据模型**，不是 UI：没有测拖拽、选择、焦点、增量渲染，也没有测真实 UI 在视图间切换时的状态保持；
- 没有多人协作、并发事务冲突；没有超大图（几千节点）的性能测试（单图最大约 50 个节点）；
- 场景缓存键 `sceneKey` 与真实 G02 渲染计划的对照（K4 已做）在 `packages/kernel/test/sceneKeyG02.test.js`（调 lycore `render.plan`，没有二进制时退回按 plan.rs 字段写的 JS 移植）：17 种编辑的“哪些镜头的场景变了”两边完全一致。因对照而改了内核：字幕文字/样式进场景缓存键（字幕是烧进画面的），转场移出（G02 目前不渲染转场，不进场景键）。这条套件**不在**一致性矩阵里，矩阵只用内核自己的 sceneKey 做“哪些编辑会/不会改它”的断言；
- 故事是 10 个真实分镜表 + 3 个手写边界，没有真实的“用户手写剧本→生成”长链，也没有 50+ 镜头的长片；真实输出里没有多镜头共用一行、一行挂多个镜头的情形（只有手写边界故事里的一镜多行与未挂行；`insert_line` 等场景会制造一行挂一个镜头）；
- `adoptVersion` / `addVersion` / `setGroupTitle` 等没有对应意图的原子 op 只通过原始事务覆盖（版本回退场景、携带表）；
- 随机会话的画布连线只在“图校验不报错”时采用，被图校验拒绝的随机连线不计入。

## 9. 当前失败

无。

## 10. 怎么跑

```
pnpm --filter @talekiln/kernel test            # 单元 + 一致性套件（node --test，分片并行）
node packages/kernel/test/conformance/report.js   # 跑完整矩阵、打印表格并重写本文件
node packages/kernel/test/conformance/report.js --quick --no-write   # 只跑矩阵、只打印
```
