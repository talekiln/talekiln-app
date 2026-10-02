# 二期 P2-H：管理后台扩展与官网静态页

状态：云端接口与迁移、后台界面、官网静态页、测试已完成。**后台界面没有在真实浏览器里点过**（只做了 `vite build` 通过和纯函数/接口调用单测）；官网只验证了构建产物，没有在真实浏览器和多种屏幕上看过。本文不含任何密钥、连接串或真实地址。

## 1. 云端（packages/cloud）

迁移 `20261004000000_admin_ops`，新增四张表（表名沿用本仓库的帕斯卡命名，对应需求里的 announcements / releases / admin_roles / admin_audit）：

| 表 | 作用 |
| --- | --- |
| `Announcement` | 公告：标题、正文、级别 `info/warn/critical`、渠道 `all/beta/stable`、生效时间 `startsAt`、结束时间 `endsAt`（可空）、`enabled` |
| `Release` | 版本发布：`version`、通道 `beta/stable`、`rolloutPercent`（0–100）、`minVersion`、`forced`、`notes`、`enabled`；`(version, channel)` 唯一 |
| `AdminRole` | 管理员角色：每账号一条，`ADMIN/OPERATOR/READONLY`，记录授予人 |
| `AdminAudit` | 审计日志：只增不改，含操作者快照（邮箱、角色）、路由、对象、结果、脱敏后的请求摘要、来源 IP |

枚举类字段用 `String` 存，取值由 zod 和迁移里的 `CHECK` 约束双重保证（含灰度 0–100）。部署：`pnpm --filter @talekiln/cloud prisma:deploy`，这是纯新增，不改旧表。

### 1.1 角色与权限

| 权限 | READONLY | OPERATOR | ADMIN | 覆盖的接口 |
| --- | :-: | :-: | :-: | --- |
| `read` | 是 | 是 | 是 | 所有 `GET /admin/*`（除下面单列的） |
| `ops:write` | | 是 | 是 | 邀请码、用户启停、公告、版本发布、模型目录、发票登记/开具/作废 |
| `feedback:diagnostic` | | 是 | 是 | 下载诊断包 |
| `billing:refund` | | | 是 | 订单退款 |
| `billing:plans` | | | 是 | 新建套餐、新增价格版本、启停套餐 |
| `admins:manage` | | | 是 | 管理员的列表/授予/改角色/撤销 |
| `audit:read` | | | 是 | 审计日志 |

- 接口用 `@Require('权限')` 声明；**未声明时的默认值是宁严勿松**：`GET` 需要 `read`，其余方法需要 `ops:write`。新加的管理写接口即使忘了标注也不会被只读账号调用。
- 角色**不放进令牌**，每次请求回查账号与角色：降权、撤销、禁用立即生效。
- 有效角色：有 `AdminRole` 记录以它为准；没有记录但 `Account.role = ADMIN` 的旧管理员（P1 里通过环境变量创建的）按 `ADMIN`，所以升级后原管理员无需任何操作。撤销旧式管理员时会把 `Account.role` 改回 `USER`。
- 保护：至少保留一个未禁用的 `ADMIN`（降级、撤销都会被 409 拒绝）；管理员账号不能通过 `/admin/users/:id/disable` 禁用（含有 `AdminRole` 记录的账号）。
- `GET /admin/me` 返回 `{ accountId, email, role, permissions[] }`，后台界面据此显示入口。
- 管理员接口：`GET /admin/admins`；`POST /admin/admins { email, role, password? }`（邮箱已有账号直接授予；否则 `password` 必填，至少 12 位，用 bcrypt 建新账号）；`PUT /admin/admins/:accountId/role { role }`；`DELETE /admin/admins/:accountId`。

### 1.2 审计

- `AuditInterceptor` 挂在所有管理控制器（`AdminController`、`AdminOpsController`、`AdminBillingController`）上，**所有非 GET/HEAD 方法自动记录**，新增管理写接口无需额外代码。响应发出前先写完日志。
- 记录内容：时间、操作者（账号、邮箱、角色）、`action`（如 `POST /admin/orders/:id/refund`）、对象（`targetType` 取路径第一段，`targetId` 取路径参数，没有则取新建记录的 `id`）、成功与否和状态码、来源 IP、请求摘要。
- 额外会记的：管理员登录成功与失败（失败只记邮箱）、**越权的写尝试**（403，操作者是谁一目了然）。读操作不记。
- 脱敏：请求摘要里键名匹配 `pass(word)|secret|token|key|authorization|sign|credential` 的值一律替换为 `[redacted]`，字符串截断到 300 字，摘要整体超 4000 字符则只记 `{truncated:true}`。
- 写审计失败只打日志，不让业务操作失败（业务已经写入，反过来回滚不可行）。因此审计是“尽力而为”，数据库故障时可能丢记录；要做到强一致需要把审计写进同一事务，当前没做。
- 查询：`GET /admin/audit?actorId=&action=&targetType=&targetId=&before=&limit=`（ADMIN），按时间倒序，`before` 翻页（同一毫秒的记录翻页时可能漏）。
- 日志只增不改：仓储接口只有 `add` 和 `list`。库里仍然可以被有权限的人直接改，需要防篡改要另外做（如外发或链式哈希），当前没做。

