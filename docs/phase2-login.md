# 二期 P2-C：短信验证码登录与微信扫码登录（模拟实现）

状态：云端服务（适配器接口 + 模拟实现、接口、限频、验证码与票据状态机、迁移、审计）、本地服务透传、桌面登录页两个新标签页、自动化测试都已写完并通过（cloud 112、local 651、renderer 283）。**没有接任何真实短信厂商或微信开放平台**，**界面没有在浏览器 / Electron 里点过**，**Prisma 迁移没有在真实 PostgreSQL 上跑过**，见第 6 节。本文不含任何密钥或真实地址。

分支 `p3c-login`，基于 `claude/phase3-foundation-mxao0h`。不改现有邮箱密码登录行为，不动 `apps/admin`。

## 1. 做了什么

| 位置 | 作用 |
|---|---|
| `packages/cloud/src/login/providers.ts` | 适配器接口 `SmsProvider`（`sendCode(phone, code, scene)`）与 `WechatQrProvider`（`createQr(state)` / `exchangeCode(code)` / `simulated`），以及 `MockSmsProvider`（验证码只写服务端日志并留在内存供测试读）与 `MockWechatQrProvider`（二维码内容是占位 URL，确认靠接口手动触发） |
| `packages/cloud/src/login/registry.ts` | 按 `SMS_PROVIDER` / `WECHAT_PROVIDER` 装配；`none` 时为 `null`，服务层回 503 |
| `packages/cloud/src/services/login.service.ts` | 业务：手机号规范化、限频、验证码签发 / 校验（HMAC、5 分钟、错 5 次作废、新码顶旧码）、二维码票据状态机、首登邀请码、无口令账号建账、登录审计 |
| `packages/cloud/src/services/auth.service.ts` | 小重构：`checkInvite` / `createWithInvite` / `unusablePasswordHash` 抽出来给短信 / 微信复用；`start` 改为公开；返回体 `account` 加 `phone`（旧客户端忽略即可） |
| `packages/cloud/src/http/controllers.ts` `LoginController` | 第 2 节的 7 个接口 |
| `packages/cloud/src/services/config.ts`、`.env.example` | `SMS_PROVIDER` / `WECHAT_PROVIDER`（mock \| none），`loginDebug = NODE_ENV !== 'production'` |
| `packages/cloud/src/services/errors.ts`、`http/filter.ts` | 新错误码 `invalid_code`(401) `code_expired`(400) `invite_required`(400) `qr_expired`(410) `sms_unavailable`(503) `wechat_unavailable`(503) |
| `packages/cloud/src/services/rate-limiter.ts` | 修一个既有 bug：清扫按见过的最大窗口来，否则 1 分钟窗口的调用会把别的键里 1 小时窗口的记录清掉（短信“每小时 5 次”就靠这个） |
| `packages/cloud/prisma/schema.prisma`、`migrations/20261006000000_login_sms_wechat` | `Account.phone` / `Account.wechatOpenId`（可空、唯一）；`SmsCode`、`WechatQrTicket` 表 |
| `packages/cloud/src/domain/*` | 仓储接口与内存 / Prisma 实现：`accounts.findByPhone / findByWechatOpenId`、`smsCodes`、`wechatQr` |
| `packages/local/src/cloud/account.js`、`routes/cloud.js`、`routes/index.js`（末尾 `// P2-C` 块） | 本地透传 `/account/sms/*`、`/account/wechat/*`；会话记 `login_method`，状态 `account` 带 `phone` 与 `login_method` |
| `packages/local/src/errors/error-codes.json` | 6 个云端码 + 本地 `INVALID_CODE` `CODE_EXPIRED` `INVITE_REQUIRED` `QR_EXPIRED` `LOGIN_METHOD_UNAVAILABLE` `CLOUD_RATE_LIMITED` `ACCOUNT_DISABLED` |
| `apps/renderer/src/views/Login.vue` | 「手机验证码」「微信扫码」两个标签页 |
| `apps/renderer/src/utils/loginView.js` | 页面纯逻辑：手机号校验、按钮状态 / 60 秒倒计时、二维码状态文案与轮询决策、账号显示名、占位二维码矩阵与 SVG path |
| `apps/renderer/src/api/account.js`、`stores/account.js`、`utils/account.js` | 接口封装、`loginBySms` / `loginByWechat`、新错误码中文文案 |

