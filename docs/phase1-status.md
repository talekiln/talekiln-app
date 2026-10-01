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