### 1.3 公告

- 旧接口 `GET|PUT /admin/announcements`（整体替换，存在 `Setting` 表）**已移除**，改为：`GET|POST /admin/announcements`、`PUT|DELETE /admin/announcements/:id`。旧 `Setting` 里的公告不迁移（旧数据只有后台手填的几条，上线前没有真实内容）。
- 客户端：`GET /public/announcements?channel=beta|stable`（缺省或非法回落 `stable`），只返回“已启用、`startsAt <= now`、`endsAt` 为空或晚于 now、渠道为 `all` 或匹配”的公告，字段 `id,title,body,level,channel,startsAt,endsAt`。
- 注意：另有一个 P1 的签名目录 `GET /catalog`，里面的 `announcements` 字段来自 `CATALOG_FILE`，**与这里的公告是两套**，本工作包没有合并。

### 1.4 版本灰度与 `GET /updates/check`

- 管理：`GET|POST /admin/releases`、`PUT /admin/releases/:id`（可改 `rolloutPercent/minVersion/forced/notes/enabled`；版本号与通道创建后不可改）。`enabled=false` 是回滚开关：立即停止下发。版本号必须是语义化版本，`minVersion` 不能高于发布版本。
- 客户端：`GET /updates/check?version=1.2.3&channel=stable&deviceId=...`，公开，每 IP 每分钟 120 次，`Cache-Control: no-store`。`channel` 缺省 `stable`；`deviceId` 可选，8–128 位 `[A-Za-z0-9._:-]`（可用设备 ID 或遥测的安装 ID，**同一个客户端要始终传同一个**）。
- 响应：`{ update: false }` 或 `{ update: true, version, channel, notes, forced, minVersion, rolloutPercent }`。**不含下载地址与哈希**——安装包仍走 P1 自动更新（`electron-updater` 的 `feedUrl`），本接口只负责“该不该提示、提示哪个版本、是否强制”。桌面端目前没有接这个接口（没动 `apps/desktop`）。
- 选择规则：`stable` 通道只看 stable 发布；`beta` 通道看 beta 与 stable。在版本高于当前版本的发布里取最新且该设备命中灰度的一个（没命中最新的会回落到次新的、已命中的版本）。同版本号 beta 与 stable 并存时 stable 优先。没有 `deviceId` 时只命中 100% 的发布。
- 分档：`bucket = sha256("talekiln-rollout|<通道>|<版本>|<deviceId>")` 前 4 字节 `mod 100`，命中条件 `bucket < rolloutPercent`。结果只取决于输入，**与时间、请求次数、服务器实例无关**，可复现。盐里带通道与版本，所以同一设备在不同发布里的档位互相独立（不会总是第一批）；调高百分比只会纳入更多设备，已命中的设备不会丢。算法改动会让全网设备重新分档，测试里锁定了这一点。
- `forced = 发布的 forced 标记，或当前版本低于该发布的 minVersion`。注意 `minVersion` 只在设备被灰度命中该发布时才生效，所以“强制低版本升级”要配合 100% 全量。

#### 1.4.1 桌面端接入（P3-C 补）