### 登录流程

**短信**：`POST /auth/sms/send` → 用户填验证码 → `POST /auth/sms/login`。老手机号直接登录；新手机号云端回 `invite_required`（**不消耗验证码**），界面展开邀请码输入框，用户补上后再提交一次即建账号并登录。

**微信**：`POST /auth/wechat/qr` 拿票据与二维码内容 → 客户端每 2 秒 `GET /auth/wechat/qr/:ticket` → 状态变 `confirmed` 后 `POST /auth/wechat/login { ticket }`。轮询应答里的 `new_account` 为真表示这个 openid 还没账号，界面先要邀请码再调登录。真实接入后微信会带 `code&state` 跳到 `GET /auth/wechat/callback`，服务端用 `exchangeCode` 换 openid 并把票据推到 `confirmed`；模拟适配器下用 `POST /auth/wechat/qr/:ticket/confirm` 代替这一步。

两种方式登录成功都走 `AuthService.start`：设备登记（含设备数上限）+ 现有令牌签发，返回体与 `/auth/login` 完全一致（`accessToken / refreshToken / expiresIn / account / device`），所以本地服务的会话、许可证续期、刷新轮换全部复用。

### 无邮箱账号怎么存

`Account.email` 目前非空且唯一，这包没有改它（影响面太大）。短信 / 微信首登建的账号用**占位登录名**：`sms-<手机号>@placeholder.talekiln.invalid`、`wx-<sha256(openid) 前 16 位>@placeholder.talekiln.invalid`。`.invalid` 是 RFC 2606 保留顶级域，不会与真实邮箱撞车；口令哈希是随机值，所以这类账号**不能**用邮箱密码登录（测试有断言）。界面上用 `accountDisplayName` 显示手机号 / “微信用户”，不露占位邮箱。是否改成 `email` 可空见第 7 节。

## 2. 接口（云端 `packages/cloud`）

| 方法 / 路径 | 作用 | 错误 |
|---|---|---|
| `POST /auth/sms/send` `{ phone, scene?: 'login' }` | 发验证码。限频：每 IP 每小时 30 次；每手机号 1 分钟 1 次、每小时 5 次。新码作废旧码。→ 200 `{ sent, phone(脱敏), expires_in: 300, resend_after: 60, provider, debug_code? }`；`debug_code` **只在非生产环境 + mock 适配器**出现 | 400 `bad_request`（号码不合法）、429 `rate_limited`、503 `sms_unavailable` |
| `POST /auth/sms/login` `{ phone, code, inviteCode?, device? }` | 验证码 5 分钟有效、错 5 次作废；新手机号首登需 `inviteCode`（沿用邀请码规则：一码一用、过期 / 吊销无效）。→ 200 同 `/auth/login` | 400 `code_expired` / `invite_required` / `invalid_invite`，401 `invalid_code`，403 `account_disabled` / `device_limit`，409 `conflict`（并发下手机号被占） |
| `POST /auth/wechat/qr` | 生成票据（每 IP 每 10 分钟 30 个）。→ 201 `{ ticket, qr_url, expires_in, poll_interval: 2, provider, simulated }` | 503 `wechat_unavailable` |
| `GET /auth/wechat/qr/:ticket` | 轮询。→ `{ status: pending \| scanned \| confirmed \| expired, new_account?, expires_in }`。已消费的票据显示 `expired` | 404 `not_found` |
| `POST /auth/wechat/qr/:ticket/confirm` `{ openId?, scanOnly? }` | **模拟器专用**：`scanOnly` 推到 `scanned`，否则 `confirmed`（没给 `openId` 就按票据派生一个稳定值）。只有 `simulated` 适配器才开放 | 其它适配器或未接入一律 404；410 `qr_expired` |
| `GET /auth/wechat/callback?code&state` | 真实适配器回调入口：`exchangeCode(code)` → 确认 `state` 票据。模拟适配器下也能用（任何 code → `mock-openid-<code>`） | 404 / 410 / 503 |
| `POST /auth/wechat/login` `{ ticket, inviteCode?, device? }` | 用 `confirmed` 票据换令牌，一票一用；首次见到的 openid 需邀请码。→ 200 同 `/auth/login` | 400 `bad_request`（未确认）/ `invite_required` / `invalid_invite`，410 `qr_expired`，403 `account_disabled` |

