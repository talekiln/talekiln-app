# 开源拆分方案（P2-G，草案）

状态：方案与干跑脚本，**未拆分、未推送**。涉及许可证与 CLA 的文字都是草案，需法务审阅。
背景决定：界面、本地服务、厂商适配器二期起以 AGPL-3.0 开源（加 CLA）；插件 SDK 用 MIT；lycore、授权、云端闭源。现状是单仓库 monorepo。

## 1. 哪些进公开仓库，哪些留私有

| 路径 | 去向 | 许可 | 说明 |
|---|---|---|---|
| `apps/renderer` | 公开 | AGPL-3.0-only | Vue 前端 |
| `apps/desktop` | 公开 | AGPL-3.0-only | Electron 主进程。更新源地址、证书主体名在公开版里只留占位，真实值由私有发布流水线注入（见 2.3） |
| `packages/local` | 公开 | AGPL-3.0-only | 本地服务与厂商适配器（`providers/`） |
| `packages/kernel` | 公开（**待 Jay 确认**） | AGPL-3.0-only | 纯 JS 数据内核；`packages/local` 直接依赖它，不公开则开源版跑不起来。若想保密，必须改成二进制/私有 npm 包，开源版自编译会受影响 |
| `packages/plugin-sdk` | 公开 | **MIT** | 自带 LICENSE，插件可用任意许可证 |
| `packages/core`（lycore，Rust） | **私有** | 专有 | 渲染、授权校验、ffmpeg 供应。见 2.1：其中 `client/` 目录要拆出 |
| `packages/cloud` | **私有** | 专有 | 订单、授权签发、目录与推广 |
| `apps/admin` | **私有** | 专有 | 运营后台 |
| `scripts/secret-scan.mjs`、`licenses-check.mjs` | 公开 | AGPL | 公开仓库 CI 也要跑 |
| `scripts/open-source-export.mjs`、`bailian-e2e.mjs` | 私有 | | 导出工具自己不必公开；e2e 脚本依赖真 Key 与 core |
| `docs/` | 按文件挑 | | 公开：`provider-extension`、`licenses`、`ffmpeg-lgpl`、`kernel-design`、`kernel-conformance`、`error-codes`、`aigc-marking`、`test-matrix`、`open-source-*`、`upstream/`。**私有**：`phase1-status`、`phase2-plan`、`audit`、`launch-prereqs-guide`、`release-signing`、`tencent-deploy`、`cloud-deploy`、`windows-collab`、`local-session-tasks`、`windows-test-results`、`bailian-flow-coverage`、`auto-update`（含发布流程细节，公开前复核）、`screenshots`（逐张确认，可能含测试数据） |
| `LICENSE-LocalMiniDrama` | 公开 | MIT（上游） | 必须保留 |
| 根 `package.json`、`pnpm-workspace.yaml`、`README.md` | 公开 | | `pnpm-lock.yaml` 里有 cloud/admin/core 的 importer 条目，公开仓库要重新生成（见 6） |
| `.github/workflows/ci.yml`、`core.yml`、`bailian-live.yml` | **私有** | | 含 Windows 签名骨架、PG 服务容器、真 Key 的 secret 名 |
| `.github/public-repo/` | 公开（导出时映射成 `.github/`） | | 公开仓库专用的 CI、CLA 机器人、dependabot。放在这个子目录是为了不在私有仓库里误触发 |
| `LICENSE`、`CONTRIBUTING.md`、`CLA.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md` | 公开 | | 草案，见 `LICENSE` 头部说明 |

边界以 `scripts/open-source-export.mjs` 里的 `PUBLIC_PATHS` / `PRIVATE_PATHS` 为准，改边界只改这一处，脚本有测试保证私有路径不会进入公开列表。

## 2. 边界上的耦合点

当前真实情况（读代码得出，不是设想）：

