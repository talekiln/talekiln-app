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
pnpm test
pnpm dev:web   # 本地服务 :5679 + 前端 :3013
pnpm dev       # Electron
```

## 许可

起点代码来自 [LocalMiniDrama](https://github.com/xuanyustudio/LocalMiniDrama)（MIT，见 `LICENSE-LocalMiniDrama`），分叉自 commit `adaecf71`。
