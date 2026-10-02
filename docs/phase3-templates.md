# 三期 P3-T：模板市场

状态：本地服务（模板包格式、安装与验签、逐镜估价、一键套用）、云端模板模块（版本、签名、公开目录、后台接口）、后台页面、渲染进程「模板市场」页与单元测试已完成；八个官方短剧包的文案已填充（§1.1 文案规范）。**界面没有在真实浏览器里点过**（只做了 `vite build` 通过和纯函数 / 接口调用单测）。本文不含任何密钥或真实地址。

## 1. 模板包格式

一个模板包是一个目录（含 `manifest.json`）或一个 zip 压缩包（后缀 `.lytpl` 或 `.zip`，`manifest.json` 在根目录或唯一的一级子目录里）。安装时只读清单，包里的其它文件（封面等）暂不解压，`cover` 字段按 URL 字符串保存。

```jsonc
{
  "id": "official-guofeng-drama",      // 2–64 位小写字母、数字、点、下划线或连字符；安装后作为主键
  "name": "国风短剧 · 错嫁",
  "version": "1.0.0",                   // x.y.z
  "genre": "guofeng",                   // 分组用；界面已知 guofeng / ecommerce / knowledge 等的中文名，其余原样显示
  "tier": "free",                       // free | pro（pro 需要付费权益，见 §3.4）
  "description": "……",
  "cover": null,                        // 可选，URL 字符串
  "music_hint": "古筝与箫的慢板……",      // 可选，写进项目 metadata.music_hint
  "style": { "name": "古风写实", "prompt": "……", "preset": "historical", "aspect_ratio": "9:16" },
  "character_slots": [                  // 最多 12 个；id 不能用保留字 scene / style
    { "id": "heroine", "name": "沈清辞", "role": "女主", "description": "……", "appearance": "……" }
  ],
  "shots": [                            // 1–60 个
    {
      "title": "红绸落雨",
      "group": "开场",                  // 可选：同名镜头归入同一段落（内核 group）；没有则整集一个段落（名为模板名）
      "duration_ms": 5000,              // 正整数毫秒
      "prompt_template": "{{scene}}，{{heroine}}身着嫁衣立在檐下",   // 占位符：{{槽位id}} / {{scene}} / {{style}}
      "character_slots": ["heroine"],   // 用到的槽位，必须覆盖提示词里出现的槽位占位符
      "scene_slot": "沈府后院，黄昏小雨", // 可选：替换 {{scene}}，并写进镜头 location
      "camera": "全景缓推",             // 可选：写进 shot_type，并作为视频提示词前缀
      "lines": [                        // 可选：台词行，kind = narration | dialogue | action，speaker 为槽位 id
        { "kind": "narration", "text": "那年春雨，她替姐姐嫁进了顾府。" }
      ]
    }
  ],
  "signature": "<ES256 紧凑 JWS，可选>"  // 云端下发的清单才有；自制模板不要带
}
```

校验规则在 `packages/local/src/templates/schema.js`（`validateManifest`，返回中文错误清单）与云端 `packages/cloud/src/services/template.service.ts`（zod 版本）各实现一份，测试里用同一批内置模板互相校验。

「套用后会得到」由 `summaryOf(manifest)` 从清单推出：镜头数与总时长、段落、角色槽位（含每个槽位被几个镜头用到）、风格、台词行数、配乐提示、运镜集合；不需要数据库。

内置官方模板在 `packages/local/templates/<id>/manifest.json`，共 11 个（8 个竖屏短剧 + 3 个非剧情类）；`genre` 的中文名在渲染进程 `utils/templateMarket.js` 的 `GENRE_LABEL`，后台页按原值显示：

