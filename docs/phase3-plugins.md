# 三期 P3-P：插件适配器（签名的服务商插件）

状态：SDK 签名/验签、本地插件宿主与 `/plugins` 接口、云端插件注册表、插件页（P3-02）、独立的插件签名密钥（只在云端服务器上）与后台「插件审核」页和测试已完成。**没有在真实桌面端里点过插件页，也没有在真实浏览器里点过后台「插件审核」页**（只做了 `vite build` 通过和纯函数单测），云端 Prisma 仓储与迁移 SQL 只在内存仓储上验证（真实 PostgreSQL 由 CI 的 `cloud-pg` 任务跑）。本文不含任何密钥。

涉及的包：`packages/plugin-sdk`（MIT，公开）、`packages/local`（AGPL，公开）、`packages/cloud`（私有）、`apps/renderer`。

## 1. 信任模型

一句话：**签名证明"包来自登记的作者且没被改过"，不证明"包是无害的"**。插件仍在本地服务进程内运行、没有沙箱（见 SDK README 的 Trust model）。

| 签名状态 | 含义 | 何时加载 |
| --- | --- | --- |
| `official` | `manifest.signature` 用官方 JWKS 里的某把公钥验签通过，且 `files` 覆盖的每个文件哈希都对得上、目录里没有未列出的文件和符号链接 | 开关打开即加载 |
| `unsigned` | 清单没有 `signature` 字段 | 只在**开发者模式**打开时加载 |
| `invalid` | 其余一切：签名格式错、`kid` 不在 JWKS 里、文件被改/缺失/多出、符号链接、清单被改 | 只在开发者模式打开时加载 |

补充规则：

- 官方公钥 = 云端 `GET /.well-known/licence-jwks.json`。里面有多把 ES256 公钥（kid 互不相同、`use: sig`）：许可证密钥（`lic-1`，许可证/模型目录/模板用它签）、**独立的插件签名密钥**（`plg-1`，只给插件包签名；服务器没配时退回许可证密钥）和已退役的插件签名公钥（让轮换前签出去的包继续验得过）。本地用 `cloud/jwks.js` 的离线缓存验签：启动扫描是同步、纯离线的；缓存里没有该 `kid` 时先记为 `invalid（unknown kid）`，云端配置好后在后台拉一次 JWKS 复验（`refreshKeys`），变成 `official` 的立即加载。
- 插件名就是服务商 id。与内置服务商同名的插件一律拒绝（`PLUGIN_NAME_CONFLICT`），所以插件不能冒充百炼/方舟。
- 从文件夹安装时，未签名/签名无效的包在开发者模式关闭时直接拒绝（`PLUGIN_SIGNATURE`，403），不会复制进插件目录。手工拷进插件目录的包会被记录但不会加载，插件页上能看到原因。
- 开发者模式是 `global_settings.developer_mode`，关掉的瞬间所有非官方插件卸载；打开前界面会弹一次确认。
- 已签名的包改任何一个被覆盖的文件（含加文件）都会变成 `invalid`。签名**不能撤回**：云端驳回一个已签名的版本只是把它撤出目录，已经分发出去的包在客户端仍然验得过；要作废只能轮换插件签名密钥（新 `PLUGIN_SIGNING_KEY_ID` + 新私钥）并且**不**把旧公钥放进退役列表——这是全局动作，该钥签过的所有包都会失效。正常轮换时把旧公钥放进 `PLUGIN_SIGNING_RETIRED_PUBLIC_KEYS_PEM`，旧包不受影响（`docs/tencent-deploy.md` 第 7 节）。
- **官方插件签名私钥只保管在云端服务器上**（腾讯云那台机器的 `.env`，`PLUGIN_SIGNING_PRIVATE_KEY_PEM`），签名只通过云端 `POST /admin/plugins/:id/sign` 发生；不分发给审核员、作者或 CI。开发者用自己的密钥跑 `sign-plugin.mjs` 得到的是非官方签名（`invalid / unknown kid`），只在开发者模式下加载。
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

