# 四视图改造：真实浏览器验证（2026-10-03）

范围：用假厂商后端（`TALEKILN_FAKE_VENDOR=1`，临时数据目录，端口 5791 / 3092）在真实 Chrome 里走一遍四视图。截图只在本机，不进库。已在用的开发后端 5679 / 渲染端 3013 没动过；临时项目和旧的 `zz-canvas-stress-throwaway` 都已软删除，开发库里只剩示例项目。

## 走过的路径

- 首页 -> 新建空白项目 -> 剧本（全文应用、追加一行、保存状态）-> 分镜（新增镜头 x3、检查器填提示词、生成全部确认框、后台生成完成后卡片自动刷新）-> 时间线 -> 画布。
- 导出菜单：四个视图各开一次，8 项齐全（导出视频、剪映、Premiere、SRT、分镜表、项目包、素材包、整项目备份）；导出视频在渲染核心未连接时是软禁用，不是消失。
- 素材面板、状态栏（`save-state`、`core-state`、摘要）。
- 语言开关切到 English 后每页复查；画质草稿 / 终稿开关；重新生成一镜后连撤两步。
- 画布：`ShotInspector` 可选 prop 名、过期高亮过滤。
- 整项目备份导出 -> 首页“导入项目包”恢复：得到新项目，原项目不动，撤销历史随之恢复。
- 外壳在约 900 px（同源 iframe 里测，窗口缩放改不了视口）下的菜单栏。
- 每页读控制台：没有错误和告警（唯一的 5xx 是 e2e 文档里记过的、故意制造的备份“测试连接”失败，本次没触发）。

## 发现并修了的问题

| 问题 | 提交 | 回归测试 |
|---|---|---|
| 后台生成结束后，已打开的分镜卡片 / 视图不刷新，要手动切页 | 5ed38d0 | `test/dialogHost.test.js` |
| 恢复项目包后撤销历史退化：日志里有 `addShot` 时 `verifyHistory` 因 `legacy_id` 对不上而丢弃整段历史 | 1ca65ab | `packages/local/test/kernelSnapshot.test.js`（保留完整历史） |
| 切到 English 后浏览器标签标题仍是中文 | 4c13336 | `test/routeTitle.test.js` |
| 窗口 <= 1100 px 时顶栏的“生成 / 导出”被裁掉 | 4c13336 | 无（纯 CSS，见下） |

## 还在的问题（没修，需要设计或范围更大）

- 未迁移 i18n 的中文：`TimelineEditor.vue`、`VersionHistoryDrawer.vue`、`DirectorPanel.vue`（全局抽屉，aria-label 在每一页都带中文）、`builtinCommands.js`，以及旧页面（新建项目、AI 配置、花费、快捷键、关于、任务中心、素材库）。
- 状态栏“画风”显示原始键（如 `realistic`），没有本地化名称。
- 16:9 项目的合成节点仍是 1080x1920。
- 时间线片段标签是素材哈希，不是镜头名。
- 没有任何可生成内容时，仍显示“采用已有结果”按钮。
- 顶栏“生成”菜单在窄屏下仍偏紧（已不再被裁掉，但没有重排）。
- 剧本视图逐行 / 全文切换偶发一次显示错位，之后没能复现。
- 顶栏窄屏换行的 CSS 没有自动化测试。
- 测试环境现象：我的浏览器标签处于后台时，`el-dialog` 的开合动画被节流，要截一次图才继续；不是产品问题。

## 没验证的

- 真实服务商生成（图 / 视频 / 配音）：只用了假厂商，没有真实 Key。
- AI 文本类功能（AI 写剧本、提取资产、生成分镜）：假厂商没有文本模型，只看到了报错路径。
- Electron 打包与安装包。
- 渲染核心的 MP4 导出（核心未连接，菜单项软禁用）。
- `apps/renderer/e2e/run.mjs` 的完整执行：已改到新路由并加了主流程，选择器逐个在真实页面核对过，但本机没有 Playwright（装它是下载，未获许可），`node e2e/run.mjs` 在第一步报 `Cannot find module 'playwright'`，0 通过 / 0 失败。需要有 Playwright 的环境重跑。

## 遗留问题修复（bugfix worker，同一分支）

| 问题 | 修法 | 回归测试 |
|---|---|---|
| 状态栏显示原始画风键（`realistic`）和原始画幅 | `StatusBar.vue` 用新的 `utils/styleName.js`（`custom` 走 `common.style.custom`，预设走 `getStyleLabel`）和 `aspectLabel` | `test/bugfixLabels.test.js` |
| 内核合成节点对 16:9 项目仍是 1080x1920 | `packages/local/src/kernel/legacy.js`：导入旧表时按 `dramas.metadata.aspect_ratio` 设置 compose 的 `size`（16:9 -> 1920x1080，9:16 -> 1080x1920，1:1、4:3、3:4、21:9 同理；未知或缺失保留内核默认）。内核包没动 | `packages/local/test/kernelComposeSize.test.js` |
| 时间线片段标签是素材哈希 | 新增 `utils/clipLabel.js`：字幕显示文字，属于镜头的片段显示“镜 5 · 标题”/“Shot 5 · title”，音乐显示文件名；`TimelineEditor.vue` 的 `clipLabel` 改为调用它；新键 `common.shot.number / numberTitled` | `test/bugfixLabels.test.js` |
| 没有可生成内容时仍显示“采用已有结果” | `previewSummary` 新增 `nothingToDo`（免费、没有可采用的缓存命中、未被拦截）；确认框此时不显示确认按钮，显示提示“没有需要生成的内容，也没有可采用的已有结果”，取消键变“关闭”；加载中 / 加载失败也不再显示灰掉的确认键 | `test/bugfixLabels.test.js` |
| 顶栏“生成”菜单窄屏偏紧 | “生成”“导出”包进 `.menus`，窄屏换行时相邻、靠右、整体换行；下拉面板宽度不超过视口。真实浏览器 1000 px / 420 px 核对过 | `test/bugfixLabels.test.js`（源码断言） |

没修的：

- 已经存在的项目图里合成节点仍是旧的 1080x1920（只在首次导入旧表时设置；之后在项目设置里改画幅不会回写 compose.size）。
- 时间线页在 1000 px 下标题“时间线编辑”被挤成竖排（TimelineEditor 样式，i18n 之外的另一个小问题）。
- 状态栏“风格”的预设名是否随语言变化取决于 `constants/styleOptions` 的本地化（仍是中文名，i18n 另有人在做）。
