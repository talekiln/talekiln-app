# 三期 P3-S：工作室版基础（工作室、成员、席位、共享角色库与模板）

状态：云端 Studio 模块（工作室 / 成员 / 邀请 / 席位、用户侧与后台接口、审计）、本机 `studio` 模块（云端身份缓存、成员管理转发、共享角色与模板的发布 / 拉取，复用云备份的 S3 客户端）、渲染进程「工作室」设置页、后台「工作室」页都已写完并通过自动化测试（云端用内存仓储 + 真实 HTTP，本机用进程内假 S3）。**没有对真实 MinIO 和真实云端跑过，两个页面都没有在浏览器里点过**，见第 7 节。本文不含任何密钥或真实地址。

决定依据：Jay 定的「共享存储与云备份先自建 MinIO，后续再接第三方」；**席位定价未定**，所以计费只留配置位与接口占位，本包里没有价格字段、不接支付、不做私有部署。

## 1. 做了什么

| 位置 | 作用 |
|---|---|
| `packages/cloud/prisma/schema.prisma`、`prisma/migrations/20261006000000_studio` | `Studio`（名称、所有者、`seatLimit`、`status`）、`StudioMember`（`owner / admin / member`，`invited / active / removed`）、`StudioInvite`（邀请码、可选邮箱、角色、过期、使用 / 撤销） |
| `packages/cloud/src/domain/*.repositories.ts` | `StudioRepository` 契约 + 内存 / Prisma 实现 |
| `packages/cloud/src/services/studio.service.ts` | 创建 / 邀请 / 撤销邀请 / 接受 / 移除 / 改角色 / 我的工作室；席位占用与超限；后台列表、调整席位数、停用 / 恢复；用户侧写操作写审计 |
| `packages/cloud/src/http/studio.controllers.ts` | `/studios/*`（AccessGuard，桌面端登录态令牌）与 `/admin/studios/*`（AdminGuard + AuditInterceptor） |
| `packages/cloud/src/services/config.ts` | `STUDIO_DEFAULT_SEAT_LIMIT`（默认 3）：新建工作室的席位数，**计费占位** |
| `packages/cloud/src/services/errors.ts`、`http/filter.ts` | 新错误码 `seat_limit`（403）、`studio_suspended`（403） |
| `packages/cloud/src/services/audit.service.ts` | 唯一改动：`targetType` 的正则也认非 `/admin/` 路由，工作室的用户侧操作在后台审计页里可按 `studios` 过滤 |
| `packages/local/migrations/36_studio_shared.sql` | `studio_shared_items`：本机发布 / 拉取过的条目、版本、sha256 |
| `packages/local/src/studio/manifest.js` | 桶内布局、清单组装 / 校验 / 摘要（纯函数，第 2 节） |
| `packages/local/src/studio/service.js` | 身份（`GET /studios/mine` 缓存与离线回落、当前工作室）、成员管理转发、`listShared / publishCharacter / pullCharacter / publishTemplate / pullTemplate` |
| `packages/local/src/routes/studio.js` | REST（第 3 节），在 `routes/index.js` 末尾以 `// P3-S` 块挂载 |
| `packages/local/src/app.js` | 组装：`createStudioService({ db, storageRoot, cloud, backup, templates })` |
| `packages/local/src/errors/error-codes.json` | `STUDIO_NOT_LOGGED_IN`（401）、`STUDIO_NOT_MEMBER`（403）、`STUDIO_FORBIDDEN`（403）、`STUDIO_INVALID_MANIFEST`（400）、`STUDIO_CHECKSUM`（409）；cloud 侧 `seat_limit`、`studio_suspended` 文案 |
| `apps/renderer/src/views/StudioPage.vue`、`utils/studioView.js`、`api/studio.js` | `/settings/studio`「工作室」：我的工作室（切换 / 创建 / 接受邀请）、成员与席位（邀请、撤销、移除、改角色）、共享角色 / 共享模板列表（发布 / 拉取 / 更新 / 重新发布） |
| `apps/renderer/src/router/index.js`、`utils/builtinCommands.js` | 路由与命令面板「工作室」（末尾 `// P3-S` 块） |
| `apps/admin/src/views/Studios.vue`、`studios.js`、`api.js`、`router.js`、`route-meta.js`、`App.vue`、`ops.js` | 后台「工作室」：只读列表（所有者、席位占用、状态）、详情抽屉（含已移除成员与全部邀请）、调整席位数、停用 / 恢复；审计动作文案 |
| 测试 | `packages/cloud/test/studio.test.ts`、`packages/local/test/studio.test.js`、`apps/renderer/test/studioView.test.js`、`apps/admin/test/studios.test.js`（第 8 节） |

