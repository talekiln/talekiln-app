# P2-F：macOS 适配（Linux 侧工作）

范围：在没有 Mac 的云端环境里，把代码里会在 macOS 上坏的地方审出来、改掉、用“参数注入平台”的单测钉住；补 macOS 的 CI 构建作业、ffmpeg 获取方案、签名公证骨架与文档。

> **先说结论：以下全部没有在真实 macOS 上运行过。** 能确认的只有：Rust 在 `aarch64-apple-darwin` / `x86_64-apple-darwin` 目标上 `cargo check` 通过（含 `--tests`，只做类型检查，没有链接也没有运行），以及各平台分支在 Linux 上用注入的 `platform` 参数通过了单测。其余（Electron 行为、签名、公证、VideoToolbox、libass 字体、Keychain、通知、托盘）都必须借一台 Mac 验证，见第 5 节清单。
>
> 涉及 Apple 政策、证书类型、公证命令、GitHub runner 标签的内容会变化，属于撰写时的认知，操作前以官方当前文档为准。

## 1. 改了什么

| # | macOS 上会坏的点 | 修复 | 测试（均不依赖真 Mac） |
|---|---|---|---|
| 1 | Unix 域套接字路径超长：macOS 的 `sun_path` 只有 104 字节（Linux 108），`$TMPDIR` 形如 `/var/folders/xx/…/T/`，叠加长路径会 `bind` 失败 | `makeEndpoint` 用 `pickSocketPath`：放不下就退到 `/tmp`，仍放不下直接抛错，不留到 bind 时才报（`apps/desktop/platform.js`、`core-runtime.js`） | `platform.test.js`：104 字节边界、回退、抛错、Windows 命名管道不变 |
| 2 | 套接字文件权限与残留：绑定后权限取决于 umask；进程被终止后文件残留 | `lycore` 绑定后 `chmod 0600`；收到 SIGTERM/SIGINT/SIGHUP 时正常返回并删除套接字（`packages/core/src/main.rs`，tokio 增加 `signal` 特性） | `client/signals.integration.test.js`（Linux 上真跑：退出码 0、套接字被删、权限 0600） |
| 3 | 进程看护：Electron 崩溃或被强杀后 lycore 变孤儿；SIGTERM 默认直接终止，运行中的 ffmpeg 子进程残留 | 返回 main 时 tokio 运行时被丢弃，`kill_on_drop` 会带走 ffmpeg；新增“父进程消失即退出”：监督器给子进程设 `LYCORE_WATCH_PARENT=1`，lycore 每秒检查 `getppid`，变化则退出（仅 Unix；不设该变量则行为不变） | 同上（孤儿退出、不设变量仍存活）；`parent_changed` 单测 |
| 4 | `.exe` 后缀与可执行位：`lycore`/`ffmpeg` 文件名按平台；解压/拷贝可能丢 x 位；fetch 脚本解出的文件没有 x 位 | `exeName(platform)`、`resolveLycoreBin/resolveFfmpeg` 接受 `platform`；启动前 `ensureExecutable`（失败只记日志）；`fetch-ffmpeg.mjs` 写入 0755；`pack-desktop.mjs` 按平台选 `lycore`/`lycore.exe` 与 `--win`/`--mac --<arch>` | `platform.test.js`、`scripts/platform-lib.test.mjs` |
| 5 | 路径与大小写：concat 列表把反斜杠一律改成 `/`——在 macOS/Linux 上反斜杠是合法文件名字符，会指向别的文件 | `concat_line_for(path, windows)`，只有 Windows 才换；单引号仍按 concat 规则转义；中文路径与空格有用例 | `render/tests.rs` |
| 6 | 应用数据目录：`~/Library/Application Support/talekiln`；大小写不敏感文件系统 | 抽出 `userDataDir`，目录名固定小写 `talekiln`（与 Windows 现有位置一致，不迁移数据） | `platform.test.js` |
| 7 | safeStorage：macOS 走 Keychain，首次访问会弹授权；换签名身份后旧密文可能无法解密；Linux 无钥匙环时退化为 `basic_text`（等同明文） | `guardSafeStorage`：Linux 的 `basic_text`/`unknown` 后端按“不可用”处理（拒绝保存，与现有“不降级明文”原则一致）；macOS/Windows 行为不变 | `platform.test.js` |
| 8 | 托盘与 Dock：macOS 菜单栏图标应是模板图；关掉最后一个窗口不应退出应用；点 Dock 图标应重开窗口 | `trayOptions` 在 macOS 对图标 `setTemplateImage(true)`；`window-all-closed` 与关窗逻辑按平台；新增 `activate` → `lifecycle.reopen()` | `platform.test.js`（lifecycle on macOS） |
| 9 | 应用菜单：原来 `Menu.setApplicationMenu(null)`，在 macOS 上 ⌘C/⌘V/⌘A/⌘Z/⌘Q/⌘W/⌘M 全部失效（这些键位来自菜单项的 role） | `buildAppMenuTemplate`：macOS 返回应用/编辑/窗口三个菜单；Windows/Linux 仍为无菜单 | `platform.test.js` |
| 10 | 快捷键 Ctrl/⌘：匹配层早已把 `ctrlKey || metaKey` 都当 `Ctrl`，但显示仍写 Ctrl | `formatCombo` 在 macOS 显示 ⌘/⌥/⇧（⇧⌘Z）；命令面板的快捷键提示走它；键位存储格式不变 | `apps/renderer/test/macShortcuts.test.js` |
| 11 | 编码器检测：只认 NVENC/QSV/AMF/Media Foundation | `encoder.detect` 增加 `h264_videotoolbox`（vendor `apple`，排在 libx264 之前）；`encoder_args` 增加 `-b:v 10M -allow_sw 0`；新增 macOS LGPL 构建的 `-encoders` 夹具 | `encoder.rs`、`render/tests.rs` |
| 12 | 字体与 libass：默认字幕字体 “Microsoft YaHei” 在 macOS 不存在；水印用的字体文件路径只有 Windows 与一个过时的 PingFang 路径 | macOS 默认 “PingFang SC”（其他平台不变）；水印字体按平台候选列表选第一个存在的；lycore 新增 `fontsDir` 参数 / `LYCORE_FONTS_DIR` / `<lycore 目录>/fonts` 自动探测，作为 `subtitles` 滤镜的 `fontsdir`（含两层滤镜转义，Windows 盘符冒号与 macOS 路径里的 `'`、`,` 都处理） | `platformFonts.test.js`、`render/tests.rs` |
| 13 | 打包：包内必须带 `platform.js`（否则主进程 `require` 失败）；macOS 目标、hardened runtime、entitlements、内置可执行文件单独签名 | `apps/desktop/package.json` 增加 `build.mac`、`dist:mac`；`apps/desktop/build/entitlements.mac.plist`；`pack-desktop.mjs` 把签名相关路径改绝对 | `platform-lib.test.mjs` 断言 `build.files` 覆盖 main.js 里所有本地 `require` |

