# 一期进度

| 任务 | 状态 | 说明 |
|---|---|---|
| A01 分叉并打包 | 进行中 | 代码已导入并改成 pnpm 多包；Windows 安装包由 CI 产出，待真机验证 |
| A04 品牌替换 | 部分 | 名称、appId 已换；图标、关于页许可清单未做 |
| A05 多包结构与 CI | 进行中 | desktop / renderer / local 三包；core、cloud 已建；admin 见 H01 |
| A06 Electron 安全基线 | 部分 | 升到 39；sandbox、CSP、外链白名单已做；Fuses 未做 |
| A07 本地服务只听本机 | 已做 | 127.0.0.1 + 每次启动令牌 |
| A02 代码审计 | 已做 | docs/audit.md，13 项必改 |
| A03 许可证扫描 | 已做 | docs/licenses.md，`pnpm licenses:check`；仅 sharp-libvips 为 LGPL |
| A08 lycore 骨架 | 已做（Windows 打包版验证） | 命名管道在 Windows 打包版实测可用（任务 1/4） |
| C01 适配器接口 | 已做 | providers/；服务商开关 `providers.enabled`（config.yaml，默认只开百炼，方舟代码保留但隐藏），见 docs/provider-extension.md |
| C02 百炼适配器 | 部分 | 文本/图像/视频/配音已写，契约测试用模拟数据；CosyVoice 报文、错误码字符串、默认模型名待真 Key 验证 |
| C03 方舟 + 火山语音适配器 | 部分 | 契约测试用模拟数据；默认模型名、Seedance 参数形式、语音地址与鉴权头待真 Key 验证 |
| C04 Key 存系统密钥 | 已做（Windows 打包版验证） | safeStorage 密文落盘，接口只回末 4 位，日志脱敏，旧明文自动迁移；任务 4 在打包版实测：`secrets.enc.json` 只有密文、重启后 Key 仍可用（解密后真的发到了服务商）、日志无明文 |
| E01 任务队列持久化 | 已做 | ai_tasks 状态机、幂等键、崩溃三点测试；未接入现有路由 |
| F02 时间线数据模型 | 已做 | 四轨、校验、从分镜装配、REST 路由；前端编辑器（F03）未做 |
| G01 媒体探测与编码器检测 | 已做（Windows 真机验证） | lycore media.probe / encoder.detect；任务 4 在本机检测到 h264_qsv / h264_mf 可用、nvenc / amf / libx264 不可用，推荐 qsv 并以之导出成功；第二轮把固定版 LGPL ffmpeg 自带的 libopenh264 加进候选表（软件编码，排 libx264 之后），没有硬件编码器时回退到它而不是只剩 h264_mf |
| F03 时间线编辑器首版 | 部分 | 四轨、拖拽、吸附、切分、预览；缺波形、缩略图、旁白/音乐播放 |
| D02 分镜模板 / F01 配音字幕 / C05 连通测试 | 已做（联网会话） | PR #2、#3 已合入 |
| D01 新建项目 / D03 分镜表 | 已做（未在浏览器打开） | 同步生成，无进度流 |
| E02 队列工作器 | 已做 | 限并发、429 退避、断点下载、sha256 入库；尚未接入真实适配器 |
| E03 唤醒对账/托盘/通知 | 已做（Windows 打包版验证了代码路径） | 托盘图标为占位；任务 4：关闭按钮隐藏到托盘、任务失败触发 Notification.show、resume 事件触发对账都在打包版验证；托盘可见 / 通知气泡可见 / 退出确认对话框 / 真实睡眠待人眼确认（见 windows-test-results/2026-10-02.md） |
| E04 任务中心 | 已做（未在浏览器打开） | |
| F04 快捷键/撤销 | 已做（未在浏览器测） | |
| F06 自动保存与恢复 | 部分 | localStorage 草稿恢复，未用 IndexedDB |
| G02 渲染计划与场景缓存 | 已做 | 只改一镜只重渲一镜；第二轮修了 clip 并列次序按 id 排、AIGC 水印 clip 每次导出换 id 导致一个场景永远重渲的问题（plan.rs `tie_breaking_ignores_clip_ids`），排序规则变了所以升级后旧缓存首次全部失效 |
| D06 花费确认与上限 / 队列接适配器 | 已做（模拟数据） | 价格表已换为百炼公开价目（2025-12-19 版，`configs/prices.json`），未逐条核对的条目标 `verified:false` 仍按示例价提示；任务完成后用结果里的用量写 `spend_log.actual`（任务 3） |
| G03/G05 渲染导出 | 已做（Windows 真机验证） | 任务 4：h264_qsv 硬件编码、中文 + 空格路径（数据目录、ffmpeg 目录、输出路径）、导出中取消不留半成品、场景缓存二次导出 4/5 命中均实测通过；第二轮修了并列排序后重打包复验二次导出 5/5 命中（0.6 秒） |
| B01–B03 云端账号与授权 | 已做（无数据库验证） | 迁移与 Prisma 仓库待真 Postgres 验证 |
| D04/D05 角色库与镜头工作台 | 已做（未在浏览器打开） | 锁定参考图对火山经典路径可能无效 |
| A09 lycore 进程守护 | 已做（Windows 打包版验证） | client/supervisor.js：core.hello 探测、退避重启、上限后上报、干净退出；desktop 主进程经 `apps/desktop/core-runtime.js` 拉起、退出时关闭、多次崩溃弹窗提示 |
| A10 ffmpeg 供应 | 已做（随包内置） | 安装包内置固定版本的 LGPL ffmpeg（`scripts/ffmpeg-pin.json` 固定地址与 sha256，`scripts/fetch-ffmpeg.mjs` 构建时下载校验，CI 打包前执行）；`ffmpeg-manifest.json` 的下载路径保留为可选后备，仍是占位 |
| B04 licence.status | 已做（自测令牌） | ES256/JWKS/宽限期；已用 node:crypto 签发的令牌互通，未用云端真实令牌验证 |
| C06 首次引导向导 | 已做（headless Chromium 截图验证） | 欢迎→选服务商→粘贴 Key→连通测试→完成（只开放一个服务商时跳过“选服务商”，截图是旧版两家并列）；可跳过、可续接，配好 Key 后不再出现；“获取 Key”按钮走 getKeyReferralUrl 占位函数（推广跳转待接）；连通测试复用 aiConfigService.testConnection，真 Key 联通未验证；Electron 内未跑 |
| C08 内置示例项目 | 已做（headless Chromium 截图验证） | POST /api/v1/samples/:id/seed 本地生成 5 镜分镜 + 脚本生成的占位图/提示音，幂等，不调用任何 AI；首页“试试示例项目”入口；音频暂未在界面播放 |
| H04 自动更新 | 已做（未跑 Electron） | electron-updater 接入，纯逻辑有测试；更新源为占位，须配 publisherName 才启用；见 docs/auto-update.md |
| H05 签名与误报清单 | 部分 | docs/release-signing.md；CI 签名步骤为骨架，未在真实 Secrets 下跑过 |
| H06 统一错误码与脱敏 | 已做 | error-codes.json 为唯一来源，local 响应与 toast 共用；脱敏补 Bearer/sk-/LTAI/签名链接/刷新令牌/许可证 JWT；见 docs/error-codes.md |
| I01 测试矩阵 | 已做（文档） | docs/test-matrix.md；任务 4 已覆盖 B1/B2/B4/C2/D5/E1/E2/G1–G4/H1/H2/I1 的可自动化部分，剩余人眼项见 windows-test-results/2026-10-02.md |
| H01 运营后台 | 已做（未在浏览器打开） | apps/admin 五屏（登录/邀请码/用户/公告与目录/概览），云端 /admin/* 独立管理员认证；vite build 通过 |
| H02 使用统计 | 已做（内存仓储验证） | 云端 POST /telemetry 白名单、概览聚合；客户端 opt-in 模块已写，尚未接入应用事件与设置开关 |
| H03 反馈与诊断包 | 已做（无 Electron/Postgres 验证） | GET /api/v1/diagnostics/bundle 脱敏 zip（植入假密钥测试）；云端 POST /feedback 有大小与限流；诊断包直接存库，未用 OSS 临时凭证；界面入口未做 |
| B05 登录/注册页与云端客户端 | 已做（模拟云端测试，未跑 Electron） | 邀请码注册/登录页、本地 `/api/v1/account/*`、刷新令牌存系统密钥存储、许可证验签与离线宽限；云端地址 `cloud.base_url` 仍是占位，未对真实云端验证；登录名为邮箱（云端无用户名） |
| B06 目录与价格表 | 已做（模拟云端测试） | 云端 `GET /catalog`（内容哈希 + ES256 签名）；本地拉取、验签、缓存，失败回退内置 prices.json；模型覆盖下拉用目录补充。花费估算器的价格表下次启动才切换；内置价目已改为百炼公开价（2025-12-19），云端目录尚未同步更新 |
| C07 推广跳转 | 已做（模拟云端测试） | 云端 `GET /r/:code` 记录点击并 302（主机白名单、仅 https）；添加 Key 向导走本地 `/api/v1/referral/:provider`；真实推广链接未配置，迁移需真 Postgres 验证 |
| E05 花费页 | 已做（模拟接口数据截图，未连真实服务） | `/spend`：按日/服务商/模型汇总、月度上限、逐任务费用、导出 CSV；任务 3 后显示预估与实际（含回传用量：计费时长/字符/张数）、注明价目版本与日期 |
| F05 背景音乐 | 已做（未跑 Electron） | 音乐库（用户导入 + 程序合成的示例配乐）、添加到音乐轨（可循环铺满）、音量/压低/响度写入时间线 JSON；render.plan 与 render.start 原本就支持音乐轨与压低 |
| G04 AI 生成内容标识 | 部分 | 画面水印“AI生成”+ MP4 元数据 AIGC，默认开；字段、位置、大小、时长必须由法务确认，见 docs/aigc-marking.md |
| G06 导出页 | 已做（Linux 真 lycore + ffmpeg 测过，页面用模拟接口截图） | `/episodes/:id/export`：分辨率/帧率/编码器/位置、进度轮询、取消、打开文件夹；本地服务经 `LYCORE_ENDPOINT` 连接 lycore，桌面主进程已启动 lycore 并设置该变量；Windows 打包版（unpacked 与 NSIS 安装包均已构建）经接口实测导出成功（h264+aac，含 AIGC 标识）；任务 4 在 Windows 打包版经接口实测 720p/1080p、中文 + 空格路径、取消、场景缓存（见 windows-test-results/2026-10-02.md），导出页能打开，点按钮走一遍仍待人眼 |
| 服务商开关 | 已做 | `providers.enabled` 统一控制注册表、队列、向导、AI 配置页、模型目录、获取 Key 链接和提示文案；默认 `['bailian']`；新增服务商步骤见 docs/provider-extension.md |
| 百炼全流程覆盖审计 | 已做（文档） | docs/bailian-flow-coverage.md：逐步骤列真实验证 / 仅夹具 / 缺；顺手修了队列共享 Key、默认模型与请求形态、本地图内联三处接线 |
| 百炼端到端脚本 | 已在 Windows 用真 Key 跑通 11/11 阶段（2026-10-01，估算 4.605 元） | scripts/bailian-e2e.mjs（3 镜、花费上限默认 5 元）；用本地模拟百炼（HTTP + WebSocket）和真 lycore 跑通过编排；手动工作流 bailian-live.yml 的 run_e2e 选项，真实运行待有 Key 的会话 |
| I2 生成项目建图 / 旁白写回 / 词级字幕 / 真实片长 | 已做（假文本模型与假 TTS 测试，未用真 Key，未在浏览器打开） | scriptgen 同事务写角色表并建项目图；`POST /episodes/:id/voiceover` 估价后确认、经内核写回、旧列物化；词级字幕与真实片长为内核投影；时间线编辑器“旁白配音”抽屉；见 kernel-design §11 |
| I1 出图/出视频走队列并写回内核 | 已做（假服务商测试，未真 Key 跑，未在浏览器打开） | `packages/local/src/generation/`：按 cacheKey 派生幂等键、先估算再建任务（整批算一次运行的额度）、缓存命中直接采用旧版本、首帧图完成后自动接视频、成功即 commit 采用版本并物化旧列、写入真实时长；`/episodes/:id/generate`、`/episodes/:id/generation/status`；分镜表与工作台改用确认弹窗 + 状态芯片，旧同步按钮在 `generation.legacy_enabled`（默认关）之后。图片提示词等编辑仍走旧路由，图感知要等旧写路由改调意图层 |
| 数据内核 K1 核心 | 已做 | packages/kernel：图、操作事务、撤销、失效、四种投影、意图层；设计见 docs/kernel-design.md |
| 数据内核 K2 持久化与旧表适配 | 已做（Linux/SQLite 验证） | project_graphs + graph_ops，快照+日志重放，importLegacy / materialize，REST |
| 数据内核 K3 一致性套件 | 已做 | 910 次场景×视图×故事执行 + 176 次等价比较，失败 0；报告 docs/kernel-conformance.md；抓到并修复 2 个内核缺陷 |
| 任务 2：界面出图/出视频走 /ai-tasks | 已做（代码 + 单测；未真 Key 在界面点击验证） | 分镜级出图/出视频（FilmCreate、画布批量/工作流）改经 `apps/renderer/src/api/queuedGeneration.js`：先估价 -> 确认弹窗（批量只弹一次）-> `/episodes/:id/generate`；旧轮询经合成 id 读队列状态，取消走 `/ai-tasks/:id/cancel`；任务中心沿用 E04。旧 `POST /images`、`POST /videos` 保留但界面不再调用分镜级入口，并补了服务端花费上限检查（402 SPEND_LIMIT）。未迁移：角色/场景/道具等非分镜图、FreeCreate 视频，仍走旧同步路径（见 windows-test-results）。 |
| 内核接线 I1 出图出视频走队列写回内核 | 已做（模拟数据） | /episodes/:id/generate，估价确认，幂等，缓存命中，崩溃恢复 |
| 内核接线 I2 剧本入库/配音/词级字幕/真实片长 | 已做（模拟数据） | 配音已于任务 3 进队列/任务中心（`voiceover/queue.js`） |
| 任务 3：配音进队列 / 真实花费回写 / 画布新增节点 | 已做（代码 + 单测；未真 Key 在界面点击验证） | 配音 `POST /episodes/:id/voiceover` 改为建 `/ai-tasks`（kind tts），估价/确认/402 不变，worker 完成后由 `voiceover/queue.js` 经内核 `recordGeneration` 写回旁白版本与词级字幕，新增 `GET .../voiceover/status`，配音抽屉轮询并显示排队/生成中/失败；任务结果 `usage` 写进 `spend_log.usage/actual`（视频计费时长 × 分辨率价、配音字符、图片张数），花费页显示预估/实际/用量；`prices.json` 换为百炼公开价目（2025-12-19）；画布工具栏新增节点（shot/script_line/image/video/narration，经 `canvas.addNodeAt`）、场景组改名（新意图 `canvas.renameGroup`），时间线页的本地撤销/重做按钮移除，Ctrl+Z/Y 改为先保存再走内核历史。见 windows-test-results/2026-10-02.md |
| 任务 4：Windows 人工检查 | 已做（打包版自动化实测 + 人眼清单） | 按 test-matrix：20 个页面逐个打开无控制台异常（含剧本页、画布页、视图切换栏、花费页、登录页）；safeStorage 密文落盘 / 重启可用 / 日志脱敏；关闭隐藏到托盘；通知与唤醒对账的代码路径；中文 + 空格路径下的数据目录、ffmpeg 目录和导出输出；h264_qsv 导出 720p/1080p、取消、场景缓存；干净退出。托盘可见、通知气泡、退出确认对话框、真实睡眠、界面点导出按钮列为人眼清单。发现 5 个观察项（时间线页重复提示、开发态 better-sqlite3 ABI 不匹配、缓存 4/5 命中、数据目录不可自定义、ffmpeg 无 libx264），同日第二轮全部处理：时间线 404 静默、`scripts/native-abi.mjs` + `pnpm native:node/electron` 切 ABI（打包脚本顺带清掉会让 electron-builder 跳过重编的 `.forge-meta`）、plan.rs 并列排序去 id、`--user-data-dir=` / `TALEKILN_USER_DATA_DIR` 自定义数据目录、libopenh264 软件回退，各带测试。见 windows-test-results/2026-10-02.md |
| 内核接线 I3 旧写接口改走内核 | 已做 | 镜头与时间线编辑全部经内核；剩余绕过清单见 kernel-design §12.5 |
| 只接百炼 + 扩展文档 + 全流程覆盖审计 + 端到端脚本 | 已做（Windows 真 Key 端到端通过） | providers.enabled 默认只开百炼；docs/bailian-flow-coverage.md |
| 云端真 Postgres 验证 | 已做 | 33 个测试在内存库与 Postgres 上同一套断言通过；CI 加 Postgres 任务 |