职责划分：**云端只管「谁在哪个工作室、什么角色、席位用了多少」**；共享素材本身在对象存储里，由本机服务凭云端返回的身份读写。本机不把素材经过云端服务器中转。

## 2. 共享存储约定

与云备份同一个桶、同一个 `<prefix>`（默认 `talekiln`），用 `docs/phase3-backup.md` §2 预留的 `shared/` 前缀：

```
<prefix>/shared/<studio_id>/characters/<shared_id>/manifest.json
<prefix>/shared/<studio_id>/characters/<shared_id>/files/<role>-<sha256 前 12 位>.<ext>     role = main | four_view | locked_reference | extra
<prefix>/shared/<studio_id>/templates/<template_id>/manifest.json
<prefix>/shared/<studio_id>/templates/<template_id>/template.json                             模板包清单（与 .lytpl 里的 manifest.json 同格式）
```

- `shared_id`：角色用 `c-<16 位十六进制>`，同一个本机角色重复发布沿用同一个 id（查 `studio_shared_items`）；模板直接用模板 id。
- 文件名含内容哈希，重复发布同一张图不会堆垃圾；改了图才会多一个文件（旧文件暂不清理，见第 7 节）。
- 清单 `manifest.json`：

```json
{
  "schema": "talekiln.shared.character/1",      // 或 talekiln.shared.template/1
  "kind": "character", "id": "c-…", "studio_id": "…", "version": 2, "name": "林小满",
  "fields": { "role": "女主", "description": "…", "appearance": "…", "polished_prompt": "…", "identity_anchors": "…", "...": "角色表里的文字字段；模板为 template_version / genre / tier / description" },
  "files": [ { "role": "main", "name": "main-a595013faf9c.png", "key": "talekiln/shared/…/files/main-a595013faf9c.png", "sha256": "…", "size": 12345, "content_type": "image/png" } ],
  "author": { "account_id": null, "email": "owner@example.com" },
  "source": { "character_id": 12 },               // 模板为 { "template_id": "…" }
  "updated_at": "2026-10-02T03:04:05.000Z",
  "sha256": "…"                                   // sha256(canonicalJson(清单去掉 sha256))
}
```

- 版本号：整数，每次发布 = max(本机记录的版本, 远端清单版本) + 1；拉取端据此显示「有更新」。
- 校验：拉取时清单摘要、每个文件的 sha256 都核对，不符 `STUDIO_CHECKSUM`（409）且**不写库、不落盘**；清单结构不对 `STUDIO_INVALID_MANIFEST`（400），列表里标 `invalid` 并隐藏。
- 发布顺序：先传文件再传清单，所以中途失败不会出现指向缺失文件的清单。
- `parseKey`（云备份）只认 `dramas/`，`shared/` 下的对象在快照列表里被忽略；反过来共享库只列 `shared/<studio_id>/…/manifest.json`。

拉取到本机：角色图片落到 `<storage_root>/studio/<studio_id>/characters/<shared_id>/`，新建 `characters` 行（`image_url` / `local_path` / `four_view_image_url` / `extra_images` 指向这些文件），并用 `reference_locks` 把共享里的锁定参考图（没有则主图）重新锁定；第二次拉取（更新）覆盖同一个本机角色。模板走模板服务 `install({ manifest, source: 'local' })`，所以内置模板 id 会被模板服务拒绝（`TEMPLATE_BUILTIN_READONLY`）。