### 复核过、没有改动的差异（需知道）

- **GUI 应用的 PATH 很短**（`/usr/bin:/bin:/usr/sbin:/sbin`），Homebrew 的 `/opt/homebrew/bin` 不在里面。生产环境靠随包 ffmpeg，不受影响；开发时若依赖 `PATH` 里的 ffmpeg，从 Finder/Dock 启动会找不到，从终端 `pnpm dev` 启动则可以。`locate` 的 PATH 回退保持原样，没有硬编码 Homebrew 路径（避免悄悄用上 GPL 版 ffmpeg）。
- **系统通知**：macOS 要求用户授权，未签名应用的通知行为不稳定；免打扰/专注模式会吞掉。代码层已有 `isSupported()` 与 try/catch，没有改动，要真机看。
- **托盘图标仍是占位纯色块**：macOS 模板图要求黑色 + 透明，换正式图标前菜单栏里会是黑方块。
- **自动更新**：`updater-logic.js` 以 `publisherName`（Windows Authenticode 概念）作启用开关；macOS 的更新依赖 electron-updater 的 `MacUpdater`，要求应用已签名且发布 `zip`（已在 `build.mac.target` 里加了 zip）。macOS 是否沿用同一开关、还是另设条件（例如团队 ID）**需要决定**，目前未改；macOS 自动更新完全未验证。
- **Unicode 规范化**：macOS 文件名可能是 NFD（带声调字母分解形式），同一个名字用 NFC 比较会不相等。中文汉字不受影响；拉丁带声调字符受影响。素材去重和缓存键里若按路径字符串比较，需在真机上试“同名不同规范化”的文件。未改动。
- **大小写不敏感文件系统**：APFS 默认不区分大小写，`A.mp4` 与 `a.mp4` 是同一个文件；Windows 同理，行为一致，不需改动。
- **Rosetta / 架构**：打包只出宿主架构的 lycore 与原生模块；arm64 包不能直接在 Intel 上运行。universal 包未做。
- **旧的 `packages/local/src/services/videoMergeService.js` 等**里仍有 `process.platform === 'win32'` 判断，已看过，macOS 走非 Windows 分支，没有发现问题。

