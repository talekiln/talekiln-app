# 三期 P3-K：可选云备份（MinIO / S3 兼容）

状态：本地服务（S3 兼容客户端、备份 / 快照 / 恢复 / 保留策略 / 自动备份、REST）、渲染进程「云备份」页、服务器 MinIO 部署手册、CI 的真实 MinIO 作业已写完；本机与渲染层自动化测试全部通过（对象存储用进程内假 S3，服务端独立重算 SigV4 签名）。**没有对真实 MinIO 跑过**（本次会话的沙箱连不上 Docker Hub），**界面没有在浏览器里点过**，见第 7 节。本文不含任何密钥或真实地址。

决定依据：Jay 定的「先自己搭 MinIO，后续再接第三方」。所以客户端只认 S3 协议，不认厂商：换阿里云 OSS（S3 兼容接口）/ 腾讯云 COS / Cloudflare R2 只改地址、区域、存储桶与寻址方式。

## 1. 做了什么

| 位置 | 作用 |
|---|---|
| `packages/local/src/backup/s3.js` | 最小 S3 客户端，无新依赖：AWS SigV4 头部签名（`node:crypto`），path-style（可切虚拟主机式），区域可配（默认 `us-east-1`），`headBucket / createBucket / putObject / getObject / headObject / deleteObject / listObjectsV2 / listAll`，手写 XML 解析；地址策略；超时与重试；`fetch` 可注入 |
| `packages/local/src/backup/service.js` | 备份服务：设置、密钥、测试连接、`backupDrama`、`listSnapshots`、`restore`、`deleteSnapshot`、`prune`、`status`、`listRuns`、每日 `tick`、`onExportFinished`；`createBackupScheduler` |
| `packages/local/migrations/34_backup_runs.sql` | `backup_runs`：每次备份 / 恢复的本地记录（离线时的快照清单兜底 + 运行历史） |
| `packages/local/src/routes/backup.js` | REST（第 3 节），在 `routes/index.js` 末尾以 `// P3-K` 块挂载 |
| `packages/local/src/app.js` | 组装：`createBackupService` + `createBackupScheduler`，用 batch 的 `attachToWorker` 挂到队列 worker 的 `start/stop`；把 `onExportFinished` 传给导出路由 |
| `packages/local/src/export/service.js` | 唯一改动：新增 `onFinished` 选项，成片导出到达 `done`（含 AIGC 标识那一步）时回调一次 `{ job_id, episode_id, output_path }` |
| `packages/local/src/errors/error-codes.json` | 新增 `BACKUP_NOT_CONFIGURED`（503）、`BACKUP_ENDPOINT_INVALID`（400）、`BACKUP_UNREACHABLE`（502）、`BACKUP_AUTH`（401）、`BACKUP_FAILED`（500）、`BACKUP_CHECKSUM`（409） |
| `apps/renderer/src/views/BackupPage.vue` | `/settings/backup`「云备份」：设置表单、测试连接、每个项目「立即备份」、云端快照（按项目分组，恢复 / 删除）、运行历史 |
| `apps/renderer/src/utils/backupView.js`、`api/backup.js` | 页面纯逻辑（地址策略、表单校验、载荷、分组、状态文案）与 axios 封装 |
| `apps/renderer/src/router/index.js`、`utils/builtinCommands.js`、`views/FilmList.vue` | 路由与命令面板「云备份」（末尾 `// P3-K` 块）；首页顶栏「云备份」按钮 |
| `packages/cloud/docker-compose.minio.yml`、`.env.example` | 可选 MinIO 服务（与主 compose 叠加），凭据只从 `.env` 读，控制台只绑 127.0.0.1 |
| `docs/tencent-deploy.md` §8 | 服务器手册：Caddy 路由、建桶与最小权限 Key、客户端设置、备份 MinIO 自己、换第三方 |
| `.github/workflows/ci.yml` `backup-minio` | ubuntu-latest 起一个一次性 MinIO 容器，等 `/minio/health/live`，用客户端自己建桶，跑 `test/backup.live.test.js` |
| `packages/local/test/backup.test.js`、`test/helpers/fakeS3.js`、`test/backup.live.test.js`、`apps/renderer/test/backupView.test.js` | 测试（第 8 节） |