## 3. 接口

### 3.1 云端

用户侧（`AccessGuard`）：

| 方法 / 路径 | 作用 |
|---|---|
| `GET /studios/mine` | `{ items: [{ id, name, status, seatLimit, my_role, seats: { limit, used, pending, available } }], issued_at }` |
| `POST /studios` | `{ name }` → 201；创建者为 owner；`seatLimit` = `STUDIO_DEFAULT_SEAT_LIMIT` |
| `POST /studios/accept` | `{ code }` → `{ studio, member }`；码过期 / 已用 / 已撤销 400，邮箱不符 403 `forbidden`，席位满 403 `seat_limit`，工作室停用 403 `studio_suspended` |
| `GET /studios/:id` | 详情：成员（带邮箱，按 owner / admin / member 排）、席位；owner / admin 还能看到未处理的邀请 |
| `POST /studios/:id/invites` | `{ email?, role: 'admin' \| 'member', expiresInDays: 1–90 }` → 201 `{ id, code, email, role, expires_at }`；owner / admin；席位（成员 + 待处理邀请）满 403 `seat_limit`；邮箱已是成员或已有邀请 409 |
| `DELETE /studios/:id/invites/:inviteId` | 撤销 → 204 |
| `DELETE /studios/:id/members/:accountId` | 移除 / 退出 → 204。owner 可移除任何人（除自己）；admin 只能移除 member；member 只能退出；owner 不能被移除 |
| `PUT /studios/:id/members/:accountId/role` | `{ role }`，只有 owner，不能改 owner |

后台（`AdminGuard`，读 `read`、写 `ops:write`，写由 `AuditInterceptor` 记审计）：

| 方法 / 路径 | 作用 |
|---|---|
| `GET /admin/studios` | 全部工作室 + 席位占用 + 所有者邮箱 |
| `GET /admin/studios/:id` | 详情（含已移除成员、全部邀请及其状态） |
| `PUT /admin/studios/:id/seats` | `{ seatLimit: 0–1000 }`；低于当前成员数 400。**定价待定**：这是席位计费的唯一占位 |
| `PUT /admin/studios/:id/status` | `{ status: 'active' \| 'suspended' }`；停用后用户侧一切写操作 403 |

用户侧写操作也写进 `AdminAudit`（`actorId` 为用户账号、`actorRole` 为空、`targetType = 'studios'`），后台审计页可按 `targetType=studios` 过滤。

### 3.2 本机

全部在 `/api/v1/studio`，令牌校验由 app 级 `localTokenGuard` 统一处理。

| 方法 / 路径 | 作用 |
|---|---|
| `GET /identity?sync=1` | `{ studios, current_studio_id, online, fetched_at, error }`。没缓存或 `sync=1` 时问云端；连不上用缓存并 `online: false`；未登录 401 `STUDIO_NOT_LOGGED_IN`（并清缓存） |
| `PUT /current` | `{ studio_id }` 切换当前工作室（必须是成员） |
| `POST /studios`、`GET /studios/:id`、`POST /studios/:id/invites`、`DELETE /studios/:id/invites/:inviteId`、`POST /accept`、`DELETE /studios/:id/members/:accountId`、`PUT /studios/:id/members/:accountId/role` | 原样转发云端（带登录态），之后刷新身份缓存；云端错误码映射：`seat_limit` → `SEAT_LIMIT`、`forbidden` → `STUDIO_FORBIDDEN`、`invalid_token` → `STUDIO_NOT_LOGGED_IN` |
| `GET /shared/:kind?studio_id=` | `kind = characters \| templates` → `{ items, invalid, my_role, can_publish, truncated }`；每条 `{ shared_id, name, version, author, updated_at, sha256, file_count, total_size, fields, state }`，`state ∈ mine \| mine_outdated \| pulled \| update_available \| not_pulled` |
| `POST /shared/characters/publish` | `{ character_id, studio_id? }` → 201 `{ shared_id, version, manifest, files, skipped, updated }`；需要 owner / admin |
| `POST /shared/characters/pull` | `{ shared_id, studio_id?, drama_id? }` → 201 `{ character_id, drama_id, version, updated, files, locked_reference }`；第一次拉取必须给 `drama_id`，更新时不用 |
| `POST /shared/templates/publish` | `{ template_id, studio_id? }` → 201 |
| `POST /shared/templates/pull` | `{ shared_id, studio_id? }` → 201 `{ template_id, version, template }` |
| `GET /records?studio_id=&kind=` | 本机发布 / 拉取记录 |

