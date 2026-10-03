# 三期开发计划（云端会话视角，2026-10-02 起草）

依据：三期总方案“三期：周边优化与拓展”一节（模板市场、插件生态、角色一致性、导演模式、选镜改片、工作室版、批量生成、可选云备份，合计约 260 人天）和设计稿 P3-01 到 P3-06。方案里三期按二期上线后的付费数据滚动排期；现在二期还没上线，所以这里只做**不依赖线上数据、不依赖外部账号**的部分，顺序按“对短剧用户最痛、最能复用现有内核”排。

## 分工原则

- 云端会话：Linux 上能做、能测的一切。需要厂商能力（局部重绘、主体注册）的部分做成适配器能力位，百炼没有的能力走降级路径，并在文档里标明未验证。
- 本地会话：Windows/macOS 真机验证、一期收尾第 3、4 项（配音进队列与花费回写、画布节点增删、托盘与通知）。三期不碰本地会话正在改的文件。
- 分支：`claude/phase3-foundation-mxao0h` 叠在二期分支之上，草稿 PR 的 base 是二期分支；每个工作包在自己的分支上做完、测过再合入。

## 工作包

| 包 | 内容 | 能在云端独立做 | 卡在什么 |
|---|---|---|---|
| P3-C 角色一致性 | lycore 加 `consistency.score`（参考图与生成结果的跨镜一致性评分，不依赖模型，用 ffmpeg 抽帧后算感知哈希、色彩直方图与主色调）；本机加 `consistency_scores` 表；生成完成后自动评分；低于阈值给“重试建议”并附估价；参考图自动挑选（按清晰度、尺寸、与四视图的相似度排序）；补上新生成路径里视频没带锁定参考图的缺口 | 是 | 评分算法只能衡量色彩与构图，认不出“是不是同一张脸”；人脸级一致性要加小模型，由你决定要不要引入 |
| P3-R 选镜改片 | 时间段（入点/出点）加画面区域，用一句话修改；记录到 `edit_regions`；厂商有遮罩编辑能力时直接调用，没有时走降级：取当前视频在入点与出点的两帧，用首尾帧生视频只重做这一段，再用 ffmpeg 拼回去；估价按时长算，比整镜便宜；结果作为新版本，旧版本保留，A/B 对比后采用 | 是 | 百炼是否有带遮罩的视频编辑模型（VACE 一类）还没查证，今晚读文档的请求被环境拦住了；降级路径的接缝效果要真机看 |
| P3-B 批量生成 | `batch_jobs` 表；一次排多集，按厂商设并发上限、总预算上限；失败策略（自动重试、跳过、只在夜间时段提交）；批次页汇总进度、已花费、预计区间，失败集单独重试 | 是 | 真机跑一次多集批次（¥ 限额内） |
| P3-T 模板市场 | 模板包格式（manifest + 分镜结构 + 角色槽位 + 风格 + 配乐提示）；内置几套官方模板；`installed_templates` 表；一键套用到新项目或已有项目的下一集，复用已锁定角色，套用前显示生成全部镜头的估价；云端 Template 模块（目录、版本、官方签名）和后台录入 | 是 | 创作者上传与分成要等支付和法务；模板内容本身需要你或运营填充 |
| P3-P 插件适配器 | 插件包签名（沿用云端目录的 ES256 密钥）与 `installed_plugins` 表（版本、签名状态、权限、开关）；本地服务启动时从插件目录加载、校验签名与权限、注册到厂商注册表；未签名插件只在开发者模式下可用；插件页（P3-02）；云端 PluginRegistry 模块（登记、版本、审核状态） | 是 | 可灵、Vidu、MiniMax 的真实适配器要各自的 Key；与视频厂商谈推广合作是商务事项 |
| P3-D 导演模式 | `director_turns` 表；右侧对话用自然语言下指令，用用户自己的百炼 Key 调大模型生成**执行计划**（只允许内核已有意图），本地校验并在内核上干跑，算出影响范围、时长变化与花费；执行时合成一笔事务，可整体撤销；预览“计划后”的镜头表 | 是（大模型调用在测试里用录制结果） | 计划质量要真 Key 多轮试；提示词需要按真实项目调 |
| P3-S 工作室版 | 成员、席位、共享角色库与模板、席位计费、私有部署 | 否 | 席位定价、共享存储（OSS/NAS）选型、企业证书形式都要你决定；等二期收费跑通 |
| P3-K 可选云备份 | 用户自己的 OSS 或网盘 | 否 | 要你决定支持哪几家 |