- `packages/local/src/export/coreProvider.js` 用相对路径 `require('../../../core/client')` 连 lycore；`app.js` 用环境变量 `LYCORE_ENDPOINT` 启用，没设置则 `getCore` 为空。
- `apps/desktop` 目前没有启动 lycore 的代码（`LYCORE_ENDPOINT` 只在测试和手工运行里用）。后续桌面主进程接入时必须按"二进制可能不存在"写。
- 授权令牌的 ES256 校验目前**在本地服务的 JS 里**（`packages/local/src/cloud/account.js` 的 `verifyLicence`，公钥来自云端 JWKS）；lycore 的 `licence.status` 是另一份实现，本地服务并没有调它。
- 云端地址来自 `config.yaml` 的 `cloud.base_url`（占位 `https://cloud.talekiln.example`）或环境变量 `TALEKILN_CLOUD_URL`，`cloud/http.js` 里还有一份同样的占位默认值。

### 2.1 本地服务到 lycore

问题：公开仓库里没有 `packages/core`，相对路径 `require` 会在导出树里断掉；协议文档 `packages/core/README.md` 也是私有的。

方案：

1. 新建公开包 `packages/lycore-client`（AGPL），把 `packages/core/client/` 里的 JSON-RPC 客户端部分（`index.js`、`supervisor.js` 及其测试）移过去；`ffmpeg-provision.js` 视清单与下载地址是否含内部信息决定是否一起移（清单里的固定哈希不是机密，但基础地址要走配置）。私有 `packages/core` 只保留 Rust 与它的协议测试，并依赖这个公开客户端做集成测试。
2. 本地服务通过包名 `@talekiln/lycore-client` 引入，**`coreProvider.js` 改成"装得上就用，装不上就返回空"**：`try { require('@talekiln/lycore-client') } catch {}`，端点为空时本来就返回 null，路由已有 503 分支。
3. 把"本地接口 v1"（传输、帧格式、方法表、错误码）抽成公开文档 `docs/lycore-protocol.md`。这是**需要 Jay 决定**的点：公开协议等于允许第三方写兼容内核，利是社区能自建渲染后端，弊是协议成为对外承诺要守兼容。若不公开，开源版只能有一个"空桩"，而无法自行对接。
4. 以上动作会改 `packages/local` 和 `packages/core`，与本地会话在改的文件有交集，**本包没有做**，放到第二批。

### 2.2 授权校验

结论先说：**开源代码里的任何检查都能被改掉**。AGPL 要求公开修改后的源码（对网络服务），但个人在本机改掉判断、自己编译自用，无法阻止。所以：

- 开源部分的授权判断只当"诚实用户的体验"（界面上灰掉、给升级入口），不当作防盗版手段。现在的 `verifyLicence` 留在公开仓库没有问题，但文档和界面都不要把它说成保护。
- 真正的收费边界放在闭源的两处：
  1. **lycore**：渲染、导出等付费功能的 RPC 要求调用方带授权令牌，由 lycore 自己验签和判权益（现在 `licence.status` 只是查询，`render.start` 不要求令牌，是二期要补的设计，**本包没做**）。
  2. **云端**：目录、价格表、推广、更新包下发、账号与设备数限制。开源版不配云端地址就拿不到这些。
- 授权验签逻辑如果要彻底只留一份，就删掉 `account.js` 里的 JS 验签，改调 lycore；但那样没有 lycore 的开源版就无法显示授权状态。折中：保留 JS 验签用于"显示状态"，lycore 验签用于"放行功能"。

### 2.3 云端地址与发布配置

- 公开仓库里一律用占位：`cloud.talekiln.example`、`updates.example.invalid`、空的 `publisherName`。真实地址、证书主体由**私有发布流水线**在打包时注入：环境变量 `TALEKILN_CLOUD_URL`、`TALEKILN_UPDATE_URL`，或私有仓库里的覆盖文件在 electron-builder 之前拷进 `resources/`。代码已支持环境变量覆盖，不需要改。
- 地址还是占位（或 `.example` / `.invalid`）时，客户端视为"社区版"：不登录、不拉目录、不跳推广，使用内置目录与价格表。现有的 `resolveKeyPage` 对占位地址已经返回 null（`cloudCatalog.test.js` 有覆盖）。
- 测试里出现的自家域名（`updates.talekiln.app`、`cloud.mytalekiln.com` 等）改成 `.example`，见第 4 节。

