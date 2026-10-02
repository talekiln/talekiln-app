# @talekiln/plugin-sdk（MIT，第一版 0.1.0）

厂商适配器插件的类型、清单校验、适配层和契约测试工具。零运行时依赖，CommonJS，Node >= 18。
SDK 与插件使用 MIT；宿主（界面、本地服务）使用 AGPL-3.0，二者通过本 SDK 的接口交互。

## 插件长什么样

一个文件夹：`manifest.json` + 入口文件。完整例子见 `examples/acme/`（对着虚构的 `api.acme.example`，所有请求形态都是编的）。

```json
{
  "name": "acme",
  "version": "0.1.0",
  "sdkVersion": "1.0.0",
  "capabilities": ["llm.chat", "image.generate", "video.submit", "video.poll", "tts.synthesize"],
  "permissions": ["network:api.acme.example", "secret:apiKey"],
  "entry": "index.js"
}
```

| 字段 | 规则 |
|---|---|
| `name` | `^[a-z][a-z0-9-]{1,39}$`，即服务商 id |
| `version` | 插件自己的 semver |
| `sdkVersion` | 写插件时所用 SDK 版本；主版本必须与宿主相同，次版本不得高于宿主 |
| `capabilities` | 只能取 `llm.chat`、`image.generate`、`video.submit`、`video.poll`、`tts.synthesize`；`video.submit` 与 `video.poll` 必须成对 |
| `permissions` | 至少一个 `network:<主机名>`（或 `*.域名`，不许 `*`、不许带协议/端口/路径）；`secret:apiKey` 表示需要用户的 Key |
| `entry` | 插件目录内的相对 `.js` / `.cjs` 路径，不许 `..` 和绝对路径 |

入口导出 `createAdapter(ctx)`，返回适配器：

```js
module.exports = {
  createAdapter(ctx) { // ctx: { apiKey?, baseUrl?, fetch, log }
    return {
      capabilities: { 'image.generate': async ({ prompt }) => ({ urls: [/* ... */] }) },
      probe: async (capability, opts) => ({ ok: true, costly: false }), // 可选
      mapError: (status, body) => new PluginError('INVALID_API_KEY', '...'),
    };
  },
};
```

能力入参出参与 `packages/local/src/providers/capabilities.js` 一致，类型见 `src/index.d.ts`。唯一的改名：插件侧叫 `llm.chat`，
宿主 registry 里叫 `text.stream`；`llm.chat` 可以返回 `Promise<{text, usage?}>`，也可以返回 delta/done 事件的异步迭代器，适配层会转成流。

规则（契约测试会检查）：

1. 只用 `ctx.fetch` 联网；不读环境变量和配置文件；Key 只来自 `ctx.apiKey`。
2. 所有失败抛 `PluginError`，错误码只能取 `ERROR_CODES`（与宿主 `ProviderError` 同名同值）。
3. 错误文本里不得出现 Key（网络错误不要原样转发 `e.message`）。
4. `mapError` 永不抛异常；余额、Key 的匹配要排在笼统的 403/400 之前。
5. 清单声明的能力必须全部实现，实现的必须全部声明。

## 契约测试

```js
const test = require('node:test');
const sdk = require('@talekiln/plugin-sdk');
const { registerContract } = require('@talekiln/plugin-sdk/contract');
registerContract(test, sdk.loadPlugin(__dirname + '/..'), require('./spec'));
```

`spec` 提供每个能力的合法入参、模拟的成功回复、各错误码对应的厂商错误回复（见 `src/contract.js` 顶部注释，例子在 `test/spec.acme.js`）。
标准用例：成功形态、只走 https 和已授权主机、网络失败 → `NETWORK` 且不泄露 Key、非 JSON → `BAD_RESPONSE`、缺 Key → `INVALID_API_KEY` 且不发请求、
错误矩阵（经能力调用和直接调 `mapError` 两条路）、`mapError` 对怪输入不抛、失败任务、越权主机被拒、连通测试返回 `{ok, costly}`。全部用模拟 HTTP，不联网。

## 接入宿主

```js
const sdk = require('@talekiln/plugin-sdk');
const { toRegistryAdapter } = require('@talekiln/plugin-sdk/bridge');
const inst = sdk.instantiate(sdk.loadPlugin(dir), { apiKey });          // 校验清单与适配器，注入受限 fetch
registry.register(toRegistryAdapter(inst, { ProviderError, secrets: [apiKey] }));
```

`bridge` 不依赖宿主：`ProviderError` 由宿主传入；`secrets` 里的值会从错误文本里抹掉。接入测试见 `packages/local/test/pluginBridge.test.js`。
注意：宿主的服务商开关（`providers/enablement.js`）仍然管可见性，插件 id 要先出现在开关里才会被 `registry.list()` 列出。
本版没有改宿主的启动流程：还没有"扫描插件目录并自动注册"，这是下一步。

## Trust model（信任模型，必读）

- 插件在宿主进程里运行，**没有沙箱**。`permissions` 是声明式权限：宿主给插件的 `ctx.fetch` 只放行 https 和清单里的主机，且不跟随重定向；
  `apiKey` 只在声明 `secret:apiKey` 时才传入。但插件代码仍可 `require('node:https')` 绕过 `ctx.fetch`。
- 所以 0.1 版的权限只是"诚实声明 + 契约测试 + 代码审查"，不能当作对恶意插件的防护。只安装你信任的插件。
- 路线：插件放进独立进程或 worker（无网络、无 fs，经消息通道调用宿主的受限 fetch），再提供签名和插件市场审核。未实现。

## 版本

`SDK_VERSION` 在 `src/constants.js`。主版本变更表示不兼容；次版本只加字段/能力。新增能力名要同步改宿主 `capabilities.js` 和本包。
