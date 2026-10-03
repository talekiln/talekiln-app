# 后端：可撤销的重新生成分镜与缺失接口（四视图统一 Task 3）

## 做了什么

| 项 | 实现 | 测试 |
|---|---|---|
| A 重新生成分镜 | `POST /episodes/:id/storyboards` 一次内核事务（`compat.replaceEpisodeShots`）：加入新镜头 + 删除全部旧镜头 + 物化，同一个 SQLite 事务；不再调用 `resetGraph`；返回 `tx_id`、`can_undo: true`；替换前调 `backup/hooks.beforeDestructive(episodeId, 'regenerate-storyboard')` | `test/storyboardRegenerate.test.js`（7 项） |
| B `GET /episodes/:id` | 新 `routes/episodes.js`，返回 `{id, drama_id, episode_number, title}`；不存在 / 已删除 / 非数字 id 均为统一 404 `NOT_FOUND` | `test/episodeLookup.test.js` |
| C `GET /dramas/:id/scenes` | `routes/legacyGaps.js`，注册在 `/dramas/:id` 之前；未知项目 404 | `test/legacyGaps.test.js` |
| D `POST /characters/:id/add-to-team-library` | 委托 `extras.studio.publishCharacter(id, {studio_id})`；`StudioError` 原样透传状态码与错误码；没有工作室服务时 501 `CAPABILITY_NOT_SUPPORTED` | `test/legacyGaps.test.js` |
| E `POST /episodes/:id/characters/extract` | 不再是空桩：委托 `characterGenerationService.generateCharacters`，大纲用本集剧本，任务结果 `{characters, count}`，提取到的角色关联到本集；未知剧集 404。**不需要 501 兜底** | `test/legacyGaps.test.js` |
| F 前端 | `useCharacters.js` 的 `dramaAPI.getCharacters`（不存在）改为 `GET /dramas/:id/characters` | `apps/renderer/test/useCharactersApi.test.js` |

`stub.js` 里的 `episodeCharactersExtract` 已不再被路由引用（保留未删，不在本任务归属内）。

## 偏离计划之处（协调者需要知道）

1. **改的是 `services/episodeStoryboardService.js`**，不是计划里写的 `routes/storyboards.js` / `storyboardService.js`：真正的“整集重新生成”流程（含流式增量入库和 `resetGraph` 调用）在这个文件里。`compat.js` 只加了 `replaceEpisodeShots`（加法）。
2. **生成期间不再增量入库**：流式解析出的分镜只在内存里收集；生成期间旧分镜原样可见，拿到完整结果后一次性替换。副作用：①进度条仍按已解析的镜头数更新，但表里看不到半成品；②生成失败（模型报错、解析为 0 条且没有流式内容）**不再丢掉旧分镜**（以前一开始就软删除了）；③连接中断但已流出部分镜头时，仍按“部分成功”提交（`truncated: true`，同样是一次可撤销事务）。
3. **POST 的返回值里 `tx_id` / `can_undo` 是预先分配的**：接口立即返回任务 id（生成是异步的），`tx_id` 用 `crypto.randomUUID()` 预分配并传给事务（事务按 `tx_id` 幂等）；真正提交后的结果（`tx_id`、`can_undo`、镜头列表）在任务结果里。撤销用 `POST /episodes/:id/undo`，撤销的就是这一步。生成失败时没有这个事务，`can_undo` 以任务结果为准。
4. **备份钩子在“替换之前”调用，不是在生成之前**：生成可能要几十秒，那时旧分镜还没动；钩子紧挨着事务调用，备份到的就是即将被替换的内容。
5. **角色补全并进了同一个事务**：以前入库后对每个镜头调 `syncStoryboardCharacters`（会产生第二步写入）。现在在入库前用同一规则（动作 / 对白 / 结果 / 描述里出现的剧集角色名）算好，合并进镜头的 `characters` 参数，整次重新生成仍是**一步**撤销。`imageService.syncStoryboardCharacters` 本身未改。
6. **旧表里图外的列**（`scene_id`、`result`、`angle_h/v/s`、`lighting_style`、`depth_of_field`、`creation_mode`、`universal_segment_text`、`storyboard_props`）在事务提交后、同一个外层 SQLite 事务里直接写；撤销后这些列保留新镜头（被软删除）的值，重做时被物化“复活”的行带着它们回来，所以撤销 / 重做对它们也是对称的。撤销把旧镜头复活时，旧行的这些列从未被改动，原样回来。
7. 新增的 501 没有加新错误码（`error-codes.json` 是共享文件，另一个 worker 有未提交改动）；用了现成的 `CAPABILITY_NOT_SUPPORTED` 并写明具体文案。

