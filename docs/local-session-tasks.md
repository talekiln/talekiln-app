# 交给本地会话的任务清单（2026-10-01）

分工沿用 `docs/windows-collab.md`：本地会话在 `win/testing` 上工作，用 Windows 真机验证并改代码。这次 Jay 决定把下面四项整体交给本地做，包括业务接线。云端不再动这四块代码，避免两边冲突；云端只在你们推送后做合并和 CI。

## 约定

- 开工前先合并 `origin/claude/phase1-foundation-mxao0h` 到 `win/testing`。
- 改动走 `win/testing` 推送，在 PR #1 里说一声，云端合并。
- Key 只放本机环境变量，不进文件和提交；提交前跑 `pnpm secrets:scan`。
- 业务写入一律走内核意图（`docs/kernel-design.md` §12.5 列了旁路清单），不要新增直写分镜表/时间线表的路径；改完跑 `node packages/kernel/test/conformance/report.js` 确认一致性套件仍是 0 失败。
- 每项做完补测试，并更新 `docs/phase1-status.md` 对应行与 `docs/bailian-flow-coverage.md`。

## 任务（按建议顺序）

### 1. 桌面主进程启动 lycore（先做，导出依赖它）
- 现状：`apps/desktop` 主进程不启动 lycore，也不设 `LYCORE_ENDPOINT`，打包后点导出报“渲染核心未启动”。
- 要做：主进程用 `packages/core/client/supervisor.js` 拉起 lycore，崩溃重启，退出时关闭；把管道地址传给本地后端（`LYCORE_ENDPOINT`）；`ffmpeg-provision.js` 的 manifest 里 TODO 占位要换成真实下载地址和哈希（或打包内置）。
- 验证：安装包（`talekiln-win-UNSIGNED`）里不靠脚本，直接在界面点导出，得到成片。

### 2. 界面出图、出视频改走任务队列
- 现状：按钮走旧同步服务（`services/imageService.js`、`videoService.js`），无花费守卫、不进任务中心；队列结果不自动写回。
- 要做：按钮改为创建 `/ai-tasks`（先估价再确认，走 `generation` 服务的 estimate -> confirm），任务完成经内核 `recordGeneration` 写回；任务中心能看到进度、取消、失败重试；旧路径保留但不再被界面调用。
- 验证：e2e 脚本里手写的粘合逻辑可以逐步删掉；界面上跑一遍真实出图和出视频。

### 3. 配音进队列、真实花费回写、画布新增节点
- 配音：`POST /episodes/:id/voiceover` 目前直接调 provider；改为进队列和任务中心，行为不变（估价、确认、写回旁白版本和词级字幕）。
- 花费：`spend_log.actual` 现在为空，要把任务结果里的用量（视频计费时长、配音字数、图片张数）写回；花费页显示估算与实际；价格表仍是示例价，要换成百炼公开价目并注明日期。
- 画布：能新增节点、重命名场景（走 `canvas` 意图），撤销/重做走内核历史；时间线页现有两个撤销按钮要合并成一个。

### 4. Windows 人工检查
对照 `docs/test-matrix.md`：托盘、系统通知、睡眠唤醒后任务恢复、退出确认、密钥安全存储（safeStorage）；每个页面打开一遍（含新加的剧本页、画布页、视图切换栏、花费页、登录页）；中文路径和带空格路径。结果写进 `docs/windows-test-results/<日期>.md`。

## 复制给本地 Claude Code 的提示词

> 你在 Windows 上负责 talekiln-app 一期收尾。先读 `docs/local-session-tasks.md`、`docs/windows-collab.md`、`docs/kernel-design.md`。把 `origin/claude/phase1-foundation-mxao0h` 合并进 `win/testing`，按任务清单顺序做 1 到 4 项，每项带测试，业务写入走内核意图，改完跑 `pnpm test`、内核一致性报告和 `pnpm secrets:scan`。Key 只用本机环境变量，绝不写进文件或提交。每完成一项就推送 `win/testing` 并在结果文档里记录；遇到需要产品决定的问题先记录，不要自行改变范围。
