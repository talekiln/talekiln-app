# 后端：完整项目备份与本地快照（四视图改造 Task 5）

规格：spec §10.3；内核文档 `docs/kernel-design.md` §3、§12。
实现：`packages/local/src/backup/kernelSnapshot.js`（一集的项目图快照）、`backup/localSnapshot.js`（本地快照）、`routes/projectBackup.js`（四个路由）、`services/dramaExportService.js` / `dramaImportService.js`（ZIP 1.5）。
测试：`packages/local/test/{kernelSnapshot,projectBackup,localSnapshot}.test.js`。云备份（`backup/service.js`）不变，用的就是同一个 ZIP。

## 路由

| 路由 | 行为 |
|---|---|
| `POST /dramas/:id/backup/full` | 先写临时文件再流式下载 `<项目名>.talekiln.zip`（不把整包放内存），下载结束删临时文件。项目不存在 404 |
| `POST /dramas/restore` | multipart 字段 `file`；**永远新建项目**，返回 201 `{ drama_id, title }`；原项目不动 |
| `GET /dramas/:id/snapshots` | 本地快照列表，新的在前：`{ id, reason, created_at, title, size }` |
| `POST /dramas/:id/snapshots/:sid/restore` | 把快照恢复成新项目；快照 id 不合法 / 不存在 404 |

错误：包损坏（不是 ZIP、缺 `project.json`、JSON 坏了、缺 `drama.title`、条目 CRC 坏）-> 400 `BACKUP_CORRUPT`；`project.json.version` 的主.次版本高于当前支持（1.5）-> 400 `BACKUP_VERSION_UNSUPPORTED`。两个码在 `errors/error-codes.json`。旧的 `/dramas/import` 仍把这些错误按含“格式/缺少/损坏”的消息映射成 400（版本错误的消息里带“格式”）。

没有 `version` 字段的老包按旧格式处理，不拒绝。

## ZIP 1.5 的内容

在 1.4 之上追加（全部向后兼容，≤1.4 的包照常导入）：

- `project.json`：`version: "1.5"`；每集多一个 `kernel_file` 指针；分镜和角色多一个 `original_id`（导出时的旧行 id）。
- `kernel/episode-<集号>-<序号>.json`：一集的内核快照（`talekiln-kernel-snapshot` v1）：`history`（图 + 撤销栈 `past` ≤200 + 重做栈 `future`）、`ops`（最近 ≤5000 条 `graph_ops`）、`legacy_map`、`refs`（图里出现的 `/static/…` 引用）、`media`（引用 -> zip 内路径）。
  - **与计划的偏差**：计划写的是 `kernel/episode-<n>.json`。实际文件名多一个序号（`episode-<集号>-<数组下标>`），因为集号在库里并不保证唯一；导入时靠 `project.json` 里每集的 `kernel_file` 指针找文件，不靠文件名约定。
- `media/kernel/<hash12>_<文件名>`：快照里引用的、而旧表导出没有带上的媒体（例如历史版本的图）。内容相同（sha256）的文件复用已经打进 `media/…` 的条目，不会打两份。引用必须落在存储目录内，越界的引用被忽略。

某一集导出内核快照失败只记警告，不让整个备份失败；那一集导入时走旧路径。

## 导入怎么还原

1. 旧表照 1.4 的逻辑建好（角色、集、场景、道具、分镜、媒体），同时用 `original_id` 记 `旧分镜 id -> 新分镜 id`、`旧角色 id -> 新角色 id`。
2. 每个带 `kernel_file` 的集：把快照里的媒体落盘到新项目目录 `…/kernel/`，得到 `旧引用 -> 新引用`；调 `kernelSnapshot.importEpisode`。
3. **没有快照、`original_id` 缺失、快照坏了或还原失败 -> 这一集不建项目图**，由现有的懒路径（`legacy.importLegacy`，首次访问时）从旧表重建。1.4 及更早的包永远是这条路径。

### id 映射规则（`kernelSnapshot.importEpisode`）

| 改写 | 内容 |
|---|---|
| 镜头 `legacy_id`、日志 `binds` | 旧 `storyboards.id` -> 新 id；对不上的丢掉，下一次物化时重建 |
| 镜头 `params.characters`（含 `setParam` 里整值替换 `characters` 的日志） | 旧 `characters.id` -> 新 id；对不上的角色丢掉 |
| 字符串里的 `/static/…` 引用 | 旧引用 -> 新引用（只映射包里真有文件的） |
| UUID 形状的时间线片段 id（`segments` / `music` 数组里的 `id`） | 换成 `seg<32 位 hex>`。**原因**：`timeline_clips.id` 是全库 TEXT 主键，物化时只有“非 UUID 的确定性 id”才会自动加 `e<集 id>_` 前缀；UUID 形状的 id 原样使用，会在新集里撞主键 |
| `cache_key` | 因为 `characters` / 引用 / 片段 id 进 cacheKey，改写后 key 全变。做法：先算整图新旧 key，建 `旧 key -> 新 key` 再整体改写，所以**过期集合与源项目一致**（测试验证） |

不改写：资产 hash、节点 id、版本 id、`tx_id`。

**cache_key 的局限**：只有当前图里某个节点算得出来的 key 才有“旧 -> 新”的映射。撤销栈 / 日志里记着的、已经不属于当前图任何节点的历史 key，恢复后保持原值（它们本来也不对应任何当前节点，对过期判断没有影响；撤销回到那个状态时，该节点的 key 会和采用版本里记的 key 不一致，表现为“需要重新生成”，不会静默用错）。

## 撤销历史能否在恢复后保留