| id | 名称 | 类型（中文名） | 档位 | 镜头 |
| --- | --- | --- | --- | --- |
| `official-urban-sweet-contract` | 都市甜宠 · 契约婚姻 | urban-sweet（都市甜宠） | free | 10 镜 54 秒，4 个槽位，段落 开场 / 契约 / 误会 / 钩子 |
| `official-revenge-god-of-war` | 逆袭打脸 · 战神归来 | revenge（逆袭打脸） | **pro** | 12 镜 65 秒，4 个槽位，段落 归来 / 羞辱 / 亮身份 / 钩子 |
| `official-suspense-seventh-visitor` | 悬疑反转 · 第七个访客 | suspense（悬疑反转） | **pro** | 11 镜 59 秒，4 个槽位，段落 开场 / 调查 / 反转 / 钩子 |
| `official-rebirth-noble-daughter` | 穿越重生 · 嫡女归来 | rebirth（穿越重生） | free | 10 镜 55 秒，4 个槽位，段落 重生 / 试探 / 反击 / 钩子 |
| `official-campus-evening-study` | 校园青春 · 第三十八张画 | campus（校园青春） | free | 9 镜 48 秒，3 个槽位，段落 开场 / 靠近 / 波澜 / 钩子 |
| `official-family-bowl-of-soup` | 家庭伦理 · 一碗热汤 | family（家庭伦理） | free | 10 镜 53 秒，4 个槽位，段落 开场 / 冲突 / 和解 / 钩子 |
| `official-workplace-second-day` | 职场逆袭 · 被开除的第二天 | workplace（职场逆袭） | free | 10 镜 54 秒，4 个槽位，段落 开场 / 低谷 / 反击 / 钩子 |
| `official-healing-corgi-days` | 萌宠治愈 · 包子的一天 | healing（萌宠治愈） | free | 9 镜 46 秒，3 个槽位，段落 清晨 / 日常 / 低谷 / 治愈 |
| `official-guofeng-drama` | 国风短剧 · 错嫁 | guofeng（国风短剧） | free | 8 镜 45 秒，3 个槽位，段落 开场 / 冲突 / 反转 |
| `official-product-seeding` | 产品种草 · 30 秒 | ecommerce（产品种草） | free | 6 镜 30 秒，1 个槽位 |
| `official-knowledge-explainer` | 知识讲解 · 一分钟看懂 | knowledge（知识讲解） | **pro** | 7 镜 44 秒，1 个槽位 |

三个 pro 包是付费权益的示例（§3.4）；其中 `revenge` 与 `suspense` 是八个短剧包里篇幅最长、段落最完整的两个。`test/templates.test.js` 按目录枚举内置包并断言：全部通过校验、6–14 镜、总时长 30–90 秒、每条提示词含中文、`style.preset` 在 `generationStylePresets` 的取值表里、每个槽位至少被一个镜头用到且镜头声明的槽位都出现在提示词里、每句台词的 `speaker` 在该镜头的槽位里、free 与 pro 都有；云端 `test/templates.test.ts` 用同一批包跑 zod 校验与摘要互验。

### 1.1 文案规范（官方短剧包）

八个短剧包按下面的规矩写，自制模板照着来就能在模板市场里「看起来像官方的」：

