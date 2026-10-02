# Talekiln

Talekiln（中文名待定）是 Windows 桌面端 AI 短视频创作工具：故事 → 分镜 → 镜头 → 成片。用户使用自己的阿里云百炼 / 火山方舟 Key。

## 目录

| 路径 | 说明 |
|---|---|
| `apps/desktop` | Electron 主进程与打包 |
| `apps/renderer` | Vue 3 前端 |
| `packages/local` | 本地服务（Express + SQLite），只监听 127.0.0.1 |
| `docs/upstream` | 上游 LocalMiniDrama 的原始文档 |

## 开发

```bash
pnpm install
pnpm test       # 先把 better-sqlite3 切到 Node 的 ABI，再跑全部测试
pnpm dev:web    # 本地服务 :5679 + 前端 :3013
pnpm dev        # Electron（先把 better-sqlite3 切到 Electron 的 ABI）
```

仓库只有一份提升式 `node_modules`，而 `better-sqlite3` 的原生模块只能匹配一个运行时（Node 25 是 NODE_MODULE_VERSION 141，Electron 39 是 140）。上面几个脚本会自动切换；手动跑本地服务或测试前可用 `pnpm native:node` / `pnpm native:electron`（见 `scripts/native-abi.mjs`）。打包（`pnpm dist:win`）不受影响，electron-builder 会在 `.stage` 副本里自己重编。

## 许可

起点代码来自 [LocalMiniDrama](https://github.com/xuanyustudio/LocalMiniDrama)（MIT，见 `LICENSE-LocalMiniDrama`），分叉自 commit `adaecf71`。