### 2.4 构建与依赖方向

公开仓库不得依赖私有包。脚本里的许可证检查会对每个导出的 `package.json` 检查是否依赖 `@talekiln/core|cloud|admin`（现状：无，`packages/local` 只依赖 `@talekiln/kernel`）。依赖方向永远是 私有 → 公开（私有云端可以用公开的 SDK/客户端，反过来不行）。

## 3. 开源版"自己编译也能跑，不含内核付费功能"

没有 lycore（`LYCORE_ENDPOINT` 为空，或二进制不存在、连不上）时：

| 功能 | 状态 | 现状与要做的事 |
|---|---|---|
| 剧本、分镜、出图、出视频、配音（用户自己的 Key） | 可用 | 全在本地服务里，不依赖 lycore |
| 数据内核、四视图、时间线编辑、版本与撤销 | 可用 | 纯 JS |
| 字幕文件（SRT/ASS）生成 | 可用 | `subtitles/` 是 JS；只是"烧进视频"要 lycore |
| 导出成片（渲染、转码、合成） | **不可用** | 现状：`routes/export.js` 抛 503 `CORE_UNAVAILABLE`，文案是"渲染核心未启动，无法导出。请重启应用后重试"。对社区版这句话是误导（重启没用）。要加区分：`not_installed`（根本没有内核）与 `unreachable`（有但连不上） |
| 编码器检测、媒体探测（`media.probe`） | 不可用，静默降级 | `generation/service.js` 在没有 core 时返回 null，不报错，保持 |
| ffmpeg 自动下载与校验 | 不可用 | 属于 lycore 客户端的 `ffmpeg-provision`，随 2.1 一起处理 |
| 登录、授权状态、专业版权益、云端目录、推广 | 不可用（无云端地址） | 见 2.3，走内置目录；`status.entitled` 为假，不影响上面可用的功能 |
| 自动更新 | 关闭 | 更新源为占位时本来就关闭（`updater-logic` 已有测试） |

界面提示（**要做，本包未做**）：

1. `GET /api/v1/export/options` 增加 `core: { available, reason: 'not_installed' | 'unreachable' }`，服务启动时判断一次并缓存。
2. 导出页在 `not_installed` 时显示固定横幅："当前为社区版，不含渲染内核，不能导出成片。分镜、素材和字幕文件仍可导出；需要成片导出请使用官方版本。"，导出按钮置灰而不是点了再报错；`unreachable` 沿用现有"请重启"提示。
3. 设置页"关于"里显示"社区版 / 官方版"，来源是 `core.available` 与云端地址是否配置，不用另存标志。
4. 本地服务的所有 core 调用点（目前 `export/service.js`、`generation/service.js`）保持"拿不到 core 就明确失败或静默降级"二选一，不能出现半个成功。
5. 测试：补一组在 `LYCORE_ENDPOINT` 为空时跑的用例（路由状态码、options 的 `core` 字段、前端横幅逻辑），并让公开 CI 显式把它设为空（`public-ci.yml` 已设）。

## 4. 仓库里需要清理的内容

干跑脚本会按下面这些规则扫导出树并给出位置（只报 `文件:行号`，不打印命中内容）。当前一次干跑（613 个文件）的结论见第 7 节。