`studio_id` 缺省用当前工作室。对象存储未配置时 503 `BACKUP_NOT_CONFIGURED`（页面上直接给「去云备份页配置」的按钮）。

## 4. 配置与凭据

- 云端：`STUDIO_DEFAULT_SEAT_LIMIT`（默认 3）。没有价格、没有订阅字段；等定价定了，`seatLimit` 改由订阅版本驱动，后台接口保留为人工覆盖。
- 本机：**没有新增设置**。S3 地址、桶、前缀、Access Key / Secret Key 沿用「云备份」页的那一套（`global_settings.backup` + 密钥存储 `backup:s3:secret`）；身份沿用「账号」页的登录态。
- 对象存储权限：当前桌面端的 Key 对 `<prefix>/*` 有读写权限，所以「成员只读 shared/」**只在本机服务层面强制**（非 owner / admin 的发布请求被拒），对象存储层面并没有隔离——一个成员拿着 Key 用别的工具能写。要做真正的隔离需要每工作室（甚至每成员角色）独立凭据，见第 9 节；部署手册 `docs/tencent-deploy.md` §8.7 给了按前缀划分策略的写法。
- 权限矩阵（服务层）：

| 操作 | owner | admin | member |
|---|---|---|---|
| 查看成员、席位、共享库，拉取 / 更新 | ✓ | ✓ | ✓ |
| 发布 / 更新共享角色与模板 | ✓ | ✓ | – |
| 邀请、撤销邀请 | ✓ | ✓ | – |
| 移除成员 | 任何人（除自己） | 仅 member | 仅自己（退出） |
| 改角色（admin ↔ member） | ✓ | – | – |
| 调整席位数、停用 / 恢复 | 后台管理员 | 后台管理员 | 后台管理员 |

## 5. 席位

占用 = active 成员数 + 未过期、未使用、未撤销的邀请数（邀请先占位，避免超发）；`available = limit - used - pending`。邀请时 `available <= 0` 拒绝；接受时只看 active 成员数（自己那份邀请已经占了位）；撤销或过期后席位自动释放（过期的码不能再用）。后台把席位数调到低于当前成员数会被拒绝，先移除成员。被移除的成员重新接受邀请回到 active（同一条成员记录）。

## 6. 部署

不需要新服务：云端跑 `prisma migrate deploy`（新迁移 `20261006000000_studio`），MinIO 还是 `docs/tencent-deploy.md` §8 那一套。§8.7 补了「同一个桶里给 `shared/` 前缀单独建策略」的写法，供以后每工作室独立凭据时用。

## 7. 未验证

- **真实云端 + 真实 MinIO 的端到端**：云端只跑过内存仓储 + 本进程 HTTP，Prisma 实现只做了类型检查（`prisma generate` + `tsc`），没在 PostgreSQL 上跑过（CI 的 PG 作业会跑同一套契约测试）；本机只对进程内假 S3 跑过。两台机器之间真正的「A 发布、B 拉取」没做过。
- **界面**：`StudioPage.vue` 与后台 `Studios.vue` 只做了 `vite build` 通过和纯函数单测，没有在浏览器里打开过。
- **大图与多图**：发布时所有文件读进内存再上传、拉取时先全部下载校验再落盘（防半成品），几十张高清图会吃内存；单文件上限 64 MB。
- **旧文件不清理**：改图重新发布后旧文件留在桶里（文件名含哈希，不会被引用），需要后续「清理未引用文件」。
- **身份缓存的时效**：被移除后，本机缓存里的工作室要等下一次 `sync` 才消失；但对象存储层面的 Key 仍然有效（见第 4 节）。
- **并发发布**：两台机器同时发布同一个角色，版本号靠「读远端版本 +1」，没有条件写（S3 没有原子比较），可能互相覆盖。
- 拉取的角色属于某个项目（`characters.drama_id` 非空），没有「跨项目共用的本机角色库」；更新时覆盖上次拉取建的那个角色，如果它被删了就按首次拉取处理（需要 `drama_id`）。
- 作者字段里 `account_id` 现在总是空（本机账号状态只带邮箱）。

