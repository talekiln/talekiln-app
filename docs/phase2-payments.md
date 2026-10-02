# 二期 P2-B：收费与授权后端（packages/cloud）

状态：服务、仓储（内存 + Prisma）、沙箱支付适配器、HTTP 接口、测试已完成；**真实微信/支付宝适配器没有实现**（见第 6 节）。本文所有密钥、证书、连接串只写环境变量名，不含任何值。

## 1. 数据模型（迁移 `20261003000000_billing`）

金额一律是整数分（CNY）。价格和权益存放在 `PlanVersion`，不写在业务逻辑里。

| 表 | 作用 |
| --- | --- |
| `Plan` | 套餐（`free`、`pro`），`enabled` 控制是否对外展示 |
| `PlanVersion` | 套餐版本：`priceMonthCents`、`priceYearCents`（可空，空表示不可购买）、`entitlements`（JSON：`maxDevices`、`exportMaxHeight`、`watermark`、`features[]`）。改价或改权益 = 新增版本，已下的订单永远指向下单时的版本 |
| `Subscription` | 每账号至多一条；`currentPeriodEnd` 即授权到期时间，是否有效按当前时间判断 |
| `Order` | 订单：`outTradeNo`（对支付平台的商户单号，唯一）、金额、渠道、状态 `PENDING/PAID/CLOSED/REFUNDING/REFUNDED`、付款后确定的授权区间 `periodStart/periodEnd`（退款折算依据） |
| `Payment` | 支付流水，每单一条；`(provider, tradeNo)` 唯一 |
| `Refund` | 退款单，`outRefundNo` 唯一；状态 `PENDING/SUCCESS/FAILED` |
| `Invoice` | 发票登记，每单一张；`REQUESTED/ISSUED/VOID` |
| `PaymentNotification` | 回调去重，`(provider, notifyId)` 唯一 |
| `LicenceUsage` | 每次签发许可证令牌记一条（账号、设备、套餐、签发/到期时间） |

默认套餐（首次启动播种，只补缺失的，不改已有价格）：

| 套餐 | 月付 | 年付 | 设备数 | 导出最大高度 | 水印 | 功能 |
| --- | --- | --- | --- | --- | --- | --- |
| free | 不可购买 | 不可购买 | 1 | 720 | 有 | generate, export |
| pro | 3900 分 | 29900 分 | 3 | 2160 | 无 | generate, export, cloud-sync, batch, pro-models |

首次启动前可用环境变量覆盖 pro 的初始价：`PLAN_PRO_PRICE_MONTH_CENTS`、`PLAN_PRO_PRICE_YEAR_CENTS`（整数分）。已播种之后改价请用管理接口新增版本。

权益解析顺序（`EntitlementService`）：有效订阅 > 邀请码内测账号（`account.plan = 'test'`，沿用旧行为：全部功能、设备数 3、无水印）> 免费版。

## 2. 数据流

```
用户                    cloud                                  支付平台
 |  POST /orders          |  取套餐最新版本的价格，建 PENDING 订单     |
 |----------------------->|  provider.createNativeOrder ----------->|
 |<-- codeUrl（二维码） ---|                                         |
 |  扫码付款 ------------------------------------------------------>|
 |                        |<-- POST /payments/notify/:provider -----|
 |                        |  verifyNotify（验签）                    |
 |                        |  核对订单存在、渠道一致、金额一致          |
 |                        |  settlePaid：一个事务内                  |
 |                        |    锁账号行 -> 登记回调 -> 订单 PAID      |
 |                        |    -> 写 Payment -> 开通/续期订阅         |
 |                        |-- 应答 success / {"code":"SUCCESS"} --->|
 |  GET /orders/:id       |  订单仍 PENDING 时主动 query 兜底        |
 |  POST /licence/renew   |  令牌带当前权益（见第 4 节）              |
```

### 幂等与并发

- 同一回调（同 `provider + notifyId`）重复到达：回调登记与订单生效在同一事务，第二次撞唯一键整体回滚，应答成功但不重复生效（`duplicate_notify`）。
- 平台换了通知 id 重发同一笔交易，或主动查单与回调同时到达：订单状态只有 `PENDING/CLOSED -> PAID` 能成功，其余返回 `already_settled`。
- 并发：Prisma 实现先 `SELECT ... FOR UPDATE` 锁账号行，同一账号的结算、退款、设备注册串行；内存实现的方法体内没有 `await`，天然原子。
- 事务内任一步失败（例如支付流水号冲突）整体回滚，不存在“回调已登记但没生效”的中间态，所以平台重试仍能成功。
- 订单超时被关闭后才付款：仍然生效（钱已收，不能不给权益）。