- **黄金三秒**：第 1 镜必须是钩子，不铺垫。要么一句反差台词（「嫁给我，你的债今晚清零。」），要么一句把前情说完的旁白加一个动作（「五年前，他被扫地出门……」+「回家。」），要么一个悬念物件（监控定格、保温桶）。第 1 镜 4–5 秒，台词不超过两句。
- **段落**：用 `group` 分 3–4 段，段名用两个字的短剧行话：开场 / 冲突 / 反转 / 钩子，或按剧种换成 归来 / 羞辱 / 亮身份、重生 / 试探 / 反击、低谷 / 和解 等。同一段的镜头写在一起；最后一段固定叫「钩子」（治愈类可叫「治愈」），且最后一镜必须停在一句悬念上（一条短信、一句反转台词、一只伸出纸箱的猫）。
- **镜头长度**：8–12 镜，每镜 4–7 秒，整集 45–70 秒；有两句以上对白的镜头给 6 秒，纯画面或一句旁白给 5 秒。
- **台词**：`dialogue` 一句话一行，短、硬、有反问或反差（「契约没写我要做饭。」「也没写你可以烧厨房。」），不写长句解释；`narration` 负责交代时间跨度与心理（「她以为，这只是一场谁也不吃亏的交易。」）；屏幕上的文字（短信、群消息、纸条、账本）写成 `action` 行并以「短信：」「纸条上写着：」开头，不要用没在画面里的人当 speaker。每个有 `dialogue` 的镜头，其 `speaker` 必须出现在该镜头的 `character_slots` 里（否则套用后该镜头的参考图不包含说话的人）。
- **角色槽位**：2–4 个，`name` 是可直接用的剧中名，`role` 用 女主 / 男主 / 反派 / 女配 / 特助 这类一眼能懂的词，`description` 一句话写人设与动机。`appearance` 是**图像提示词素材**，不是小说描写：按「年龄性别 + 脸部特征 + 发型 + 服装 + 一件辨识物件」写，例如「二十九岁男性，眉骨高挺，薄唇，黑色短发一丝不苟，深灰三件套西装，袖口银质袖扣，左腕一块黑色机械表」；辨识物件（红绳、硬币、创可贴、核桃、缺耳朵的布兔子）要在剧情里用到，方便跨镜一致。
- **提示词模板**：每镜以 `{{scene}}` 开头，再写槽位的位置、动作、表情与关键物件，一镜只写一个动作；`scene_slot` 写具体的「地点 + 时间 + 光」（「老式公寓楼道，暴雨夜，墙皮斑驳」）；`camera` 用国内分镜习惯用语（全景缓推、中景过肩、近景正反打、特写慢动作、跟拍侧移、俯拍、手持晃动、低机位仰拍、镜面反打）。
- **风格**：`style.preset` 必须是 `generationStylePresets.js` 里的取值；`style.prompt` 写电影化的布光、镜头、色调（「35mm 镜头浅景深，夜景以城市霓虹与暖色室内光对比，高级灰加琥珀色调」），不重复 preset 已经包含的词；`aspect_ratio` 一律 `9:16`；`music_hint` 写乐器、情绪与转折点（「门开那一刻鼓点全开，结尾戛然而止」）。
- **边界**：不出现真实品牌、真实人物与可对号入座的机构；暴力停留在电视剧尺度（泼酒、下跪、推搡，不见血）；没有成人内容；不引用受版权保护的歌词或台词。`description` 用一两句话告诉创作者「套用后得到什么、适合什么账号」。

本地服务每次启动把它们按磁盘内容重写进 `installed_templates`（`source = 'builtin'`、`signature_status = 'official'`，保留 `use_count`）；磁盘上不存在的内置行会被删掉。内置模板不能被覆盖或删除（409 `TEMPLATE_BUILTIN_READONLY`）。

## 2. 签名

- 摘要：`sha256(canonicalJson(清单去掉 signature 字段))`，`canonicalJson` 与模型目录签名共用（键排序、跳过 undefined）。签名载荷是字符串 `'tpl-' + 摘要十六进制`。
- 云端新增版本时用许可证 / 目录同一把私钥做 ES256 紧凑 JWS，header 带 `kid`；公开目录把 `signature` 嵌进清单下发，另附 `sha256`、`kid`。
- 本地安装时：
  - 没有 `signature` → `unsigned`。
  - 有 `signature` → 解析 header 的 `kid`，先查本地缓存的 JWKS（`global_settings` 的 `cloud.jwks`），没有且已配置云端则联网取 `/.well-known/licence-jwks.json`；拿到公钥后验签，且载荷必须等于本地算出的摘要 → `official`。
  - 签名错误、内容被改、别的密钥冒充、云端不认识的 `kid`、签名格式不对 → **拒绝安装**（400 `TEMPLATE_SIGNATURE_INVALID`）。
  - 取不到公钥（离线且没有缓存、云端未配置）→ 按 `unsigned` 安装（返回 `signature.reason = 'key_unavailable'`），之后重新安装同一清单可升级为 `official`。不会在无法验证时把模板标成官方。
- `signature_status` 取值：`official` / `unsigned`；`invalid` 保留给界面文案，本地不会落库（无效签名直接拒绝）。