## 2. 测试与验证状态

| 项 | 结果 |
|---|---|
| `cargo test`（packages/core，Linux） | 52 通过（原 45，本次新增 7） |
| `cargo check` / `cargo check --tests` 目标 `aarch64-apple-darwin`、`x86_64-apple-darwin` | 通过（仅类型检查）；另检查了 `x86_64-pc-windows-msvc` 也通过 |
| core 的 Node 集成测试（含新增 signals） | 通过（Linux） |
| `apps/desktop` | 68 通过（原 42，新增 26） |
| `packages/local` | 481 通过（含新增 4） |
| `apps/renderer`（受影响的 shortcuts 与新增 macShortcuts） | 18 通过 |
| `scripts`（open-source-export + platform-lib） | 15 通过 |
| `pnpm secrets:scan` | 通过 |
| 真实 macOS 上任何东西 | **未验证** |
| CI 的 `package-macos` 作业 | **从未跑过**（YAML 已解析通过，仅此而已） |

## 3. CI：`package-macos` 作业

- 位置：`.github/workflows/ci.yml`，依赖 `test` 作业。
- 矩阵：`arm64`（`macos-14`，主，必须通过）+ `x64`（`macos-15-intel`，实验，`continue-on-error`）。**选 arm64 为主**：现役 Mac 以 Apple 芯片为主；better-sqlite3 与 sharp 的原生模块按同架构构建最稳，不做交叉编译。runner 标签以 GitHub 当前文档为准，Intel 镜像会下线。
- 作业会在真 macOS 上跑：`pnpm --filter @talekiln/core test`（cargo + Node 集成，含套接字与信号）、`pnpm --filter @talekiln/desktop test`；全量 `pnpm test` 作为“摸底”步骤（`continue-on-error`），其余包没在 macOS 上跑过，稳定后应改成必须通过。**这是不借 Mac 也能拿到的第一批真机结果。**
- ffmpeg：`node scripts/fetch-ffmpeg.mjs` 在 macOS 条目仍为 TODO 时退出码 3，步骤 `continue-on-error`，产物名带 `-NOFFMPEG`，包内没有 ffmpeg（导出会提示媒体工具缺失）。
- 未签名构建：先对 `lycore` 与 ffmpeg 做 **ad-hoc 签名**（`codesign --force --sign -`）——arm64 上完全无签名的 Mach-O 无法运行；这不是身份签名，产物只能内部测试。打包用 `-c.mac.identity=null`。
- 签名/公证骨架（与 Windows 同样的“有 Secrets 才执行”）：

| Secret 名（只写名字，值不进仓库） | 用途 |
|---|---|
| `MAC_CSC_LINK` | “Developer ID Application” 证书（.p12）的 base64 文本；步骤里经 env 映射为 electron-builder 读取的 `CSC_LINK` |
| `MAC_CSC_KEY_PASSWORD` | 该 .p12 的口令（映射为 `CSC_KEY_PASSWORD`） |
| `APPLE_ID` | 公证用的 Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | App 专用口令（不是 Apple ID 登录密码） |
| `APPLE_TEAM_ID` | 开发者团队 ID（10 位字母数字） |

  行为：证书 Secrets 齐全且不是 PR → 签名；再加上三项公证 Secrets → 追加 `-c.mac.notarize=true`；之后跑 `codesign --verify --deep --strict`，公证时再跑 `spctl --assess` 与 `xcrun stapler validate`。这些命令没有在真实环境执行过；`mac.binaries` 的路径写法（相对 `.app` 内）、entitlements 是否足够（公证被拒时按日志增减）、`notarize` 的配置键，都按 electron-builder 26 的文档核对。
