# 云服务部署与数据库验证（packages/cloud）

本文说明如何在本地或 docker-compose 中运行 PostgreSQL、需要哪些环境变量、如何应用迁移、如何通过环境变量创建首个管理员，以及哪些行为已经在真实 PostgreSQL 上验证过。

> 所有口令、连接串、私钥只通过环境变量传入，**不要写入任何提交到 git 的文件**。下文示例中的口令均为占位符，请自行替换。

## 1. 本地运行 PostgreSQL

### 方式 A：docker 单容器

```bash
docker run -d --name talekiln-pg \
  -e POSTGRES_USER=talekiln -e POSTGRES_PASSWORD="$PGPW" -e POSTGRES_DB=talekiln \
  -p 5432:5432 postgres:16
export DATABASE_URL="postgresql://talekiln:$PGPW@localhost:5432/talekiln"
```

### 方式 B：docker-compose（postgres + app）

`packages/cloud/docker-compose.yml` 已包含 `postgres:16-alpine` 与 app 服务。在 `packages/cloud` 下准备 `.env`（不要提交），至少包含：

```
POSTGRES_PASSWORD=<自行生成>
JWT_ACCESS_SECRET=<至少 32 字符的随机串>
LICENCE_PRIVATE_KEY_PEM=<ES256 PKCS8 私钥，换行写成 \n>
ADMIN_EMAIL=<首个管理员邮箱>
ADMIN_PASSWORD=<首个管理员口令>
```

然后执行 `docker compose up --build`。app 容器的启动命令是 `prisma migrate deploy && node dist/main.js`，所以每次启动都会先应用未执行的迁移。

### 方式 C：本机已安装的 PostgreSQL

```sql
CREATE USER talekiln WITH PASSWORD '<自行设置>';
CREATE DATABASE talekiln OWNER talekiln;
```

## 2. 环境变量

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串（必填） |
| `JWT_ACCESS_SECRET` | 访问令牌 HS256 密钥，至少 32 字符（必填） |
| `ADMIN_JWT_SECRET` | 管理后台令牌密钥（可选，见 `config.ts`） |
| `LICENCE_PRIVATE_KEY_PEM` | 许可证 ES256 私钥；生产必填，非生产留空则临时生成 |
| `LICENCE_KEY_ID` / `LICENCE_TTL_DAYS` / `LICENCE_GRACE_DAYS` | 密钥标识、许可证有效期、离线宽限天数 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 首个管理员（见第 4 节） |
| `REFERRAL_LINKS` / `REFERRAL_ALLOWED_HOSTS` | 推广链接覆盖与主机白名单 |
| `MAX_DIAGNOSTIC_BYTES` / `FEEDBACK_RATE_LIMIT` | 反馈诊断包大小上限与限流 |
| `CATALOG_FILE` | 自定义模型目录文件 |
| `PORT` | 监听端口，默认 3000 |
| `PAYMENT_MODE` / `PAYMENT_SANDBOX_SECRET` / `PAYMENT_NOTIFY_BASE_URL` / `ORDER_TTL_MINUTES` / `PLAN_PRO_PRICE_MONTH_CENTS` / `PLAN_PRO_PRICE_YEAR_CENTS` | 收费与支付，见 `docs/phase2-payments.md` |

## 3. 应用迁移

```bash
cd packages/cloud
pnpm prisma:generate        # 生成 Prisma Client
pnpm prisma:deploy          # = prisma migrate deploy，只应用已检入的迁移，不会生成新迁移
```

漂移检查（库结构与 `schema.prisma` 是否一致，退出码非 0 表示有差异）：

```bash
pnpm exec prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

关于迁移目录：`20261002000000_admin_stats_feedback` 与 `20261002000000_referral_click` 时间戳相同。Prisma 按目录名的字典序应用，所以顺序固定为 `admin_stats_feedback` 先、`referral_click` 后；两者操作的是完全不相交的对象（前者改 `Account`/`InviteCode` 并新增 `Setting`/`TelemetryEvent`/`Feedback`，后者只新增 `ReferralClick`），互不依赖，顺序无关紧要。已在全新数据库上验证可干净应用。因为已部署的库会在 `_prisma_migrations` 里记录目录名，**不要再改名**，否则会与已应用历史不一致。新增迁移请使用更晚的时间戳。

## 4. 通过环境变量创建首个管理员

设置 `ADMIN_EMAIL` 与 `ADMIN_PASSWORD` 后启动服务（`src/main.ts` 的 `seedAdmin`）：若该邮箱（转小写）对应的账号不存在，则以 `ADMIN` 角色创建并输出一行日志（不含口令）；已存在则什么也不做，因此重启是幂等的，也不会重置已有账号的口令。创建成功后建议从环境中移除 `ADMIN_PASSWORD`，之后在管理后台修改口令或增加管理员。

## 5. 运行针对真实 PostgreSQL 的测试

```bash
export DATABASE_URL="postgresql://<user>:<password>@localhost:5432/<测试库>"   # 或 TEST_DATABASE_URL
pnpm --filter @talekiln/cloud prisma:deploy
pnpm --filter @talekiln/cloud test:pg
```

- 未设置 `TEST_DATABASE_URL`/`DATABASE_URL` 时，`pnpm test` 使用内存仓储，不需要数据库。
- 设置后，`test/helpers/repos.ts` 的 `makeRepos()` 改为返回 Prisma 仓储，并在每个测试前 `TRUNCATE` 全部业务表，所以**测试库会被清空，务必使用专用测试库**。
- `test:pg` 使用 `--test-concurrency=1`，因为各测试文件共用同一个库；请不要在设置了 `DATABASE_URL` 的 shell 里直接跑并发的 `pnpm test`。
- CI 的 `cloud-pg` 任务使用 `postgres:16` 服务容器，库口令是写在工作流里的一次性值，仅用于该容器。

## 6. 已在真实 PostgreSQL 16 上验证的内容

- 3 个迁移在全新库上依次应用成功；应用后 `prisma migrate diff` 与 `schema.prisma` 无差异。
- 全部既有服务测试（认证/邀请码/设备/刷新令牌/许可证/管理后台/统计/反馈/目录/推广，共 27 个）用同一套断言在 Prisma 仓储上通过。
- 新增的仓储契约测试（`test/repositories.test.ts`，内存与 Postgres 共用同一断言）覆盖：邮箱与邀请码唯一约束；邀请码过期边界（`expiresAt == now` 视为过期）；12 路并发 `consume` 只有一个赢家；并发 `markUsed` 只有一个赢家；并发 `device upsert` 不重复、不报唯一键冲突；删除账号时设备与刷新令牌级联删除、邀请码 `usedById` 置空；设置表 JSON 往返；遥测按天过滤；反馈诊断包 `BYTEA` 二进制往返、列表不含诊断包且新到旧排序。
- 同邮箱并发激活：落败方得到 `email_taken`，库中只有一个账号。

## 7. 尚未验证

- 通过 `docker compose up` 实际构建并启动镜像（本环境没有 docker）；Dockerfile 的构建与 `HEALTHCHECK` 仍只是静态检查。
- 真实的 HTTP 入口 + Postgres 的端到端并发压力（连接池耗尽、事务隔离级别下的极端交错）；目前只验证了单进程内 8–12 路并发。
- 多实例部署时的内存限流器（`RateLimiter`）是进程内的，不跨实例共享。
- 迁移在已有生产数据上的升级路径（只验证了空库）。
- 在 Windows runner 之外的 `cloud-pg` CI 任务本身尚未在 GitHub Actions 上实际跑过。
