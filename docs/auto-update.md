# 自动更新（H04）

## 组成

| 文件 | 作用 |
|---|---|
| `apps/desktop/update-config.json` | 更新源与渠道配置（占位值） |
| `apps/desktop/updater-logic.js` | 纯逻辑：配置解析与启用判定、版本比较、对话框文案（有单元测试） |
| `apps/desktop/updater.js` | 控制器：封装 electron-updater，依赖全部注入（有假对象测试） |
| `apps/desktop/main.js` | 接线：`setupUpdater()`；托盘菜单“检查更新 / 安装更新” |
| `apps/desktop/package.json` 的 `build.publish` | 让 electron-builder 产出 `latest.yml`（占位 URL） |

## 行为

- 启动后延迟 `checkOnStartDelayMs`（默认 15 秒）检查一次，之后每 `checkIntervalHours`（默认 6 小时）检查一次。自动检查是静默的：没有更新或失败只写 `main.log`。
- 手动检查：托盘菜单“检查更新”，有结果弹窗（已是最新 / 发现新版本 / 失败原因）。目前没有渲染进程按钮（渲染进程沙箱下没有 preload，加按钮需要先加受限 IPC，留待后续）。
- 发现新版本后在后台下载；下载完成后弹窗询问“立即重启并安装 / 稍后”，默认“稍后”。选稍后后托盘菜单变为“安装更新 x.y.z”，可随时点。
- 从不静默安装：`autoInstallOnAppQuit = false`；`allowDowngrade = false`。远端版本不高于当前版本时忽略。
- 有未完成 AI 任务时弹窗会提示；真正退出时仍会走原有的“仍有任务在运行”确认（`lifecycle.js`），升级后任务自动恢复，不会重复提交。
- 开发模式、未配置、占位地址、非 https、渠道不合法、未配置 `publisherName` 时，更新功能保持关闭（见 `resolveConfig`），不会影响应用启动；`electron-updater` 缺失同样只记日志。

## 配置

`update-config.json`：

```json
{
  "feedUrl": "https://updates.example.invalid/talekiln",
  "channel": "latest",
  "publisherName": "",
  "checkOnStartDelayMs": 15000,
  "checkIntervalHours": 6
}
```

环境变量覆盖（便于测试渠道）：`TALEKILN_UPDATE_URL`、`TALEKILN_UPDATE_CHANNEL`（`latest` 或 `beta`）。`TALEKILN_UPDATE_ALLOW_UNSIGNED=1` 仅用于内部未签名测试，正式包不要设置。

上线前要改的地方（两处必须一致）：

1. `apps/desktop/update-config.json` 的 `feedUrl`、`publisherName`
2. `apps/desktop/package.json` 的 `build.publish[0].url`，以及 `build.win.signtoolOptions.publisherName`（或 Azure Trusted Signing 的 `azureSignOptions.publisherName`），详见 `docs/release-signing.md`

## 签名校验说明（重要）

electron-updater 在 Windows 上做两层校验：

1. **sha512**：安装包下载后与 `latest.yml` 里的 `sha512` 比对。`latest.yml` 与安装包来自同一个源，所以这一层只能防传输损坏，**不能防更新源被攻破**。
2. **Authenticode 发布者校验**：`win.verifyUpdateCodeSignature`（本仓库已显式设为 `true`）。校验使用打包时写入 `app-update.yml` 的 `publisherName`。**如果构建时没有配置 `publisherName`，electron-updater 会直接跳过这一步**（源码 `NsisUpdater.verifySignature`：`publisherName == null` 时返回 null）。

因此本实现要求：运行时配置里没有 `publisherName` 就不启用更新；CI 打包后要检查 `app-update.yml` 里确实有 `publisherName`（`docs/release-signing.md` 的 CI 骨架里有对应步骤）。`update-config.json` 里的 `publisherName` 只是启用开关，真正用于校验的是打包时写进 `app-update.yml` 的值，两者要保持一致。

其他要点：

- 更新源只接受 https，且不能带账号口令。
- 校验失败（签名不符、sha512 不符）时 electron-updater 触发 `error` 事件，控制器只记录日志、不安装。
- 证书续期或更换主体时，旧版本客户端按旧 `publisherName` 校验新包会失败，需要提前规划（先让新证书包含旧主体名，或发一版过渡包）。
- 密钥、证书、口令不进配置文件，见 `docs/release-signing.md`。

## 更新源格式（云端实现不在本任务范围内）

采用 electron-updater 的 `generic` provider：纯静态文件目录，任何支持 https 的对象存储 / CDN 均可。

```
https://<feed>/                 ← feedUrl
├── latest.yml                  ← 稳定渠道元数据
├── beta.yml                    ← 测试渠道元数据（channel = beta 时读取）
├── Talekiln-1.3.0.exe          ← NSIS 安装包（artifactName 见 package.json）
└── Talekiln-1.3.0.exe.blockmap ← 差分更新用，可选但建议一并上传
```

`latest.yml` 示例（由 electron-builder 生成，不要手写；数值为示意）：

```yaml
version: 1.3.0
files:
  - url: Talekiln-1.3.0.exe
    sha512: <base64 编码的 sha512>
    size: 123456789
path: Talekiln-1.3.0.exe
sha512: <同上>
releaseDate: '2026-10-01T00:00:00.000Z'
```

可选字段：`releaseNotes`、`minimumSystemVersion`、`stagingPercentage`（0–100，灰度发布）。

服务端要求：

- 必须 https；`latest.yml` / `beta.yml` 设置 `Cache-Control: no-cache`（或很短的 max-age），安装包可长缓存。
- 发布顺序：先传安装包与 blockmap，最后传 yml，避免客户端读到指向不存在文件的元数据。
- 支持 HTTP Range（差分下载需要）。
- 回滚：把 yml 指回旧版本不会让已升级的客户端降级（`allowDowngrade = false`）；要撤回坏版本，需发一个更高版本号的修复版。
- 渠道：`channel: beta` 的客户端读取 `beta.yml`（同时 `allowPrerelease = true`），`latest` 读取 `latest.yml`。

## 测试与验证状态

- 已有单元测试：`apps/desktop/test/updater.test.js`（版本比较、配置判定、占位地址关闭、安全选项、静默/手动检查、确认后才安装、同版本不重复弹窗、错误不触发安装、托盘文案）与 `lifecycle.test.js` 中的托盘扩展项。
- 未验证：真实 Electron + electron-updater 联动、真实 Windows 下的 Authenticode 校验、差分下载、`quitAndInstall` 与托盘“关闭即隐藏”的交互、更新源服务本身。需要签名后的安装包在 Windows 真机上走一遍（见 `docs/test-matrix.md`）。
