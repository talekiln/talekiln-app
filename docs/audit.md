# 代码审计（A02）

审计对象：`claude/phase1-foundation` 上的 LocalMiniDrama 分叉代码（约 2.4 万行后端服务 + 1.6 万行前端视图）。日期 2026-10-01。

## 1. 模块结构

### packages/local（Express + better-sqlite3，CommonJS）

| 目录 | 内容 | 备注 |
|---|---|---|
| `src/server.js` / `app.js` | 启动、令牌校验、CORS、静态资源 | 已加本地令牌；仍保留 `insecure_tls` |
| `src/config` | 读 `configs/config.yaml` | 配置与业务耦合（风格预设、图床等混在一起） |
| `src/db` | `index.js` 打开库，`migrate.js`（540 行）执行 `migrations/01..22.sql` 并用 `ALTER TABLE` 补列 | 迁移器可用，但"补列"逻辑与 SQL 迁移并存 |
| `src/routes` | 约 24 个路由文件，`/api/v1` | 薄层，直接调 service |
| `src/services` | 约 55 个文件，业务与供应商调用混杂 | 见下 |
| `src/utils`、`constants` | 工具、风格预设 | 可复用 |
| `test/` | 13 个 `node --test` 用例，多为供应商协议细节 | 覆盖面窄，无路由或 DB 层测试 |

services 分层（按职责）：
- 供应商调用层：`aiClient`（文本/视觉，717 行）、`imageClient`（1958 行）、`videoClient`（4653 行）、`ttsService`（173 行）、`klingJwt`、`modelArkAssetProxyService`、`jimengMaterialHubService`。
- 配置：`aiConfigService`（含 `ai_service_configs` 增删改、连通性测试、厂商锁定）、`settingsService`、`deepseekConfig`、`promptOverridesService`。
- 业务流水线：`storyGenerationService`、`episodeStoryboardService`、`storyboardService`、`framePromptService`、`characterGenerationService`、`imageService`、`videoService`、`videoMergeService`（ffmpeg）、`taskService`（异步任务）。
- 资产库：`character/scene/propLibraryService`、`assetService`、`uploadService`（含第三方图床上传）。
- 提示词：`promptI18n`（1620 行）、`universalSegment*`、`generationStylePresets`。

### apps/renderer（Vue 3 + Vite + Element Plus + Pinia + Vue Flow，JS，无 TypeScript）

- `views/`：`FilmCreate.vue` 10791 行（单文件巨型组件）、`DramaDetail` 1520、`FilmList` 1326、`DramaCanvas` 1145、`FreeCreate`、`MediaLibrary`、`AiConfig`。
- `components/`：`dramaCanvas/*`（Vue Flow 画布节点与面板）、`AIConfigContent`、`SceneModelMap`、`PromptEditor` 等。
- `api/`：16 个 axios 封装，与后端路由一一对应。
- `stores/`：`film.js`、`generationTaskStore.js`（657 行，任务轮询）。仅 2 个 store，大量状态仍在视图内。
- 无测试、无 lint 配置。

### apps/desktop（Electron 39）

`main.js` 153 行：生成每次启动令牌，起本地服务到 127.0.0.1，窗口 `sandbox + contextIsolation`，外链白名单。无 preload、无 IPC、无 `safeStorage`，尚未启用 Fuses。

## 2. 数据库表（SQLite，22 个迁移）

- 创作主链：`dramas` → `episodes` → `storyboards`；`characters`、`episode_characters`、`scenes`、`props`、`storyboard_props`、`frame_prompts`。
- 生成记录：`image_generations`、`video_generations`、`video_merges`、`async_tasks`、`image_proxy_cache`。
- 资产库：`character_libraries`、`scene_libraries`、`prop_libraries`、`assets`。
- 配置：`ai_service_configs`（含明文 `api_key`）、`ai_model_map`（场景到模型映射）、`prompt_overrides`、`global_settings`。
- 问题：表名与概念为"短剧"（drama/episode），与 Talekiln 的"故事→分镜→镜头→成片"需重新映射；字段含 Seedance2、即梦素材中心等供应商专有列；大量 `TEXT` 存 JSON，无外键约束说明；`deleted_at` 软删散落各表。