- 文件名 `latest-mac.yml`（electron-updater 的 macOS 元数据）与 `.zip` 一并上传。

## 4. ffmpeg：macOS 的 LGPL 构建获取与校验

### 现状与限制

- `scripts/ffmpeg-pin.json` 改为 schema 2，按 `${platform}-${arch}` 分条目；`win32-x64` 条目内容与原先完全一致（BtbN win64-lgpl），新增 `darwin-arm64`、`darwin-x64`，**url / sha256 / version 全是 `TODO`**。
- 我没有为 macOS 编造任何地址或哈希，也没有核实出一个可以直接用的 macOS LGPL 预编译来源：BtbN 不提供 macOS 构建；常见的 macOS 静态包与 Homebrew 的 ffmpeg 通常带 `libx264`/`libx265` 等 GPL 组件（Homebrew 的还会 `--enable-gpl`），不符合本项目“只用 LGPL、不带 `--enable-gpl`/`--enable-nonfree`”的原则（`docs/ffmpeg-lgpl.md`）。第三方站点的构建许可证与稳定性必须在使用前逐个核实，本次未核实。
- `selectPin` 遇到占位直接抛错；`fetch-ffmpeg.mjs` 退出码 3，不发任何网络请求。`packages/core/ffmpeg-manifest.json`（运行时按需下载那条路径）同样补了 `darwin-arm64`/`darwin-x64` 的占位条目，沿用“含 TODO 即拒绝”的现有逻辑。

### 建议方案（待执行）

1. **自己编译**（推荐）：在 macOS（arm64 与 x64 各一台，或在 arm64 上交叉）用 FFmpeg 官方源码，configure 不含 `--enable-gpl`、`--enable-nonfree`、`--enable-libx264`、`--enable-libx265`，启用 `--enable-videotoolbox`、`--enable-audiotoolbox`，并带 libass（字幕烧录必需；其依赖 freetype、fribidi、harfbuzz 需确认各自许可）。参数建议起点，**未在真机验证**：`--disable-gpl --disable-nonfree --enable-videotoolbox --enable-libass --enable-static --disable-shared --disable-doc`。只需 `ffmpeg` 与 `ffprobe` 两个可执行文件。
2. 编译产物按 `scripts/ffmpeg-pin.json` 的 `layout: "flat"` 打成**一个 zip**（含 `ffmpeg`、`ffprobe`、LGPL 许可文本），传到自有存储；zip 的 SHA-256 用自己的机器对**实际文件**计算后填入对应条目的 `sha256`，`version` 写 ffmpeg 版本号，`url` 写 https 地址，`source` 写源码与 configure 参数的公开地址（同时填 `docs/ffmpeg-lgpl.md` 的声明）。
3. 用 `ffmpeg -version` 核对 configure 行不含 GPL/nonfree 开关，`ffmpeg -encoders | grep videotoolbox` 与 `ffmpeg -filters | grep subtitles` 都要有。
4. 公证要求内置可执行文件也签名：CI 里 electron-builder 会重签；自己编译的产物还需 hardened runtime，见第 6 节。
5. 没有 libx264 的后果（与 Windows 的 BtbN LGPL 构建相同）：`libx264` 兜底不可用，macOS 上靠 `h264_videotoolbox`；`h264_videotoolbox` 不可用（例如虚拟机里没有硬件编码器）时导出会报“所有编码器均失败”。是否需要软编兜底属产品与许可决策（见 `docs/ffmpeg-lgpl.md` 原则 1）。

## 5. 必须真 Mac 验证的清单

结果请写进 `docs/macos-test-results/<日期>.md`（每项：通过/失败、现象、复现步骤、日志片段；日志中不得出现任何 Key、令牌）。

**启动与进程**
- [ ] 未签名包首次打开：右键“打开”或 `xattr -dr com.apple.quarantine`；记录 Gatekeeper 提示原文。arm64 的 ad-hoc 签名内置二进制能否运行。
- [ ] `pnpm dev` 在 macOS 上启动；`lycore` 起得来，`~/Library/Application Support/talekiln/main.log` 里有 `lycore ready`。
- [ ] 在 `$TMPDIR` 很长（例如 `TMPDIR` 指向深层目录）时仍能启动（验证回退到 `/tmp`）。
- [ ] 活动监视器里 `kill -9` Electron 主进程后，`lycore` 与其 ffmpeg 子进程在几秒内消失；⌘Q 正常退出后没有残留，也没有残留的 `.sock` 文件。
- [ ] 运行时 `ls -l $TMPDIR/talekiln-lycore-*.sock` 权限为 `srw-------`。