备份载荷**就是「导出项目」的 ZIP**（`dramaExportService.exportDrama`，`project.json` + `media/`），恢复走 `dramaImportService.importDrama`。没有第二种项目格式；导出 / 导入格式升级时备份自然跟着升级。

## 2. 存储布局

```
<prefix>/                                 默认 talekiln；一个桶可以放多个前缀（多台机器 / 多个用户各用一个）
  dramas/<drama_id>/<时间戳>.zip          项目 ZIP（导出格式）
  dramas/<drama_id>/<时间戳>.json         清单 { drama_id, title, created_at, size, sha256, export_version, app_version }
  shared/                                 预留：工作室版共享素材库（本包不建，见第 9 节）
```

时间戳是 ISO 时间把冒号换成连字符：`2026-10-02T03-04-05.123Z`，对象键、URL、Windows 文件名都友好；`parseKey` 能从键还原出 `drama_id` 与 ISO 时间，所以快照列表不依赖清单也能排序。`drama_id` 是**备份来源机器上的** id，只用来分组；恢复总是新建项目。

## 3. 接口

全部在 `/api/v1/backup`，令牌校验由 app 级 `localTokenGuard` 统一处理。

| 方法 / 路径 | 作用 |
|---|---|
| `GET /settings` | 设置视图：`{ provider:'s3', endpoint, region, bucket, prefix, access_key, auto, keep, path_style, has_secret, configured, secret_store_available, auto_modes }`。**永远没有 Secret Key**，只有 `has_secret` |
| `PUT /settings` | 任意子集；`secret_key`：非空写入密钥存储，`null` 删除，缺省或空串不动。字段错误 400 `BAD_REQUEST`（`details.errors[]`），地址不合法 400 `BACKUP_ENDPOINT_INVALID`，密钥存储不可用 503 `SECRET_STORE_UNAVAILABLE` |
| `POST /test` | 测试连接，可带表单里尚未保存的值（`secret_key` 缺省用已保存的）：`HEAD bucket` + 对 `<prefix>/dramas/` 列举一次 → `{ ok, endpoint, bucket, region, prefix, insecure, latency_ms }` |
| `POST /dramas/:id` | 立即备份 → 201 `{ run, snapshot }`；未配置 503，项目不存在 404，连不上 502，凭据错 401 |
| `GET /snapshots?drama_id=` | `{ items: [{ key, drama_id, created_at, manifest_key, title, size, sha256, manifest, source }], source: 's3' \| 'local', offline, configured }`。本机做过的备份直接用本地记录里的标题 / sha256，其它键取清单（最多 200 个）；连不上时 `source: 'local'`、`offline: true`，列本地记录 |
| `POST /restore` | `{ key, mode: 'new' }` → 201 `{ drama_id, title, key, size, sha256, source_drama_id, run }`；只支持 `new`（其它 400），sha256 不符或没有任何校验依据 409 `BACKUP_CHECKSUM` |
| `DELETE /snapshots` | `{ key }`（或 `?key=`），zip 与清单一起删 |
| `GET /status` | `{ configured, has_secret, auto, keep, endpoint, bucket, prefix, running, current, pending, last_run, last_error, offline_since, last_daily_at, next_daily_at }` |
| `GET /runs?drama_id=&limit=` | `{ items: [backup_runs 行] }`，新的在前 |

`key` 必须符合第 2 节的布局（`<prefix>/dramas/<数字>/<时间戳>.zip`），否则 400：不能用这组接口读写桶里别的东西。

## 4. 设置与密钥

