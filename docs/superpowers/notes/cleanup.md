# 清理与接线（四视图改造 Task 12 步骤 1-3）

规格：spec §10；计划 Task 12。提交：`2e974a0`（删除）、`a086c12`、`765a4db`、`6ea94ce`、`5d9d456`（接线）。

## 已删除（2e974a0：70 个文件，+121 / -23455）

| 类别 | 内容 |
|---|---|
| 旧页面 | `views/{FilmCreate,DramaDetail,DramaCanvas,FreeCreate,ReferenceLibrary,ExportPage}.vue` |
| 旧画布组件 | `components/dramaCanvas/*`（19 个）、`UniversalSegmentOmniAtEditor.vue`、`EpisodeBatchImportDialog.vue` |
| 旧 composables | `composables/filmCreate/*`、`useCanvas*`、`useGenerationTaskSync.js`、`useStoryGeneration.js` |
| 旧 store / 工具 | `stores/film.js`、`stores/generationTaskStore.js`、`utils/{canvasEntityIds,canvasLayout,canvasWorkflow,dramaCanvasAdapter,storyboardMedia}.js` |
| 旧客户端接口 | `api/drama.js`、`api/videos.js` 里的 finalize / quick-merge / video_merges 调用 |

保留：`utils/referenceLibrary.js`（新素材库仍在用）。

旧地址（`/film/..`、`/drama/..`、`/episodes/:id/script`、`/project/:id/library`、`/free-create` 等）统一由 `utils/legacyRoutes.js` 的 `LEGACY_ROUTE_RECORDS` 与 `router.beforeEach` 重定向到 `/p/...` 具名路由。`test/noLegacyLinks.test.js` 保证 `src/` 里（除重定向表）不再出现 `/film/`、`/drama/`。

## 已移植 / 接线

- 导航：`viewLocation`、命令面板、`useHistoryDrawer` 全部走具名路由。
- 共享中文文案改用 `t()`（zh-CN / en 键集相等）：`GenerateDialog.vue`（经 `previewSummary`）、`StylePickerButton.vue`（`common.style.*`）、画幅显示（`utils/aspectRatio.js`，`common.aspect.*`）、`VersionHistoryDrawer` 的状态文案；`utils/projectViews.js` 去掉全部中文标签表，改用 `components/canvas/canvasModel.js` 的 `nodeTypeLabel / stateLabel / lineKindLabel / editableFieldsT / nodeSummaryT / newNodeParams / sceneTitleCheck`。以上文件已登记到 `test/i18n-migrated/*.json`。
- 分镜表导出的说明文字改为"仅文字、不含缩略图"。
- 导出对话框内联显示错误，导出接口（options / jianying / fcpxml）带 `silentError`，不再重复弹全局提示。
- 素材面板 `AssetPanel` 由 `ProjectShell` 挂载（此前没有任何地方挂载，LeftRail 的按钮是空的）。
- 全局素材库只有一个入口：`home.globalLibrary` -> 对话框 `assets.globalLibrary`（`browseOnly`，只浏览、不导入到任何项目；页脚"管理"跳到 `/media-library`）。
- 注册表覆盖测试 `test/shellRegistries.test.js`：源码里所有字面量 `runAction / openDialog` id、菜单项、LeftRail / TopBar / FilmList / ScriptView 的 id、对话框加载器指向的组件文件都已注册 / 存在，没有缺口。

## 遗留缺口

1. 后端 `packages/local/src/routes/videoMerges.js` 路由仍在（前端已不调用），未删。
2. e2e 脚本仍用旧地址（靠重定向跑通），需改成 `/p/...`。
3. 素材面板"选取"只把 `@token` 复制到剪贴板；各视图的编辑器没有"插入 token"。
4. `utils/generationView.js`（`confirmSummary`、chips、`KIND_LABELS`、`submittedText`、`taskTarget`）与 `api/queuedGeneration.js` 仍是中文，未走 i18n。（已处理，见下一节）
5. `constants/styleOptions` 的风格名与分组名仍是中文。（已处理，见下一节）
6. `VersionHistoryDrawer.vue` 里除状态外的其它中文（如 `kindText`）。（已处理，见下一节）
7. `exportJob.js` 的标签用 `i18n-ignore` 跳过了检查。
8. 状态栏仍显示原始画幅比例（未用 `aspectLabel`）。
9. `NewBlankDialog` 用 `home.aspect.*`，与 `common.aspect.*` 重复。（已处理，见下一节）
10. 首页进入"媒体素材"标签只有"管理"按钮和命令面板两条路。
11. 首页上 `useActionContext` / `shell.dramaId` 可能是上一个项目的残留值（全局素材库因此用 `browseOnly`）。
12. 其它各 lane 笔记（`assets / canvas / generate-export / home / script / shell / storyboard`）里的缺口不在此重复。

## 多语言补扫（I18N SWEEP）

已迁到 `t()`（zh-CN / en 键集相等，登记在 `test/i18n-migrated/*.json`）：