**导出与编码**
- [ ] `encoder.detect`：`h264_videotoolbox` 为 available；Apple 芯片与 Intel 各看一次。
- [ ] 用 VideoToolbox 导出 1080p/720p 横竖屏各一条，播放正常、码率合理（固定 10M 是否过大/过小需看画质与体积）。
- [ ] 中文路径、带空格路径、带单引号与反斜杠的路径、外置硬盘、iCloud 桌面目录下导入素材与导出。
- [ ] 带声调的拉丁文件名（NFD）素材：缓存命中与去重是否正常。

**字幕与字体**
- [ ] 字幕烧录成功（ffmpeg 含 libass 的 `subtitles` 滤镜）；中文字幕不出现豆腐块；默认字体 “PingFang SC” 能被 CoreText 找到。
- [ ] 水印文字字体：`/System/Library/Fonts/PingFang.ttc` 在当前 macOS 版本是否存在；候选列表里实际命中哪一个。
- [ ] 放一个 `<lycore 目录>/fonts` 或设置 `LYCORE_FONTS_DIR`，`fontsdir` 是否生效，路径含空格/引号时是否正常。

**界面与系统集成**
- [ ] 应用菜单：⌘C/⌘V/⌘X/⌘A/⌘Z/⇧⌘Z（文本框内）、⌘Q、⌘W、⌘M、⌘H。
- [ ] 命令面板 ⌘K、时间线 ⌘Z/⇧⌘Z、PR 键位预设、自定义键位录入（含 ⌥+数字、⌥+字母）；显示是否为 ⌘/⌥/⇧。
- [ ] 菜单栏托盘图标：是否为模板图（深浅色自适应）、菜单项、点击行为；关窗后应用仍在 Dock、点 Dock 图标重开窗口；有未完成任务时 ⌘Q 的确认框。
- [ ] 系统通知：授权弹窗、点击聚焦窗口、专注模式下的表现；签名前后对比。
- [ ] 睡眠唤醒后任务对账恢复（`powerMonitor` 的 `resume`）。
- [ ] 深色模式、Retina 显示、多显示器。

**密钥存储**
- [ ] 保存 API Key 时 Keychain 授权弹窗；重启应用后 Key 仍在；点“拒绝”后的表现（应拒绝保存并给出提示，不得降级明文）。
- [ ] 从未签名包换成签名包（身份变化）后，旧密文能否解密；解密失败时界面是否让用户重填 Key（目前代码静默忽略失败条目，体验需确认）。

**签名、公证与更新（有 Apple 账号后）**
- [ ] `codesign --verify --deep --strict`、`spctl --assess --type execute`、`xcrun stapler validate` 全部通过；包内 lycore/ffmpeg/ffprobe 均已带 hardened runtime 签名。
- [ ] 在从没装过的 Mac 上下载 dmg（带隔离属性）安装并启动，无拦截。
- [ ] entitlements 是否足够（公证被拒或启动崩溃时看日志）；`disable-library-validation` 能否去掉。
- [ ] 自动更新：zip + `latest-mac.yml`，旧版升级到新版；`publisherName` 开关在 macOS 的取舍。

## 6. Apple 开发者账号与公证流程

> 以下按撰写时对 Apple 流程的认知整理，名称、价格、入口、命令可能已变化；以 Apple Developer 官网与 `notarytool`/electron-builder 当前文档为准。**证书、.p12、口令只放 GitHub Secrets，不进仓库、日志、聊天或文档。**

