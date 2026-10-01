# 云端 Claude 与本地 Windows Claude 的分工

两边用同一个仓库、不同分支，靠 git 交接，不直接对话。

## 分支约定

- 云端：`claude/phase1-foundation-mxao0h`（PR #1，所有功能和合并都在这里）。
- 本地：从上面分支开 `win/testing`（只放测试结果和 Windows 专属小修）。本地推送后在 PR #1 里说一声，云端合并进主分支。
- 本地不要直接改 `claude/phase1-foundation-mxao0h`，避免冲突。

## 云端做什么

功能开发、数据内核、云端服务、CI、合并与测试、文档；在 Linux 上能验证的一切。收到本地的问题报告后修复，修完在 PR 里说明，并提示本地拉最新分支。

## 本地做什么（只有 Windows 真机能做）

1. 装依赖并从源码启动：`pnpm install`、`pnpm dev`（或装 CI 产出的 `talekiln-win-UNSIGNED` 安装包）。
2. 跑 Windows 专属验证并把结果写进 `docs/windows-test-results/<日期>.md`（对照 `docs/test-matrix.md`）：
   - `cargo test`（packages/core）和 `node packages/core/client/test.js`：Windows 命名管道。
   - `encoder.detect` 输出；NVENC / QSV / AMF 各试导出一段（用你机器实际有的显卡）。
   - Electron：托盘、系统通知、睡眠唤醒后任务恢复、退出确认、密钥安全存储（C04）。
   - 每个新页面（首次引导、分镜表、角色库、镜头工作台、时间线、花费、导出、登录）打开一遍，记录报错和截图。
   - 中文路径、带空格路径、长路径下导入素材和导出。
3. 真 Key 测试：Key 只放你本机的环境变量 `BAILIAN_API_KEY`，不写入任何文件、不发给我。运行 `node scripts/bailian-e2e.mjs`（默认花费上限 5 元，总上限你自己的 50 元），把阶段通过表和实际花费贴回来。
4. 发现问题：用应用里的“导出诊断包”（日志已脱敏），连同复现步骤写进结果文档。

## 本地 Claude 可以直接改的

只改 Windows 专属问题（路径、进程启动、命名管道、字体、安装包配置），改动小、带测试，提交到 `win/testing`。涉及业务逻辑或数据内核的问题只记录，不改，交给云端。

## 给本地 Claude Code 的提示词（复制使用）

> 你在 Windows 上配合云端 Claude 测试 talekiln-app。先读 `docs/windows-collab.md` 和 `docs/test-matrix.md`。从 `claude/phase1-foundation-mxao0h` 开分支 `win/testing`。严格按“本地做什么”逐项验证，结果写进 `docs/windows-test-results/<今天日期>.md`（每项：通过/失败、现象、复现步骤、相关日志片段，日志里不得出现任何 Key、令牌或个人路径以外的敏感信息）。只修 Windows 专属的小问题，业务逻辑问题只记录。绝不把 API Key 写进任何文件或提交。完成后推送 `win/testing`。