### 订阅开通与续期

- 无订阅或已过期：从付款时刻起算；仍有效：从当前到期时刻顺延（不吃掉剩余天数）。
- 月 = UTC 日历月，月末取目标月最后一天（1 月 31 日 + 1 月 = 2 月 28/29 日）；年 = 12 个月。
- 到期瞬间（`currentPeriodEnd == now`）即视为失效。

## 3. 退款折算规则（整数分）

```
剩余时长 = periodEnd - max(now, periodStart)        尚未开始的续期单：整段都算剩余
剩余天数 = min(总天数, ceil(剩余时长 / 1 天))         不足一天按一天算，对用户有利
应退金额 = floor(实付分 * 剩余天数 / 总天数)          分以下舍去，对平台有利，最多差 1 分
```

- 总天数 = 本单授权区间的天数（31 天的月、365 天的年等，按实际区间）。用 BigInt 做乘除，无浮点误差。
- 付款后不足 24 小时：剩余天数等于总天数，全额退。到期时刻及之后：应退 0，拒绝退款（`conflict`）。
- 整单只能退一次（全额折算，不支持手动指定金额）。示例：3900 分、31 天、用了 10 天，退 `floor(3900*21/31) = 2641` 分。
- 退款成功后订阅到期时间前移“精确剩余时长”（不取整），但不早于当前时刻；只回退这一单的时长，其他订单的时长保留。
- 状态：`PAID -> REFUNDING`（原子占位，并发的第二个退款请求拿不到）`-> REFUNDED`；渠道退款失败则退款单 `FAILED`、订单回到 `PAID`，可重试（新的 `outRefundNo`）。
- 已 `ISSUED` 的发票会阻止退款：先 `void` 发票（线下红冲），再退款。

边界用例见 `test/billing-math.test.ts`（刚付款、满 1 天、满 1 天 + 1 毫秒、只剩 1 毫秒、恰好到期、未开始的续期单、年付、单调不增）。

## 4. 设备数上限与许可证令牌

- `DeviceService.register`（`POST /devices` 与登录/激活带设备信息时共用）按当前权益的 `maxDevices` 限制未吊销设备数，超限返回 403 `device_limit`。已注册的设备重复登录不占新名额；吊销释放名额。检查与创建在仓储里同一把账号锁内完成，并发注册不会超限。
- 降级（订阅过期）后设备数可能超过新上限：已有设备不删除，但 `POST /licence/renew` 只给“按注册先后排在前 `maxDevices` 个的未吊销设备”续期，其余返回 `device_limit`。
- 许可证令牌（ES256 JWT）新增/变更的声明：`plan`（套餐代码，内测账号为 `test`）、`entitlements`（功能列表，与旧字段兼容）、`limits`（`maxDevices`、`exportMaxHeight`、`watermark`）、`subEnd`（付费订阅到期 Unix 秒，免费/内测为 `null`）。`exp` 逻辑未变（`LICENCE_TTL_DAYS`，默认 7 天）。**令牌 `exp` 不会被截到 `subEnd`**：订阅在令牌有效期内到期时，令牌里的专业版权益最多再有效到 `exp`（加客户端的离线宽限）。客户端若要严格执行，应在 `subEnd` 之后按免费版处理——这一点需要本地会话/桌面端配合，本工作包没有改客户端。

## 5. HTTP 接口