## 3. 本地服务（packages/local）

### 3.1 表与模块

迁移 `31_installed_templates.sql`：

```sql
installed_templates (id TEXT PK, source 'builtin'|'cloud'|'local', version, manifest JSON 文本,
                     signature_status 'official'|'unsigned', installed_at, use_count INTEGER)
```

`src/templates/`：

| 文件 | 内容 |
| --- | --- |
| `schema.js` | `validateManifest`、`summaryOf`、`templateDigest`、`renderPrompt`（占位符替换） |
| `package.js` | `loadPackage(path)`：目录 / `manifest.json` / `.lytpl` zip（adm-zip）→ 清单；清单上限 2MB |
| `entitlement.js` | `isPro(status)` / `proReason(status)`：付费权益判断（§3.4） |
| `service.js` | `createTemplateService({ db, spend, cloud, listConfigs, catalogModels, builtinDir, getAccountStatus })` |
| `errors.js` | `TemplateError(code, message, status, details)` |

`app.js` 创建服务并经 `extras.templates` 交给路由；`routes/index.js` 末尾的 `// P3-T` 块挂载 `routes/templates.js`。

### 3.2 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/templates` | `{ items: [{ id, name, version, genre, tier, description, cover, music_hint, style, source, signature_status, installed_at, use_count, summary }], pro_available, pro_reason }` |
| GET | `/templates/cloud` | 云端目录（`items[]` 含 `manifest`、`sha256`、`kid`、`installed`、`installed_version`）；未配置云端 503 `CLOUD_NOT_CONFIGURED`，离线 503 `CLOUD_UNREACHABLE` |
| POST | `/templates/install` | `{ path }`（目录或 .lytpl）或 `{ manifest, source: 'cloud' \| 'local' }` → 201，返回模板视图 + `signature: { status, reason, kid }` + `replaced` |
| GET | `/templates/:id` | 视图 + 完整 `manifest` |
| POST | `/templates/:id/estimate` | 逐镜估价（§3.3） |
| POST | `/templates/:id/apply` | `{ mode: 'new' \| 'episode', drama_id?, title?, character_map: { 槽位: 角色id }, tx_id? }` → 201（§3.5） |
| DELETE | `/templates/:id` | 删除已安装模板；内置 409 |

新增错误码（`errors/error-codes.json`，均为 `local` 域）：`TEMPLATE_INVALID`（400）、`TEMPLATE_PACKAGE_INVALID`（400）、`TEMPLATE_SIGNATURE_INVALID`（400）、`TEMPLATE_PRO_REQUIRED`（403）、`TEMPLATE_BUILTIN_READONLY`（409），以及之前只在云端路由映射里用到、此次补进表的 `CLOUD_UNREACHABLE`、`CLOUD_NOT_CONFIGURED`。

### 3.3 估价

对每个镜头生成两条花费规格：一张图（`kind: 'image'`，有角色槽位按「带参考图」选模型）、一段视频（`kind: 'video'`，按首帧模式选模型，时长 `clamp(round(duration_ms / 1000), 1, 15)` 秒），服务商与模型的选择与生成前估算同一套规则（`generation/models.js` 的 `chooseProvider` / `pickModel`），一次 `spend.checkBatch` 得到每条估算与额度检查。返回：

```jsonc
{ "items": [{ "index", "title", "duration_ms", "seconds", "image": { "provider", "model", "estimate", "max", "known", "basis" }, "video": {…}, "subtotal", "subtotal_max" }],
  "total", "max", "currency", "known", "sample_prices", "provider_ready",
  "check": { "ok", "reason", "message", "total", "max", "cap" } }
```

验收点「估价等于逐镜估价之和」：`total` 就是 `items[].subtotal` 之和，测试同时断言它等于 `spend.checkBatch` 的合计、以及逐条调用 `spend.estimate` 的合计。没有可用 Key 时仍给出估算（`provider_ready: false`），套用本身不计费。

### 3.4 付费模板（pro）

