# 代码签名与杀毒误报清单（H05）

目标：Windows 安装包与自动更新包都带有效的 Authenticode 签名，并有一套固定流程处理 SmartScreen 与杀毒软件误报。

> 铁律：证书文件、证书口令、云签名凭据只放 GitHub Secrets（或签名服务本身），**绝不提交进仓库、日志或文档**。`pnpm secrets:scan` 已拦截 `CSC_KEY_PASSWORD=` 之类赋值，但不能代替自觉。
>
> 下文涉及 CA 政策、SmartScreen 规则、各厂商入口的内容会变化，属于撰写时的认知，操作前以官方当前文档为准。

## 1. 证书方案选择

| 方案 | 说明 | 适合 | 注意 |
|---|---|---|---|
| OV（组织验证）代码签名证书 | 价格较低；需企业主体验证 | 内测 / 小范围分发 | 近年行业规则要求私钥放在硬件（USB 令牌或云 HSM），多数 CA 不再发可下载的 `.pfx`；SmartScreen 信誉要靠下载量慢慢积累 |
| EV 代码签名证书 | 验证更严、价格更高；私钥必须在硬件 / 云 HSM | 正式对外分发 | 硬件令牌无法直接用在 GitHub 托管 runner；不要把“EV 立即消除 SmartScreen 警告”当作前提 |
| 云签名服务（Azure Trusted Signing、DigiCert KeyLocker、SSL.com eSigner 等） | 私钥不出服务，CI 里通过 API 签名 | 想用 GitHub 托管 runner 又满足硬件密钥要求 | electron-builder 26 内置 `win.azureSignOptions`；其他服务通常经 `win.signtoolOptions.sign` 自定义脚本接入 |
| 自建签名机（自托管 runner + 硬件令牌） | 令牌插在自己的机器上 | 已购买 EV 令牌 | 要维护机器；令牌口令同样只放 Secrets / 机器本地 |

决策顺序建议：先确定主体（公司名要与 `publisherName` 一致）→ 选能在 CI 里无人值守签名的方案 → 再比较价格。自动更新的发布者校验依赖主体名稳定，更换主体会让旧客户端校验失败（见 `docs/auto-update.md`）。

签名参数：SHA-256 摘要 + RFC 3161 时间戳（时间戳让证书过期后已签名的包仍然有效；没有时间戳的签名会随证书过期而失效）。electron-builder 默认使用其内置时间戳服务；若要指定，用 `win.signtoolOptions.rfc3161TimeStampServer`。

## 2. electron-builder 签名环境变量（只通过 GitHub Secrets 注入）

### 方式 A：PFX 证书（仅当 CA 允许导出时）

| Secret 名 | 内容 |
|---|---|
| `WIN_CSC_LINK` | 证书文件的 base64 文本，或受保护的下载地址 |
| `WIN_CSC_KEY_PASSWORD` | 证书口令 |

electron-builder 读取 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`（通用名为 `CSC_LINK` / `CSC_KEY_PASSWORD`，Windows 专用名优先）。准备 base64 时在本机操作，用完删除临时文件，不要把命令输出贴进聊天或 issue：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Set-Clipboard
```

### 方式 B：Azure Trusted Signing

| Secret / Variable | 内容 |
|---|---|
| `AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET` | 服务主体凭据（Secrets） |
| 终结点、账户名、证书配置名 | 非敏感，可放 `package.json` 的 `build.win.azureSignOptions` 或 Variables |

### 方式 C：其他云 HSM

按服务商文档把凭据放 Secrets，经 `signtoolOptions.sign` 指向仓库内的签名脚本；脚本只读环境变量，不落盘。

### 发布者名称（自动更新校验用）

在 `apps/desktop/package.json` 的 `build.win.signtoolOptions.publisherName`（Azure 方式为 `azureSignOptions.publisherName`）填证书主体 CN，同时填 `apps/desktop/update-config.json` 的 `publisherName`。这是公开信息，不是密钥。