用户侧（除标注外需 `Authorization: Bearer <访问令牌>`）：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /plans` | 公开。已启用套餐的最新版本：`prices.{month,year}`（分）、`entitlements` |
| `POST /orders` | `{ planCode, period: 'month'\|'year', provider: 'wechat'\|'alipay' }`，返回订单与 `codeUrl`。每账号 10 分钟 10 单限流 |
| `GET /orders` / `GET /orders/:id` | 自己的订单；待支付的订单会向渠道主动查单兜底，超时未付则关闭 |
| `POST /orders/:id/invoice` | `{ title, taxNo?, email }`，提交开票申请（已付款且未退款的订单，每单一张） |
| `GET /subscription` | 当前生效权益与订阅区间 |
| `POST /payments/notify/:provider` | 公开，支付平台回调，靠验签保证真实性；应答格式由适配器决定（微信 JSON，支付宝纯文本 `success`）。验签失败/金额不符/未知订单回失败应答；数据库故障等意外回 500，平台会重试 |

管理侧（`AdminGuard`，与既有管理接口一致，不做后台界面）：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /admin/orders?status=&accountId=&limit=` | 订单列表 |
| `GET /admin/orders/:id` | 详情：订单、套餐代码、支付、退款、发票、当前退款试算 |
| `POST /admin/orders/:id/refund` | `{ reason? }`，按第 3 节折算退款 |
| `GET /admin/refunds` | 退款列表 |
| `POST /admin/orders/:id/invoice` | 人工开票登记；带 `invoiceNo` 则直接 `ISSUED` |
| `GET /admin/invoices?status=` · `POST /admin/invoices/:id/issue` `{ invoiceNo }` · `POST /admin/invoices/:id/void` | 发票列表、开具、作废 |
| `GET /admin/plans` · `POST /admin/plans` · `POST /admin/plans/:code/versions` · `PUT /admin/plans/:code/enabled` | 套餐与版本管理（新增版本即改价） |

新增错误码：`device_limit`(403)、`conflict`(409)、`provider_unavailable`(503)、`invalid_signature`(401，仅用于适配器内部，回调接口按渠道格式应答)。

## 6. 支付适配器与配置

接口 `PaymentProvider`（`src/payments/provider.ts`）：`createNativeOrder`、`verifyNotify`、`refund`、`query`，另有 `ack` 生成给平台的应答。

- **沙箱实现**（`src/payments/sandbox.provider.ts`，微信与支付宝各一个实例）：不发任何网络请求；回调体是 `{ notify_id, out_trade_no, trade_no, amount_cents, status, paid_at, sign }`，`sign` 是对“渠道名 + 排序后的字段”做的 HMAC-SHA256（签名里带渠道名，微信的签名不能冒充支付宝）。订单状态保存在进程内存，**只用于开发和测试**。测试里用 `simulatePay`/`buildNotify` 构造回调，`failNextRefund` 模拟退款失败。
- **真实实现**（`src/payments/real.providers.ts`）：`WechatNativeProvider`、`AlipayNativeProvider` 只是占位，每个方法都抛 `provider_unavailable`，文件里用 TODO 写了要接的接口。**没有任何已验证的真实支付代码。**

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `PAYMENT_MODE` | `sandbox` / `live`。未设置：非生产 = `sandbox`，生产 = 不启用任何支付方式。生产环境设为 `sandbox` 会拒绝启动（避免用模拟回调免费开通） |
| `PAYMENT_SANDBOX_SECRET` | 沙箱签名密钥；未设置时由 `JWT_ACCESS_SECRET` 派生 |
| `PAYMENT_NOTIFY_BASE_URL` | 公网回调基地址（拼出 `notify_url`），默认 `http://localhost:3000` |
| `ORDER_TTL_MINUTES` | 订单待支付有效期，默认 30 |
| `PLAN_PRO_PRICE_MONTH_CENTS` / `PLAN_PRO_PRICE_YEAR_CENTS` | 首次播种时 pro 的初始价（整数分） |

接入真实渠道时预计需要的变量（**当前代码尚未读取这些变量**，名称是约定，接入时以实际 SDK/文档为准）：

| 渠道 | 变量名 |
| --- | --- |
| 微信支付 APIv3 | `WECHAT_PAY_APP_ID`、`WECHAT_PAY_MCH_ID`、`WECHAT_PAY_MCH_SERIAL_NO`、`WECHAT_PAY_MCH_PRIVATE_KEY_PEM`、`WECHAT_PAY_API_V3_KEY`、`WECHAT_PAY_PLATFORM_CERT_PEM`（或平台公钥及其 ID） |
| 支付宝 | `ALIPAY_APP_ID`、`ALIPAY_APP_PRIVATE_KEY_PEM`、`ALIPAY_PUBLIC_KEY_PEM`、`ALIPAY_SELLER_ID`、`ALIPAY_GATEWAY`（沙箱/正式切换） |

还需要：HTTPS 公网回调域名；回调路径不能被限流或鉴权中间件挡住；真实渠道验签必须用原始报文——`src/http/setup.ts` 已为 `/payments/notify` 保留 `req.rawBody`，并同时解析 JSON 和表单编码（支付宝）。

