'use strict';
/**
 * Provider enablement: the single switch that decides which providers are visible.
 *
 * config.yaml:  providers: { enabled: [bailian] }   (default ['bailian'])
 *
 * Everything user-facing reads from here: registry (list/get), createProviders, queue providers,
 * /ai-tasks validation, onboarding wizard, key-page links, vendor console links, catalog filtering and
 * error/help text. Adapters for providers that are not enabled stay in the repo (hidden, not deleted).
 *
 * To add a provider: see docs/provider-extension.md (add one KNOWN_PROVIDERS entry + adapter + registry wiring).
 */

/**
 * Static facts per known provider. `aliases` are the saved-config `provider` values that map to it
 * (AI config rows store vendor-flavoured names such as 'dashscope').
 */
const KNOWN_PROVIDERS = Object.freeze({
  bailian: Object.freeze({
    id: 'bailian',
    label: '阿里云百炼',
    aliases: Object.freeze(['bailian', 'dashscope', 'aliyun', 'qwen_image', 'qwen']),
    consoleUrl: 'https://bailian.console.aliyun.com/',
    keyPageUrl: 'https://bailian.console.aliyun.com/',
    // Recognises a saved text config row by provider + base_url (scriptgen).
    textHint: /bailian|dashscope|aliyun/,
  }),
  ark: Object.freeze({
    id: 'ark',
    label: '火山方舟',
    aliases: Object.freeze(['ark', 'volces', 'volcengine', 'volcengine_omni', 'volc']),
    consoleUrl: 'https://console.volcengine.com/ark',
    keyPageUrl: 'https://console.volcengine.com/ark',
    textHint: /ark|volc|doubao/,
  }),
});

const DEFAULT_ENABLED = Object.freeze(['bailian']);

let enabled = [...DEFAULT_ENABLED];

/** Validate a list: known ids only, de-duplicated, order kept, at least one. Throws on bad input. */
function normalizeEnabled(list) {
  if (list == null) return [...DEFAULT_ENABLED];
  if (!Array.isArray(list)) throw new TypeError('providers.enabled 必须是数组');
  const out = [];
  for (const raw of list) {
    const id = String(raw || '').trim();
    if (!Object.prototype.hasOwnProperty.call(KNOWN_PROVIDERS, id)) {
      throw new TypeError(`providers.enabled 含未知服务商：${id}（已知：${Object.keys(KNOWN_PROVIDERS).join(', ')}）`);
    }
    if (!out.includes(id)) out.push(id);
  }
  if (!out.length) throw new TypeError('providers.enabled 至少启用一个服务商');
  return out;
}

/** Apply the loaded config.yaml (or a bare list). Call once at startup; tests may call it to switch sets. */
function configureEnabled(cfgOrList) {
  const list = (Array.isArray(cfgOrList) || typeof cfgOrList === 'string') ? cfgOrList : (cfgOrList && cfgOrList.providers && cfgOrList.providers.enabled);
  enabled = normalizeEnabled(list);
  return getEnabled();
}

function resetEnabled() { enabled = [...DEFAULT_ENABLED]; }
function getEnabled() { return [...enabled]; }
function isEnabled(id) { return enabled.includes(id); }

/** Meta of enabled providers, in configured order. */
function listEnabledMeta() { return enabled.map((id) => KNOWN_PROVIDERS[id]); }

/** Enabled provider id for a saved-config provider name (e.g. 'dashscope' -> 'bailian'), or null. */
function providerForAlias(name) {
  const n = String(name || '').toLowerCase();
  for (const id of enabled) if (KNOWN_PROVIDERS[id].aliases.includes(n)) return id;
  return null;
}

/** Every config-provider alias belonging to enabled providers. */
function enabledAliases() { return enabled.flatMap((id) => KNOWN_PROVIDERS[id].aliases); }

/** Human list for messages: "阿里云百炼" / "阿里云百炼或火山方舟". */
function enabledLabels(joiner = '或') { return listEnabledMeta().map((m) => m.label).join(joiner); }

module.exports = {
  KNOWN_PROVIDERS, DEFAULT_ENABLED, normalizeEnabled, configureEnabled, resetEnabled,
  getEnabled, isEnabled, listEnabledMeta, providerForAlias, enabledAliases, enabledLabels,
};