**能，默认完整保留。** 恢复后新项目的撤销 / 重做栈、`graph_ops` 日志（`snapshot_seq` 指向新日志末尾）、已采用版本和版本历史都在，测试里恢复后实际撤销了一步。

兜底（降级）：写入前先在映射后的图上走一圈 `redoAll -> undoAll -> redoAll -> undo(n)`，图必须回到起点；`validateGraph` 也必须通过。这一步失败（例如历史里有映射不了的 id），**自动降级为只还原当前图 + 采用版本**：撤销栈 / 重做栈清空、不带 `graph_ops`，该集 `can_undo = false`（`importEpisode` 返回 `mode: 'graph'` 和 `degraded_reason`，日志里有 `Drama imported`）。降级也失败 -> 这一集不建项目图（见上，走懒重建）。降级是两个独立的 savepoint，失败的一次不留任何行。

## 本地快照

- 位置：`<应用数据目录>/snapshots/<dramaId>/<id>.talekiln.zip` + `<id>.json`（原因、时间、标题、大小）。应用数据目录 = 库文件所在目录（`db.name` 的目录）；内存库退到存储目录的上一级；可用 `extras.snapshotDir` 覆盖。
- id 形如 `s<13 位毫秒时间戳>_<4 位 hex>`，字典序即时间序；同一进程内毫秒严格递增。路由和 `restoreSnapshot` 都用这个格式校验 id（防路径穿越），不合法一律“不存在”。
- 保留最近 5 份（`KEEP`），存第 6 份时删最旧的（zip 和 json 一起删）。先写 `.part` 再改名，失败不留半个文件。
- 接线：`setupRouter` 注册 `projectBackup` 路由时调用 `localSnapshot.install()`，把处理函数挂到 `backup/hooks.setBeforeDestructive`。钩子收到的是集 id，处理函数先查 `drama_id` 再 `snapshotEpisode(dramaId, reason)`。快照是同步完成的，所以调用方 `await beforeDestructive(...)` 返回时，破坏性操作还没开始。当前调用方：`episodeStoryboardService`（`regenerate-storyboard`）、`routes/qualityRerun.js`（`quality-rerun`）。快照失败被钩子吞掉，不拦用户的操作。
- 钩子是进程级单例，**后一次 `setupRouter` 覆盖前一次**。生产里只有一个 app，没有影响；`extras.localSnapshots === false` 可以不挂钩子。
- 测试证明运行时真的走到了：`localSnapshot.test.js` 里未挂钩子时 `beforeDestructive` 不产生任何文件；`setupRouter` 之后同一个调用在库旁边的 `snapshots/<dramaId>/` 下产出一个 zip。

### 成本

每次破坏性操作做一次**完整导出**（含全部媒体），项目大时有磁盘和时间成本：最多 5 份 × 项目大小。同一份媒体不去重（快照之间、快照与项目之间各一份）。如果以后要降成本，方向是只带上次快照之后变化的文件，或对 `media/` 做内容寻址的共享目录；本任务没做。

## 失败不留半个项目

`importDrama` 把整个写入包在一个 DB 事务里，同时记录本次落盘的每个媒体文件；任何一步抛错 -> 事务回滚 + 删掉这些文件，并清掉因此变空的目录（只到存储根为止）。`projectBackup.test.js` 里的用例让一个分镜的字段绑定失败（角色图已经落盘），断言无 drama / 角色 / 分镜行、无遗留文件；把清理注释掉后该用例会失败。

同一个 zip 条目在一次导入里只落盘一次（旧表和内核快照共用同一个文件），所以恢复后图里的资产引用和 `storyboards.local_path` 指向同一个文件。

已知小缺口：内核快照还原失败（降级也失败）时，它为这一集写的 `kernel/` 媒体不会单独删，成为新项目目录里的孤儿文件（整次导入失败时会被一并删掉）。

## 时间线与其它限制

- 时间线靠 `legacy.materialize` 从图重新生成：片段、轨道、字幕按图里的数据还原。**轨道音量 / 静音 / 混音这类不在图里的设置不会随快照恢复**（和新建一集时的默认值一样）。
- `graph_ops` 随包最多带最近 5000 条；撤销栈最多 200 层（`store.MAX_UNDO_DEPTH`）。更早的日志恢复后没有，但当前图和栈都是完整的。
- 恢复出来的项目标题按现有规则去重（“<名> 导入N”）。
- 上传上限 2 GB（`/dramas/restore`）；旧的 `/dramas/import` 仍是 500 MB。

## 手动快照与已删除项目（首页“删除前先存一份”）

- `POST /dramas/:id/snapshots`，body 可选 `{ reason }`（字符串，默认 `'manual'`，去空白后截到 64 字符；不是字符串 -> 400）。成功 201 `{ id, created_at }`。项目不存在 / 已软删除 / id 不是数字 -> 404（不留文件）。
- 走的就是自动快照的 `snapshotEpisode`：同一份完整导出，含项目全部集（测试里用两集的项目验证 `project.json.episodes.length === 2`），同步完成，保留最近 5 份。前端先 `POST` 这个再 `DELETE /dramas/:id`。
- **软删除后的快照**：`GET /dramas/:id/snapshots` 和 `POST …/:sid/restore` 只看磁盘上的 `snapshots/<dramaId>/`，不查 `dramas` 表，所以已软删除的项目照常列出、照常恢复成新项目（本来就是这样，没有改路由，只补了测试）。`DELETE /dramas/:id` 只写 `deleted_at`，不碰快照目录。只有“新建快照”要求项目存在且未删除。
- 测试：`packages/local/test/localSnapshotManual.test.js`。
