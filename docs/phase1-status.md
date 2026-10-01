# 一期进度

| 任务 | 状态 | 说明 |
|---|---|---|
| A01 分叉并打包 | 进行中 | 代码已导入并改成 pnpm 多包；Windows 安装包由 CI 产出，待真机验证 |
| A04 品牌替换 | 部分 | 名称、appId 已换；图标、关于页许可清单未做 |
| A05 多包结构与 CI | 进行中 | desktop / renderer / local 三包；core、cloud、admin 待建 |
| A06 Electron 安全基线 | 部分 | 升到 39；sandbox、CSP、外链白名单已做；Fuses 未做 |
| A07 本地服务只听本机 | 已做 | 127.0.0.1 + 每次启动令牌 |
| A02 代码审计 | 已做 | docs/audit.md，13 项必改 |
| A03 许可证扫描 | 已做 | docs/licenses.md，`pnpm licenses:check`；仅 sharp-libvips 为 LGPL |
| A08 lycore 骨架 | 已做（Linux 验证） | Windows 命名管道由 CI 首次验证 |
| C01 适配器接口 | 已做 | providers/，仅暴露 bailian、ark |
| C02 百炼适配器 | 部分 | 文本/图像/视频/配音已写，契约测试用模拟数据；CosyVoice 报文、错误码字符串、默认模型名待真 Key 验证 |
| C03 方舟 + 火山语音适配器 | 部分 | 契约测试用模拟数据；默认模型名、Seedance 参数形式、语音地址与鉴权头待真 Key 验证 |
| C04 Key 存系统密钥 | 已做（未跑 Electron） | safeStorage 密文落盘，接口只回末 4 位，日志脱敏，旧明文自动迁移 |
| E01 任务队列持久化 | 已做 | ai_tasks 状态机、幂等键、崩溃三点测试；未接入现有路由 |
| F02 时间线数据模型 | 已做 | 四轨、校验、从分镜装配、REST 路由；前端编辑器（F03）未做 |
| G01 媒体探测与编码器检测 | 已做（Linux 验证） | lycore media.probe / encoder.detect，Windows 真机显卡检测待测 |
| F03 时间线编辑器首版 | 部分 | 四轨、拖拽、吸附、切分、预览；缺波形、缩略图、旁白/音乐播放 |
| D02 分镜模板 / F01 配音字幕 / C05 连通测试 | 已做（联网会话） | PR #2、#3 已合入 |
| D01 新建项目 / D03 分镜表 | 已做（未在浏览器打开） | 同步生成，无进度流 |
| E02 队列工作器 | 已做 | 限并发、429 退避、断点下载、sha256 入库；尚未接入真实适配器 |
| E03 唤醒对账/托盘/通知 | 已做（未跑 Electron） | 托盘图标为占位 |
| E04 任务中心 | 已做（未在浏览器打开） | |
| F04 快捷键/撤销 | 已做（未在浏览器测） | |
| F06 自动保存与恢复 | 部分 | localStorage 草稿恢复，未用 IndexedDB |
| G02 渲染计划与场景缓存 | 已做 | 只改一镜只重渲一镜 |
| D06 花费确认与上限 / 队列接适配器 | 已做（模拟数据） | 价格表为示例价；界面（E05）未做 |
| G03/G05 渲染导出 | 已做（Linux 真 ffmpeg 测过） | 硬件编码器、Windows 路径、取消需 Windows 真机 |
| B01–B03 云端账号与授权 | 已做（无数据库验证） | 迁移与 Prisma 仓库待真 Postgres 验证 |
| D04/D05 角色库与镜头工作台 | 已做（未在浏览器打开） | 锁定参考图对火山经典路径可能无效 |
| A09 lycore 进程守护 | 已做（Linux 验证） | client/supervisor.js：core.hello 探测、退避重启、上限后上报、干净退出；未接入 desktop 主进程 |
| A10 ffmpeg 供应 | 部分 | 下载/校验/续传已做并测试；清单为 TODO 占位，需填真实 LGPL 构建与 sha256，见 docs/ffmpeg-lgpl.md |
| B04 licence.status | 已做（自测令牌） | ES256/JWKS/宽限期；已用 node:crypto 签发的令牌互通，未用云端真实令牌验证 |
| C06 首次引导向导 | 已做（headless Chromium 截图验证） | 欢迎→选服务商→粘贴 Key→连通测试→完成；可跳过、可续接，配好 Key 后不再出现；“获取 Key”按钮走 getKeyReferralUrl 占位函数（推广跳转待接）；连通测试复用 aiConfigService.testConnection，真 Key 联通未验证；Electron 内未跑 |
| C08 内置示例项目 | 已做（headless Chromium 截图验证） | POST /api/v1/samples/:id/seed 本地生成 5 镜分镜 + 脚本生成的占位图/提示音，幂等，不调用任何 AI；首页“试试示例项目”入口；音频暂未在界面播放 |
