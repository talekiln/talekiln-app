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
| `files`（可选） | 签名覆盖的相对路径列表（不含 `manifest.json`），必须包含 `entry`；签名工具会自动填 |
| `signature`（可选） | `{ alg: "ES256", kid, value }`，见下文「签名」 |

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

## 签名

签名证明"包来自登记的作者且没被改过"，不证明无害。宿主只把**官方 JWKS**（与云端目录、许可证同一把 ES256 密钥）验签通过的包当作 `official`；
没有签名的是 `unsigned`，其余一切（格式错、`kid` 未知、文件被改/缺失/多出、符号链接）是 `invalid`。`unsigned` / `invalid` 的包只有宿主打开"开发者模式"时才会加载。

签的是 `canonicalJson({ manifest: <去掉 signature 的清单>, files: { "<相对路径>": "<sha256>" } })`，ES256（P-256，IEEE P1363）+ base64url，
`manifest.files` 列出覆盖的文件（不含 `manifest.json`，必须含 `entry`）。`sha256(载荷)` 是**包指纹**，宿主界面和云端注册表都显示它，签名前后不变。

```bash
node scripts/sign-plugin.mjs ./my-plugin --inspect          # 不需要密钥：文件、哈希、指纹（提交云端登记用）
TALEKILN_PLUGIN_SIGNING_KEY_FILE=/secure/key.pem \
node scripts/sign-plugin.mjs ./my-plugin --kid lic-1        # 写回 manifest.json；--out <file> 写到别处；--dry-run 只算不写
```

私钥只从 `TALEKILN_PLUGIN_SIGNING_KEY_FILE`（路径）或 `TALEKILN_PLUGIN_SIGNING_KEY_PEM`（内容，`\n` 转义）读，永远不要作为参数传、不要提交。
一般作者不持有官方私钥：把 `--inspect` 的输出交给云端注册表登记、审核，由云端签名后把 `signedManifest` 写回包里即可（流程见 `docs/phase3-plugins.md`）。

程序接口（只依赖 `node:crypto`）：`signManifest(manifest, dir, privateKey, { kid, files? })` → `{ manifest, hash, files }`；
`verifySignature(manifest, dir, keys, { strict = true })` → `{ ok, status, reason, kid, hash, files }`，`keys` 可以是 JWKS `{keys:[]}`、JWK 数组、单个 JWK、
公钥对象/PEM 或 `(kid) => key` 函数；还有 `canonicalJson / listPluginFiles / hashFiles / signingPayload / payloadHash / resolveKey`。测试用 `node:crypto` 临时生成密钥对。

## 接入宿主

```js
const sdk = require('@talekiln/plugin-sdk');
const { toRegistryAdapter } = require('@talekiln/plugin-sdk/bridge');
const inst = sdk.instantiate(sdk.loadPlugin(dir), { apiKey });          // 校验清单与适配器，注入受限 fetch
registry.register(toRegistryAdapter(inst, { ProviderError, secrets: [apiKey] }));
```

`bridge` 不依赖宿主：`ProviderError` 由宿主传入；`secrets` 里的值会从错误文本里抹掉。接入测试见 `packages/local/test/pluginBridge.test.js`。
本仓库的本地服务已经这样接好（`packages/local/src/plugins/`）：启动时扫描 `<数据目录>/plugins/*/manifest.json`，`readPluginManifest` 校验清单（不执行代码），
`verifySignature` 对官方 JWKS 的离线缓存验签，按上面的信任规则决定是否 `loadPlugin`，再注册进服务商注册表和任务队列。插件 id 追加在内置服务商开关之后，永远不能覆盖内置 id。
插件应**自带一份 SDK 的错误类**（像 `examples/acme` 那样复制 `PluginError` / `ERROR_CODES`），宿主按 `code` 字段桥接错误，不要求插件 `require` 宿主的 SDK 实例。

## Trust model（信任模型，必读）

- 插件在宿主进程里运行，**没有沙箱**。`permissions` 是声明式权限：宿主给插件的 `ctx.fetch` 只放行 https 和清单里的主机，且不跟随重定向；
  `apiKey` 只在声明 `secret:apiKey` 时才传入。但插件代码仍可 `require('node:https')` 绕过 `ctx.fetch`。
- 所以权限只是"诚实声明 + 契约测试 + 代码审查"，不能当作对恶意插件的防护。签名把"谁发布的、有没有被改"这件事钉死，审核把关内容；只安装官方签名的或你自己写的插件。
- 路线：插件放进独立进程或 worker（无网络、无 fs，经消息通道调用宿主的受限 fetch）。未实现。

## 版本

`SDK_VERSION` 在 `src/constants.js`。主版本变更表示不兼容；次版本只加字段/能力。新增能力名要同步改宿主 `capabilities.js` 和本包。