| 类别 | 现状（已核实的） | 处理 |
|---|---|---|
| 内部文档 | 见第 1 节"私有"列；公开文档里仍有 5 处引用 `phase*-plan` 之类 | 删引用或改成泛指；公开 `docs/` 只放面向使用者和贡献者的内容 |
| 私有包路径引用 | 公开文档与注释里 18 处提到 `packages/core`、`packages/cloud`、`apps/admin`（如 `docs/ffmpeg-lgpl.md`、`error-codes.md`） | 改写成"闭源内核""云端服务"，或迁到私有文档 |
| 自家真实地址 | `updates.talekiln.app`、`beta.talekiln.app`（`apps/desktop/test/updater.test.js`）、`cloud.mytalekiln.com`、`h.mytalekiln.com`（`cloudCatalog.test.js`） | 全部换 `.example`；是否真是已注册域名由 Jay 确认，但无论如何不放进公开仓库 |
| 第三方中转站/渠道站地址 | 继承自上游的：`apihub.agnes-ai.com`（出现 20+ 次）、`83zi.com`、`ffir.cn`、`silvamux.tingyutech.com` 等（`AIConfigContent.vue`、`videoClient.js`、`jimengMaterialHubService.js`） | 逐个判断：是用户可选的预设就保留并确认对方允许；是推广/渠道绑定就删。这是继承代码，不要默认可公开 |
| 渠道/外发配置 | `config.yaml` 注释里提到 `ai-configs-qudao.json`；`.gitignore` 已忽略这类文件，但**历史里是否出现过**未核查 | 删引用；公开前用全历史扫描（见 5）确认 |
| 示例价 | `packages/local/configs/prices.json` 已标 `"sample": true` 且有 `_notice`；渲染端测试里有 20 处价格字样；`phase2-plan.md` 里有 39/299 的定价（私有文档） | 价格表保留示例并保持 `_notice`；真实价格只放云端下发。测试里的价格换成明显的假数 |
| 品牌与素材 | `apps/renderer/public/style-thumbs/*`（39 个样图，来源与许可未记录）、`docs/screenshots/*`；产品名 "Talekiln（中文名待定）"；应用图标 | 逐个记录来源与许可证，来源不明的重做或删除。AGPL 不授予商标权：另写商标使用政策（名字、logo 只许指代官方版本），并在名称定稿后再做商标检索。**TODO，需 Jay 与法务** |
| 上游署名 | `LICENSE-LocalMiniDrama`（MIT，xuanyustudio）与 `README.md` 引用 | 保留。上游 MIT 允许在衍生作品上用 AGPL，但**必须保留上游版权与许可声明**；`docs/licenses.md` 第 5 条已要求法务确认商用条款，这条在公开前必须闭环 |
| 包许可证字段 | `apps/desktop` 是 `UNLICENSED`，其余未写 | 公开前改成 `AGPL-3.0-only`（`plugin-sdk` 为 MIT）；干跑脚本会提示 |
| 依赖许可证 | 现有扫描：无 GPL/AGPL，2 个 LGPL（sharp 的 libvips），1 个 WTFPL | 公开仓库 CI 继续跑 `licenses:check`；LGPL 动态链接与 AGPL 兼容，说明留在 `docs/licenses.md` |
| ffmpeg | 公开文档 `ffmpeg-lgpl.md` 描述的是 lycore 的供应方式 | 改写成"闭源内核如何使用 ffmpeg"，公开部分只保留 LGPL 义务说明 |
| 锁文件 | `pnpm-lock.yaml` 含 cloud/admin/core 的依赖条目 | 在导出树里 `pnpm install --lockfile-only` 重新生成，不手改 |
| 密钥 | 现有 `pnpm secrets:scan` 通过 | 导出树上再扫一次（脚本已做），并扫全历史（见 5） |

## 5. 拆分方式与可重复脚本思路

三种做法：

| 方式 | 做法 | 利 | 弊 |
|---|---|---|---|
| A. `git subtree split` | 对某个目录切出带历史的分支 | 自带工具，历史完整 | 只能一个目录对应一个仓库根，而公开仓库由 `apps/*` + 多个 `packages/*` + 根文件组成，不适用；历史里的私有内容仍在 |
| B. `git filter-repo --paths-from-file` | 用 `PUBLIC_PATHS` 重写出只含公开路径的历史，可加 `--path-rename` 做 `.github/public-repo/` 映射、`--replace-text` 抹字符串 | 保留 blame 与贡献记录；可重复 | 需安装 python 工具；提交哈希全变；**历史上任何时候出现过的密钥、内部文档、渠道配置都会带出去**，必须再扫全历史（gitleaks / trufflehog 之类，本环境未运行）；脚本要处理好 `PRIVATE_PATHS` 曾经被移动过的提交 |
| C. 快照导出 | 把当前文件复制出来，在新仓库做一个全新的首提交，之后每次发布再提交一次 | 最安全：没有历史包袱，清理一次即可；本脚本就是这个思路 | 没有历史，blame 看不到演进；外部 PR 合进来之后要回流 |