## 建议批次

1. 第一批（互不冲突，并行）：P3-C、P3-R、P3-B、P3-T、P3-P、P3-D 各在自己的分支上做；合入时由云端会话统一解决 `routes/index.js`、迁移编号、错误码、命令面板注册这几处必然的冲突。迁移编号预分配：28 一致性、29 选镜改片、30 批量、31 模板、32 插件、33 导演。
2. 第二批：真机验证（Windows），导演模式与一致性用真 Key 调参，模板内容填充。
3. 等你决定后：P3-S、P3-K、创作者上传分成、人脸级一致性模型。

## 已决定（Jay，2026-10-02 上午）

- 人脸级一致性：引入本地小模型。选型：YuNet 人脸检测（MIT，0.2 MB）+ SFace 人脸特征（Apache-2.0，int8 约 10 MB），经 onnxruntime-node 在本机服务里跑，模型随安装包内置、不进 git（`scripts/fetch-face-models.mjs` 固定哈希下载）。
- 插件签名私钥：只保管在腾讯云服务器后台（云端服务的 `.env`），签名由云端管理接口完成；后台加插件审核页；密钥轮换走 JWKS 多 kid。
- 可灵、Vidu、MiniMax 测试 Key：稍后提供；真实适配器等 Key 到了再写。
- 工作室版共享存储与云备份：先自建 MinIO（S3 兼容接口），后续再接第三方（OSS / COS / R2 只换端点）。工作室版席位定价仍未定。
- 官方模板文案：由云端会话编写（第二批 8 套）。

## 验收口径（三期第一批）

自动化：内核一致性套件保持 0 失败；一致性评分对“同图”“换色”“完全不同”三类样例的分数单调；选镜改片的降级路径对样例视频拼接后时长误差小于 1 帧；批量生成在并发上限与预算上限下的调度用假厂商测；模板套用后内核图通过校验且估价等于逐镜估价之和；插件签名错误、权限越界、SDK 版本不符都被拒；导演模式对录制的计划能干跑、执行、整体撤销后图与执行前一致。人工：Windows 真机跑一遍每个页面，真 Key 跑一次选镜改片与导演模式。

## 进度（2026-10-02 上午）

第一批六个工作包已全部合入 `claude/phase3-foundation-mxao0h`（草稿 PR #6，base 二期分支）。合入后全量测试通过：local 592、renderer 255、kernel 198（含一致性套件）、cloud 99、plugin-sdk 64、desktop 69、admin 37、core（cargo）65；renderer 与 admin 都能 `vite build`；密钥扫描通过。合并时解决的冲突只在路由挂载、迁移编号、错误码表、命令面板、Prisma 模型列表这几处；两处语义修正：模板套用也给视频节点写参考图哈希（一致性包改了输入同步规则），`editShotRegion` 进共享意图表但对导演模式排除（改片要先估价确认）。

