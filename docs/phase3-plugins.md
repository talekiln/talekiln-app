# 三期 P3-P：插件适配器（签名的服务商插件）

状态：SDK 签名/验签、本地插件宿主与 `/plugins` 接口、云端插件注册表、插件页（P3-02）和测试已完成。**没有在真实桌面端里点过插件页**（只做了 `vite build` 通过和纯函数单测），云端 Prisma 仓储与迁移 SQL 只在内存仓储上验证（真实 PostgreSQL 由 CI 的 `cloud-pg` 任务跑）。本文不含任何密钥。

涉及的包：`packages/plugin-sdk`（MIT，公开）、`packages/local`（AGPL，公开）、`packages/cloud`（私有）、`apps/renderer`。

## 1. 信任模型

一句话：**签名证明"包来自登记的作者且没被改过"，不证明"包是无害的"**。插件仍在本地服务进程内运行、没有沙箱（见 SDK README 的 Trust model）。

| 签名状态 | 含义 | 何时加载 |
| --- | --- | --- |
| `official` | `manifest.signature` 用官方 JWKS 里的某把公钥验签通过，且 `files` 覆盖的每个文件哈希都对得上、目录里没有未列出的文件和符号链接 | 开关打开即加载 |
| `unsigned` | 清单没有 `signature` 字段 | 只在**开发者模式**打开时加载 |
| `invalid` | 其余一切：签名格式错、`kid` 不在 JWKS 里、文件被改/缺失/多出、符号链接、清单被改 | 只在开发者模式打开时加载 |

补充规则：

- 官方公钥 = 云端 `GET /.well-known/licence-jwks.json`（与目录、许可证同一把 ES256 密钥）。本地用 `cloud/jwks.js` 的离线缓存验签：启动扫描是同步、纯离线的；缓存里没有该 `kid` 时先记为 `invalid（unknown kid）`，云端配置好后在后台拉一次 JWKS 复验（`refreshKeys`），变成 `official` 的立即加载。
- 插件名就是服务商 id。与内置服务商同名的插件一律拒绝（`PLUGIN_NAME_CONFLICT`），所以插件不能冒充百炼/方舟。
- 从文件夹安装时，未签名/签名无效的包在开发者模式关闭时直接拒绝（`PLUGIN_SIGNATURE`，403），不会复制进插件目录。手工拷进插件目录的包会被记录但不会加载，插件页上能看到原因。
- 开发者模式是 `global_settings.developer_mode`，关掉的瞬间所有非官方插件卸载；打开前界面会弹一次确认。
- 已签名的包改任何一个被覆盖的文件（含加文件）都会变成 `invalid`。签名**不能撤回**：云端驳回一个已签名的版本只是把它撤出目录，已经分发出去的包在客户端仍然验得过；要作废只能轮换密钥（换 `LICENCE_KEY_ID` + 私钥）。
- 本地只信 JWKS 里的公钥，不信清单里的任何声明；插件代码运行前要先过 SDK 的 `validateManifest`、能力/权限/`sdkVersion` 检查，运行时只能通过受限 `fetch` 访问 `network:` 声明的主机（https，不跟重定向），`apiKey` 只在声明 `secret:apiKey` 时注入。

## 2. 签名

### 2.1 签的是什么

```
载荷 = canonicalJson({ manifest: <manifest 去掉 signature>, files: { "<相对路径>": "<sha256 hex>", ... } })
签名 = ES256（P-256 + SHA-256，IEEE P1363 r||s）over UTF-8 载荷，base64url
manifest.signature = { "alg": "ES256", "kid": "<官方 JWKS 里的 kid>", "value": "<base64url>" }
```

- `canonicalJson`：键排序、跳过 `undefined`，与本地校验云端目录的算法相同（`packages/local/src/cloud/jws.js`、`packages/cloud/src/services/catalog.service.ts`、SDK `src/signing.js` 三处一致，云端测试做了交叉校验）。
- `manifest.files`：签名覆盖的相对路径列表（不含 `manifest.json` 本身），必须包含 `entry`。签名时如果清单没写 `files`，就把目录里全部普通文件（排序）填进去；有符号链接直接拒签。
- **包指纹** `hash = sha256(载荷)`：插件页展示、云端登记记录、`sign-plugin.mjs --inspect` 输出的都是它；同一个包签名前后指纹不变，所以可以用它把本机安装的插件对到云端的审核记录。

### 2.2 怎么签（SDK 命令行）

私钥只从环境变量指向的文件读，不接受命令行参数，不写进仓库：

```bash
# 作者/审核员：看一眼包的文件、哈希与指纹（不需要密钥）
node packages/plugin-sdk/scripts/sign-plugin.mjs ./my-plugin --inspect

# 持有官方私钥的人：签名（写回 manifest.json；--out 写到别处；--dry-run 只算不写）
TALEKILN_PLUGIN_SIGNING_KEY_FILE=/secure/plugin-signing.pem \
node packages/plugin-sdk/scripts/sign-plugin.mjs ./my-plugin --kid lic-1
```