## 3. 供应商调用层

- **共性**：均为函数式模块，签名 `(db, log, opts)`，在函数内部直接 `getDefaultConfig(db, …)` 读库再拼 HTTP，**配置读取、协议适配、重试轮询、图床中转、落盘混在同一函数**。
- `aiClient`：OpenAI 兼容 chat 为主（普通 / 流式 / 视觉），自带 `postJSON*` 三套 HTTP 实现（原生 `https`），有拒答检测。结构相对清晰。
- `imageClient`：按 `inferProtocol(provider, model)` 分派到 DashScope（通义万相 / qwen-image）、火山 Seedream、Gemini / NanoBanana、可灵、Agnes、OpenAI 兼容；含尺寸换算、负向提示词、参考图压缩（sharp）、第三方图床代理缓存。
- `videoClient`：108 个顶层函数，十余家协议（火山 Seedance、可灵 Omni、即梦、MiniMax H3、Agnes、Vidu、Veo/Gemini 等）的创建 + 轮询 + 取结果，4653 行。
- `ttsService`：minimax 与 OpenAI 兼容两路，直接 `writeFileSync` 落盘；调用不存在的 `./cloudService`（`try/catch` 吞掉，死代码）。
- 与一期目标（百炼 + 方舟）的重合：DashScope 图像、火山 Seedream/Seedance、OpenAI 兼容文本（百炼与方舟均提供兼容模式）。其余供应商一期不需要。

## 4. 复用性评估与保留 / 重做 / 重写

| 部分 | 结论 | 理由 |
|---|---|---|
| `aiClient` 文本/流式/视觉 | **保留，小改** | 协议简单；抽出 `config` 注入以去掉对 `db` 的直接依赖 |
| `imageClient` 的 DashScope / Seedream 分支 | **保留并抽取** | 一期核心；尺寸换算与参考图处理有价值，其余分支（Kling/Gemini/Agnes）一期可冻结 |
| `videoClient` | **重做** | 只抽取火山 Seedance 与百炼视频两条；4653 行混合十余家，作为 `providers/` 适配器逐个迁移，旧文件不整体搬 |
| `ttsService` | **重做（缩小）** | 仅留 OpenAI 兼容 / MiniMax 之一，改成纯函数 + 注入配置 |
| `taskService`、`async_tasks` | **保留** | 异步任务与启动时孤儿任务清理机制合理 |
| `videoMergeService`（ffmpeg） | **保留，评估许可** | 见 `licenses.md` 的 ffmpeg 一项 |
| `db/migrate.js` + SQL 迁移 | **保留**，新表加新迁移，不改旧文件 | 需删除"ALTER 补列"与迁移并存的重复路径 |
| `routes/*` | **保留结构**，逐个核查输入校验 | 目前几乎无参数校验，错误信息直接回传 |
| `promptI18n` 及风格预设 | **保留数据，重写组织方式** | 1620 行内联字符串，应拆成资源文件 |
| 业务流水线（storyGeneration、episodeStoryboard 等） | **重写** | 与"短剧"模型强耦合，需按 Talekiln 的故事→分镜→镜头→成片重建，旧逻辑当参考 |
| `jimengMaterialHub`、`modelArkAssetProxy`、`klingJwt`、`uploadService` 图床 | **冻结 / 移除** | 一期不用；图床把用户图片上传到第三方域名，存在隐私问题 |
| 前端 `FilmCreate.vue`（10791 行） | **重写** | 无法维护与测试，按步骤拆成组件与 store |
| 前端 `DramaCanvas` + `dramaCanvas/*` | **保留，后评估** | Vue Flow 画布可复用，但依赖旧数据模型 |
| 前端 `api/*`、`AIConfig*` | **保留**，改 key 的展示与提交方式 | |
| 前端 stores / 构建配置 | **保留**，补 ESLint、Vitest | |
| 桌面 `main.js` | **保留**，扩充 | 令牌与沙箱已就位 |

