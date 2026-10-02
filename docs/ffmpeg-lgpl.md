# ffmpeg 的 LGPL 合规与供应方式

本文说明应用如何获取、使用并分发 ffmpeg，以及需要满足的 LGPL 义务。**不是法律意见**，正式发布前请由法务复核。

## 原则

1. **只用 LGPL 构建**：configure 不得含 `--enable-gpl`、`--enable-version3` 以外的 GPL 开关，也不得含 `--enable-nonfree`。因此不带 libx264/libx265（H.264 软件编码）；硬件编码器（NVENC/QSV/AMF/Media Foundation）属 LGPL 可用范围。`libx264` 兜底在 LGPL 构建中不可用，渲染流水线会按 `encoder.detect` 的结果回退，所有编码器都不可用时返回 -32032。若产品要求软编兜底，需另行评估许可（例如商业授权或让用户自行安装）。
2. **独立进程、动态使用**：lycore 只通过 `ffmpeg` / `ffprobe` **可执行文件的子进程**调用，不静态或动态链接 libav*。ffmpeg 保持为可单独替换的文件，用户可以换成自己编译的版本（`LYCORE_FFMPEG_DIR` 或 `ffmpegDir` 参数指向的目录）。
3. **随安装包内置**（`scripts/ffmpeg-pin.json` 固定 BtbN win64-lgpl 构建的地址与 sha256，构建时由 `scripts/fetch-ffmpeg.mjs` 下载校验，放入 `<安装目录>/resources/lycore/ffmpeg/`，LICENSE 一并随附）。首次使用时下载的路径保留为后备。无论哪种，应用向用户分发 ffmpeg 都需要履行下列义务。注意：BtbN autobuild 的旧版本可能被上游清理，发布前应把该文件转存到自有存储并更新固定地址。

**macOS**：`scripts/ffmpeg-pin.json` 已按平台分条目（schema 2），`darwin-arm64` / `darwin-x64` 目前是 TODO，没有核实过的 LGPL 预编译来源，拒绝下载；获取与自编译方案、VideoToolbox 与无 libx264 的后果见 `docs/phase2-macos.md` 第 4 节。

## 供应方式（`packages/core/client/ffmpeg-provision.js`）

- 清单 `packages/core/ffmpeg-manifest.json`：版本、各平台文件名、相对路径、**固定的 SHA-256**、大小。校验值只来自随应用发布的清单，不信任服务器返回的任何哈希。
- 下载地址 = 配置的基础地址 + 清单里的相对路径。基础地址优先级：调用参数 `baseUrl` > 环境变量 `LYCORE_FFMPEG_BASE_URL` > 代码里的占位值 `https://example.invalid/talekiln/ffmpeg/`（必然解析失败，必须配置）。地址中不得包含凭据；若用对象存储的临时签名，由调用方在运行时拼装，不写入仓库。
- 只允许 https（测试用的回环地址除外）。支持重定向与断点续传（`.part` 文件 + `Range`）；服务器不支持 Range 时自动整体重下。
- 下载完成后校验 SHA-256（以及清单里有的大小），**不一致即删除并拒绝**（`ProvisionError.code = 'sha256_mismatch'`），不会落到最终文件名。校验通过后原子改名，类 Unix 系统设置可执行位。
- 清单仍是占位（含 `TODO`、哈希不是 64 位十六进制）时，在发起任何网络请求之前就拒绝（`manifest_placeholder`）。
- 落盘位置：`<应用数据目录>/ffmpeg/<版本>/`；返回的目录直接作为 `LYCORE_FFMPEG_DIR` 传给 lycore。

### 发布前必须完成（TODO）

- [ ] 选定或自行编译 LGPL 构建，记录 `ffmpeg -version` 里的 configure 参数，确认不含 GPL/nonfree 开关；
- [ ] 把文件放到下载地址，计算 SHA-256，填入清单的 `version`、`path`、`sha256`、`size`，删除 `_comment` 里的 TODO；
- [ ] 公开对应源码与构建脚本（`sourceUrl`），并保存一份（见下）；
- [ ] 在“关于/开源许可”页加入下方声明。

## 需要履行的义务（LGPL v2.1）

- **许可文本**：随应用提供 LGPL-2.1 全文（与 ffmpeg 一起放在 `ffmpeg/` 目录或“关于”页）。
- **声明**：在“关于”页或随附文档中写明（文本见下）。
- **源码**：提供所分发 ffmpeg 版本对应的完整源码及我们应用的修改（如有）的获取方式——可以是公开链接，或书面承诺在分发后至少三年内应请求提供。
- **允许替换与逆向调试**：用户可以替换 ffmpeg 可执行文件（本设计满足）；不得在 EULA 中禁止为调试对该库的修改而做的逆向工程。
- 若自己修改了 ffmpeg，修改部分同样以 LGPL 公开。

## 声明文本（可直接放入“关于”页）

> 本软件使用 FFmpeg（https://ffmpeg.org）项目的库与工具，依据 GNU 宽通用公共许可证（LGPL）2.1 版或更高版本授权。FFmpeg 作为独立的可执行文件在单独的进程中运行，本软件未与其链接；你可以用自己编译的版本替换它（见设置中的 ffmpeg 目录）。我们分发的 FFmpeg 构建的版本号、编译参数与对应源码见：TODO 填入 sourceUrl。FFmpeg 是 FFmpeg 项目的商标。LGPL 许可证全文随应用提供，亦可见 https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html 。

## 与许可证扫描的关系

`docs/licenses.md` 记录的 sharp-libvips（LGPL）同样需要在“关于”页列出。ffmpeg 是运行期下载的第三方二进制，不进入 `pnpm licenses:check` 的依赖扫描，需靠本文的发布前清单人工把关。