票据状态机：`pending → scanned → confirmed`，任何状态到期即 `expired`；`confirmed` 后多给 15 分钟宽限填邀请码；换过令牌（`consumedAt`）后视为 `expired`。

审计：短信 / 微信登录成功与失败都写 `AdminAudit`（`action = POST /auth/sms/login` / `POST /auth/wechat/login`，`detail.body.method = sms | wechat`，手机号脱敏、票据只记前 8 位），成功时 `actorId` 为账号 id。邮箱密码登录没有动。

### 本地服务（`packages/local`，前缀 `/api/v1`，需本地令牌）

| 路径 | 对应云端 | 备注 |
|---|---|---|
| `POST /account/sms/send` `{ phone }` | `/auth/sms/send` | 原样回云端应答（含 `debug_code`，界面只在开发模式显示） |
| `POST /account/sms/login` `{ phone, code, invite_code? }` | `/auth/sms/login` | 成功后与 `/account/login` 一样返回状态视图 |
| `POST /account/wechat/qr` / `GET /account/wechat/qr/:ticket` / `POST /account/wechat/qr/:ticket/confirm` `{ open_id?, scan_only? }` | 同名云端接口 | |
| `POST /account/wechat/login` `{ ticket, invite_code? }` | `/auth/wechat/login` | |

云端码到本地码：`invalid_code→INVALID_CODE(401)`、`code_expired→CODE_EXPIRED(400)`、`invite_required→INVITE_REQUIRED(400)`、`qr_expired→QR_EXPIRED(410)`、`sms_unavailable / wechat_unavailable→LOGIN_METHOD_UNAVAILABLE(503)`、`rate_limited→CLOUD_RATE_LIMITED(429)`、`not_found→NOT_FOUND(404)`、`account_disabled→ACCOUNT_DISABLED(403)`。`GET /account/status` 的 `account` 多了 `phone` 与 `login_method`（`password | sms | wechat`）。

## 3. 配置

`packages/cloud/.env.example`：

```
SMS_PROVIDER=        # mock | none；留空：开发 / 测试 = mock，生产 = none
WECHAT_PROVIDER=     # 同上
```

- `none`：相关接口 503（`sms_unavailable` / `wechat_unavailable`），模拟确认接口 404。生产环境不配就是这个状态，桌面端两个标签页会显示“暂不可用，请改用邮箱密码登录”。
- `mock`：验证码写服务端日志（`[cloud][sms-mock] login 验证码 123456 -> 138****8000`）；`NODE_ENV !== 'production'` 时接口还回 `debug_code`。生产环境配 `mock` 不会回 `debug_code`，但验证码仍在日志里——**不要在生产用 mock**。
- 其它值（如 `aliyun`）启动直接报错，提醒尚未接入。

真实厂商接入点（只留接口，没写调用）：
- 阿里云短信：实现 `SmsProvider.sendCode`，调 `SendSms(PhoneNumbers, SignName, TemplateCode, TemplateParam={"code"})`，需要签名与模板审批；`.env.example` 里有占位变量名（当前代码不读取）。
- 微信开放平台（网站应用扫码登录）：`createQr(state)` 返回 `https://open.weixin.qq.com/connect/qrconnect?appid=…&redirect_uri=…&response_type=code&scope=snsapi_login&state=<state>`，回调到 `GET /auth/wechat/callback`；`exchangeCode` 调 `sns/oauth2/access_token` 拿 `openid`（有 unionid 也带回来）。`simulated` 必须为 `false`。
- 两者都在 `src/login/registry.ts` 里按环境变量选择，业务代码不动。

## 4. 渲染端