| 包 | 状态 | 未验证 |
|---|---|---|
| P3-C 角色一致性 | lycore `consistency.score` / `consistency.pick_reference`（感知哈希 + 直方图 + 主色调）、迁移 28、生成写回后自动评分、`GET /episodes/:id/consistency`、参考图自动挑选、视频请求带锁定参考图，见 `docs/phase3-consistency.md` | 真实出图的分数分布（阈值 60/40 来自合成样例）；算法认不出人脸，是否引入小模型待定；Windows |
| P3-R 选镜改片 | 内核意图 `editShotRegion` / `adoptShotVersion`、迁移 29、估算只算重做的一段、能力位 `video.edit`、降级拼接路径、工作台改片面板与内核版本 A/B，见 `docs/phase3-region-edit.md` | 百炼 / 方舟是否有带遮罩的视频编辑模型；拼接接缝的真机效果 |
| P3-B 批量生成 | 迁移 30、批次服务与调度器（按厂商并发、预算上限、夜间时段、重试/跳过/暂停）、`/batches` 接口、批次页，见 `docs/phase3-batch.md` | 真 Key 多集批次；在途 1.2 倍预算系数是否过于保守 |
| P3-T 模板市场 | 模板包格式与三套内置模板、迁移 31、估价与一键套用（一笔内核事务）、官方签名校验、专业版门槛、云端 Template 模块与后台页、模板市场页，见 `docs/phase3-templates.md` | 两个页面未在浏览器里点过；云端 Prisma 实现只在 CI 的 Postgres 作业跑；模板文案需运营填充 |
| P3-P 插件适配器 | SDK 签名/验签与 `sign-plugin.mjs`、迁移 32、插件宿主（扫描、离线验签、开发者模式、安装/删除、接入注册表与队列）、`/plugins` 接口、云端 PluginRegistry、插件页，见 `docs/phase3-plugins.md` | 真实厂商插件（可灵、Vidu、MiniMax）未写；签名私钥保管与轮换是经营决定；插件仍在进程内运行 |
| P3-D 导演模式 | 迁移 33、计划 / 校验 / 干跑 / 影响与花费 / 一笔事务执行 / 撤销、`/episodes/:id/director/*` 接口、右侧导演面板，见 `docs/phase3-director.md` | 从未对真实文本模型跑过（计划质量、修复轮次、长剧集上下文） |

下一批：Windows 真机过一遍六个页面；真 Key 跑选镜改片与导演模式并调阈值和提示词。

## 第二批（2026-10-02 上午开工）

按上面的决定，四个工作包并行，各在自己的分支上做完、测过再合入 `claude/phase3-foundation-mxao0h`：

| 包 | 分支 | 内容 |
|---|---|---|
| P3-F 人脸级一致性 | `p3b-face` | 本机服务新增人脸引擎（检测 + 对齐 + 128 维特征，余弦相似度），与现有色彩/构图评分合成；模型下载脚本与打包；报告与界面显示人脸分 |
| P3-P2 插件签名服务器保管 | `p3b-signing` | 云端独立签名密钥（环境变量）、JWKS 多 kid 与退役公钥、后台插件审核页（登记 / 审核 / 签名 / 下载已签名清单）、服务器密钥生成与轮换手册 |
| P3-K 云备份（MinIO） | `p3b-backup` | 本机服务 S3 兼容客户端（SigV4，无新依赖）、项目备份 / 快照列表 / 恢复 / 保留策略 / 自动备份、云备份设置页、服务器 MinIO 部署手册、CI 用真实 MinIO 跑一次 |
| P3-T2 官方模板文案 | `p3b-templates` | 8 套新模板（都市甜宠、逆袭打脸、悬疑反转、穿越重生、校园、家庭伦理、职场、治愈），其中两套付费示例；文案规范 |

### 第二批进度（2026-10-02 中午）

四个工作包已全部合入 `claude/phase3-foundation-mxao0h`（头 `3cfda1e`，草稿 PR #6）。合入后全量测试通过：local 652（650 通过、2 个需真实 S3 / 人脸模型的测试按环境跳过）、kernel 200、renderer 275 并 `vite build`、desktop 77、admin 46 并 `vite build`、cloud 103、plugin-sdk 64、scripts 19、core（cargo）68；密钥扫描 991 个文件通过；许可证检查通过。人脸模型下载脚本在云端沙箱实测可用（两个模型落到 `apps/desktop/resources/models/face`）。合并时的冲突只在 `routes/index.js` 挂载块、`app.js` 服务装配、`docs/tencent-deploy.md` 的章节编号（MinIO 改为第 8 节）。

