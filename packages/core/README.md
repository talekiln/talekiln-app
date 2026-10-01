# lycore（闭源核心骨架）

Rust crate `lycore`：以本地 JSON-RPC 2.0 服务形式运行的核心进程。当前仅为骨架，业务方法后续补充。

## 本地接口 v1

- **传输**：Windows 命名管道（如 `\\.\pipe\lycore-<id>`）；Linux/CI 开发环境回退为 Unix domain socket（路径即端点）。
- **帧格式**：换行分隔的 JSON（一行一条消息，UTF-8），协议为 JSON-RPC 2.0。
- **启动**：`lycore --pipe <端点> [--log-dir <日志目录>]`。日志通过 `tracing` 按日滚动写入 `<日志目录>/lycore.log.*`。

### 方法

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| `core.hello` | 已实现 | 握手与版本协商 |
| `licence.status` | 占位 | 返回 not implemented |
| `media.probe` | 占位 | 返回 not implemented |
| `render.start` | 占位 | 返回 not implemented |

### core.hello

请求：`{"jsonrpc":"2.0","id":1,"method":"core.hello","params":{"apiVersions":[1]}}`

`apiVersions` 为客户端支持的 API 版本整数数组；服务端选取双方共同支持的最高版本。

成功响应 `result`：`{"name":"lycore","version":"0.1.0","apiVersion":1,"build":"..."}`
（`build` 可在编译时通过环境变量 `LYCORE_BUILD` 注入。）

### 错误码

| code | 含义 |
| --- | --- |
| -32700 | 解析错误 |
| -32600 | 无效请求 |
| -32601 | 方法不存在 |
| -32602 | 参数无效（如缺少 `apiVersions`） |
| -32001 | 方法尚未实现（not implemented） |
| -32010 | API 版本不兼容；`error.data` 含 `serverApiVersions` 与 `clientApiVersions` |

## 开发与测试

```
cd packages/core
cargo build --release
cargo test
node client/test.js   # 集成测试：启动二进制并调用 core.hello
```

Node 客户端助手位于 `client/index.js`（CommonJS，无依赖）：`connectRetry(endpoint)` 返回带 `call` / `hello` / `close` 的对象。
