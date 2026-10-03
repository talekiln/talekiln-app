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
4. `utils/generationView.js`（`confirmSummary`、chips、`KIND_LABELS`、`submittedText`、`taskTarget`）与 `api/queuedGeneration.js` 仍是中文，未走 i18n。
5. `constants/styleOptions` 的风格名与分组名仍是中文。
6. `VersionHistoryDrawer.vue` 里除状态外的其它中文（如 `kindText`）。
7. `exportJob.js` 的标签用 `i18n-ignore` 跳过了检查。
8. 状态栏仍显示原始画幅比例（未用 `aspectLabel`）。
9. `NewBlankDialog` 用 `home.aspect.*`，与 `common.aspect.*` 重复。
10. 首页进入"媒体素材"标签只有"管理"按钮和命令面板两条路。
11. 首页上 `useActionContext` / `shell.dramaId` 可能是上一个项目的残留值（全局素材库因此用 `browseOnly`）。
12. 其它各 lane 笔记（`assets / canvas / generate-export / home / script / shell / storyboard`）里的缺口不在此重复。
