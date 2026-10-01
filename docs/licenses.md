# 依赖许可证清单

生成方式：`pnpm install` 后运行 `pnpm licenses list --json`（覆盖整个工作区，含 devDependencies，共 436 个包）。
复查命令：`pnpm licenses:check`（脚本 `scripts/licenses-check.mjs`）。遇到 GPL / AGPL 退出码为 1；LGPL、未知许可证只告警。
扫描日期：2026-10-01。

## 统计

| 许可证 | 包数 | 备注 |
|---|---|---|
| MIT | 333 | 可商用 |
| ISC | 39 | 可商用 |
| BSD-3-Clause | 26 | 可商用，需保留版权声明 |
| Apache-2.0 | 14 | 可商用，需保留 NOTICE |
| BSD-2-Clause | 7 | 可商用 |
| BlueOak-1.0.0 | 7 | 宽松 |
| (MIT OR WTFPL) / (WTFPL OR MIT) / WTFPL OR ISC | 3 | 双许可，取 MIT / ISC |
| WTFPL | 1 | 宽松，见下 |
| (BSD-2-Clause OR MIT OR Apache-2.0)、(MIT OR CC0-1.0)、0BSD、Python-2.0 | 各 1 | 宽松 |
| **LGPL-3.0-or-later** | 2 | 需关注，见下 |
| GPL / AGPL | 0 | 无 |
| 未知 / UNLICENSED | 0 | 无 |

## 需关注项

1. **LGPL-3.0-or-later：`@img/sharp-libvips-*`**（sharp 的预编译 libvips，当前平台为 linux-x64 与 linuxmusl-x64；Windows 打包时会换成 `@img/sharp-libvips-win32-x64`，同为 LGPL）。
   - 以动态链接的独立 `.node` / `.dll` 形式分发，不修改 libvips，一般可商用。
   - 要求：安装包与「关于」页附带 LGPL 全文与来源声明；允许用户替换该库（不要把它静态打进单一可执行文件）。
   - 打包前需在 Windows 目标上重新扫描一次（`pnpm licenses:check` 在 CI 的 Windows runner 上跑）。
2. **WTFPL（1 个包）**：宽松但法务口径不一，建议在法务评审时确认；目前只在构建链上，不影响分发。
3. **ffmpeg 不在依赖扫描范围内**：`packages/local/tools/ffmpeg/` 由用户或安装包放置二进制。若随包分发，必须选 LGPL 构建（不含 `--enable-gpl` / `--enable-nonfree`），否则整个安装包落入 GPL 义务。待定项。
4. **Electron / Chromium 自带许可证**：随 electron-builder 产出 `LICENSES.chromium.html`，需在「关于」页链接（A04 待办）。
5. **LocalMiniDrama 上游代码**：根目录 `LICENSE-LocalMiniDrama` 为上游许可证，须保留；商用条款以该文件为准，上线前需法务确认（扫描工具无法覆盖）。

## 未覆盖

- 前端 CDN 字体 / 图标资源、`apps/renderer/public` 与 `assets` 内的图片素材许可未扫描。
- 将来新增的 `core / cloud / admin` 包加入工作区后自动被 `pnpm licenses` 覆盖。