- `Login.vue` 新增标签页「手机验证码」「微信扫码」，原「登录」「邀请码注册」不变。
- 手机验证码：手机号校验（`1[3-9]` 开头 11 位，接受 `+86` / 空格 / 连字符）、「获取验证码」60 秒倒计时（禁用 + 剩余秒数）、收到 `INVITE_REQUIRED` 后展开邀请码框并提示；开发模式（`import.meta.env.DEV`）下把 `debug_code` 显示在提示条里。
- 微信扫码：切到标签页即取票据并每 2 秒轮询；二维码用**纯 SVG 占位点阵**（`placeholderMatrix` 把 `qr_url` 哈希成带三个定位角的 25×25 点阵；仓库没有二维码库，也没新增依赖），页面标注“当前为占位二维码”。`scanned` 显示“已扫码，请在手机上确认”，`confirmed` 自动登录或要邀请码，过期 / 失败显示「刷新二维码」。开发模式或云端 `simulated: true` 时显示「模拟扫码」「模拟确认」两个按钮。
- 离开标签页 / 组件卸载时停止轮询与倒计时。

## 5. 怎么测

```
pnpm --filter @talekiln/cloud test          # 112（新增 test/login.test.ts 9 个：限频、过期与错误次数、状态机、邀请码、重复手机号 / openid、503 / 404、HTTP 端到端）
pnpm --filter @talekiln/cloud typecheck
pnpm --filter @talekiln/local test          # 651 通过（新增 cloudAccount.test.js 3 个：短信 / 微信透传、错误码映射、503）
pnpm --filter @talekiln/renderer test       # 283（新增 test/loginView.test.js 8 个）
pnpm --filter @talekiln/renderer build
pnpm secrets:scan
```

手工联调（开发环境，云端 `NODE_ENV=development` 不配 provider 即 mock）：
1. 起云端与本地服务，桌面端配置 `cloud.base_url`。
2. 登录页 → 手机验证码 → 填 `13800138000` → 获取验证码 → 提示条里显示模拟验证码（云端日志也有）→ 填码登录 → 首次会要邀请码（后台 `POST /admin/invites` 生成）。
3. 微信扫码 → 看到占位二维码 → 点「模拟确认」→ 首次要邀请码 → 登录。再来一次不再要邀请码。
4. 云端 `.env` 写 `SMS_PROVIDER=none`、`WECHAT_PROVIDER=none` 重启，两个标签页应显示“暂不可用”。

## 6. 未验证

- 没有接真实短信厂商与微信开放平台，`callback` 路径只在模拟适配器下跑过。
- `Login.vue` 没有在浏览器 / Electron 里打开过（只过了 `vite build` 与纯函数测试）；布局、暗色主题、Element Plus 标签页切换时的轮询停启都是按代码推断。
- Prisma 迁移与 `prisma.repositories.ts` 的新实现只过了 `prisma validate` / `generate` 与类型检查，**没有在真实 PostgreSQL 上跑过**（CI 的 `cloud-pg` 作业会跑 `migrate deploy` + `migrate diff` + `test:pg`，`test/login.test.ts` 用 `makeRepos` 所以在 PG 模式下也会跑）。
- 限流仍是进程内存（与现有 `RateLimiter` 一致），多实例部署要换共享存储。
- 占位二维码不可扫；真实接入时要换二维码库（或在适配器里让微信返回图片 URL）。
- `tsconfig.build.json` 的 `build`（`prisma generate && tsc`）没单独跑，只跑了 `typecheck`（同一套源码）。

## 7. 需要你决定

1. **无邮箱账号的存法**：现在是占位邮箱（`@placeholder.talekiln.invalid`）。更干净的做法是把 `Account.email` 改可空并给 `role/plan` 之外加“登录标识”概念，但会牵动后台账号列表、审计 `actorEmail`、令牌声明与导出脚本，建议等真实短信接入时一起做。
2. **微信首登要不要强制绑手机号 / 邮箱**：任务里的“最小做法”是只要邀请码；若后续要找回账号或合规实名，需要加绑定接口（`POST /account/bind-phone` 之类），本包没做。
3. **邀请码策略**：新手机号 / 新 openid 首登仍要邀请码（与邮箱注册一致）。若公测期想放开，只需在 `LoginService.requireInvite` 处按配置跳过并指定默认套餐。
4. **短信厂商与签名**：阿里云短信需要企业资质审核签名与模板（“【故事窑】您的验证码为 ${code}，5 分钟内有效”），审批周期按天计；微信开放平台“网站应用”要已备案域名与回调地址。都不是代码能解决的。
5. **限频数值**：手机号 1 次 / 分钟、5 次 / 小时，IP 30 次 / 小时、二维码 30 个 / 10 分钟，都是拍的；上线前看一下量。