1. **加入 Apple Developer Program**：个人或组织主体。组织需要 D-U-N-S 编号与可核验的法人信息，审核周期按天到周计；年费以官网为准。**主体名就是以后证书里的开发者名**，应与产品运营主体一致（与 Windows 的 `publisherName` 同理）。账号需开启双重认证。
2. **创建证书**：在 developer.apple.com → Certificates 创建 “Developer ID Application” 证书（用于 Mac App Store 之外分发）。用本机“钥匙串访问”生成证书签名请求（CSR），上传后下载 `.cer` 并双击装入钥匙串。注意 Developer ID 证书通常只有账号持有者（Account Holder）能创建。
3. **导出 .p12**：钥匙串里右键该证书（连同私钥）导出为 `.p12`，设置导出口令。本机转 base64（例如 `base64 -i cert.p12 | pbcopy`），粘进 GitHub Secret `MAC_CSC_LINK`，口令放 `MAC_CSC_KEY_PASSWORD`；用完删除本机临时文件。
4. **公证凭据**：在 appleid.apple.com → 登录与安全 → App 专用密码，生成一个专用口令放 `APPLE_APP_SPECIFIC_PASSWORD`；Apple ID 邮箱放 `APPLE_ID`；Team ID 在开发者网站 Membership 页，放 `APPLE_TEAM_ID`。也可改用 App Store Connect API 密钥方式（electron-builder 另有对应环境变量），更适合无人值守。
5. **构建**：Hardened Runtime 必须开启（`build.mac.hardenedRuntime`，已设）；内置的 `lycore`、`ffmpeg`、`ffprobe` 与原生模块（`.node`、libvips 动态库）都要被签名并带时间戳（electron-builder 签名时会遍历签；`build.mac.binaries` 是兜底）；entitlements 见 `apps/desktop/build/entitlements.mac.plist`。
6. **公证**：electron-builder 在 `-c.mac.notarize=true` 且环境变量齐全时调用苹果的 `notarytool`（Xcode 13 起的命令行工具，取代已停用的 `altool`）提交并等待结果，成功后对 `.app` 做 staple。手工等价命令：`xcrun notarytool submit <zip或dmg> --apple-id … --team-id … --password … --wait`，再 `xcrun stapler staple <app或dmg>`。被拒时 `xcrun notarytool log <submission-id>` 看原因（常见：内置二进制未签名、缺 hardened runtime、缺时间戳、签名身份不一致）。
7. **验收**：`codesign --verify --deep --strict --verbose=2 Talekiln.app`；`spctl --assess --type execute --verbose=2 Talekiln.app`；`xcrun stapler validate Talekiln.app`；在另一台干净 Mac 上下载安装（带隔离属性）确认无拦截。
8. **发布**：dmg 供首次下载，zip + `latest-mac.yml` 供 electron-updater；更换证书主体会影响自动更新（macOS 的 Squirrel.Mac 校验新旧包签名身份一致，具体规则以 electron-updater 文档为准）。

Mac App Store 上架（沙盒、不同证书与描述文件）不在本工作包范围内，且与“本地 lycore 子进程 + 内置 ffmpeg”的架构冲突较大，未评估。

## 7. 分工与交接

- **云端会话（本包）**：已完成代码审查与修复、CI 骨架、ffmpeg 方案与文档；分支 `p2f`（基于 `claude/phase2-foundation-mxao0h`），提交留在本地分支，未 push。
- **本地 Windows 会话（Jay）**：**无法验证 macOS**，不要把“Windows 上通过”当作 macOS 通过。合并 `p2f` 后只需在 Windows 上做回归：`pnpm test`（desktop/local/core）、`pnpm dist:win` 出包、安装后确认托盘、退出确认、导出、密钥保存仍正常；本包动了 `apps/desktop/main.js`（菜单、`activate`/`window-all-closed`、userData 路径、safeStorage 包装）、`core-runtime.js`、`lifecycle.js`、`supervisor.js`（多传一个环境变量），Windows 分支的逻辑都保持原行为，但这几个文件是之前本地会话改过的，请留意冲突。
- **需要借一台 Mac**：第 5 节清单只有真 Mac 能做；最好有 Apple 芯片和 Intel 各一台（或一台 Apple 芯片 + Rosetta 跑 x64 包做粗测，Rosetta 不能替代 Intel 真机上的 VideoToolbox 验证）。短期替代：GitHub 的 macOS runner 能拿到编译与自动化测试结果（`package-macos` 作业），但不能做界面、托盘、通知、Keychain、Gatekeeper 的交互验证。
- **需要 Jay 决定或办理**：Apple Developer Program 账号与主体；是否接受“macOS 只靠 VideoToolbox、无软编兜底”；macOS 自动更新的启用条件；ffmpeg 自编译由谁做（需要一台 Mac）。