建议：**首次公开用 C（或 B + 全历史扫描通过），之后以公开仓库为公开部分的权威来源**。理由是外部贡献会直接进公开仓库，如果仍以私有 monorepo 为源，每个外部 PR 都要手工回灌。落地形态：

1. 公开日之前：私有 monorepo 仍是唯一源码；每周跑一次干跑，把 FAIL 清零。
2. 公开日：用 C 生成首个快照提交，推到公开仓库（推送由人手动做，脚本不推）。
3. 之后：私有仓库把公开仓库作为 `public/` 子模块（或 `git subtree pull`）引入，私有包（core、cloud、admin）与官方发布流水线放私有仓库，官方安装包 = 公开代码 + 闭源内核 + 注入的发布配置。公开仓库的 CI 与私有仓库的 CI 见 `docs/open-source-ci.md`。

反方案（继续以私有 monorepo 为源、单向镜像）：改动流程小，但外部贡献回流麻烦，社区会觉得是"橱窗仓库"。需要 Jay 决定。

### 干跑脚本 `scripts/open-source-export.mjs`

```bash
node scripts/open-source-export.mjs --skip-deps          # 或 pnpm export:dry -- --skip-deps
node scripts/open-source-export.mjs --out /some/empty/dir --json
```

做的事：`git ls-files` 取已跟踪文件 → 按 `PUBLIC_PATHS` 选取并排除 `node_modules`、`.env*`、`*.db`、`data/`、`release/`、`dist/` → 复制到临时目录（`.github/public-repo/` 改写为 `.github/`）→ 检查私有路径未混入 → 在导出树里临时 `git init`+`git add`（无提交、无 remote，随后删除 `.git`）跑仓库自带的 `secret-scan.mjs` → 许可证检查（AGPL 全文是否到位、MIT SDK、上游许可证、治理文件、包 license 字段与是否依赖私有包、素材清单）→ 依赖许可证（未 `--skip-deps` 且已 `pnpm install` 时运行 `licenses-check.mjs`）→ 清理规则命中统计 → 打印报告并写 `report.json`。有 FAIL 退出码 1。
不做：不推送、不联网、不改源仓库、不重写历史、不生成锁文件、不扫全历史。纯函数部分有测试：`pnpm test:scripts`。

## 6. 公开前的待办（按顺序）

1. Jay 定：仓库名与组织、公开时间、CLA 条款、`packages/kernel` 是否公开、是否公开 lycore 协议、拆分方式（C 还是 B）、商标策略。
2. 法务：AGPL 版本与持有人、上游 MIT 衍生处理、CLA 全文、行为准则全文、隐私与数据说明。
3. 把真正的 AGPL-3.0 全文放进 `LICENSE`，Contributor Covenant 全文放进 `CODE_OF_CONDUCT.md`。
4. 拆出 `packages/lycore-client` 并改 `coreProvider.js`（2.1）；补"社区版"提示（第 3 节）。
5. 清理第 4 节所列内容；各包 `license` 字段。
6. 在导出树里重生成锁文件；公开仓库开 CLA 机器人所需分支与 secret（`docs/open-source-ci.md`）。
7. 跑全历史密钥扫描（若选 B）；跑干跑脚本到 FAIL 为 0；人工通读导出树一遍。

## 7. 当前干跑结果（2026-10-01，本分支）

导出 616 个文件，无私有路径混入，密钥扫描通过，依赖许可证检查通过（仅 sharp 的 LGPL libvips 告警，已知）。FAIL 1 项：`LICENSE` 仍是占位（符合预期，要等第 6 节第 3 步）。WARN 6 项：plugin-sdk 版权人占位、四个包的 `license` 字段未设为 AGPL、39 个素材待确认许可。清理命中：内部文档引用 5、私有包路径引用 18、真实/第三方域名 79、示例价 20、上游署名 2、渠道配置引用 1（命中数会随文档更新变化，以脚本输出为准）。