| 范围 | 文案文件 | 说明 |
|---|---|---|
| 时间线：`TimelineEditor.vue`、`MusicPanel.vue`、`VoiceoverPanel.vue`、`utils/voiceover.js`、`utils/mixView.js` | `messages/timeline.js` | 轨道名、保存状态、草稿恢复对话框、混音 / 配音文案 |
| 版本历史：`VersionHistoryDrawer.vue`、`utils/versionHistory.js` | `messages/history.js` | 抽屉标题（全局挂载，aria / title）、事务名、内核 op 名、来源、状态 |
| 导演模式：`DirectorPanel.vue`、`utils/director.js` | `messages/director.js` | 抽屉、步骤、影响范围、费用、字段名；事务名复用 `history.tx.*` |
| 命令面板：`CommandPalette.vue`、`utils/builtinCommands.js` | `messages/commands.js` | 命令标题 / 分组 / 关键词是 getter，命令只注册一次，切换语言后下一次渲染 / 搜索即生效；关键词中英文都保留，英文界面额外带上中文标题 |
| 风格名：`constants/styleOptions.js` | `messages/style.js` | 选项名、分组名是 getter；`prompt` / `promptEn` 是发给模型的内容，保持原样并用 `i18n-ignore` 标记 |
| 生成队列：`utils/generationView.js`、`api/queuedGeneration.js`、`utils/queuedTask.js` | `messages/generation.js` | 状态芯片、`kindLabel`、`taskTarget`、队列确认弹窗；`confirmSummary` / `submittedText` 改为委托 `components/generate/generateConfirm.js`（同一套规则，旧弹窗的中文措辞随之变成「首帧图：N」「视频：N」，提交提示的分隔改为分号） |
| 画幅 | （复用 `common.aspect.*`） | `NewBlankDialog` / `ImportScriptDialog` 不再用 `home.aspect.*`，已删除重复行 |

上面的遗留缺口 4、5、6、9 已处理。顺带：`stores/timeline.js` 里 `mutate()` 的（未被读取的）label 参数改成英文标识。

仍含中文字面量的文件（`findCjkLiterals` 口径，第二轮后共 27 个，第一轮后 40 个，补扫前 56 个）：

- 旧的独立页面，范围外：`views/{About,AiConfig,BackupPage,KeyboardSettings,Login,Onboarding,PluginsPage,SpendPage,StudioPage,TemplateMarket}.vue`，以及它们的 `utils/{account,backupView,keymap,keymapPresets,legal,loginView,onboarding,pluginsView,studioView,updatesView,templateMarket,spendView}.js`、`components/{AIConfigContent,PromptEditor,SceneModelMap,Sd2AssetManagement}.vue`、`composables/useDesktopCloud.js`。
- 第二轮（SWEEP-2）已处理，不再列在这里：`stores/projectViews.js`、`router/index.js`、`api/storyboards.js`、`utils/{errorToast,request,scriptTools,scriptEpisodes,regionEdit,referenceLibrary,consistencyView,aiTaskView,modelSelection,providerEnablement}.js`。
- 有意保留中文：风格 `prompt`、命令关键词里的中文搜索词、`exportJob.js`（见缺口 7）。

### 第二轮（SWEEP-2）：四视图里还会露出的错误提示、路由标题和纯逻辑文案

登记在 `test/i18n-migrated/sweep2.json`（13 个文件，现在也被 `i18nLiterals` 守着），新增文案文件 `messages/{request,aiTask,model,region,consistency}.js`：

| 范围 | 做法 |
|---|---|
| 请求层：`utils/request.js`、`utils/errorToast.js`、`api/storyboards.js`、`stores/projectViews.js` | 「请求失败 / 网络错误 / 操作失败 / 加载失败 / 不支持流式读取 / 「…。建议：…」」走 `request.*`。服务端返回的 message / action（含 `error-codes.json` 里的兜底文案）不翻译，原样显示；`projectViews.setParam` 的事务名 `改节点参数` 是存进内核的标识，`history.tx.*` 按它查译文，保留并标 `i18n-ignore` |
| 路由：`router/index.js` | `meta.title` 改成英文（只剩「有没有标题」和未登记路由的兜底作用），实际标题仍由 `routeTitle()` + `routes.title.*` 决定 |
| 任务中心：`utils/aiTaskView.js` | `STATE_LABELS` / `ERROR_TEXT` / `FILTERS[].label` 改成 getter（读取时才取当前语言），`UNCERTAIN_TEXT` 常量换成函数 `uncertainText()`；服务端给的 `error_readable` 优先，原样显示 |
| 选镜改片：`utils/regionEdit.js` | 位置、费用、策略、拒绝原因、状态、来源、采用提示走 `region.*`；与 `storyboard.wb.*` 完全相同的几条（整段、导入、AI 生成、选镜改片、模型、秒、采用提示、模式名）直接复用。镜头工作台界面本来就用 `components/shot/workbenchLabels.js`，这里是旧纯逻辑的同步迁移，中文输出不变 |
| 一致性：`utils/consistencyView.js` | 评分芯片、建议句、人脸部分、重做估价、自动挑图摘要走 `consistency.*`（整句带参数，英文语序独立）；内部比较 `'视频'` 的地方改成比较 `'image' 或 'video'` |
| 其余：`modelSelection`（价格单位）、`providerEnablement`（默认服务商名、分隔符）、`referenceLibrary`（发给生图模型的提示词）、`scriptTools` / `scriptEpisodes`（解析中文章节标题的正则） | 前两者走 `model.*`；后三者是发给模型 / 解析中文剧本的内容，保持中文并标 `i18n-ignore` |

测试：相关测试文件补了 `setLocale('zh-CN')`，并为 consistencyView、regionEdit、aiTaskView、errorToast、providerEnablement、catalogModels 各加了一条英文语言用例。

遗留（需要后端配合）：`packages/local/src/errors/error-codes.json` 的 130 条 message / action 是中文单语言数据，服务端没带 message 时的兜底、以及几乎总是由表补上的 action（「建议：…」）在英文界面下仍是中文。要彻底解决，需要错误码表加英文字段并让 `/api/v1` 按 `Accept-Language` 返回，或在前端按错误码加 `errors.code.*` 译文；这次没有动。
