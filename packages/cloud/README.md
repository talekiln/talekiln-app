# @talekiln/cloud

Talekiln Windows 桌面端配套的轻量云服务：邀请码激活、密码登录、JWT 访问令牌 + 刷新令牌轮换（重放检测）、设备注册、ES256 许可证签发。

技术栈：NestJS 11 + Prisma 6 + PostgreSQL。业务逻辑在 `src/services/*`（普通类），只依赖 `src/domain/repositories.ts` 中的仓储接口；测试使用内存仓储，**无需数据库**。

## 快速开始

```bash
cp .env.example .env          # 填写占位符；不要提交 .env
node -e "console.log(require('crypto').generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'pkcs8',format:'pem'}).replace(/\n/g,'\\\\n'))"
                              # 输出填入 LICENCE_PRIVATE_KEY_PEM（私钥只放环境变量/密钥管理，绝不入库）
docker compose up --build     # postgres + app，启动时自动 prisma migrate deploy
curl localhost:3000/health
```

本地开发（需自备 PostgreSQL）：`pnpm prisma migrate deploy && pnpm dev`。
测试：`pnpm test`（node 内置测试运行器 + tsx）；类型检查：`pnpm typecheck`；Schema 校验：`DATABASE_URL=postgresql://x pnpm prisma:validate`。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `JWT_ACCESS_SECRET` | 访问令牌 HS256 密钥，至少 32 字符 |
| `LICENCE_PRIVATE_KEY_PEM` | 许可证 ES256 私钥（PKCS8 PEM，换行写成 `\n`）。生产必填；非生产留空则启动时临时生成 |
| `LICENCE_KEY_ID` | JWKS 中的 `kid`，轮换密钥时更换 |
| `LICENCE_TTL_DAYS` / `LICENCE_GRACE_DAYS` | 许可证有效期（默认 7）/ 写入令牌的离线宽限天数（默认 14） |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 若账号不存在则在启动时创建初始管理员 |

## API

所有请求/响应均为 JSON。错误格式：`{ "error": "<code>", "message": "..." }`。
需要登录的接口使用 `Authorization: Bearer <accessToken>`。

### `GET /health`
返回 `{ "status": "ok", "time": "..." }`。

### `POST /auth/activate`（邀请码激活并注册）
```json
{ "inviteCode": "ABC...", "email": "a@x.com", "password": "至少8位",
  "device": { "fingerprint": "设备指纹(>=8位)", "name": "我的电脑" } }
```
`device` 可选。邀请码**一码一用**（原子消耗），过期或已用返回 400 `invalid_invite`；邮箱已存在返回 409 `email_taken`。
响应：`{ accessToken, refreshToken, expiresIn, account:{id,email,role,plan}, device:{id,name}|null }`。

### `POST /auth/login`
`{ email, password, device? }` → 同上。密码使用 bcrypt（12 轮）存储。凭据错误 401 `invalid_credentials`。

### `POST /auth/refresh`
`{ "refreshToken": "..." }` → 新的 `accessToken` + `refreshToken`。
刷新令牌是不透明随机串（库中只存 SHA-256），**每次使用即轮换**。同一令牌家族（一次登录）内，若已使用/已吊销的旧令牌被再次提交（重放），整个家族立即吊销，返回 401 `token_reuse`，客户端须重新登录。访问令牌有效期 15 分钟，刷新令牌 30 天。

### `POST /auth/logout`
`{ "refreshToken": "..." }` → 204，吊销该令牌所在家族。

### 设备
- `POST /devices`（需登录）`{ fingerprint, name }`：注册/更新设备（按 账号+指纹 幂等）。
- `GET /devices`：列出本账号设备。
- `POST /devices/:id/revoke`：吊销设备（其后续刷新与许可证续期均被拒绝，403 `device_revoked`）。

> 访问令牌中的 `did` 声明来自登录时携带的 `device`；许可证续期需要访问令牌绑定设备。

### `POST /licence/renew`（需登录，令牌须绑定设备）
无请求体。返回：
```json
{ "licence": "<ES256 JWT>", "expiresAt": "ISO时间", "graceDays": 14 }
```
许可证 JWT：header `{alg:"ES256", kid, typ:"JWT"}`；claims：

| claim | 含义 |
| --- | --- |
| `iss` | `talekiln-cloud` |
| `sub` | accountId |
| `did` | deviceId |
| `plan` | 套餐（目前 `test`） |
| `entitlements` | 功能列表，`test` 套餐 = 全部功能：`generate, export, cloud-sync, batch, pro-models` |
| `graceDays` | 离线宽限天数（14） |
| `iat` / `exp` | 签发 / 过期（默认 7 天） |

