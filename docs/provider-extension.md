# 新增服务商指南

当前只开放阿里云百炼。火山方舟（ark）的代码仍在仓库里，但默认隐藏。本文写清楚：怎样开启已有的隐藏服务商，以及怎样从零加一个新服务商。

## 1. 开关：`providers.enabled`

唯一开关在 `packages/local/configs/config.yaml`：

```yaml
providers:
  enabled:
    - bailian        # 默认只有百炼；想开方舟就加一行 - ark
```

实现在 `packages/local/src/providers/enablement.js`（启动时 `createApp` 调用 `configureEnabled(config)`；测试里可传 `createApp({ enabledProviders: [...] })` 或直接 `configureEnabled([...])`）。下面这些地方都只读这一份，不要在别处再写服务商清单：

| 位置 | 行为 |
|---|---|
| `providers/registry.js`、`providers/index.js` | `registry.list()` / `get()` 只认已开启的；未开启的适配器根本不会构造，调用得到 `PROVIDER_NOT_AVAILABLE` |
| `queue/providerAdapter.js` | `buildQueueProviders` 默认只给已开启的服务商建队列适配器；配置里 `provider` 别名取自 `KNOWN_PROVIDERS[*].aliases` |
| `routes/aiTasks.js` | `POST /ai-tasks` 的 `provider` 必须是已开启的 |
| `services/onboardingService.js`、`GET /providers` | 向导步骤、可选服务商；只开一个时去掉“选择服务商”步骤并隐含选定 |
| `cloud/referral.js`、`queue/taskView.js` | 获取 Key 的链接、任务失败时的控制台链接，只给已开启的服务商 |
| `cloud/catalog.js` | 模型目录（云端或内置）只列已开启服务商的 providers / models；价格表保留，历史任务估算不丢 |
| `services/scriptgenService.js` | “未找到可用的文本模型配置（…）”里的服务商名取自开关 |
| 渲染端 `utils/providerEnablement.js` | 通过 `GET /providers` 过滤 AI 配置页的预设厂商、一键配置按钮、模型目录映射；拉取失败按默认只开百炼 |

只想开启已有的隐藏服务商（比如方舟）：在 `enabled` 里加上它即可，向导会自动多出“选择服务商”一步，AI 配置页多出火山的预设。方舟的契约测试用的是模拟数据，默认模型名、Seedance 参数、语音鉴权头仍待真 Key 验证（见 `phase1-status.md` C03），开启前先过一遍。

## 2. 新增一个服务商：改哪些文件

下面以新服务商 `acme` 为例。按顺序做，每步都有对应的测试。

### 2.1 能力契约（只读，不要改）

业务代码只按能力调用，不碰厂商 SDK。契约写在 `packages/local/src/providers/capabilities.js` 顶部注释，共五个能力：

| 能力 | 入参 | 返回 |
|---|---|---|
| `text.stream` | `{model, messages, temperature?, maxTokens?, signal?}` | 异步迭代器：`{type:'delta', text}`…`{type:'done', text, usage?}` |
| `image.generate` | `{model?, prompt, size?, referenceImages?, negativePrompt?, signal?}` | `{urls: string[]}` |
| `video.submit` | `{model?, prompt, imageUrl?, firstFrameUrl?, lastFrameUrl?, referenceUrls?, duration?, resolution?, signal?}` | `{taskId}` |
| `video.poll` | `{taskId, signal?}` | `{status:'pending'\|'running'\|'succeeded'\|'failed', videoUrl?, usage?, actualPrompt?, error?}` |
| `tts.synthesize` | `{model?, text, voice?, format?, sampleRate?, rate?, pitch?, volume?, wordTimestamps?, signal?}` | `{audio: Buffer, format, words?: {text, startMs, endMs}[], usage?}` |

规则：

- 不支持的能力就不要放进 `capabilities`，调用会得到 `CAPABILITY_NOT_SUPPORTED`，不要自己抛别的错。
- `wordTimestamps: true` 时必须返回逐字时间戳（毫秒，从音频开头算），字幕按它切分。没有时间戳的服务商，字幕只能按整镜头显示。
- 所有失败都抛 `ProviderError`（统一错误码，见 2.6），不要把厂商的原始错误或带 Key 的 URL 抛出去。
- 新增能力名要先改 `CAPABILITIES`，registry 会拒绝未知能力名。