`--inspect` 的 JSON 里 `manifest`（已含 `files`，不含 `signature`）和 `fileHashes` 正是云端登记接口要的提交体。CI 密钥库里只有一行时可用 `TALEKILN_PLUGIN_SIGNING_KEY_PEM`（`\n` 转义）；`kid` 也可从 `TALEKILN_PLUGIN_SIGNING_KID` 读。签完会自检（清单仍合法、签名结构正确），再用 `verifySignature` + JWKS 复验一次更稳妥。

### 2.3 官方流程（云端注册表签名，推荐）

云端用许可证同一把私钥签名，不需要把私钥分发给任何人：

1. 作者在本地跑 `--inspect`，把 `manifest`、`fileHashes`、包的下载地址（https）与包文件 `sha256` 交给运营。
2. 运营（OPERATOR 及以上）`POST /admin/plugins` 登记 → 版本进入 `pending`。
3. 审核员按 `packageUrl` 下载包、核对 `sha256`，解包后跑 `--inspect`，比对指纹与登记记录里的 `hash` 一致，再看代码；`POST /admin/plugins/:id/approve`（或 `reject`，`notes` 写理由）。
4. ADMIN `POST /admin/plugins/:id/sign`：云端签名，返回 `signedManifest`。
5. 作者把 `signedManifest` 原样写回包里的 `manifest.json`（签名不覆盖 `manifest.json`，所以这一步不会让签名失效），重新打包分发。
6. 已通过的版本出现在公开的 `GET /plugins/catalog`，带 `signedManifest`、`hash`、`reviewedAt`。本地启动时会拉一次目录，把 `reviewedAt` 写到对应指纹的插件上（插件页"审核日期"）。

云端**不下载也不执行**插件包；第 3 步的核对是人工动作，没有这一步签名就等于只认登记的人。

## 3. 权限

清单 `permissions`：

| 权限 | 作用 |
| --- | --- |
| `network:<host>` / `network:*.<domain>` | 受限 `fetch` 放行的主机（必须 https，不跟重定向，不许裸 `*`、不许带协议/端口/路径）；至少一个 |
| `secret:apiKey` | 需要用户为该服务商保存的 API Key；不声明则 `ctx.apiKey` 为空 |

插件页把权限翻译成"访问 a.example、b.example"和"使用你保存的 API Key"。这些是**声明式**的：宿主只约束 `ctx.fetch` 和 Key 注入，插件代码本身可以 `require('node:https')`，所以仍然要靠签名 + 审核。

## 4. 接口

### 4.1 本地服务（`packages/local`，挂在 `/api/v1`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/plugins` | `{ items, developer_mode, plugins_dir }`。每项：`id, name, label, version, description, homepage, sdk_version, dir, source:'plugin', capabilities（宿主能力名，llm.chat 显示为 text.stream）, permissions, hosts, needs_api_key, signature:{status, kid, hash, reason}, enabled, active, blocked_reason, load_error, installed_at, updated_at, reviewed_at` |
| GET | `/plugins/:id` | 单个 |
| POST | `/plugins/install` `{ dir }` | 把本机文件夹复制进 `<数据目录>/plugins/<name>`（先拷到临时目录再改名），校验 + 验签 + 加载。错误：`PLUGIN_INVALID`(400)、`PLUGIN_NAME_CONFLICT`(409)、`PLUGIN_SIGNATURE`(403，开发者模式关闭时装未签名/无效包) |
| POST | `/plugins/:id/enable` / `disable` | 开关持久化在 `installed_plugins.enabled`，重新扫描不会改它 |
| DELETE | `/plugins/:id` | 删记录并删除插件目录里的文件夹（目录外的不动） |
| GET / PUT | `/settings/developer-mode` | `{ developer_mode: boolean }`；PUT 返回与 `GET /plugins` 同形的汇总 |

内置服务商仍由 `GET /providers`（`config.yaml providers.enabled`）下发，插件页把两者合成一张表。

数据：迁移 `32_installed_plugins.sql`，表 `installed_plugins(id=插件名, name, version, dir, manifest json, signature_status official|unsigned|invalid, signature_kid, signature_hash, permissions json, enabled, reviewed_at, installed_at, updated_at)`。插件目录：`config.yaml plugins.dir`（默认 `./data/plugins`，相对本地服务工作目录，桌面端即 `userData/local/data/plugins`）。

接到现有管线的方式：`providers/enablement.js` 新增 `registerPluginProviders / availableProviders / isProviderAvailable`，内置开关不变，活跃插件 id 追加在后面且永远不能覆盖内置 id；`registry.js`、`routes/aiTasks.js validateSpec`、`queue/providerAdapter.js`（别名表外的 id 按小写原名取 AI 配置）、`generation/models.js` 都改用 `availableProviders()`；`providers/index.js createProviders` 对活跃插件调用 `host.createAdapter(id, cfg)`（SDK `instantiate` + `bridge.toRegistryAdapter`，Key 从错误文本里抹掉）；运行中安装的插件由 `app.js` 的 `ensureQueueProviders` 补上队列适配器。未知 id 照旧被 `validateSpec` 拒绝。

