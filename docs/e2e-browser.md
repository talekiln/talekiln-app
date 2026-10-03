# 三期页面浏览器 e2e（假厂商 + Playwright）

三期六个工作包的文档里都写着“页面没在浏览器里点过，只做了 vite build 与纯函数测试”。这份脚本把那些页面在真实 Chromium 里点一遍：自带启动 / 关闭本机服务与渲染端 dev server，不联网、不花钱，每页截图并记录控制台错误、页面异常与 5xx 响应。2026-10-02 在 Linux 沙箱跑通，发现并修了 3 个问题（第 4 节）。

## 1. 做了什么

- **假厂商模式**（`packages/local/src/providers/fakeVendor.js`）：本机服务以 `TALEKILN_FAKE_VENDOR=1` 启动时，`server.js` 向 `createApp` 注入
  - 队列服务商 `bailian`：submit 立刻受理，约 1.2 秒后 poll 成功，download 落一张本机合成 PNG（视频用 ffmpeg 合成 2 秒纯色 VP8/WebM 短片，没有 libvpx 退回 H.264，没有 ffmpeg 落占位字节）；回传用量 = 请求时长，花费与估价一致；
  - 配置列表：一条 dashscope 文本 / 图像 / 视频配置（假 Key），让生成、估价、批量、模板套用都认为“已配好厂商”；
  - 一致性评分器：按目标文件名哈希给 30–95 分（芯片三种颜色都能看到）；人脸引擎关闭；
  - 导演模式文本模型：对任何指令回一份合法计划（第一镜 `setShotField` 改特写），用来干跑 / 执行 / 撤销。
  实现思路复用 `test/batch.test.js`、`test/consistency.test.js`、`test/director.test.js` 里的假对象。生产装配不引用这个文件；`app.js` 只多透传 `listConfigs` / `directorDeps` 两个注入点，`routes/index.js` 的导演服务按 `extras.directorDeps` 接收 `resolveProvider` / `createProviders`。
- **e2e 脚本** `apps/renderer/e2e/run.mjs`（`pnpm --filter @talekiln/renderer e2e`，不进默认 `test`）：
  1. 在系统临时目录建工作目录（数据库、存储、插件目录都在里面，跑完留着看日志），把 `packages/local/test/fixtures/plugins/acme`（未签名插件夹具）拷进插件目录；
  2. 启动本机服务（`TALEKILN_FAKE_VENDOR=1`，随机 `TALEKILN_DEV_SECRET_KEY` 让备份页能保存 Secret Key，端口默认 5791）与 vite（端口默认 3091，`TALEKILN_API_PORT` 把代理指到临时端口），等 `/health` 与首页可达；
  3. 用 API 跳过首次引导、种内置示例项目（5 镜），然后按第 3 节逐页操作、截图；
  4. 结束时杀掉两个子进程，写 `apps/renderer/e2e/screenshots/report.json`，有任一页失败则退出码 1。
- 渲染端 `vite.config.js` 的 `/api`、`/static` 代理目标改为读 `TALEKILN_API_PORT`（缺省仍是 5679）。
- `apps/renderer/e2e/.gitignore` 忽略截图目录；截图与报告只落本机，不进 git。

## 2. 怎么跑

```bash
pnpm install --frozen-lockfile
pnpm native:node                                   # better-sqlite3 切到 Node ABI（和 pnpm test 一样）
pnpm --filter @talekiln/renderer e2e               # 约 1.5–2 分钟
```

- Playwright：优先用仓库依赖（`playwright` 或 `@playwright/test`），没有就用全局 npm 包（`npm root -g`）。浏览器用 Playwright 自带的 Chromium（`PLAYWRIGHT_BROWSERS_PATH` 指向预装目录即可，不会执行 `playwright install`）；`TALEKILN_E2E_CHROMIUM=/path/to/chrome` 可指定别的可执行文件。
- 环境变量：`TALEKILN_E2E_API_PORT` / `TALEKILN_E2E_WEB_PORT` 换端口（被占用会直接报错退出）；`TALEKILN_E2E_HEADED=1` 有头运行；`TALEKILN_E2E_KEEP=1` 跑完不关服务，方便接着手工点（服务地址在控制台输出里）。
- 输出：`apps/renderer/e2e/screenshots/NN-页面.png` 与 `report.json`（每页耗时、备注、截图路径、控制台错误、页面异常、5xx / 4xx 列表）；子进程日志在临时目录的 `logs/local.log`、`logs/vite.log`，路径打在最后一行。
- 想手工点：`TALEKILN_FAKE_VENDOR=1 TALEKILN_DEV_SECRET_KEY=<64 位 hex> PORT=5791 node packages/local/src/server.js`（在一个空目录里跑，数据落到 `./data`），另开 `TALEKILN_API_PORT=5791 pnpm --filter @talekiln/renderer dev`。

## 3. 点了哪些页、看到了什么

> 2026-10-03 注：下表是 2026-10-02 的记录。四视图统一之后 `/project/:id/...` 这些旧路由只做重定向到 `/p/:dramaId/e/:episodeId/...`（`utils/legacyRoutes.js`，保留一个版本），批次页现在是 `/p/:dramaId/batch`，镜头工作台是 `/p/:dramaId/e/:episodeId/shot/:shotId`；脚本里的步骤需要按新路由重写。