- `apps/desktop/cloud-check.js`（副作用）+ `cloud-check-logic.js`（纯函数，`node:test`）：主进程启动后 **30 秒**首次、之后**每 6 小时**各调一次 `GET /updates/check?version=&channel=&deviceId=&platform=&arch=` 与 `GET /public/announcements?channel=`。`channel` 由 electron-updater 的渠道映射（`latest → stable`、`beta → beta`）；`deviceId` 首次生成后存 `<userData>/device-id`，同一台机器始终相同；`platform / arch` 云端目前忽略（zod 剥掉未知键），先带上。base URL 沿用本机服务的 `cloud.base_url`（`configs/config.yaml`，`TALEKILN_CLOUD_URL` 可覆盖），HTTP 层直接复用 `packages/local/src/cloud/http.js`；占位域名、离线、云端不可达一律静默（只写 `main.log`，保留上一次结果）。
- 结果经 IPC `cloud:status` 推给渲染端；`preload.js`（sandbox + contextIsolation）只暴露 `window.talekilnDesktop.{getCloudStatus, checkCloudNow, downloadUpdate, onCloudStatus}`，不暴露 `ipcRenderer`。渲染端：`utils/updatesView.js`（纯函数，`node:test`）、`composables/useDesktopCloud.js`；「关于」页显示“有新版本 x.y.z，去下载”（强制更新加说明）或“已是最新 / 尚未检查 / 检查失败”；首页顶部 `AnnouncementBar.vue` 显示公告（按级别 critical > warn > info，最多 5 条），可关闭，关闭按公告 `id` 记在 `localStorage`（`talekiln.announcements.dismissed`，上限 200 条）。
- “去下载”不含下载地址（接口本来就不给）：已启用 electron-updater 时触发它的手动检查（有结果弹窗、下载后经用户确认安装）；未启用时打开 `update-config.json` 的 `downloadPageUrl`（https、非占位），都没有则提示去官网下载页。
- **未验证**：没有在打包后的 Electron 里点过（沙箱无图形环境）；只有主进程控制器（假 http + 假计时器）与渲染端纯函数的单元测试；`/public/announcements` 的时间窗与渠道在客户端又兜底过滤了一次，和云端口径一致但没有做联调。

### 1.5 推广漏斗

`GET /admin/stats/funnel?days=14`（1–90）。**这是按时间窗的汇总，不是逐人追踪**：

| 阶段 | 口径 |
| --- | --- |
| 点击 | 窗口内 `ReferralClick` 条数，另给按推广码的分布 |
| 注册 | 窗口内创建的非管理员账号 |
| 激活 | 上述账号里至少登记过一台设备的 |
| 首次导出 | 窗口内到达 `first_export` 引导步骤或有 `export_done` 事件的去重安装数（遥测） |

点击不带账号、遥测是匿名的，三者之间没有可关联的标识，所以后一阶段可以大于前一阶段（自然流量），`rateFromPrev/rateFromFirst` 只适合看趋势，界面上也写了这句话。想做真正的归因，需要在点击时给客户端发一个归因标识，并在注册与遥测里带上它，这需要改客户端与隐私说明，没做。另给按天序列。窗口按 UTC 日历天。

### 1.6 错误码

没有新增 `ErrorCode`（用到的 `forbidden`、`not_found`、`bad_request`、`conflict` 已登记在 `packages/local/src/errors/error-codes.json` 的 cloud 作用域）。

## 2. 后台界面（apps/admin）

沿用 Vue 3 + Element Plus + hash 路由，接口调用都走 `api.js`。原有 5 屏保留，新增/调整：

| 路由 | 屏 | 权限 |
| --- | --- | --- |
| `/overview` | 概览 + **推广漏斗**（阶段表、按推广码点击、说明） | read |
| `/orders` | 订单：状态/账号筛选，详情抽屉（支付、退款试算、退款、发票登记） | read；退款按钮需 `billing:refund` |
| `/refunds` | 退款记录 + 发票（开具/作废） | read；开具/作废需 `ops:write` |
| `/plans` | 套餐与价格版本：版本表、新增版本（改价/权益）、新建套餐、启停 | read；写需 `billing:plans` |
| `/releases` | 版本灰度：新建、调灰度、全量、设为强制、暂停/恢复 | read；写需 `ops:write` |
| `/announcements` | 公告：时间窗、渠道、级别、启停、删除 | read；写需 `ops:write` |
| `/content` | 模型目录（公告已搬走） | read；保存需 `ops:write` |
| `/admins` | 管理员（授予/改角色/撤销）+ 审计日志（按操作、操作者筛选，加载更早记录） | `admins:manage` |

- 权限显示：登录后拉 `/admin/me`，菜单、路由、按钮按 `permissions` 显示或禁用（纯函数在 `src/permissions.js`，有测试）。**这只是避免把人引到必然 403 的页面，真正的鉴权在云端。**
- 纯函数与测试：`src/ops.js`（金额分↔元、状态标签、退款可用性、漏斗行、套餐版本表单、灰度校验与语义化版本比较、公告状态、审计中文名与摘要）、`src/permissions.js`、`src/route-meta.js`；`test/ops.test.js`。语义化版本比较在前端与云端各有一份，两边测试用同一张排序表，改一边要同步改另一边。
- 套餐价格输入按“元”，转分时不经浮点乘法（`yuanToCents('1.15') === 115`）。

