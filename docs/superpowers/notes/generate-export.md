# 生成 / 导出 lane（Task 9）说明

范围：「生成」菜单（`generate.*`）与「导出」菜单（`export.*`）背后的全部动作，加上 `usePipeline` 编排、导出对话框、多集批量页、
SRT / 分镜表导出、项目包 / 资产包 / 完整备份入口，以及 zh-CN / en 文案。本文先写与计划不同之处，再写旧功能到新位置的对照与缺口。

## 1. 与计划的差异（以本节为准）

1. **新增 `components/generate/**`**（计划里只有 `components/export/**`）：`GenerateConfirmDialog.vue`、`PipelineDialog.vue`、`VoiceDialog.vue`、
   `RerunDraftDialog.vue`，以及纯函数 `generateConfirm.js`、`generateActions.js`、`generateApi.js`、`pipelineView.js`。纯逻辑与 `.vue` 分开，
   是为了能在 `node --test` 下单测。
2. **`components/export/` 多了辅助文件**：`zipStore.js`（无依赖的 store-only ZIP 写入）、`assetPack.js`、`exportActions.js`（导出菜单各动作的纯逻辑）、
   `exportDialogModel.js`、`saveFile.js`，对话框是 `ExportDialog.vue` 与 `MediaExportDialog.vue`（剪映 / FCPXML 共用）。
3. **`utils/batchView.js` 改成 i18n 版本**：标签表变成函数 / getter（`KINDS_OPTIONS[i].label`、`ON_FAIL_OPTIONS[i].label`、`batchStatusLabel` 等），
   移除了没人用的 `BATCH_STATUS_LABELS` / `ITEM_STATUS_LABELS` / `WAITING_LABELS` 三个导出。zh-CN 输出与之前逐字相同。
4. **改动了 `router/index.js` 里 `episode-export` 这一条记录**（计划允许的唯一一处）：`beforeEnter` 打开 `export.video` 对话框并重定向到 `episode-timeline`。
   `legacy-episode-export`（`/episodes/:id/export`）没动，仍指向 `ExportPage.vue`；该文件已改成几行的兜底：回到时间线并打开导出对话框
   （只有 `resolveLegacyRoute` 解析不出项目时才会走到，这时没有 dramaId，所以只跳回首页）。
5. **`TimelineEditor.vue`** 只改了 `goExport()`：先 `flushPending()`，再直接 `openDialog('export.video', …)`，不再经过路由。其余（视觉、中文文案、快捷键）原样保留，
   所以它**没有**登记到 `i18n-migrated`。
6. **`BatchPage.vue` 搬进 shell**：删掉自带的头部（返回按钮、任务中心 / 花费链接，shell 已提供），只留标题行；全部文案走 `generate.batch.*`；
   后端暂停原因是中文文案，页面里用 `/预算/` 判断是否弹出“提高预算”，该行带 `// i18n-ignore`。`/p/:dramaId/batch`（路由名 `batch`）与旧 `legacy-batch` 都指向它。
7. **一键成片的暂停**：计划里的 `pauseBetweenPhases` 默认关；runner 多了 `cancelled` 状态（取消只停掉后续步骤，已提交给后端的任务不撤销）。
8. **导出对话框是模态的**：导出进行中不能关闭（关闭会让轮询失联）；“取消”只停止渲染任务。
9. **确认弹窗统一用 `shots: 'all'` + `regenerate: false`**：已是最新的跳过、有相同内容的旧结果直接采用（不收费），摘要里单独列出。
10. **kernel 视图要取 `.data`**：`kernelAPI.view()` 返回 `{ view, seq, data }`。`usePipeline.collectState` 与 `loadTimeline`（SRT 导出）都按此解包。
    上线前浏览器检查时发现一键成片误报“没有剧本”，据此修复。
11. **`PipelineDialog` 的画风 prop 叫 `artStyle`**，不能叫 `style`（Vue 会把它当成 style 透传并转成对象）。
12. 新增守卫测试 `test/generateExportKeys.test.js`：本 lane 源码里出现的 `generate.*` / `export.*` i18n key 必须存在（动态 key 检查前缀）。
13. 登记了 `test/i18n-migrated/generate.json` 与 `export.json`（只含已完全迁移的文件）。为通过检查，把 `exportStoryboardSheet.js` 里嵌套的模板字符串拆开了
    （检查器不处理模板里嵌套的引号 / 正则）。

## 2. 旧功能 → 新位置对照