## 3. CI 骨架（已加入 `.github/workflows/ci.yml` 的 `package` 作业）

行为：

- 先探测 Secrets 是否存在；**没有就走未签名构建**（`CSC_IDENTITY_AUTO_DISCOVERY=false`），fork 的 PR 拿不到 Secrets，自然走这条路。
- 有 Secrets 且不是 PR 事件才签名；签名后用 `Get-AuthenticodeSignature` 校验，状态不是 `Valid` 就失败。
- 签名构建额外检查 `app-update.yml` 里有 `publisherName`（否则自动更新会跳过签名校验）。
- 产物上传包含 `latest.yml` 与 `.blockmap`，未签名与已签名分开命名，避免把未签名包误当正式包。
- Secrets 只通过 `env:` 传给需要它的单个步骤，不 `echo`，不写入文件。

当前是骨架：未在真实 Secrets 下跑过，证书到位后需要实际走一遍并按结果调整。

## 4. SmartScreen

- 症状：“Windows 已保护你的电脑”。未签名必现；已签名的新证书 / 新文件在信誉不足时也可能出现。
- 做法：
  1. 始终签名并带时间戳，文件名与发布者保持稳定（不要每个版本换证书主体）。
  2. 通过固定的 https 官方下载页分发，避免经常换直链、避免把安装包再打包进压缩壳。
  3. 信誉积累期在下载页写明“更多信息 → 仍要运行”的操作说明，给测试者的话术见 `docs/test-matrix.md`。
  4. 对被误判的具体文件，通过微软的文件提交入口申诉（Microsoft Security Intelligence 的 “Submit a file”，登录开发者账号提交，勾选“我认为文件被错误判定为恶意软件”）。

## 5. 杀毒软件误报清单

发布每个版本前：

- [ ] 签名校验通过（`Get-AuthenticodeSignature` 为 `Valid`，时间戳存在）。
- [ ] 把安装包上传 VirusTotal 看检出名单，记录版本、哈希与检出引擎（不要上传含用户数据的文件）。
- [ ] 在干净的 Windows 10 / 11 虚拟机或真机上，开启默认的 Defender 实测安装、启动、导出一次。
- [ ] 国内常见杀软各测一遍：360 安全卫士、腾讯电脑管家、火绒、Defender（真机，见测试矩阵）。
- [ ] 安装包里的 FFmpeg、`lycore` 等可执行文件同样签名（二进制不签名更容易被判可疑）。

被误报时：

1. 先确认不是真问题：重新构建、比对哈希、检查是否被第三方篡改。
2. 保存证据：杀软名称与版本、病毒库版本、拦截提示截图、文件 SHA-256。
3. 向厂商提交误报：Microsoft Defender（Security Intelligence 文件提交）；360、腾讯电脑管家、火绒、卡巴斯基等在各自官网的“误报反馈 / 文件提交”入口提交，附签名信息、官网地址、软件说明。入口地址会变，以官网当前页面为准，提交记录写进下面的台账。
4. 在发布说明与下载页同步给用户的临时处理办法（加入信任 / 恢复隔离文件），并说明如何校验 SHA-256 与签名发布者。
5. 复发预防：减少壳与自解压、不要在运行时从网络下载并执行未签名可执行文件、版本号与文件名保持稳定。

误报台账（按次追加）：

| 日期 | 版本 | 安装包 SHA-256 | 厂商 / 产品 | 症状 | 提交编号 | 结果 |
|---|---|---|---|---|---|---|
| | | | | | | |

## 6. 发布前自检摘要

- [ ] Secrets 已配置：`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`（或 Azure 三件套），确认没有任何值出现在仓库与日志里（`pnpm secrets:scan` 通过）。
- [ ] `publisherName` 三处一致：证书主体、`package.json`、`update-config.json`。
- [ ] 签名构建 CI 绿，签名校验步骤通过。
- [ ] 本地对安装包执行 `Get-AuthenticodeSignature`，并在 Windows 真机安装、升级一次。
- [ ] 杀软清单完成，台账更新。