## 7. 测试

- `test/billing-math.test.ts`：周期推算与退款折算（纯函数）。
- `test/billing.repositories.test.ts`：仓储契约，内存与 PostgreSQL 同一套断言——套餐版本、订单、`settlePaid` 幂等、12 路并发同一回调、12 路并发不同 id、同账号多单并发串行顺延、结算原子回滚、退款占位并发、退款失败回滚、设备上限并发、发票、用量。
- `test/billing.test.ts`：服务层——改价新版本、下单、回调校验（验签/金额/渠道/未知订单/非成功状态）、重复与并发回调、续期与过期、超时单迟到付款、主动查单、退款折算与边界、退款失败与并发退款、发票与退款互斥、设备上限（含登录路径）、许可证令牌权益与降级。
- `test/billing-http.test.ts`：HTTP 端到端（用户侧与管理侧）。
- 运行：`pnpm --filter @talekiln/cloud test`（内存）；`DATABASE_URL=<专用测试库> pnpm --filter @talekiln/cloud prisma:deploy && … test:pg`（PostgreSQL，会清空库，用法见 `docs/cloud-deploy.md` 第 5 节）。

## 8. 未验证与已知缺口

- 真实微信/支付宝：适配器未实现，验签、下单、退款、查单均未对接真实接口，也没有用真实商户号走通任何一单。沙箱验证的是我们自己的状态机，不能证明真实渠道的字段、签名、时序（例如微信退款是异步的、有退款结果通知；本实现把渠道退款调用成功视为成功，没有处理异步退款结果回调和退款中状态）。
- 渠道退款成功但随后写库失败（数据库故障）：订单会停在 `REFUNDING`、退款单 `PENDING`，需要人工核对渠道后处理；没有自动补偿任务，也没有管理接口“重新完成退款”。
- 没有定时任务：超时未付订单只在被查询时才关闭；没有主动对账。
- 开票与退款存在极小的竞态：开票申请检查订单状态与建发票不在同一事务，申请与退款并发时可能出现“已退款订单上有 REQUESTED 发票”，需人工处理。发票作废后不能为同一订单重新登记（每单一张，唯一约束）。
- 发票只是登记，不对接税控/电子发票平台。
- 沙箱适配器的订单状态在进程内存里，多实例或重启后不保留（退款会按请求总额重建）；仅限开发和测试。
- `RateLimiter` 仍是进程内的（既有限制，见 `docs/cloud-deploy.md`）；回调接口限流为每 IP 每分钟 600 次，真实渠道的出口 IP 范围未核对。
- 迁移只在空库上验证过；PostgreSQL 并发测试是单进程内的 6–12 路并发，没有多实例、连接池压力或极端事务交错的验证。
- 许可证令牌的 `exp` 未截到 `subEnd`（见第 4 节），客户端需要读取 `limits`/`subEnd` 并执行水印、分辨率、设备数；本工作包没有改 `apps/desktop` 与 `packages/local`。
- 邀请码内测账号（`plan = 'test'`）绕过免费版限制；是否在公测后迁移这些账号，需要产品决定。

## 9. 对其他工作包的影响

- P2-H 后台：可直接用第 5 节的管理接口做订单、退款、套餐屏；表结构已就绪。
- P2-C 登录：新账号默认 `plan` 由创建方决定；短信/微信登录新建账号时建议用 `plan = 'free'`（不是 `'test'`），否则会走内测账号的全功能分支。`AuthService` 构造函数新增了可选的第 5 个参数（`DeviceService`），不传则自建，既有调用不受影响。
- 本地/桌面：许可证声明新增 `limits`、`subEnd`，`plan` 值现在可能是 `free`/`pro`/`test`；旧字段 `entitlements` 保持为功能名数组。登录与注册设备现在可能返回 403 `device_limit`，界面需要提示用户先吊销旧设备。
- `DeviceRepository` 新增 `registerLimited`，`Repositories` 新增 `plans/orders/subscriptions/refunds/invoices/licenceUsage/billing`；其他分支如果也新增仓储字段，合并时注意 `memory.repositories.ts`、`prisma.repositories.ts`、`test/helpers/repos.ts` 的清表列表。
- 迁移目录 `20261003000000_billing` 晚于现有迁移；其他包新增迁移请用更晚的时间戳。