**CI 仍未跑**：GitHub Actions 的私有仓库免费分钟数已用尽，每个作业 3 秒失败且无日志，需要 Jay 在组织账单里加卡并设支出上限后重跑（`backup-minio` 作业与 Windows 上的人脸模型下载步骤都还没有真正跑过一次）。

| 包 | 状态 | 未验证 |
|---|---|---|
| P3-F 人脸级一致性 | `packages/local/src/consistency/face.js`：YuNet 检测 + SFace 特征（onnxruntime-node，CPU，不联网），阈值余弦 0.363，总分 = 0.6·人脸 + 0.4·原算法；`scripts/fetch-face-models.mjs` 按 `face-models-pin.json` 固定哈希下载，模型随安装包、不进 git；报告与芯片显示人脸分，缺模型时 `face_available=false` 回退原算法，见 `docs/phase3-face.md`、`docs/face-models.md` | 只在 Linux 沙箱用 3 张公共领域人像测过；Windows / macOS、打包后的二进制加载、动漫与国风脸型都没跑过；阈值要按真实出图再调 |
| P3-P2 插件签名服务器保管 | 云端独立签名密钥 `PLUGIN_SIGNING_PRIVATE_KEY_PEM` / `PLUGIN_SIGNING_KEY_ID`（默认 kid `plg-1`），JWKS 带退役公钥，`GET /admin/plugins/signing-key`，后台「插件审核」页（登记 / 审核 / 签名 / 下载已签名清单），见 `docs/phase3-plugins.md` §5、`docs/tencent-deploy.md` §7 | 密钥还没在真实服务器上生成；后台页只过了测试与构建，没有点过；离线备份由谁保管、轮换周期、审核员人选未定 |
| P3-K 云备份（MinIO） | 手写 SigV4 S3 客户端（path-style，仅回环 / 内网允许 http）、备份 / 快照列表 / 恢复 / 保留策略 / 自动备份（迁移 34），设置存 `global_settings.backup`，密钥走 secret store；渲染端「云备份」设置页；`packages/cloud/docker-compose.minio.yml`；CI 新增 `backup-minio` 作业，见 `docs/phase3-backup.md`、`docs/tencent-deploy.md` §8 | 从未对真实 MinIO 跑过（沙箱拉不到 Docker Hub，只用了模拟 S3 服务校验 SigV4）；设置页没打开过；备份 ZIP 在内存里拼装，大项目要看内存；`after_export` 触发依赖界面轮询 |
| P3-T2 官方模板文案 | 8 套新模板包（都市甜宠、逆袭打脸、悬疑反转、穿越重生、校园、家庭伦理、职场、治愈），付费示例为 `official-revenge-god-of-war`、`official-suspense-seventh-visitor`；`GENRE_LABEL` 扩充；文案规范写进 `docs/phase3-templates.md`（共 11 套） | 文案没有用真 Key 出过图，提示词效果未验；运营口径需 Jay 过目 |

下一步：Jay 恢复 Actions 配额后重跑 CI；Windows 真机过一遍人脸评分、云备份设置页、插件审核页；服务器重装后按部署手册生成签名密钥并起 MinIO。

## P3-S 基础（第三批，2026-10-02 下午）

分支 `p3c-studio`，详见 `docs/phase3-studio.md`。按 Jay 的决定：共享存储用自建 MinIO（复用 P3-K 的 S3 客户端与设置，桶内 `shared/<studio_id>/` 前缀），**席位定价仍未定**，所以只有 `seatLimit` 配置位（`STUDIO_DEFAULT_SEAT_LIMIT`，后台可改），没有价格字段、不接支付、不做私有部署。