### 4.2 云端（`packages/cloud`）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/plugins/catalog` | 公开 | `{ generated_at, kid, plugins:[{ name, label, homepage, versions:[{ version, sdkVersion, capabilities, permissions, manifest（签名后含 signature）, signed, kid, hash, packageUrl, sha256, reviewedAt, signedAt }] }] }`，只含 `approved` 的版本（未签名的也列，`signed=false`） |
| GET | `/admin/plugins?status=&limit=` | `read` | 版本列表 |
| GET | `/admin/plugins/:id` | `read` | 版本 + 审核记录 |
| POST | `/admin/plugins` | `ops:write` | 登记 `{ manifest, fileHashes, packageUrl(https), sha256, notes? }`；同插件同版本 409 |
| POST | `/admin/plugins/:id/approve` / `reject` | `plugins:review`（OPERATOR 以上） | 状态机：pending/rejected → approved；pending/approved → rejected |
| POST | `/admin/plugins/:id/sign` | `plugins:sign`（仅 ADMIN） | 只签 approved；同一 `kid` 不重复签；返回 `signedManifest` |

所有写操作经 `AuditInterceptor` 自动审计（含越权尝试）。表：`Plugin(name 唯一)`、`PluginVersion(manifest, fileHashes, hash, packageUrl, sha256, signature, reviewStatus pending|approved|rejected, reviewedAt/By, signedAt/By)`、`PluginReview(action submit|approve|reject|sign, notes)`，迁移 `20261005000000_plugin_registry`（纯新增）。云端镜像不含 SDK，清单规则与签名载荷在 `services/plugin-registry.service.ts`、`services/plugin-signing.ts` 复刻，测试用相对路径加载 SDK 做交叉校验。

### 4.3 SDK 新增

`manifest.files?`、`manifest.signature?`；`readPluginManifest(dir)`（只读清单不执行代码）；`signing.js`：`canonicalJson, listPluginFiles, hashFiles, signingPayload, payloadHash, signManifest, verifySignature, resolveKey`（只用 `node:crypto`；`keys` 可以是 JWKS、JWK 数组、单个 JWK、公钥对象/PEM 或 `(kid) => key` 函数）；`scripts/sign-plugin.mjs`；类型在 `index.d.ts`。

### 4.4 插件页（`/settings/plugins`）

一张表：内置服务商（`GET /providers`，隐藏的一期服务商不会出现）+ 已安装插件；每行有版本、能力、访问主机、指纹、审核日期、签名标签（官方内置 / 官方签名 / 未签名 / 签名无效）、开关和状态文案；详情抽屉列能力、权限、签名密钥、包指纹、审核日期、安装目录；页头链接 SDK 文档（`VITE_PLUGIN_SDK_DOCS_URL`，缺省指向公开仓库里的 SDK 说明）和「从文件夹安装」（输入完整路径——桌面端目前没有给渲染进程暴露系统文件夹选择框）；页脚是社区插件维护责任说明；开发者模式开关在页顶。内置服务商的开关固定为开且不可动（开关由安装包的 `config.yaml` 决定）。命令面板：「插件与服务商」。纯逻辑在 `utils/pluginsView.js`。

## 5. 没有验证的

- 真实桌面端上的插件页交互、`ElMessageBox.prompt` 的路径输入体验，以及 Windows 路径（带反斜杠、盘符）从输入框到 `fs.cpSync` 的全链路；测试只跑了 Linux 临时目录。
- 云端 Prisma 仓储（`plugins` 那组）与迁移 SQL 没有在真实 PostgreSQL 上跑过；`prisma validate` 通过，CI 的 `cloud-pg` 任务会做 `migrate deploy` + `migrate diff` + 全量测试。
- 真实厂商插件（可灵、Vidu、MiniMax）一个都没写；测试夹具是 SDK 示例的独立拷贝（虚构的 `api.acme.example`）。
- 后台界面没有插件审核页，云端接口只能用 HTTP 工具调。
- 官方签名私钥的保管、谁来审核、轮换流程是商务/运维决定（`docs/phase3-plan.md` 待决项）。
- 插件在进程内运行、没有沙箱，这一点没有变化。

## 6. 怎么测

```bash
pnpm --filter ./packages/plugin-sdk test     # 签名/验签/CLI（密钥每次运行临时生成）
pnpm --filter ./packages/local test          # test/plugins.test.js：扫描、信任规则、开发者模式、安装/删除、队列接入、目录同步
pnpm --filter ./packages/cloud test          # test/plugin-registry.test.ts：校验、角色、状态机、审计、签名被 SDK 用 JWKS 验过
pnpm --filter ./apps/renderer test           # test/pluginsView.test.js
```

手工：把 `packages/local/test/fixtures/plugins/acme` 拷一份，用临时密钥 `--kid dev-1` 签名；本地服务 `global_settings.cloud.jwks` 里放对应公钥的 JWKS（或配置云端地址让它去拉）；在插件页「从文件夹安装」，应显示「官方签名」并可开关；改一个文件再重启，应变成「签名无效」且不加载；打开开发者模式后才能启用。所有测试都不联网，不写任何密钥文件到仓库。