| 旧功能（位置） | 新位置 | 说明 |
|---|---|---|
| 时间线页「导出」按钮 → ExportPage | 导出菜单「导出成片 MP4…」/ 时间线页「导出」→ `ExportDialog` | 分辨率、平台预设（含预设说明）、帧率、编码器（含重新检测）、输出路径、AIGC 开关与制作方名称、进度 / 计时 / 取消 / 打开所在文件夹全部保留 |
| ExportPage 的草稿档提示 | `ExportDialog` 内的草稿提示 | 由 `shell.draftCount` 驱动 |
| ExportPage 的剪映草稿 / FCPXML 区块 | 导出菜单「剪映草稿」「Premiere / Final Cut 工程」→ `MediaExportDialog` | 多了分辨率 / 帧率选择；目录默认取默认输出路径所在目录；“仅检查”（dry run）与同名工程“覆盖”保留 |
| 旧 `/episodes/:id/export` 页面 | `export.video` 对话框 | 路由重定向见上文第 4 条 |
| 无（新增） | 导出菜单「字幕 SRT」 | 取时间线字幕轨；UTF-8 带 BOM、LF 换行 |
| 无（新增） | 导出菜单「分镜表」 | 纯文本列的 Excel HTML（.xls）与 CSV 备选（**没有缩略图**）；道具列目前为空（旧分镜列表没有道具 id） |
| 无（新增） | 导出菜单「项目包 ZIP…」 | 调 Task 5 的项目包接口 |
| 无（新增） | 导出菜单「资产包…」 | 浏览器端生成 store-only ZIP（见第 3 条） |
| 无（新增） | 导出菜单「完整项目备份…」 | 调 Task 5 `backup/full`；接口 404 时降级提示 |
| 剧集页 / 分镜页「一键成片」流程（FilmCreate 内） | 生成菜单「一键成片」→ `PipelineDialog` + `usePipeline` | 步骤固定 10 步，已有 / 已锁定的跳过；可选“提取”“角色/场景/道具图”“旁白配音”“每阶段后暂停”；花钱前必须点“确认并开始（将产生费用）” |
| 「补齐过期与未生成」 | 生成菜单「只补齐过期与未生成」→ `GenerateConfirmDialog` | 先预览（含缓存命中、已最新、被拦截项），再确认 |
| 全部首帧图 / 全部视频 | 生成菜单同名项 → `GenerateConfirmDialog` | 同上 |
| 全部配音 | 生成菜单「全部配音」→ `VoiceDialog` | 先预览条数与费用再确认 |
| 导演模式 | 生成菜单「导演模式…」 | 打开 `composables/useDirectorPanel.js` 的 `openDirector`（既有入口）（本 lane 不重写） |
| `/dramas/:id/batch` 批量页 | 生成菜单「多集批量生成…」/ 侧栏「多集批量生成」→ shell 内 `BatchPage` | 估算、预算、每服务商并发、失败策略（重试 / 跳过或暂停 / 夜间时段）、暂停 / 继续 / 取消 / 重试失败集全部保留；创建前必须确认估算 |
| 按成片质量重跑草稿产物 | 生成菜单「按成片质量重跑草稿产物…」→ `RerunDraftDialog` | 调 `POST /episodes/:id/quality/rerun`（Task 5 regenerate），先预览再确认 |
| 「快速合并」/ finalize 界面 | **删除**（按计划不重做） | `FilmCreate.vue` 里还留着 `finalizeEpisode` 调用，随旧页面一起在 Task 12 清理 |

## 3. 已知缺口与取舍

- **渲染核心缺口**：字幕烧录、对白烧录、水印不在本 lane 范围，渲染核心（闭源，未连接时 `503 CORE_UNAVAILABLE`）目前没有对应参数。导出对话框不提供这些开关。
- **费用估算不含**角色 / 场景 / 道具图与“提取”步骤（`generate.pipeline.estimateExcludes` 会提示）；这些步骤的数量要等前面的步骤跑完才知道。
- **取消不撤销已排队的后端任务**：已提交给服务商的任务照常跑完并写回，费用已产生（批量页的取消确认里也这么写）。
- **资产包**：纯前端生成 store-only ZIP（不压缩、无 zip64），整包放在浏览器 Blob 里，远程图片受 CORS 限制，失败的文件会列在结果里而不是静默丢弃。
- **SRT**：UTF-8 带 BOM、LF 换行；没有字幕时给出提示而不写空文件。
- **分镜表没有缩略图、道具列为空**。给协调者：`messages/shell.js` 里 `shell.menu.export.storyboardSheet.desc` 写的是“带缩略图的分镜表文档 / with thumbnails”，与实际不符，应改成不提缩略图（该文件不归本 lane）。
- **Task 5 依赖**：`backup/full` 与 `quality/rerun` 若不存在，对应菜单项给出可读的失败提示，不抛未处理异常。
- **导出对话框打开时若渲染核心不可用**：顶部显示错误，同时 `request.js` 会弹一次全局提示（所以会看到两次同样的文字）。
- 浏览器检查（只读，开发服务器 3013、测试数据、无真实 Key）：批量页在 shell 内正常渲染；导出菜单项禁用 / 启用状态正确；
  `/p/1/e/1/export` 重定向到时间线并打开导出对话框；一键成片对话框预览出步骤与费用，确认按钮在预览期保持禁用。**没有**点任何会花钱的按钮。

## 4. 测试

`cd apps/renderer && node --test test/<file>.test.js`。本 lane 的测试：`usePipeline`、`pipelinePlan`、`pipelineView`、`exportJob`、`exportSrt`、`exportStoryboardSheet`、
`exportDialogModel`、`exportMenuActions`、`generateConfirm`、`generateMenuActions`、`assetPack`、`zipStore`、`batchView`、`generateExportKeys`，另有 `i18nParity` / `i18nLiterals`。
