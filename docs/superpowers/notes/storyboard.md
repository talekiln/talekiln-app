# 分镜视图（四视图改造 Task 8）

规格：spec §4.2；计划 Task 8。把旧页（`FilmCreate.vue` 第 5-7 步、`composables/filmCreate/*`、`UniversalSegmentOmniAtEditor.vue`、`PromptEditor.vue`、旧 `StoryboardPage.vue` / `ShotWorkbench.vue`）里的分镜 / 镜头功能移到新 `StoryboardPage`、共享 `ShotInspector`、`ShotParamsDialog` 与整页 `ShotWorkbench`。

## 结构

| 文件 | 作用 |
|---|---|
| `views/StoryboardPage.vue` | 工具条、卡片 / 表格、多选与批量条、右侧 `ShotInspector compact`、自动保存、离开守卫 |
| `views/ShotWorkbench.vue` | 整页工作台：当前视频 / A/B 对比 / 旧候选、选镜改片、版本列表、快捷键、`ShotInspector in-workbench` |
| `components/shot/ShotInspector.vue` | 共享检查器（props：`shotId` = 内核镜头节点 id、`compact`、`inWorkbench`） |
| `components/shot/ShotParamsDialog.vue` | `storyboard.shotParams`：光线 / 景深 / 角度 / 布局锚点 / 氛围 / 动作 / 结果 / 台词 / 旁白、按音频拆分、单镜配音 |
| `components/shot/ShotCard.vue`、`FrameSlot.vue`、`FramePromptDialog.vue`、`AtImageEditor.vue`、`ShotGenerateDialog.vue` | 卡片、首尾帧槽、帧提示词、@图片N 顺序编辑、生成确认（走队列） |
| `components/shot/*.js` | 纯函数与组合式：`shotParams`、`shotInspectorModel`、`shotWrite`、`frameSlots`、`framePrompt`、`atImageOrder`、`multiSelectModel`、`storyboardPageModel`、`storyboardGenerate`、`storyboardOptions`、`workbenchLabels`、`useShotGeneration`、`useShotRecord`、`useMultiRef` |
| `shell/actions/storyboard.js` | `storyboard.generate` `storyboard.regenerate` `storyboard.inferParams` `storyboard.addShot` |
| `shell/dialogs/storyboard.js` | `storyboard.shotParams` |
| `i18n/messages/storyboard.js` | zh-CN / en（430 条）；`test/i18n-migrated/storyboard.json` 登记 |

测试：`atImageOrder` `framePrompt` `frameSlots` `shotInspectorModel` `shotParams` `shotWorkbench` `shotWrite` `storyboardMultiSelect` `storyboardOptions` `storyboardPageModel` `storyboardTable` `workbenchLabels` + `i18n*`。

## 旧功能 -> 新位置对照

| 旧功能 | 新位置 | 备注 |
|---|---|---|
| 生成分镜（第 5 步） | `storyboard.generate` / 工具条“生成分镜” | `POST /episodes/:id/storyboards`，一个可撤销内核事务 |
| 重新生成分镜 | `storyboard.regenerate` / 工具条 | 先确认；成功提示“可撤销以恢复上一版本”（读响应 `can_undo`）；撤销走 `POST /episodes/:id/undo` |
| 旧流程生成（旧按钮） | 已删除 | 按要求不迁移 |
| 批量推断参数 | `storyboard.inferParams` / 工具条 | 不覆盖已有值 |
| 添加镜头 | `storyboard.addShot` / 工具条、`shot.addShot` intent | 加在聚焦镜头之后，否则末尾 |
| 分镜卡片 / 表格 | `StoryboardPage` 卡片 / 表格切换（记住选择） | 表格内联编辑描述 / 台词 / 时长 |
| 多选 + 批量生成 / 重新生成 / 删除 | 批量条（Shift / Ctrl 点选、Ctrl+A、Esc） | 不可用时给出原因；删除走 `shot.deleteShot`，可撤销 |
| 上移 / 下移 / 分段 | `reorderShots`、`moveShotToGroup` intent | |
| 镜头详情（标题、描述、景别、运镜、时长） | `ShotInspector` 剧情 / 镜头语言 | 图字段走 `setShotField`，其余走 `storyboardsAPI.update` + `views.refresh()` |
| 视频 / 图片提示词、模板、润色、按参数重写 | `ShotInspector` 提示词区 | 润色写 `polished_prompt` |
| 关联场景 / 角色 / 道具 + 参考图顺序 | `ShotInspector` 关联素材 + `AtImageEditor` | |
| 首帧 / 尾帧：生成、上传、历史、放大、提示词、用上一镜尾帧、衔接下一镜 | `FrameSlot` + `ShotInspector` 首尾帧区 | 上传用 `imagesAPI.upload`；生成走队列 |
| 项目开关：首尾帧模式、全能片段模式、包含旁白 | 工具条“分镜设置”浮层 | `dramaAPI.saveOutline({metadata})` + `shell.loadProject` |
| 全能片段（`UniversalSegmentOmniAtEditor`） | `ShotInspector` 全能片段区 | 仅在模型支持多参考图时可开；AI 生成 / 润色 |
| 更多镜头参数、按音频拆分、单镜配音 | `ShotParamsDialog` | 配音 `voiceoverAPI.run({shots:[内核镜头id]})` |
| 一致性分数徽标 | 卡片 / 表格 / 工作台 chip | 仅显示分数档位，详细提示文案未本地化（见缺口） |
| 导演模式 | 工具条 / 工作台头部按钮 | 复用 shell 的导演对话框 |
| 工作台：视频预览、A/B 对比、采用版本、选镜改片、版本列表、快捷键 | `ShotWorkbench` | `utils/regionEdit.js` 的中文标签经 `workbenchLabels` 映射到 i18n |
| 工作台：旧候选（`shotCandidatesAPI`） | “候选（旧版）”页签 | 只保留采用，不再生成 |
| 批量页 / 素材页 / 导出 / 任务中心入口 | 外壳（LeftRail / TopBar） | 不在本页重复 |