- 设置在 `global_settings` 的 `backup` 键：`{ provider:'s3', endpoint, region, bucket, prefix, access_key, auto:'off'|'daily'|'after_export', keep, path_style:true }`。`normalizeSettings` 在写入前删掉任何 `secret*` 字段，测试断言存进表里的 JSON 不含密钥。
- Secret Key 只经 `secrets.getSecretStore()`，ref `backup:s3:secret`：明文只在内存，落盘的是 Electron safeStorage 的密文（`secrets.enc.json`），与 API Key 同一套机制；密钥存储不可用时拒绝保存，不降级为明文。`redactText` 也会把它从日志里抹掉（`knownSecrets`）。
- 地址策略（客户端与渲染层各一份，测试互相对照）：`https://` 一律允许；`http://` 只允许回环（`localhost`、`*.localhost`、`127.0.0.0/8`、`::1`）或 RFC1918（`10/8`、`172.16/12`、`192.168/16`），其它 http 地址明确拒绝（公网 MinIO 必须上 Caddy / https）。不允许地址里带用户名口令、查询串、锚点；允许路径前缀（反代放在子路径时）。
- 校验：`region` 字母数字连字符；`bucket` 3–63 位小写字母 / 数字 / 点 / 连字符；`prefix` 去首尾斜杠、不含 `..`；`keep` 0–365（0 = 不清理）。
- 错误映射：网络错误 / 超时 → `BACKUP_UNREACHABLE`；403 或 `SignatureDoesNotMatch / InvalidAccessKeyId / AccessDenied / AuthorizationHeaderMalformed`（区域填错时带正确区域提示）→ `BACKUP_AUTH`；404 → `NOT_FOUND`；5xx / 429 / `SlowDown` 重试后仍失败 → `BACKUP_FAILED`（502）；301/307 → `BACKUP_FAILED` 提示区域填错。
- 重试：所有请求都幂等（PUT 同一内容、DELETE、GET、HEAD），网络错误与 5xx / 429 最多 3 次，退避 300 / 600 ms；单次超时 30 s；流式上传（`UNSIGNED-PAYLOAD`）不重试。

## 5. 自动备份

- `auto: 'daily'`：调度器在队列 worker 启动 60 s 后开始，每 15 分钟调一次 `tick()`（不阻塞启动）。`tick` 在「已配置、没有备份 / 恢复在跑、距上一轮完成 ≥ 24 h」时把所有未删除项目各备一次（`trigger: 'daily'`），**最近 24 h 内已成功备份过的项目跳过**（断网中途续跑不重复）；连不上就记日志返回，不记为完成，下一轮再试；单个项目失败记入 `backup_runs` 不影响其它项目；整轮完成后写 `global_settings.backup.last_daily_at`。
- `auto: 'after_export'`：成片导出到 `done` 后（`export/service.js` 的 `onFinished`，只在界面轮询到完成时触发一次）→ 查该集的 `drama_id` → `backupDrama(…, { trigger: 'after_export' })`；同一项目已在排队就不重复。
- 保留策略：每次备份成功后对该项目按 `keep` 清理（新的在前，多出的 zip + json 一起删）；`prune()` 可整桶清理；`keep: 0` 不清理。
- 备份与恢复串行（进程内队列），`status().running / current / pending` 给界面看。

## 6. 部署

见 `docs/tencent-deploy.md` §8：`docker-compose.minio.yml` 与主 compose 叠加启动（`MINIO_ROOT_USER/PASSWORD` 只在 `.env`，9000/9001 只绑 127.0.0.1），Caddy `s3.<域名>` → `127.0.0.1:9000`（ICP 注意事项与 API 域名相同），用容器里的 `mc` 建桶、建只能读写 `talekiln-backup/talekiln/*` 的策略与用户（管理员账号不进桌面端），备份 MinIO 的数据卷，以及换阿里云 OSS / 腾讯云 COS / Cloudflare R2 时的地址 / 区域 / 寻址对照。

## 7. 未验证