做了什么：云端 Studio 模块（`Studio` / `StudioMember` / `StudioInvite`，迁移 `20261006000000_studio`；创建 / 邀请 / 接受 / 移除 / 改角色 / 我的工作室；席位占用 = 成员 + 待处理邀请，超限 403 `seat_limit`；后台 `/admin/studios` 列表、调席位、停用；用户侧写操作也进审计）；本机 `studio` 模块（云端身份缓存与离线回落、成员管理转发、共享角色的发布 / 拉取——主图、四视图、锁定参考图、`extra_images`，清单与每个文件都带 sha256，拉取时校验、更新覆盖同一本机角色；共享模板复用模板包格式与模板服务安装；迁移 36 `studio_shared_items`；`/api/v1/studio/*`）；渲染端「工作室」设置页（`/settings/studio`，命令面板入口）；后台「工作室」页（纯函数 + 测试）。测试：cloud 108、local 658（3 条按环境跳过）、renderer 281 并 `vite build`、admin 50 并 `vite build`，密钥扫描通过。

未验证：真实云端 + 真实 MinIO 的两机端到端（云端只跑了内存仓储 + 本进程 HTTP，Prisma 实现只做了类型检查；本机只对假 S3 跑过）；两个页面没在浏览器里点过；大图批量的内存；旧文件不清理；并发发布的版本号没有条件写；成员在对象存储层面仍是读写权限（只在服务层限制发布）。

需要 Jay 决定：席位定价与超限策略；企业证书形式（个人账号 + 席位，还是独立企业许可证）；每工作室独立 S3 凭据（云端签发 STS / 独立用户，`docs/tencent-deploy.md` §8.7 已给策略写法）；私有部署要不要做、怎么分发企业配置；拉取的角色要不要进「跨项目的本机角色库」。

## 第三批进度（2026-10-02 下午）

CI 配额仍未恢复，先做了不依赖 CI 的四路，全部合入 `claude/phase3-foundation-mxao0h`（头见 git），加上云备份的一次补充实测。合入后全量测试通过：local 668（2 个需真实 S3 / 人脸模型的测试按环境跳过）、cloud 117 并 `tsc` 类型检查、renderer 293 并 `vite build`、admin 50 并 `vite build`、desktop 86、kernel 200、plugin-sdk 64、scripts 19；密钥扫描 1029 个文件通过；浏览器 e2e 7 页全部通过。合并接缝：云端 `ErrorCode` 联合类型与 `WechatQrRepository` 接口的收尾各漏了一处，已修。

