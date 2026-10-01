# 统一错误码与日志脱敏

## 错误码表（H06）

唯一数据源：`packages/local/src/errors/error-codes.json`。每条含 `scope`（provider / local / cloud / core）、面向用户的中文 `message`、建议操作 `action`。core 的数字码（JSON-RPC 风格）以字符串作键。

| 使用方 | 方式 |
|---|---|
| local 服务响应 | `response.error(res, status, code, message, details)` 会在 `error` 里附带表内的 `action`；调用方没给 `message` 时用表内文案 |
| 渲染进程 toast | `apps/renderer/src/utils/errorToast.js`：同时识别 local 形态 `{error:{code,message,action}}` 与 cloud 形态 `{error:'code',message}`；服务端给的具体文案优先，缺省用表内文案，并追加“建议：…” |
| 任务中心 | 仍用 `providers/errors.js` 的 `READABLE`（未改动适配器）；测试强制两者文案一致 |

新增错误码流程：先改 JSON，再写代码。`packages/local/test/errorCodes.test.js` 会校验：

- `ERROR_CODES`（provider）全部在表内且文案与 `READABLE` 一致
- `packages/cloud/src/services/errors.ts` 的 `ErrorCode` 联合类型全部在表内
- `packages/core/src` 里所有 `pub const ERR_*: i64` 都在表内
- local 源码里 `response.error(res, status, 'CODE', …)` 出现的字面量都在表内

已知缺口：`TimelineError` 目前没有 `code` 字段（路由层用 `err.code` 回传，部分为空），其细分码待后续补；cloud 的 `bad_request` 响应带 `issues` 而不是 `message`，toast 会显示表内文案。

## 日志脱敏复查

脱敏入口：`packages/local/src/logger.js` 调用 `redactText`（文本）与 `redactValue`（对象，按字段名），实现在 `packages/local/src/secrets/index.js`。录制测试数据另有 `packages/local/scripts/lib/redact.js`。

本次补充（均有 `packages/local/test/redactText.test.js` 用例，测试里的假数据用拼接生成，不会触发 `pnpm secrets:scan`）：

| 形态 | 处理 |
|---|---|
| `Bearer xxx` / `Basic xxx` / `authorization: xxx` | 值替换为 `[REDACTED]` |
| `sk-…`、`sk-ws-…`（即使不是已保存的 Key） | `sk-[REDACTED]` |
| 阿里云 `LTAI…`、AWS `AKIA…`、百炼 CLI `o1_…` | 替换 |
| 签名下载链接（`Signature`、`X-Amz-Signature`、`X-Amz-Credential`、`OSSAccessKeyId`、`x-oss-signature`、`security-token`、`sig`、`token` 等参数） | 只抹参数值，保留域名与路径便于排障 |
| 刷新令牌（`refresh_token=`、JSON 字段 `refreshToken`） | 替换；对象按字段名整体替换 |
| 许可证 JWT（`eyJ….eyJ….sig`）与 `licence/license` 字段 | `[REDACTED_JWT]` / 字段值替换 |
| 字段名 | 敏感字段名扩充：credential、signature、cookie、licence/license、jwt、private_key、session_id、sig |

`pnpm secrets:scan` 同步新增 JWT 与证书口令赋值（`CSC_KEY_PASSWORD` 等）两条规则。

未覆盖 / 需注意：

- 脱敏是尽力而为的黑名单；不要把整段请求体或响应体打进日志。新增日志点优先打 id 与状态码。
- 非 `eyJ` 开头的自定义令牌、没有字段名也没有前缀的裸随机串无法识别；已保存的 Key 靠“按值替换”兜底。
- 主进程日志（`main.log`）目前只写异常栈，未经过 `redactText`；若栈里带 URL 查询串有泄漏可能，后续可让 `writeMainLog` 也走脱敏。
- 云端 `console.error(e)` 不在本次范围，上线前需单独复查。