### 2.2 适配器 `packages/local/src/providers/acme/index.js`

适配器骨架（可直接复制，替换 `acme`、地址和请求体）：

```js
'use strict';
/**
 * Acme 适配器。服务商 id："acme"。
 * 写清楚哪些请求形态已用真 Key 验证（附录制数据位置），哪些只对着模拟数据测过。
 */
const { ProviderError, ERROR_CODES } = require('../errors');

const DEFAULT_BASE = 'https://api.acme.example';

/** 厂商错误 -> 统一错误码。顺序有讲究：余额、Key 先于笼统的 403/400。 */
function mapError(status, body, extra = {}) {
  const err = (body && typeof body.error === 'object' && body.error) || body || {};
  const vendorCode = String(err.code || err.type || '');
  const message = String(err.message || (typeof body === 'string' ? body : '') || '');
  const hay = `${vendorCode} ${message}`.toLowerCase();
  const opts = { provider: 'acme', status, vendorCode: vendorCode || null, ...extra };
  let code;
  if (/arrears|insufficient|balance|欠费|余额/.test(hay)) code = ERROR_CODES.INSUFFICIENT_BALANCE;
  else if (status === 401 || /invalid.?api.?key/.test(hay)) code = ERROR_CODES.INVALID_API_KEY;
  else if (/model.*(not|access)|未开通/.test(hay) || status === 403 || status === 404) code = ERROR_CODES.MODEL_NOT_ENABLED;
  else if (status === 429) code = ERROR_CODES.RATE_LIMITED;
  else if (status === 400) code = ERROR_CODES.INVALID_PARAMS;
  else code = ERROR_CODES.UNKNOWN;
  return new ProviderError(code, message || vendorCode || `HTTP ${status}`, opts);
}

function createAcmeAdapter(cfg = {}) {
  const apiKey = cfg.apiKey;
  const base = (cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const doFetch = cfg.fetch || ((...a) => globalThis.fetch(...a)); // 测试注入 fetch，生产用全局

  async function request(path, { method = 'POST', body, signal } = {}) {
    if (!apiKey) throw new ProviderError(ERROR_CODES.INVALID_API_KEY, '未配置 Key', { provider: 'acme' });
    let res;
    try {
      res = await doFetch(base + path, {
        method, signal, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      });
    } catch (e) {
      throw new ProviderError(ERROR_CODES.NETWORK, e.message, { provider: 'acme' }); // 注意：消息里不能带 Key
    }
    return res;
  }

  async function readJson(res) {
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { /* 留空 */ }
    if (!res.ok) throw mapError(res.status, data || raw);
    if (!data) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '非 JSON', { provider: 'acme' });
    return data;
  }

  async function imageGenerate({ model, prompt, size, referenceImages, signal }) {
    const data = await readJson(await request('/v1/images', { body: { model: model || 'acme-img-1', prompt, size, refs: referenceImages }, signal }));
    const urls = (data.data || []).map((d) => d.url).filter(Boolean);
    if (!urls.length) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '未返回图片', { provider: 'acme' });
    return { urls };
  }

  // 只实现服务商真有的能力；其余留空，registry 会回 CAPABILITY_NOT_SUPPORTED。
  // C05 连通测试：每个能力一个零费用或近零费用的探测，返回 { ok, costly }，失败抛 ProviderError。
  const probes = {
    async 'image.generate'({ model, signal } = {}) {
      const res = await request('/v1/images', { body: { model: model || 'acme-img-1', prompt: '1', size: '1*1' }, signal });
      if (res.status === 400) return { ok: true, costly: false }; // 先验 Key 和模型，再拒参数 = 没有生成任何东西
      await readJson(res);
      return { ok: true, costly: true };
    },
  };

  return { id: 'acme', label: 'Acme', probes, capabilities: { 'image.generate': imageGenerate } };
}

module.exports = { createAcmeAdapter, mapError };
```

要点：

- 适配器不读环境变量、不读配置文件；Key、`baseUrl`、`fetch` 都由调用方传入（`cfg`）。
- 同步接口（图像、配音）在 `submit` 里一次完成；异步接口（视频）拆成 `video.submit` / `video.poll`。队列适配器（`queue/providerAdapter.js`）会自己把同步结果编码进任务 ID，适配器不用管。
- 工作空间域名、WebSocket 等特殊地址放在适配器里推导（百炼适配器是榜样），不要让用户手填两处。