# 开发者本地联调：用自己的密钥签（写回 manifest.json；--out 写到别处；--dry-run 只算不写）。
# 这不是官方签名：kid 不在官方 JWKS 里，客户端判 invalid，只在开发者模式下加载。官方签名见 2.3。
TALEKILN_PLUGIN_SIGNING_KEY_FILE=/secure/dev-signing.pem \
node packages/plugin-sdk/scripts/sign-plugin.mjs ./my-plugin --kid dev-1
```

`--inspect` 的 JSON 里 `manifest`（已含 `files`，不含 `signature`）和 `fileHashes` 正是云端登记接口要的提交体（后台「插件审核」→「登记新版本」直接粘贴整段输出即可）。CI 密钥库里只有一行时可用 `TALEKILN_PLUGIN_SIGNING_KEY_PEM`（`\n` 转义）；`kid` 也可从 `TALEKILN_PLUGIN_SIGNING_KID` 读。签完会自检（清单仍合法、签名结构正确），再用 `verifySignature` + JWKS 复验一次更稳妥。

### 2.3 官方流程（云端注册表签名，唯一的官方签名途径）

官方插件签名私钥只在云端服务器上（`PLUGIN_SIGNING_PRIVATE_KEY_PEM`，kid `plg-1`；与许可证密钥分开，服务器没配时退回许可证密钥并告警），不分发给任何人。后台有「插件审核」页（`/plugins`）做下面每一步，接口也可以直接调：

1. 作者在本地跑 `--inspect`，把输出 JSON（含 `manifest`、`fileHashes`）、包的下载地址（https）与包文件 `sha256` 交给运营。
2. 运营（OPERATOR 及以上）在「插件审核」→「登记新版本」粘贴 `--inspect` 输出（`POST /admin/plugins`）→ 版本进入 `pending`。
3. 审核员按 `packageUrl` 下载包、核对 `sha256`，解包后跑 `--inspect`，比对指纹与详情抽屉里的 `hash` 一致，再看代码；「通过」/「驳回」并写备注（`POST /admin/plugins/:id/approve` / `reject`）。
4. ADMIN 在详情抽屉点「官方签名（plg-1）」（`POST /admin/plugins/:id/sign`）：签名在服务器上完成，返回 `signedManifest` 与 `kid`；抽屉提供「复制已签名清单」/「下载 manifest.json」。页顶横幅（`GET /admin/plugins/signing-key`，仅 ADMIN）显示当前 kid、是否独立密钥、退役 kid。
5. 作者把 `signedManifest` 原样写回包里的 `manifest.json`（签名不覆盖 `manifest.json`，所以这一步不会让签名失效），重新打包分发。
6. 已通过的版本出现在公开的 `GET /plugins/catalog`（`kid` 为插件签名 kid），带 `signedManifest`、`hash`、`reviewedAt`。本地启动时会拉一次目录，把 `reviewedAt` 写到对应指纹的插件上（插件页"审核日期"）。

云端**不下载也不执行**插件包；第 3 步的核对是人工动作，没有这一步签名就等于只认登记的人。密钥的生成、备份、轮换见 `docs/tencent-deploy.md` 第 7 节；轮换后旧 kid 签的版本在后台标成「旧密钥」，可用新钥重签。

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
| POST | `/admin/plugins/:id/sign` | `plugins:sign`（仅 ADMIN） | 用插件签名私钥（`PLUGIN_SIGNING_PRIVATE_KEY_PEM`）签 approved 的版本；同一 `kid` 不重复签（换钥后可重签）；返回 `signedManifest`、`signature`、`kid` |
| GET | `/admin/plugins/signing-key` | `plugins:sign`（仅 ADMIN） | `{ kid, alg:'ES256', dedicated, licenceKid, retiredKids, jwksPath }`：当前插件签名 kid、是否配置了独立密钥、退役 kid。没有任何私钥材料 |
| GET | `/.well-known/licence-jwks.json` | 公开 | 许可证公钥 + 插件签名公钥 + 退役的插件签名公钥（kid 互不相同，`use: sig`，`alg: ES256`，无 `d`） |

服务器配置（`packages/cloud/.env.example`、`docker-compose.yml`）：`PLUGIN_SIGNING_PRIVATE_KEY_PEM`（PKCS8，P-256）、`PLUGIN_SIGNING_KEY_ID`（默认 `plg-1`，不能与 `LICENCE_KEY_ID` 相同）、`PLUGIN_SIGNING_RETIRED_PUBLIC_KEYS_PEM`（多把 SPKI 公钥用 `;` 分隔）+ `PLUGIN_SIGNING_RETIRED_KEY_IDS`（逗号分隔、顺序对应；只接受公钥，填私钥拒绝启动）。解析在 `services/config.ts`，JWKS 组装在 `services/signing-keys.ts`。

所有写操作经 `AuditInterceptor` 自动审计（含越权尝试）。表：`Plugin(name 唯一)`、`PluginVersion(manifest, fileHashes, hash, packageUrl, sha256, signature, reviewStatus pending|approved|rejected, reviewedAt/By, signedAt/By)`、`PluginReview(action submit|approve|reject|sign, notes)`，迁移 `20261005000000_plugin_registry`（纯新增）。云端镜像不含 SDK，清单规则与签名载荷在 `services/plugin-registry.service.ts`、`services/plugin-signing.ts` 复刻，测试用相对路径加载 SDK 做交叉校验。

### 4.3 SDK 新增

`manifest.files?`、`manifest.signature?`；`readPluginManifest(dir)`（只读清单不执行代码）；`signing.js`：`canonicalJson, listPluginFiles, hashFiles, signingPayload, payloadHash, signManifest, verifySignature, resolveKey`（只用 `node:crypto`；`keys` 可以是 JWKS、JWK 数组、单个 JWK、公钥对象/PEM 或 `(kid) => key` 函数）；`scripts/sign-plugin.mjs`；类型在 `index.d.ts`。

### 4.4 后台「插件审核」页（`apps/admin`，`/plugins`）

路由权限 `read`（只读角色能看、不能点）；按状态筛选（待审核/已通过/已驳回）；详情抽屉有 manifest（美化 JSON）、文件哈希表、指纹、包地址、sha256、签名 kid、审核记录；动作按钮按角色与状态机禁用并给出原因：通过/驳回（`plugins:review`，弹窗填备注）、官方签名（`plugins:sign`，按钮上带当前 kid）；签名后「复制已签名清单」/「下载 manifest.json」。「登记新版本」粘贴 `--inspect` 整段输出 + 包地址 + sha256。页顶横幅显示签名密钥状态（独立 / 暂用许可证密钥 / 退役 kid）。纯逻辑在 `src/plugins.js`（`test/plugins.test.js`），审计动作文案在 `src/ops.js`，菜单项在模板市场旁边。

### 4.5 插件页（`/settings/plugins`）

一张表：内置服务商（`GET /providers`，隐藏的一期服务商不会出现）+ 已安装插件；每行有版本、能力、访问主机、指纹、审核日期、签名标签（官方内置 / 官方签名 / 未签名 / 签名无效）、开关和状态文案；详情抽屉列能力、权限、签名密钥、包指纹、审核日期、安装目录；页头链接 SDK 文档（`VITE_PLUGIN_SDK_DOCS_URL`，缺省指向公开仓库里的 SDK 说明）和「从文件夹安装」（输入完整路径——桌面端目前没有给渲染进程暴露系统文件夹选择框）；页脚是社区插件维护责任说明；开发者模式开关在页顶。内置服务商的开关固定为开且不可动（开关由安装包的 `config.yaml` 决定）。命令面板：「插件与服务商」。纯逻辑在 `utils/pluginsView.js`。

## 5. 没有验证的

- 真实桌面端上的插件页交互、`ElMessageBox.prompt` 的路径输入体验，以及 Windows 路径（带反斜杠、盘符）从输入框到 `fs.cpSync` 的全链路；测试只跑了 Linux 临时目录。
- 云端 Prisma 仓储（`plugins` 那组）与迁移 SQL 没有在真实 PostgreSQL 上跑过；`prisma validate` 通过，CI 的 `cloud-pg` 任务会做 `migrate deploy` + `migrate diff` + 全量测试。
- 真实厂商插件（可灵、Vidu、MiniMax）一个都没写；测试夹具是 SDK 示例的独立拷贝（虚构的 `api.acme.example`）。
- 后台「插件审核」页只过了 `vite build` 和纯函数单测，没有在真实浏览器里点过（抽屉、弹窗备注、复制/下载）。
- 独立的插件签名密钥还没在真实服务器上生成和配置过；`docs/tencent-deploy.md` 第 7 节的命令只在本地 shell 里核对过语法。谁持有离线备份与口令、是否定期轮换、审核员名单仍待 Jay 决定。
- 插件在进程内运行、没有沙箱，这一点没有变化。

## 6. 怎么测

```bash
pnpm --filter ./packages/plugin-sdk test     # 签名/验签/CLI（密钥每次运行临时生成）
pnpm --filter ./packages/local test          # test/plugins.test.js：扫描、信任规则、开发者模式、安装/删除、队列接入、目录同步、多把 JWKS 公钥（插件 kid / 退役 kid / 许可证 kid）
pnpm --filter ./packages/cloud test          # test/plugin-registry.test.ts：校验、角色、状态机、审计、签名被 SDK 用 JWKS 验过
                                             # test/plugin-signing-key.test.ts：独立密钥/回退/退役公钥配置、JWKS 三把公钥、signing-key 门禁、旧 kid 仍可验、换钥重签
pnpm --filter ./apps/renderer test           # test/pluginsView.test.js
pnpm --filter @talekiln/admin test           # test/plugins.test.js：后台「插件审核」页纯逻辑、api 路径、门禁、审计文案
```

手工：把 `packages/local/test/fixtures/plugins/acme` 拷一份，用临时密钥 `--kid dev-1` 签名；本地服务 `global_settings.cloud.jwks` 里放对应公钥的 JWKS（或配置云端地址让它去拉）；在插件页「从文件夹安装」，应显示「官方签名」并可开关；改一个文件再重启，应变成「签名无效」且不加载；打开开发者模式后才能启用。所有测试都不联网，不写任何密钥文件到仓库。