`entitlement.isPro(status)` 读 `account.status()` 的返回：已登录、许可证 `valid` 或 `grace`、套餐不是 `free`、`sub_end` 为空或在未来；或许可证权益含 `templates:pro`。为此 `cloud/account.js` 的 `licenceView` 新增两个字段：`sub_end`（许可证 claims 的 `subEnd`，unix 秒 → ISO，空 = 不限期）与 `limits`（原样透传）。此前本地没有任何地方读过这两个 claims。

`GET /templates` 附带 `pro_available` / `pro_reason`（中文原因：未登录、许可证过期、订阅到期、套餐不含）；套用 pro 模板不满足条件时 403 `TEMPLATE_PRO_REQUIRED`。免费模板不受账号状态影响，离线可用。

### 3.5 一键套用

全部写入在一个 SQLite 事务里，任一步失败不留半成品：

1. `mode: 'new'`：`dramaService.createDrama`（标题 = `title` 或模板名，`genre`、`style = style.preset`，`metadata` 记录模板 id / 版本、`music_hint`、风格），建第 1 集；`mode: 'episode'`：`drama_id` 必填，集数 = 现有最大集数 + 1。
2. 角色槽位：`character_map` 里映射到的角色——续集模式必须属于该项目，直接沿用；新项目模式把角色行克隆进新项目（含外观、参考图路径等列）并**复制锁定参考图**（`reference_locks`）。没映射的槽位按清单的名字 / 描述 / 外观新建占位角色。所有角色写入 `episode_characters`。
3. `legacy.importLegacy` 得到只有合成节点的空图，然后 **一个内核事务**（`store.commit`，`tx_id = tpl-<id>-<uuid>`）里：按 `group` 建段落（`addGroup`）、按顺序 `insertLine`（speaker 换成角色名）与 `addShot`（`title`、`description` = 渲染后的提示词、`image_prompt` = 提示词（槽位替换成「名字（外观）」）+ 风格提示词、`video_prompt` = 运镜 + 提示词、`shot_type`、`location`、`characters` = 角色 id、`duration_ms`），再 `setShotReferences` 写入锁定参考图哈希（与 `kernel/inputs.js` 同一规则：按镜头顺序去重、最多 4 张、`sha256('ref:' + url)`），所以之后生成前的输入同步不会再产生变化。`addShot` 同时给合成节点加片段，提交后 `kernel.validateGraph` 通过，旧表（storyboards / timelines）由物化写出。
4. `use_count + 1`，更新项目的 `total_episodes`。

返回 `{ template_id, template_version, mode, tx_id, drama_id, episode_id, episode_number, title, characters: [{ slot, character_id, name, mapped, cloned_from, locked }], shots, shot_ids, storyboard_ids, groups, use_count }`。

## 4. 云端（packages/cloud）

迁移 `20261005000000_templates`，两张表：

| 表 | 字段 |
| --- | --- |
| `Template` | `id`（即清单 id）、`name`、`genre`、`tier`、`description`、时间戳 |
| `TemplateVersion` | `templateId`（级联删除）、`version`、`manifest` JSONB、`packageUrl`、`sha256`、`signature`、`kid`、`tier`、`published`、`publishedAt`、`createdAt`；`(templateId, version)` 唯一 |

`TemplateService`（`services/template.service.ts`）：zod 清单校验（含槽位 / 占位符交叉检查，未知字段与 `signature` 被剥掉）、摘要与签名、模板 CRUD、版本新增 / 发布 / 下架、公开目录（每个模板最近发布的版本）。新增版本时把模板的名字 / 类型 / 档位 / 简介同步成清单里的值。