### 2.3 登记服务商

三处各加一条，都在 `packages/local/src`：

1. `providers/enablement.js` 的 `KNOWN_PROVIDERS`：

   ```js
   acme: Object.freeze({
     id: 'acme',
     label: 'Acme',
     aliases: Object.freeze(['acme']),              // AI 配置里 provider 字段可能的取值（小写）
     consoleUrl: 'https://console.acme.example/',   // 任务失败时的“去控制台”链接
     keyPageUrl: 'https://console.acme.example/keys', // 添加 Key 向导打开的官方密钥页
     textHint: /acme/,                              // 用 provider + base_url 认出文本配置（脚本生成用）
   }),
   ```

   `queue/providerAdapter.js` 的别名表、`cloud/referral.js` 的密钥页、`queue/taskView.js` 的控制台链接都从这里派生，不用再改。

2. `providers/index.js` 的 `createProviders` 里加一行（只为已开启的服务商构造适配器）：

   ```js
   if (cfg.acme && enablement.isEnabled('acme')) registry.register(createAcmeAdapter(cfg.acme));
   ```

3. `queue/providerAdapter.js` 的 `facadeConfigFor`：如果服务商除了 Key 和 `baseUrl` 还要别的凭据（方舟语音要 AppID + Token），在这里从配置的 `settings` 里取；没有就不用改。若默认模型需要按请求形态调整，参考同文件的 `modelFitsRequest`。

另外：

- `configs/config.yaml` 的 `ai_queue.limits` 加 `acme: 3`（该服务商的并发上限，不写则用 `default`）。
- 云端 `packages/cloud/src/services/referral.service.ts`（默认推广落地页）和 `catalog.service.ts`（目录种子）各加一条，运营后台才能下发它的模型和推广链接。云端 `/r/:code` 只会跳到白名单主机：`DEFAULT_LINKS` 里的主机自动进白名单，推广链接用别的主机时要加进环境变量 `REFERRAL_ALLOWED_HOSTS`。

### 2.4 夹具与契约测试

- 真 Key 验证：写一个类似 `packages/local/scripts/bailian-live.js` 的手动脚本，Key 只从环境变量读。录下的响应一律先过 `packages/local/scripts/lib/redact.js`，存到 `packages/local/test/fixtures/acme/`，真实录制的文件名以 `live_` 开头，模拟的不带前缀。
- 契约测试 `packages/local/test/providers.acme.test.js`，参照 `providers.bailian.test.js` / `providers.ark.test.js`，用注入的 `fetch` 回放夹具。每个能力至少覆盖：
  - 正常返回（含 usage、逐字时间戳等可选字段）
  - 无效 Key → `INVALID_API_KEY`；模型未开通 → `MODEL_NOT_ENABLED`；余额不足 → `INSUFFICIENT_BALANCE`；限流 → `RATE_LIMITED`；参数错误 → `INVALID_PARAMS`；视频任务级失败 → `TASK_FAILED`；网络错误 → `NETWORK`；非 JSON 或缺字段 → `BAD_RESPONSE`
  - 错误消息和日志里不出现 Key
- 连通测试：`providers.probe.test.js` 里加该服务商的探测用例（每个能力 `{ok, costly}`，Key / 模型 / 余额错误互相区分）。
- 开关测试：测试文件顶部显式开启，因为默认只开百炼：

  ```js
  require('../src/providers/enablement').configureEnabled(['bailian', 'acme']);
  ```

  并在 `providers.enablement.test.js` 里补一条“未开启时 registry / 队列 / 目录 / 密钥页都看不到它”的断言。
- 模拟数据与真实数据要分开标注：没用真 Key 验证过的字段，在适配器注释和 `docs/phase1-status.md` 里写明“待验证”。

### 2.5 目录与价格