| 包 | 状态 | 未验证 / 待定 |
|---|---|---|
| P2-C 登录（二期遗留） | 短信验证码与微信扫码登录的服务端接口与 mock 适配器（`SMS_PROVIDER` / `WECHAT_PROVIDER` = mock / none），限频、验证码 5 分钟 / 错 5 次作废、二维码状态机、首登邀请码；本机转发接口；登录页两个新标签页，见 `docs/phase2-login.md` | 真实短信厂商与微信开放平台未接；登录页没在浏览器里点过；无邮箱账号用占位邮箱存，是否改 `email` 可空、微信首登是否强制绑手机、公测是否放开邀请码待 Jay 定 |
| P3-S 工作室版基础 | 云端 Studio / 成员 / 席位 / 邀请（席位超限 403，`STUDIO_DEFAULT_SEAT_LIMIT` 默认 3，无价格字段）、后台「工作室」页；本机把角色（主图、四视图、锁定参考图）与模板发布 / 拉取到 MinIO `shared/<studio_id>/` 前缀，清单带 sha256；渲染端「工作室」页，见 `docs/phase3-studio.md` | 真实云端 + 真实 MinIO 两机端到端没跑；两个页面没在浏览器里点过；对象存储层成员仍共用备份那把读写 Key（只读只在本机服务层强制）；席位定价、企业证书形式、每工作室独立 S3 凭据、私有部署待 Jay 定 |
| 桌面小收尾 | 桌面端接云端更新检查（30 秒后首查、每 6 小时）与公告条（首页顶部、可关闭）；云备份 ZIP 改为落临时文件再流式上传 / 下载并校验 sha256（adm-zip 内部仍整包在内存，真正流式 ZIP 要换库）；时间线页删掉第二套本地撤销栈 | 打包后的 Electron 里没跑过 IPC 与 preload；`downloadPageUrl` 为空待填官网下载页 |
| 浏览器 QA | 假厂商模式 `TALEKILN_FAKE_VENDOR=1`（默认不生效）+ `pnpm --filter @talekiln/renderer e2e` 脚本，点了模板市场、插件、批量、云备份、分镜表一致性芯片、工作台改片、导演面板 7 页；修了 3 个真 bug（导演面板执行 / 撤销按钮永远禁用、工作台框选层 0×0、备份页提示截断），见 `docs/e2e-browser.md` | 没点到的交互列在该文档第 5 节；开源 Chromium 放不了 H.264；e2e 未进 CI |
| 云备份补充实测 | live 套件对 SeaweedFS 与 rclone serve s3 两个真实 S3 实现跑通；修了列举键的 `encoding-type=url` 解码 | MinIO 本体仍没跑过（沙箱拉不到镜像），等 CI 的 `backup-minio` 作业 |

下一步仍是：Jay 恢复 Actions 配额后重跑 CI；Windows 真机过一遍新页面；服务器重装后按部署手册起 MinIO 与签名密钥。

## 四视图统一工作台（2026-10-03，分支 `win/four-view-impl`）

放弃 LocalMiniDrama 的 FilmCreate / DramaDetail / DramaCanvas 交互，剧本 / 分镜 / 时间线 / 画布四视图成为唯一的项目工作区，共用 `ProjectShell` 外壳，全程中英文可切换。规格 `docs/superpowers/specs/2026-10-03-four-view-unification-design.md`，计划 `docs/superpowers/plans/2026-10-03-four-view-unification.md`，各 lane 的实现记录与「旧功能 -> 新位置」对照表在 `docs/superpowers/notes/`（`shell`、`backend-regenerate`、`backend-quality`、`backend-backup`、`script`、`assets`、`storyboard`、`generate-export`、`canvas`、`home`）。进度见 `phase1-status.md` 末尾，测试结果见 `windows-test-results/2026-10-03.md`。

### 评审决定 D1-D8 的结果

规格 §5.2 的 D1-D8 由用户在 2026-10-03 评审（规格 §10.1）；D5、D7、D8 未回复，按建议执行。