接口：

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/templates/catalog` | 公开，`Cache-Control: no-store`；`{ items: [{ id, version, tier, sha256, kid, packageUrl, published_at, manifest(含 signature) }], kid, issued_at }` |
| GET | `/admin/templates`、`/admin/templates/:id` | `read` |
| POST | `/admin/templates` `{ id, name, genre, tier?, description? }` | `ops:write`；id 重复 409 |
| PUT | `/admin/templates/:id` | `ops:write` |
| DELETE | `/admin/templates/:id` | `ops:write`，204，级联删版本 |
| POST | `/admin/templates/:id/versions` `{ manifest, packageUrl? }` | `ops:write`；清单不合法 400（中文原因）、id 不一致 400、版本重复 409 |
| POST | `/admin/templates/:id/versions/:vid/publish` / `unpublish` | `ops:write` |

管理接口挂 `AdminGuard`（READONLY 只能读，OPERATOR / ADMIN 可写）与 `AuditInterceptor`（写操作自动审计，越权尝试也记）。`/admin/templates` 的请求体上限单独放宽到 1MB（`http/setup.ts`）。

部署：`pnpm --filter @talekiln/cloud prisma:deploy`（纯新增表）。

## 5. 后台（apps/admin）

新页面「模板市场」（`/templates`，`views/Templates.vue`，权限 `read`）：模板列表（展开看版本）、新建模板、新增版本（粘贴 `manifest.json`，浏览器端先做 JSON / 必填 / id 一致 / 不得自带 signature 的检查，云端做完整校验与签名）、发布 / 下架、删除。纯函数在 `src/templates.js`，审计动作文案加进 `ops.js`。

## 6. 渲染进程（apps/renderer）

- 页面 `/templates`（`views/TemplateMarket.vue`，设计稿 P3-01）：按类型分组的卡片（档位徽标、镜头数与时长、使用次数、官方 / 来源标记），右侧详情：「套用后会得到」、估价（合计 + 逐镜明细 + 额度提示）、镜头列表；「一键套用」对话框：新项目或已有项目的下一集、标题、项目选择、角色槽位映射（下拉列出该项目角色，锁定参考图的排前并标注；留空 = 新建占位角色；重复映射与未知角色即时报错）；「从文件安装」（路径）与「浏览云端模板」（安装 / 更新）。套用成功跳到该集的分镜表。
- 入口：项目列表页头部「模板」按钮；命令面板「模板市场」（`builtinCommands.js` 末尾的 `// P3-T` 块）；路由在 `router/index.js` 末尾的 `// P3-T` 块。
- 纯函数 `utils/templateMarket.js`：分组、标签、时长、「套用后会得到」文案、估价文案、`canApply`、角色选项、槽位映射校验、请求体、跳转目标、云端条目状态；`api/templates.js` 封装接口。

## 7. 未经验证的部分

- 界面（渲染进程「模板市场」页、后台「模板市场」页）只通过 `vite build` 与纯函数单测，没有在真实浏览器里操作过。
- Prisma 实现（`prisma.repositories.ts` 的 `templates`）只做了类型检查与 `prisma validate`；仓储契约测试在设置 `TEST_DATABASE_URL` 时会跑真实 PostgreSQL，本次没有可用的库。
- 没有针对真实服务商跑过「套用后生成」；估价依赖的价格表仍是示例价。
- 云端下发的 `packageUrl`（zip 下载地址）只是透传，客户端从云端安装时直接用目录里的清单，不下载压缩包。
- 封面图：清单里的 `cover` 只按字符串保存，压缩包里的图片文件不会被解出来。

## 8. 如何测试

```bash
pnpm --filter ./packages/local test      # 含 test/templates.test.js：清单、权益、估价之和、套用（图校验 + 参考图）、安装 / 验签（本地模拟云端）、路由
pnpm --filter ./packages/cloud test      # 含 test/templates.test.ts：清单（与本地摘要互验）、仓储契约、签名可用 JWKS 验证、目录、角色鉴权与审计
pnpm --filter ./apps/renderer test       # 含 test/templateMarket.test.js
pnpm --filter ./apps/admin test          # 含 test/templates.test.js
```

手工验证：启动本地服务后 `GET /api/v1/templates` 应看到十一个内置模板；`POST /api/v1/templates/official-guofeng-drama/apply` 带 `{ "mode": "new" }` 会建一个 8 镜的新项目，再 `GET /api/v1/episodes/<episode_id>/graph` 可看到 3 个段落与每镜的 image / video 节点。