- `packages/local/configs/prices.json` 的 `providers.acme` 下按 `image` / `video` / `tts` 写条目，`per` 取 `image` / `second` / `char`，视频可加 `by_resolution`；`_default` 兜底。价格表驱动花费估算和上限，**没有条目就按 0 估算且 `known:false`**，花费守卫等于失效，所以必须配。当前价格是示例价，上线前换成云端下发的真实价格。
- 本地内置目录 `cloud/catalog.js` 的 `bundledCatalog` 从价格表条目推出模型清单（`_` 开头的不列），所以给每个要展示的模型单独写一条价格。
- 云端目录（`catalog.service.ts`）下发时 `providers` / `models` / `prices` 要带上 `acme`；本地只展示已开启服务商的模型。

### 2.6 错误映射与文案

- 厂商错误只通过适配器里的 `mapError` 变成 `ERROR_CODES`（`providers/errors.js`），业务代码只认统一码。
- 新服务商的特殊错误字符串，先在 `mapError` 里加匹配，再在夹具里放一条录制的错误响应，测试里断言映射结果。
- 需要全新的统一码时：先改 `packages/local/src/errors/error-codes.json`，再改 `providers/errors.js` 的 `ERROR_CODES` 与 `READABLE`，`errorCodes.test.js` 会校验两边文案一致；渲染端 `apps/renderer/src/utils/aiTaskView.js` 的 `READABLE` 要同步。
- 任务中心的“去控制台”链接来自 `KNOWN_PROVIDERS[*].consoleUrl`，渲染端 `aiTaskView.js` 的 `VENDOR_CONSOLES` 是服务端没给 `console_url` 时的兜底，也要加一条。

### 2.7 首次引导向导与 AI 配置页文案

- 向导：`apps/renderer/src/utils/onboarding.js` 的 `PROVIDERS` 加一条（`id`、`name`、`tagline`、`configProvider`、`baseUrl`、`defaultModel`、`consoleUrl`、`instructions` 至少 3 步）。是否显示由服务端 `providers.enabled` 决定（`visibleProviders`），开了两个以上服务商时向导才多出“选择服务商”一步。
- AI 配置页：`apps/renderer/src/components/AIConfigContent.vue` 的 `providerConfigs`（按服务类型的预设厂商）、`providerProtocolMap`、`getBaseUrlForProvider` 各加该服务商；一键配置按钮用 `v-if="oneKeyVisible(enabledProviders, 'acme')"` 控制。预设厂商的 `id` 必须出现在 `KNOWN_PROVIDERS.acme.aliases` 里，否则会被开关过滤掉。
- 模型目录下拉：`utils/providerEnablement.js` 的 `providerIdForConfig` 用 `aliases` 把配置里的厂商名映射到目录里的服务商 id，不用改。
- 同步更新渲染端测试 `apps/renderer/test/onboarding.test.js`、`providerEnablement.test.js`。

### 2.8 最后一步：开启并自检

1. `config.yaml` 的 `providers.enabled` 加上 `acme`。
2. `pnpm secrets:scan` 与 `pnpm test`。
3. 起本地服务，`GET /api/v1/providers` 应返回新服务商；向导应出现“选择服务商”；AI 配置页有它的预设；`POST /api/v1/ai-tasks` 接受 `provider: "acme"`。
4. 用真 Key 跑 `scripts/bailian-e2e.mjs` 的同类脚本（目前该脚本固定走百炼，要复用需把 `provider` 和模型参数化），再对照 `docs/bailian-flow-coverage.md` 逐步骤填一张新服务商的覆盖表。

## 3. 检查清单

- [ ] `providers/<id>/index.js`：五个能力里实际支持的，`mapError`，`probes`
- [ ] `providers/enablement.js`：`KNOWN_PROVIDERS` 一条
- [ ] `providers/index.js`：注册一行（带 `isEnabled`）
- [ ] `queue/providerAdapter.js`：`facadeConfigFor`（仅在需要额外凭据时）
- [ ] `configs/config.yaml`：`ai_queue.limits`；需要时 `providers.enabled`
- [ ] `configs/prices.json`：价格条目
- [ ] `test/fixtures/<id>/` 与 `test/providers.<id>.test.js`、`providers.probe.test.js`
- [ ] 云端：`referral.service.ts`（含 `REFERRAL_ALLOWED_HOSTS`）、`catalog.service.ts`
- [ ] 渲染端：`utils/onboarding.js`、`AIConfigContent.vue`、`utils/aiTaskView.js` 及对应测试
- [ ] `docs/phase1-status.md`：写清哪些已用真 Key 验证、哪些还只是模拟数据