## 写入路径

- 图字段（标题、描述、景别、运镜、时长等）：`views.intent('shot','setShotField',{shot_id, patch})`。
- 其余列（台词、旁白、布局等旧表列）：`storyboardsAPI.update(legacyId, …)`，随后 `views.refresh()`。拆分在 `components/shot/shotWrite.js` 的 `saveShotPatch`。
- 增删 / 排序：`shot.addShot`、`shot.deleteShot`、`reorderShots`、`moveShotToGroup`。
- 生成：只走队列（`useShotGeneration` + `ShotGenerateDialog`）。本文件集合不调用 `imagesAPI.create` / `videosAPI.create`（`imagesAPI.upload` 除外）。

## 缺口与偏差（协调者需要知道）

1. **尾帧没有队列生成路径**：能力位 `lastFrameGenerate=false`，按钮禁用并给出原因；可上传、从历史选或使用上一镜尾帧。
2. **多参考图能力来源**：取当前视频 AI 配置（`useMultiRef`，`aiAPI.list('video')`，只读），而不是内核能力接口。
3. **后端不保存光线 / 景深**：`lighting_style`、`depth_of_field` 不会被 `PUT/GET /storyboards` 持久化（后端缺口，非本 lane）；对话框内已提示。
4. **依赖生成 lane 的文件**：`ShotGenerateDialog` / `useShotGeneration` 引用 `@/components/generate/generateConfirm`（`previewSummary`、`submittedText`）。
5. **一致性提示文案**：只保留“分数 + 三档建议”，`consistencyView` 的详细提示被省略。
6. **失败原因**：优先显示服务端 `error_message / error_code`，否则回退到 `storyboard.state.failedHint`。
7. **工作台布局变化**：左侧为首帧预览 + 共享 `ShotInspector`（旧版是单独的表单），右侧页签。路由 `legacy-shot-workbench` 没有 `episodeId`，内核镜头 id 由旧 id 经 `views.index.shotByLegacy` 反查，视图在读到镜头后再加载。
8. **空分组**：内核的“剧本”空分组会显示一个 0 镜头的分组标题（卡片视图）。
9. **环境**：浏览器走查用的是 `http://127.0.0.1:3013`（3000 端口是另一个应用）。

## 浏览器走查（只读，伪造服务商）

在示例项目“雨夜末班车”上：卡片视图、选中镜头出现批量条与检查器、“更多镜头参数”对话框、表格视图、整页工作台均能打开，控制台无新错误（只有一条渲染核心 503，属外壳）。走查中发现并修复两个问题：`useShotRecord` 把 getter 传给 `unref` 导致检查器显示“找不到这个镜头”（改用 `toValue`）；卡片图片在 9:16 项目里把卡片撑得过高（图片改为绝对定位铺满 16:9 容器）。没有执行任何写操作。
