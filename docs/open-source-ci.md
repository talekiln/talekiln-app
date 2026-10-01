# 双仓库 CI 说明（P2-G，草案）

对应 `docs/open-source-split.md` 第 5 节的目标形态：公开仓库（界面、本地服务、适配器、SDK）和私有仓库（lycore、云端、后台、发布流水线）。
本文只描述，没有创建任何会推送代码的工作流。

## 公开仓库

工作流来源：本仓库 `.github/public-repo/`，导出时映射为公开仓库的 `.github/`。

| 工作流 | 触发 | 内容 | 需要的 secret |
|---|---|---|---|
| `public-ci.yml` | push 到 main、所有 PR | Windows 与 Linux 上：`pnpm install --frozen-lockfile`、`secrets:scan`、`licenses:check`、`pnpm test`（`LYCORE_ENDPOINT` 显式置空，证明没有内核也能过）、`pnpm build`；另跑 SDK 测试与类型检查 | 无 |
| `cla.yml` | PR 打开/更新、评论 | `contributor-assistant/github-action@v2.6.1`：未签 CLA 的作者在 PR 里收到提示，回复固定句子即签署；未签则状态检查失败 | `GITHUB_TOKEN`（自动提供）；`CLA_SIGNATURES_PAT`（仅当签署记录放在别的仓库或受保护分支时才要，名字可改，**值只存在 GitHub Secrets，不进仓库**） |
| `dependabot.yml` | 每周 | npm 与 Actions 依赖更新，次/补丁合并成一个 PR | 无 |

上线前要在公开仓库做的设置：

1. 把 `cla.yml` 里 `path-to-document` 的 `TODO-ORG/TODO-REPO` 换成真实仓库名（Jay 定名后）。
2. 建一个空的 `cla-signatures` 分支，保持不受保护（或给 PAT 绕过权限）；签署记录是 `signatures/cla.json`。
3. 把 "CLA" 和 "public-ci / test" 设为 main 分支的必需状态检查；开启 GitHub 私密漏洞报告（`SECURITY.md` 依赖它）。
4. `cla.yml` 用 `pull_request_target`，它带写权限，**不得在该工作流里检出或运行 PR 代码**；以后改它时守住这条。
5. 不在公开 CI 里放任何厂商真 Key 的任务（`bailian-live.yml` 留在私有仓库）；来自 fork 的 PR 本来也拿不到 secret。
6. 法务审阅 `CLA.md` 之前不要启用机器人，否则贡献者签的是未定稿的文本。

## 私有仓库

保留现有工作流不动：`ci.yml`（Windows 测试、云端 PG 测试、打包与签名骨架）、`core.yml`（Rust 构建与测试）、`bailian-live.yml`（真 Key 手动检查）。拆分后的变化：

- 公开代码以 `public/` 子模块进入（见拆分方案第 5 节）。`ci.yml` 的测试步骤改成：先跑公开仓库同一套测试，再跑私有包（core、cloud、admin）和"有内核"的集成测试（`LYCORE_ENDPOINT` 指向刚构建的 lycore）。
- 打包流水线 = 公开代码 + 闭源内核二进制 + 注入发布配置（云端地址、更新源、证书主体）。这些值只在私有仓库的 secret 或变量里；现有签名用的 `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD` 不变。
- 私有仓库额外加一条"公开部分漂移检查"：对子模块指向的提交跑 `scripts/open-source-export.mjs`（私有仓库里的版本），FAIL 非零就阻止升级子模块指针。
- 想自动把私有侧改动同步到公开仓库时，用单独的发布工作流 + 细粒度 PAT（建议名 `PUBLIC_REPO_PUSH_TOKEN`，只给公开仓库的 contents 写权限，只在手动触发、需审批的环境里可用）。**本包没有写这个工作流**：首次公开建议人工推送，流程稳定后再自动化。

## 两边的一致性

| 事项 | 做法 |
|---|---|
| 同一份测试跑两遍 | 公开仓库的测试不依赖私有包；私有仓库只在其上叠加。公开测试在私有侧红了，先修公开仓库 |
| 接口契约 | lycore 协议（`docs/lycore-protocol.md`，待建）与插件 SDK 版本号是两边共同的契约；改它们要两个仓库同时看 |
| 许可证与密钥检查 | 公开 CI 每次都跑；导出干跑脚本在私有侧跑，用于发布前把关 |
| 依赖方向 | 私有可依赖公开，公开不得依赖私有；干跑脚本会检查 |
