# 剧本视图（四视图改造 Task 6）

规格：spec §4.2、§10.3；计划 Task 6。把 LocalMiniDrama 旧页（`FilmCreate.vue`、`DramaDetail.vue`、`composables/filmCreate/*`、`useStoryGeneration.js`）里的剧本 / 分集功能移到 `ScriptView` 与外壳。

## 结构

| 文件 | 作用 |
|---|---|
| `views/ScriptView.vue` | 工具条、逐行编辑、全文编辑、检查器、行 -> 正文防抖写回 |
| `components/script/AiWriteDialog.vue` | `script.aiWrite`：AI 写剧本 |
| `components/script/ImportScriptDialog.vue` | `script.importScript`：粘贴 / TXT / 模板库，4 种分集方式 |
| `components/script/ProjectSettingsDialog.vue` | `home.projectSettings`：名称、大纲、比例、单镜头时长、语言、故事背景、题材、画风 |
| `components/script/EpisodeManagerDialog.vue` | `script.episodes`：分集列表（上移 / 下移 / 重命名 / 删除 / 新增） |
| `components/script/FullTextEditor.vue` | 全文模式 |
| `components/script/episodeOps.js` | 新增 / 重命名 / 删除 / 移动 / 跳转，各入口共用 |
| `api/episodesCore.js`、`api/episodes.js` | `episodesAPI`、`scriptSync`（行 <-> 正文）、`scriptAPI`（故事生成、小说导入、模板） |
| `utils/scriptTools.js` | 纯函数（分章、请求体、分集列表变换、行解析 / 序列化、出场资产） |
| `shell/actions/script.js` | `script.addEpisode` `script.importEpisodes` `script.renameEpisode` `script.deleteEpisode` `script.reorderEpisodes`，另有 `script.syncContent` |
| `shell/dialogs/script.js` | `script.aiWrite` `script.importScript` `script.episodes` `home.projectSettings` |
| `i18n/messages/script.js` | zh-CN / en；`test/i18n-migrated/script.json` 登记 |

测试：`test/scriptTools.test.js`（49）、`test/episodesApi.test.js`（14）。

## 行为要点

- 分镜生成、提取资产读的是分集正文（`episodes.script_content`），而本视图编辑的是项目图里的剧本行。行变化后 1 秒把行序列化回正文（工具条标签：待保存 / 保存中 / 已保存 / 失败可点重试）；点“生成分镜 / 提取”前会先立即写，写失败则不继续；离开页面时也写。
- 全文模式：只在该集没有镜头时可用（`canEditFullText`）。应用时先改项目图（`replaceGraphLines`，有镜头会被拒绝），成功后再写正文。
- 分集写接口 `PUT /dramas/:id/episodes` 会软删除未出现的集号，所以所有操作都发送完整的新列表。
- 删除分集：确认框说明可从项目备份恢复；删除当前集后跳到相邻集（replace 导航）。
- 每个分集操作后 `useShellStore().loadProject()`。
- AI 写剧本用同步的 `POST /generation/story`（不带 `drama_id`）。带 `drama_id` 是异步且会覆盖，故不用。
- 项目设置：`PUT /dramas/:id`，再 `PUT /dramas/:id/outline`（它会清空没带的 tags，所以带回原 tags）。

## 旧功能 -> 新位置（对照表）

| 旧功能 | 新位置 |
|---|---|
| AI 写剧本（梗概、故事背景、题材、集数、语言） | 工具条“AI 写剧本” / 空状态；`script.aiWrite` |
| 导入剧本 / 小说：粘贴、TXT、整篇一集、按“第 N 集”标记、按章节合并、按字数切分、自定义章节正则 | 工具条“导入剧本 / 小说”、分集菜单“批量导入分集”、左栏“批量导入分集”；`script.importScript` |
| AI 概括章节后导入 | `script.importScript` 的“AI 概括每一章” |
| 模板库导入 | `script.importScript` 的“模板库”标签（追加分集） |
| 提取角色 / 场景 / 道具 | 工具条 -> `assets.extract` |
| 生成分镜 / 重新生成 | 工具条 -> `storyboard.generate` / `storyboard.regenerate` |
| 剧本全文编辑 | 工具条“逐行 / 全文”切换（有镜头时禁用） |
| 逐行编辑、拆分、合并、插入、删除、排序 | 逐行视图（保留原有行为与 data-test） |
| 分集新增 | 分集菜单 / 左栏 `+` -> `script.addEpisode` |
| 分集重命名 | 分集菜单 -> `script.renameEpisode` |
| 分集删除 | 分集菜单 -> `script.deleteEpisode` |
| 分集排序 | 分集菜单“分集管理与排序” -> `script.reorderEpisodes` |
| 项目设置（名称、大纲、比例、时长、语言、画风、题材） | 分集菜单“项目设置…” / 左栏；`home.projectSettings` |
| 本行对应镜头与状态 | 检查器“对应镜头”（图 / 视频 / 配音状态） |
| 出场角色 / 场景 / 道具 | 检查器“出场”（`@角色 #场景 #道具`；资产未就绪时隐藏） |
| 重新配音某镜 | 检查器“重新配音这一镜”（先估价再确认） |
| 在分镜中查看 / 镜头工作台 | 检查器两个按钮（保持选中） |

## 缺口与偏差

- AI 写剧本是同步请求，不进任务中心，可在对话框内停止。成功路径没有在浏览器里走通（本机后端当时没配置文本模型，只验证了报错路径）；请求体、结果转换有单元测试。
- 出场资产来自镜头的 `params.characters` 加行文 / 镜头描述里的 `@` `#` 提及。镜头上绑定了、但文字里没提到的场景和道具不显示。
- 排序是在集号槽位之间交换内容（分集 id 留在原集号上），有镜头的集不能移动；角色 / 场景的分集归属不跟着移动。
- 模板库是追加分集，不是覆盖。
- 画风选择器 `StylePickerButton` 是共享组件，标签仍是中文；画面比例显示原始比例字符串。
- 首次把“没有标题行”的正文做全文应用时，会多出一行与组名同名的场景标题（`# 剧本`），之后稳定。
- 写入当前集的导入 / AI 写作：该集有镜头时禁用，需追加新分集。
- 浏览器检查时发现 Vite 对 `shell/dialogs/assets.js` 等被他人中途清空过的文件缓存了空模块，需要改动文件时间才恢复；与本任务代码无关。