## 3. 官网（apps/website）

纯静态 HTML/CSS，没有第三方依赖，没有 JavaScript、没有外部字体或 CDN。`build.mjs`（约 125 行 Node）只做占位符替换：

```bash
pnpm --filter @talekiln/website build      # 输出到 apps/website/dist
pnpm --filter @talekiln/website test
SITE_CONFIG=/path/to/prod.json pnpm --filter @talekiln/website build   # 用私有配置覆盖
```

- 页面：`index.html`（产品介绍：剧本、镜头、时间线、画布多视图无缝切换，自带 Key，本地处理，下载入口，开源入口）、`download.html`（下载表、SHA-256、校验方法）、`privacy.html` / `terms.html` / `report.html`（**占位页**，页面上明确写了需经律师审阅，不能当作承诺）。页脚有隐私政策、用户协议、举报入口、开源仓库链接和备案号占位。
- 配置 `site.config.json` 全是占位值（无 URL、无哈希）。部署时用 `SITE_CONFIG` 指向**不入库**的私有 JSON，覆盖 `version`、`releaseDate`、`downloads.windows.{url,sha256,size}`、`repoUrl`、`privacyUrl/termsUrl/reportUrl`、`icpNumber`、`contact`。深度合并，只写要改的字段。
- 构建期校验：版本必须是语义化版本；链接只接受 `https://`、站内相对路径或 `#` 锚点（拒绝 `javascript:`、`http:`、`//host`）；哈希若写成十六进制必须正好 64 位（统一转小写）；模板引用不存在的配置项会让构建失败；所有值输出前做 HTML 转义。测试还断言产物里没有 `<script>`、没有任何 `http(s)://`。
- 响应式：移动优先，16px 边距，断点 720px / 1000px，下载表在窄屏横向滚动；跟随系统深浅色。
- 备案号：文字占位。备案号通常要链接到工信部备案查询站点，这是公共地址但本包不放任何真实地址，上线时在 `partials/footer.html` 里加。
- 文案里的事实性表述（“匿名统计需同意”“诊断包本机脱敏”“应用内检查更新、由你确认后安装”）对照了仓库现有文档，但**未经产品与法务逐句核对**；“Windows 10/11”“macOS 即将开放”按当前进度写。

## 4. 测试

| 位置 | 内容 |
| --- | --- |
| `packages/cloud/test/admin-ops.repositories.test.ts` | 仓储契约（内存 + Postgres 同一套断言）：公告窗口/渠道、发布唯一与更新、角色增删与账号级联、审计筛选/翻页/JSON 往返、点击区间 |
| `packages/cloud/test/admin-ops.test.ts` | 版本比较、灰度分档（稳定、均匀、单调、版本独立）、更新决策、权限矩阵、审计脱敏、漏斗；HTTP：三种角色的接口矩阵、管理员管理与最后一个 ADMIN 保护、审计自动记录、公告过滤、`/updates/check` 稳定可复现 |
| `apps/admin/test/ops.test.js` | 金额、退款可用性、漏斗行、套餐表单、灰度校验、公告状态、权限显示与路由权限声明、审计显示、新接口的路径/方法/请求体 |
| `apps/website/test/build.test.mjs` | 构建产物、内容、无外部资源、配置注入与转义、校验失败、默认配置无真实值 |

Postgres 用法（连接串只通过环境变量，不进任何文件）：

```bash
export TEST_DATABASE_URL='<你的连接串>'   # 一个空库即可，测试会 TRUNCATE
pnpm --filter @talekiln/cloud prisma:deploy
pnpm --filter @talekiln/cloud test:pg
```

## 5. 没做 / 未验证

- 后台界面未在真实浏览器里点过；订单抽屉里的“登记发票”用了一个输入框按 `抬头 | 税号 | 邮箱` 解析，是权宜写法。
- 订单列表只显示账号 ID，没有联表显示邮箱和套餐代码（接口没改）。
- ~~桌面端没有接 `/updates/check`；公告也没有接到桌面端展示。~~ 已在三期 P3-C 接入（见 1.4.1），但未在真机点过。
- 审计是尽力而为，不与业务同事务，也没做防篡改。
- 推广漏斗不是逐人归因（见 1.5）。
- 管理员无法自助改口令，也没有口令重置流程（授予时给初始口令，之后只能运维处理）。
- 没有双因素登录；登录限流沿用既有逻辑。
- 官网没有多语言、没有 SEO 之外的统计，没有真实托管与 HTTPS 配置，法务页只有占位。