| 编号 | 结论 | 落地情况 |
|---|---|---|
| D1 资产放哪 | 左侧资产面板 + 整页，不做第五个标签；面板数据全局可引用（任何视图、任何检查器里可用 `@角色` / `#场景` / `#道具`） | 已做：`useAssetsStore`、`AssetPanel`、`/p/:dramaId/assets`（notes/assets.md）。道具也进了资产库 |
| D2 上游改动是否自动重跑 | 只标记「已过期」，不自动重跑；另增草稿 / 成片质量档和整个项目备份。生成分镜后全文模式只读（按建议） | 已做：质量档（notes/backend-quality.md）、完整备份（notes/backend-backup.md）、剧本视图有镜头后禁用全文编辑（notes/script.md） |
| D3 重新生成分镜 | 改成多版本管理：新分镜作为一次可撤销事务，旧镜头及其产物靠撤销恢复；执行前自动做本地快照 | 已做：`compat.replaceEpisodeShots` + 备份钩子（notes/backend-regenerate.md，kernel-design §12.4 / §17） |
| D4 快速拼接 | 删除，导出菜单里没有，旧 `finalize` 随旧页面删除；没有渲染核心时只有「导出成片」置灰 | 界面入口已删。后端 `POST /episodes/:episode_id/finalize` 路由本文写作时仍在 `routes/index.js`，是否一并删除未决定 |
| D5 字幕烧录 / 对白烧录 / 水印 | 不进本轮，只记为渲染核心缺口，导出对话框不显示这些选项 | 已按此做，见下面「已知缺口」 |
| D6 旧画布工作流分组 | 放弃；用分镜视图多选 + 生成菜单代替 | 已做：分镜多选批量条；画布节点位置也不迁移（notes/canvas.md、storyboard.md） |
| D7 通用片段（全能）模式 | 只在支持多参考图的模型（方舟 Seedance 2.0）可用时显示；删除 Grok 格式转换 | 已做，但可用性来自当前视频 AI 配置，方舟路径没有真 Key 验证 |
| D8 旧路由重定向 | 保留一个版本，之后删除 | 已做：`utils/legacyRoutes.js` 的 `resolveLegacyRoute`。**下一个版本要删除**这个文件和 `router/index.js` 里的 `legacy-*` 记录，并同时去掉 `noLegacyLinks` 测试对它的豁免 |

### 已知缺口（汇总自各 lane 的 notes，未补）

渲染核心与导出：

- 字幕烧录、对白烧录、水印：渲染核心（闭源，未连接时 `503 CORE_UNAVAILABLE`）目前没有对应参数，导出对话框不提供这些开关（D5；notes/generate-export.md）。
- 分镜表导出没有缩略图，道具列为空（旧分镜列表没有道具 id）；`messages/shell.js` 里 `shell.menu.export.storyboardSheet.desc` 仍写「带缩略图的分镜表」/ "with thumbnails"，与实际不符（该文件不归 generate-export lane，写本文时未改）。
- 资产包由浏览器端生成 store-only ZIP，整包放在 Blob 里，远程图片受 CORS 限制；完整备份的下载经 `fetch` 读成 blob 再保存，超大项目占内存（后端是流式的，要改需要 GET 路由或桌面端下载钩子）。
- 导出对话框打开时渲染核心不可用，会看到两次同样的错误文字（对话框顶部 + 全局提示）。

生成（后端与队列）：

- 资产（角色 / 场景 / 道具）图片生成没有进队列：队列只支持分镜首帧图 / 视频，资产出图保留旧同步路由，且只有 `generation.legacy_enabled === true` 时才可点（**默认配置下禁用**，只能上传）。不进任务中心、不受队列的花费确认约束（只有 402 就地提示）。资产出图也没有传画风（notes/assets.md；bailian-flow-coverage.md）。
- 尾帧生成没有队列路径：`lastFrameGenerate=false`，尾帧槽只能上传、从历史选或用上一镜尾帧（notes/storyboard.md）。
- 后端不持久化 `lighting_style`、`depth_of_field`：`PUT/GET /storyboards` 不保存，「更多镜头参数」对话框里有提示（notes/storyboard.md）。
- 道具不能锁定参考图（后端锁定接口只支持角色和场景）；`use_quad_grid` 后端忽略所以没暴露；`identity_anchors` 只读（`PUT /characters/:id` 忽略它，只能靠提取刷新）；团队库 `add-to-team-library` 没有界面入口（无工作室服务的环境返回 501）（notes/assets.md）。
- 一键成片的费用预估不含角色 / 场景 / 道具图和「提取」步骤；取消只停后续步骤，已提交的任务照常跑完并计费（notes/generate-export.md）。
- 用户显式选的模型在现状下到不了（每次生成前节点模型被改写成自动挑选的结果；已保存配置的默认模型也被草稿档覆盖），需要先有「在节点上选模型」的入口（notes/backend-quality.md）。
- 重跑草稿进行中该节点仍显示 `fresh`；重跑首帧后已有的成片视频不会跟着重做（notes/backend-quality.md）。