| 步骤 | 页面 | 操作 | 结果（2026-10-02） |
|---|---|---|---|
| templates | `/templates` | 等 11 张模板卡出现 → 点第一张 → 等估价 → 一键套用 → 确认（新建项目） | 估价“预计 ¥30.60，最高 ¥36.72”；套用成功提示，项目数 1 → 2 |
| plugins | `/settings/plugins` | 打开开发者模式（确认框）→ 看未签名的 acme 行 → 详情 → 关闭开发者模式 | acme 行出现，签名标签“未签名”，运行中（开发者模式）；关闭后提示“未签名插件已停用” |
| batches | `/project/:id/batch` | 全选分集 → 等估算 → 开始 → 确认 → 暂停 → 继续 → 等批次结束 | 估算 ¥10.20–12.24；暂停后“已暂停”；最终 `completed`，已花费 1020 分，与估算下限一致 |
| backup | `/settings/backup` | 填回环地址（无人监听的端口）、桶、Access/Secret Key → 保存 → 测试连接 | 保存成功、显示“已保存”；测试连接失败文案“连不上对象存储（HeadBucket）：网络错误…”，服务端按设计返回 502 |
| storyboard | `/project/:id/storyboard` | API：给示例角色锁参考图、分镜勾上角色、整集重做（假厂商约 10 秒）→ 打开分镜表 | 5 个一致性芯片（ok / check / retry 三色都出现过）+ 5 个生成芯片 |
| workbench | `/project/:id/shot/:sid` | 看一致性芯片与提示 → 改片面板：提示词为空时按钮禁用 → 填提示词 → 框选区域（在视频层拖矩形） | 估价“只改这 3 秒约 ¥1.80（整镜重做约 ¥1.80）”，确认按钮可用；没有真的提交改片 |
| director | 工作台右上“导演模式” | 输入指令 → 生成计划 → 看干跑结果（会改 / 不会改 / 时长 / 花费 / 计划后镜头）→ 执行 → 撤销 | 状态 待执行 → 已执行 → 已撤销，提示语都出现 |

控制台错误只有备份“测试连接”那一次预期中的 502（浏览器对 5xx 资源一律打 console error）；没有页面异常，没有其它 5xx / 4xx。

## 4. 发现并修了什么

1. **导演面板的“执行 / 撤销”按钮永远禁用**（`apps/renderer/src/components/DirectorPanel.vue`）。`:disabled="!t.canApply || acting"` 里 `acting` 是字符串 ref（空串 / `apply:1`），表达式结果是 `''`，Vue 对 Boolean 类型的 prop 会把空串当 `true`，于是计划生成后谁也点不了执行。改成 `!!acting`。纯函数测试测不到模板里的类型转换，所以之前没发现。
2. **工作台框选层在视频元数据没到（或解码失败）时是 0×0**（`apps/renderer/src/views/ShotWorkbench.vue`）。`measure()` 只在 `loadedmetadata` 里调；在 Playwright 自带的开源 Chromium 里 H.264 解不了，层就一直 0×0，用户点“框选区域”也拖不出矩形。现在播放器元素一出现就量一次、`error` 事件也量，`contentBox` 在没有视频宽高时退化为整个播放器区域。Electron 自带 H.264 解码，真机上只影响元数据到达前的一瞬间，但同样的兜底是对的。
3. **云备份页“每个项目保留最近几份”下方的提示挤在数字框右边被截断**（`apps/renderer/src/views/BackupPage.vue`）。`el-form-item__content` 是 flex 容器，给 `.bk-hint` 加 `flex-basis: 100%` 让它独占一行。

e2e 过程中排除的“假问题”：截图里偶尔出现的半截标签是 Element Plus `el-tag` 的 0.3 秒 `el-zoom-in-center` 进场动画，不是样式 bug（脚本现在截图前等 400 ms）；批次在“整集重做”并发进行时被判为“有镜头没有生成最新版本（可能在批次运行期间被修改）”是设计行为（脚本改为等批次结束再重做）；分镜表顶栏“待生成 / 已过期 1”在五个镜头都“最新”时仍显示 1，是成片节点 `compose_1` 过期（内核 `staleSet` 包含它），不是镜头表的错。

## 5. 还没点到什么

- 模板市场：浏览云端模板（需要云端）、从文件安装、删除模板、套用到已有项目下一集的角色槽位映射（只跑了“新建项目”路径）、付费模板门槛（没有登录态）。
- 插件页：从文件夹安装、删除插件、启用 / 停用单个插件（只切了开发者模式）。
- 批量生成：预算上限触发暂停、夜间时段、失败重试 / 跳过（假厂商从不失败）、取消、多集批次（示例项目只有一集）。
- 云备份：真正的备份 / 快照列表 / 恢复 / 删除（没有对象存储；备份上传逻辑由另一个 worker 在改，本次不碰）。
- 改片：没有点“确认改片”（会建任务、拼接视频），A/B 对比标签页、采用某个版本。
- 导演模式：被拒绝的计划（校验失败、未知意图）、多步计划、顶栏撤销后面板的状态变化；假文本模型只回一种计划。
- 一致性：人脸分（模型未安装）、“重新评分”“自动挑参考图”按钮。
- 深色模式、窄窗口、Windows / macOS 真机、Electron 壳（本地令牌、safeStorage）都没有覆盖；渲染端四视图（剧本 / 时间线 / 画布）与登录、工作室、更新检查、公告按边界不碰。
- 本机 Chromium 不带 H.264 解码：假厂商改出 VP8/WebM 才能在 e2e 里看到播放器真的在播；真厂商的 mp4 在 Electron 里能播但在这个 e2e 里不能。

## 6. 需要你决定

- 假厂商模式是否保留在仓库里（现在只在 `TALEKILN_FAKE_VENDOR=1` 时装配，默认完全不生效）；若保留，是否顺手给桌面端加一个隐藏的开发者开关。
- e2e 要不要进 CI（需要 Playwright 浏览器与 ffmpeg，约 2 分钟）；现在只是手工命令。
- 第 5 节里未覆盖的交互，哪些值得补进脚本。