## 事务内容（`compat.replaceEpisodeShots(db, episodeId, newShots, {txId})`）

1. `ensureGraph`（没有图就导入旧表）。
2. 新镜头先加（按 `segment_index|segment_title` 变化开新场景组 `grp_N`，同键的连续镜头共用一组；每个镜头带动作 / 旁白 / 台词三类行），**再**删旧镜头：先加后删，避免 `makeAlloc` 的 `prefix_(max+1)` 重用旧 id。
3. 旧镜头删光之后，没有镜头引用的旧剧本行、没有子节点的旧场景组一并删除。`removeNode` 会级联边 / 布局 / 版本 / 采用，逆操作是 `restoreNode`，所以撤销能原样带回旧镜头的首帧 / 视频版本和采用状态。
4. 物化（`legacy.writeStoryboards`）：旧行软删除；重做时按 `graph_legacy_map` 复活同一批行 id。
5. 空列表抛 `KernelError('INTENT', ...)`，什么都不动；同一个 `txId` 重复提交返回 `applied: false`，不重复生效。

`graph_ops` 日志里这是一条普通 `apply` 条目（`kind: 'apply'`，`tx_id` 为上面的 id）；不会清日志，`seq` 单调增加。

## 给 `kernel-design.md` 的建议改动（本任务不改该文件）

§12.4 把“整集重建分镜……调用 `compat.resetGraph` 丢弃旧图”那条改为：

> - 整集重新生成分镜（`generateStoryboard`）是**一次可撤销的内核事务**：`compat.replaceEpisodeShots` 在同一个事务里加入新镜头、删除全部旧镜头并物化回旧表，返回 `tx_id` / `can_undo`；`POST /episodes/:id/undo` 一步还原旧分镜（含首帧 / 视频版本与采用状态），重做回到新分镜。生成期间旧分镜原样保留，流式解析结果只在内存里收集；生成失败不会丢旧分镜。日志不清空（不再调用 `resetGraph`）。替换前调用备份钩子 `beforeDestructive(episodeId, 'regenerate-storyboard')`。

§12.5 最后一条“整集重建分镜”改为：

> - **整集重新生成分镜**：已走内核（`compat.replaceEpisodeShots`，见 12.4）。图外列（`scene_id` / `result` / 角度分量 / 灯光 / 景深 / 创作模式 / `universal_segment_text` / `storyboard_props`）在同一个 SQLite 事务里直接写。`resetGraph` 仍保留给“导入 / 恢复整集”等确实要作废整张图的场景，不再被分镜生成调用。

§11.4 若提到“分镜重建靠 `resetGraph` 作废旧图”，同样改成指向 12.4。

## 已知的既有问题（与本任务无关）

- 种子 / 导入得到的基线图（带 `legacy-import` 采用版本）在不变式 **I5**（过期集合 == 重新计算的 oracle）上不通过；重新生成之后的图是通过的。因此 `storyboardRegenerate.test.js` 在撤销之后不跑 `checkGraph`，而是断言“撤销后图 + 四视图 + 旧表与重新生成前逐字节相同”。
- `splitStoryboardByAudio` 等函数引用未定义函数（见 §12.4 原文），未动。

## 手动验证（前端修复）

渲染进程没有 Vue 组件测试环境，`useCharactersApi.test.js` 用源码级回归：`useCharacters.js` 里每个 `dramaAPI.xxx` 都必须在 `api/drama.js` 里存在，并断言“项目全部角色”读 `GET /dramas/:id/characters`。手动验证：打开分镜 / 角色页的“项目全部角色”面板，应列出项目所有角色（以前永远加载失败）。