## 5. 一期必改清单

| # | 项 | 现状 | 处理 |
|---|---|---|---|
| 1 | **API Key 明文存 SQLite** | `ai_service_configs.api_key` 明文；`aiConfigService.listConfigs` 将 `api_key` 原样返回前端；`bulkUpdateApiKey`、厂商锁定刷新逻辑都依赖读回明文 | 主进程用 Electron `safeStorage`（Windows DPAPI）加密，库内只存密文或引用 id；本地服务经主进程注入的函数取 key；对前端只返回掩码；迁移时把旧明文加密并清空旧列；`safeStorage` 不可用时拒绝保存而不是降级明文 |
| 2 | **日志泄露 Key** | `ttsService` 用 `console.log` 打印 `api_key`（已在本次提交删除）。`jimengMaterialHubService` 日志含 key 长度 | 统一用日志脱敏器；全仓 grep `api_key` 日志 |
| 3 | **Edge TTS** | 代码中无实际实现，仅文件头注释提及（已改）；调用不存在的 `cloudService` | 一期不使用 Edge TTS（非官方接口）；删除 `cloudService` 死引用；前端 TTS 选项里如有 edge 项需同步去掉 |
| 4 | **`insecure_tls`** | `server.js` 读 `server.insecure_tls`，开启后设 `NODE_TLS_REJECT_UNAUTHORIZED=0`，全进程关闭证书校验 | 删除该开关与读取逻辑；默认值虽为 false，但配置文件可被用户改，发布版不应保留 |
| 5 | **CORS** | `cors_origins` 默认 `http://localhost:3012`，与实际 `127.0.0.1:随机端口` 不符；令牌中间件在 CORS 之前，预检请求（OPTIONS）会被 401 | 桌面环境同源加载，直接移除 CORS；开发模式靠 Vite 代理；令牌校验保留 |
| 6 | **本地服务暴露面** | 令牌仅在设了环境变量时校验，纯开发模式无校验；`/static` 为静态目录（已在令牌之后，但 `<img>` 请求靠主进程注入头） | 发布构建强制要求令牌，缺失则启动失败 |
| 7 | **第三方图床** | `uploadService` 把用户图片上传到 `imageproxy.zhongzhuan.chat`；`videoClient` 针对该域名有分支 | 一期默认关闭，改用供应商自己的文件上传或 base64；需用户明确同意才可外传 |
| 8 | **输入校验与错误回传** | 路由无 schema 校验；全局错误处理把 `err.message` 直接回给前端 | 引入 zod 或 ajv 校验；错误对外统一码 + 通用信息，细节仅写日志 |
| 9 | **文件上传** | `multer 1.x`，限制 16MB，未见 MIME 白名单 | 升 multer 2.x（1.x 已有已知漏洞公告），加类型与扩展名白名单 |
| 10 | **Electron 加固未完** | Fuses 未做；无 preload / IPC 白名单；webSecurity 默认 | 补 Fuses（关 RunAsNode 等）、最小 preload（key 存取 IPC）、`will-navigate` 限制 |
| 11 | **品牌与许可** | 配置里仍有 `LocalMiniDrama`、`vendor_lock` 厂商锁定（`ai-configs-qudao.json`）、"sxy" 注释、`console.log('webDist')` | 清理；vendor_lock 为上游渠道商定制，一期删除 |
| 12 | **测试与 CI** | 13 个供应商协议测试；前端 0 测试；无 lint | 补 DB 迁移、任务状态机、key 加解密测试；加入 `pnpm licenses:check` 到 CI |
| 13 | **依赖** | `sharp` 的 LGPL libvips、ffmpeg 许可待定 | 见 `docs/licenses.md` |

## 6. 建议顺序

1. 1、2、4、5 先做（改动小、风险高）。
2. 再抽 `providers/` 接口：`{ text, image, video, tts }` 适配器 + 注入配置，先迁百炼与方舟两家。
3. 以新数据模型重建流水线与前端步骤页，旧 `FilmCreate.vue` 在迁完前保持只读参考。