质量档与服务商（见 `bailian-flow-coverage.md`）：

- 百炼上草稿档只在「不带参考图的出图」有差别（`z-image-turbo` 对 `wan2.6-t2i`），且 `z-image-turbo` 的价目是占位价（`verified:false`），省不省钱取决于它是否属实；草稿视频没有节省。
- 方舟草稿档只加 `--rs 480p`（不换模型），未经真 Key 验证；方舟出图没有草稿档。
- 全部新流程（重新生成分镜、质量档重跑、一键成片、备份恢复）只用假服务商验证，没有用真 Key 在界面里跑过。AI 写剧本的成功路径也没有走通（当时本机没配文本模型）。

备份与内核：

- 轨道音量 / 静音 / 混音不在图里，不随内核快照恢复（与时间线撤销不恢复它们是同一个原因，kernel-design §12.5）。
- 快照的磁盘成本：每次破坏性操作做一次完整导出（含全部媒体），最多 5 份 × 项目大小，不去重；以后可以改成只带上次快照后变化的文件，或对 `media/` 做内容寻址的共享目录（notes/backend-backup.md）。
- 内核快照还原失败且降级也失败时，它为这一集写的 `kernel/` 媒体成为新项目目录里的孤儿文件。
- 种子 / 导入的基线图（带 `legacy-import` 采用版本）I5 不通过，原因未查（kernel-design §17.4）。
- 首页「最近删除」记录只存在这台机器的浏览器存储里，清站点数据后界面里找不到快照（快照文件仍在应用数据目录）（notes/home.md）。

界面与国际化：

- `GenerateDialog.vue` 只有中文：英文界面下画布「应用并重新生成」弹出的确认框仍是中文；`utils/projectViews.js` 里共享的中文标签表其他视图若还在用也是中文（notes/canvas.md）。
- 画风名（`constants/styleOptions`）、题材模板名 / 描述（`/scriptgen/templates`）、服务端 `error_readable`、画布分组标题等是数据，仍是中文；`StylePickerButton` 标签是中文，画面比例显示原始字符串（notes/home.md、script.md、canvas.md）。
- 重命名项目不能改画幅（`updateDrama` 只支持 title / description / genre / status），也不能把描述清成空；没有剧集的旧项目点卡片落到 `project-home`（notes/home.md）。
- 剧本视图：出场资产只来自镜头的 `params.characters` 和行文 / 镜头描述里的 `@` `#` 提及；分集排序是在集号槽位之间交换内容，有镜头的集不能移动，角色 / 场景的分集归属不跟着移动；模板库导入是追加不是覆盖；有镜头的集不能写入导入 / AI 写作（notes/script.md）。
- 分镜视图：多参考图能力取自当前视频 AI 配置而不是内核能力接口；一致性提示只保留「分数 + 三档建议」；空的「剧本」分组在卡片视图里显示一个 0 镜头的标题（notes/storyboard.md）。
- 首页的 `GlobalLibraryPanel` 与资产 lane 的 `GlobalLibraryDialog` 是两份相似的全局库面板，尚未合并（notes/home.md、assets.md）。
- 「只看过期」在全新、什么都没生成的项目里几乎等于全图（约定行为，不是 bug）（notes/canvas.md）。

### 需要用户做的事

- 用真 Key 在本机验收：出图 / 出视频 / 配音经队列生成、草稿档重跑、重新生成分镜后撤销、完整备份与恢复（含大项目）、资产出图（需要先把 `generation.legacy_enabled` 打开）。Claude 只能用假服务商测。
- 决定：后端 `finalize` 路由是否删除；`z-image-turbo` 价目是否核对；是否验证一个更便宜的百炼视频模型来让草稿视频真的省钱；资产出图要不要进队列（需要扩展队列 kind）；字幕烧录 / 水印是否排进渲染核心。