**离线宽限在客户端强制执行**：客户端用公钥验签；`exp` 之后 `graceDays` 天内仍可使用，超过则要求联网续期。客户端应本地缓存 JWKS，并同时检查 `did` 与本机设备 ID 一致。

### `GET /.well-known/licence-jwks.json`
公开，返回 ES256 公钥 JWKS（含 `kid`，不含私钥）。轮换密钥：新增 `LICENCE_KEY_ID` 与新私钥后发布（当前实现同时只发布一把公钥；平滑轮换需扩展为多 key）。

### 管理后台 API（独立认证）
`POST /admin/auth/login` `{ email, password }`（仅 `role=ADMIN` 且未禁用；按 IP 与邮箱限流）→ `{ token, expiresIn(2h), admin }`。管理员令牌使用独立密钥（`ADMIN_JWT_SECRET`，未设置则由访问令牌密钥派生）和 `aud=talekiln-admin`，普通用户令牌不能访问 `/admin/*`，反之亦然；每次请求回查账号仍是未禁用的管理员。其余接口均需 `Authorization: Bearer <管理员令牌>`：

- `POST /admin/invites` `{ plan?, expiresInDays?, count?(1..200) }` → 邀请码数组；`GET /admin/invites?status=unused|used|expired|revoked`；`POST /admin/invites/:id/revoke`（仅未使用的）。
- `GET /admin/users`、`GET /admin/users/:id`（含设备与授权视图：套餐、权益、有效期、宽限天数）、`POST /admin/users/:id/disable|enable`（禁用即吊销全部刷新令牌，并拒绝登录/续期；管理员账号不可禁用）。
- `GET|PUT /admin/announcements`、`GET|PUT /admin/catalog`（整体替换，zod 校验；存于 `Setting` 表）。客户端读取 `GET /public/announcements`、`GET /public/catalog`（只含启用项）。
- `GET /admin/stats/overview?days=14`：DAU、项目数、导出数、失败数按天序列，失败码排行，引导步骤到达数，账号/邀请码计数。
- `GET /admin/feedback`、`GET /admin/feedback/:id/diagnostic`（下载诊断包 zip）。

### 匿名统计 `POST /telemetry`（客户端须在用户同意后才上报）
`{ installId, appVersion?, events: [{ name, code?, step? }] }`，一次最多 50 条，每 IP 每分钟 120 次。`name` 白名单：`app_open, onboarding_step, connect_test, project_created, export_done, export_failed, task_failed`；`code` 只允许大写蛇形错误码（如 `ENCODER_FAIL`）；`step` 只允许 `[a-z0-9_]`。请求体 `strict`：出现任何其他字段（提示词、路径、Key、邮箱……）整个请求以 400 拒绝。服务端不记录 IP、账号，事件时间取服务器接收时间。

### 反馈 `POST /feedback`
`{ message(<=4000), contact?, taskId?, installId?, appVersion?, diagnostic?(zip 的 base64) }`。诊断包解码后上限 `MAX_DIAGNOSTIC_BYTES`（默认 1.5MB，超出 413；必须以 zip 魔数开头）；请求体上限 2.5MB（其余路径 100KB）；每 IP 每 10 分钟 `FEEDBACK_RATE_LIMIT` 条（默认 5，超出 429）。文字会再做一遍服务端脱敏。当前诊断包直接存数据库 `bytea`（原方案是 OSS 临时凭证直传，量大后再换）。

## 数据库

Schema：`prisma/schema.prisma`；迁移已检入 `prisma/migrations/`（`pnpm prisma migrate deploy` 应用）。表：`Account`、`InviteCode`、`Device`、`RefreshToken`、`Setting`、`TelemetryEvent`、`Feedback`。

## 已知限制 / 后续

- 限流为单实例内存实现；用户登录接口尚未限流；未实现邮箱验证、找回密码。
- 统计概览在应用内聚合 `since(day)` 的事件行（≤90 天），数据量大后应改为数据库聚合/预汇总。
- 邀请码激活为"先建账号、原子抢码、失败回滚账号"，不是单事务；极端崩溃下可能留下无邀请码关联的账号。
- Prisma 仓储与迁移 SQL 需要真实 PostgreSQL 做集成验证（单元测试覆盖的是内存仓储上的同一套服务逻辑）。