- **真实 MinIO**：本次沙箱连不上 Docker Hub，`backup-minio` CI 作业与 `test/backup.live.test.js` 一次都没跑过。签名算法对照了 AWS 公开的三组 SigV4 测试向量，假 S3 的服务端重算又是独立实现，所以协议层有把握；MinIO 对 `continuation-token`、`BucketAlreadyOwnedByYou`、虚拟主机式等细节的实际行为要看第一次 CI。
- **Windows / 桌面壳**：密钥经 safeStorage 落盘、调度器随 `aiWorker.start()` 启动都走的是现成路径，但没在真机上点过。
- **界面**：`BackupPage.vue` 只做了 `vite build` 通过和纯函数单测，没有在浏览器里打开过。
- **大项目**：ZIP 整个在内存里（导出服务本来如此），几 GB 的项目会吃内存；`putObject` 支持可读流（`UNSIGNED-PAYLOAD`）但服务没有用到。
- 第三方对象存储的地址 / 区域格式只按各家文档写了对照表，没有在真实账号上试过。
- `after_export` 依赖界面轮询到 `done`：用户导出后立刻关掉导出页，这一次就不会触发自动备份。

## 8. 怎么测

```bash
pnpm --filter ./packages/local test                        # 含 test/backup.test.js（30 条）；backup.live.test.js 无环境变量时跳过
pnpm --filter @talekiln/renderer test                      # 含 test/backupView.test.js（8 条）
pnpm --filter @talekiln/renderer build
pnpm secrets:scan

# 对真实 MinIO（本机 Docker）
docker run -d -p 9000:9000 -e MINIO_ROOT_USER=ci -e MINIO_ROOT_PASSWORD=ci-throwaway-minio minio/minio server /data
TALEKILN_TEST_S3_ENDPOINT=http://127.0.0.1:9000 TALEKILN_TEST_S3_BUCKET=talekiln-ci TALEKILN_TEST_S3_CREATE_BUCKET=1 \
TALEKILN_TEST_S3_ACCESS_KEY=ci TALEKILN_TEST_S3_SECRET_KEY=ci-throwaway-minio \
  node --test --test-reporter=spec packages/local/test/backup.live.test.js
```

`test/backup.test.js` 覆盖：SigV4 三组公开向量、`uriEncode` / 规范化查询、地址策略（允许与拒绝各十余例）、XML（实体、命名空间、续传令牌、`<Error>`、畸形文档）、对假 S3 的全部操作（含中文与空格键、分页续传、幂等删除、建桶）、服务端拒绝错 Secret / 错 Access Key / 错区域 / 被改动的载荷、5xx / 429 的退避与放弃、网络错误与超时、流式上传不重试；服务层的设置校验与密钥隔离、未配置行为、测试连接、用内置示例项目做「备份 → 列表（本地记录与清单两种来源）→ 恢复为新项目（标题加「导入1」、5 个镜头与媒体文件齐全）」、被改动的对象与缺清单的 409、保留策略（按项目、zip 与清单一起删、手动 `prune`、`keep: 0`）、串行与状态、离线（列表回落本地、备份失败记录、每日 tick 不记完成、恢复后补跑、24 h 内跳过）、单项目失败不影响整轮、`after_export` 去重；调度器（假定时器）；导出服务 `onFinished` 只触发一次且钩子抛错不影响导出；REST 全部路径与错误码。

## 9. 与工作室版的关系

桶布局里 `<prefix>/shared/` 预留给工作室版（P3-S）的共享素材库：同一个 S3 客户端、同一套签名与地址策略、同一个桶，只是前缀和权限策略不同（成员只读 `shared/`，管理员可写）。本包**没有**建它：`parseKey` 只认 `dramas/`，`shared/` 下的对象在快照列表里会被忽略。等席位、共享存储选型（自建 MinIO 还是第三方）与企业证书形式定下来再做。

## 10. 需要你决定

1. **第一次真 MinIO**：合并后看 `backup-minio` 作业；或按第 8 节在本机 Docker 跑一遍 live 测试。
2. **服务器要不要现在就起 MinIO**：`docs/tencent-deploy.md` §8 是完整步骤；`s3.<域名>` 也要走备案。
3. **默认 `keep`（现在 10）和每日备份间隔（24 h、15 分钟一查）** 是否合适；是否需要「仅在 Wi-Fi / 电源下备份」这类策略（现在没有）。
4. **要不要在导出页也放「备份」按钮**（现在只有首页顶栏、命令面板和设置页）。