## 8. 怎么测

```bash
pnpm --filter @talekiln/cloud test                         # 含 test/studio.test.ts（5 条：仓储契约、席位、角色、纯函数、HTTP 与审计）
TEST_DATABASE_URL=postgres://… pnpm --filter @talekiln/cloud run test:pg   # 同一套断言对真实 PostgreSQL
pnpm --filter ./packages/local test                        # 含 test/studio.test.js（10 条）
pnpm --filter @talekiln/renderer test && pnpm --filter @talekiln/renderer build
pnpm --filter @talekiln/admin test && pnpm --filter @talekiln/admin build
pnpm secrets:scan
```

`packages/local/test/studio.test.js` 覆盖：键布局与清单摘要 / 校验（篡改、错工作室、错 id）；身份同步、缓存、离线回落、退出清缓存、切换工作室；成员管理转发与云端错误映射；未配置对象存储 503；member 发布被拒；角色「发布 → 列表（mine）→ 另一台机器拉取（4 张图逐个 sha256 一致、参考图重新锁定、`extra_images` 落地）→ 发布端改图改名重发 v2 → 拉取端看到 `update_available` → 更新覆盖同一个本机角色」；改文件 409 不写库不落盘、改清单 400 并在列表里标 invalid；模板「发布内置模板 → 拉取端因内置 id 被拒 → 发布改 id 的副本 → 拉取安装成功 → 篡改 template.json 409」；REST 全部路径与错误码。

`packages/cloud/test/studio.test.ts` 覆盖：仓储契约（成员唯一、按成员列工作室、邀请码唯一、级联）；席位占用 = 成员 + 待处理邀请、超限 `seat_limit`、撤销 / 过期释放、邮箱匹配、重复邮箱 409、后台不能把席位调到成员数以下、审计记录（含失败的超限尝试、操作者邮箱）；角色矩阵（member / admin / owner 各自能做什么、owner 不能被移除、被移除后重新接受、停用后拒绝写）；HTTP（用户令牌、403 `seat_limit`、后台只读 403、运营调席位 200 并进审计）。

## 9. 需要你决定

1. **席位定价**：现在只有 `seatLimit` 配置位与后台手动调整；定价定了之后要决定「按席位数订阅」还是「工作室套餐含 N 席」，以及超限时是拒绝还是允许超售后补费。
2. **企业证书形式**：工作室版的授权凭证是「所有者个人账号的专业版 + 席位」，还是单独的企业许可证（机构名、统一开票）？现在成员各自用自己的账号登录，没有企业实体。
3. **每工作室独立 S3 凭据**：现在所有人共用「云备份」页那把 Key，服务层限制了发布权限，但对象存储层面成员也能写、也能读别的工作室的前缀（如果知道 id）。建议下一步由云端为每个工作室（按角色）签发 MinIO 的 STS 临时凭据或独立用户，本机按工作室切换凭据；§8.7 的策略写法已备好。
4. **私有部署**：本包没做。如果企业要自己部署云端 + MinIO，需要把 `cloud.base_url`、S3 地址做成可随安装包分发的企业配置，以及离线许可证。
5. **要不要「跨项目的本机共享角色库」**：现在拉取的角色落在某个项目里；如果工作室常用角色要在多个项目复用，可以考虑拉到 `character_libraries`（本剧资源库）再「应用到角色」。
