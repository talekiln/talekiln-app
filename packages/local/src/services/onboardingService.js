'use strict';
/** C06: first-run wizard state. Keys are NOT stored here; they go through the normal AI config + secret store. */
const aiConfigService = require('./aiConfigService');
const secrets = require('../secrets');

const STEPS = ['welcome', 'provider', 'key', 'test', 'done'];
const enablement = require('../providers/enablement');
const KEY = 'onboarding_state';

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`);
}

function readState(db) {
  ensureSchema(db);
  const row = db.prepare('SELECT value FROM global_settings WHERE key = ?').get(KEY);
  try { return row ? JSON.parse(row.value) || {} : {}; } catch (_) { return {}; }
}

function hasConfiguredKey(db) {
  return aiConfigService.listConfigs(db).some((c) => c.is_active && c.has_api_key);
}

/** Key 不是在向导里保存的（例如在「AI 配置」页填的）时，向导没记下 config_id；退回到当前有 Key 的配置，让连通测试一步可达。 */
function fallbackConfigId(db) {
  const c = aiConfigService.listConfigs(db).find((c) => c.is_active && c.has_api_key);
  return c ? c.id : null;
}

/** Wizard steps for the current enablement: the provider-choice step is skipped when only one is enabled. */
function stepsFor(providerIds = enablement.getEnabled()) {
  return providerIds.length > 1 ? STEPS : STEPS.filter((s) => s !== 'provider');
}

/** needed = no key configured yet and the user has not dismissed the wizard. */
function getStatus(db) {
  const st = readState(db);
  const hasKey = hasConfiguredKey(db);
  const dismissed = !!st.dismissed;
  const enabled = enablement.getEnabled();
  return {
    needed: !hasKey && !dismissed,
    has_key: hasKey,
    dismissed,
    step: STEPS.includes(st.step) ? st.step : 'welcome',
    // With a single enabled provider it is implied, so the wizard never asks.
    provider: enabled.includes(st.provider) ? st.provider : (enabled.length === 1 ? enabled[0] : null),
    providers: enablement.listEnabledMeta().map((m) => ({ id: m.id, label: m.label })),
    steps: stepsFor(enabled),
    config_id: Number.isInteger(st.config_id) ? st.config_id : fallbackConfigId(db),
  };
}

/** Merge a validated partial state. Unknown fields are ignored; bad values throw status-400 errors. */
function saveState(db, patch) {
  const p = patch || {};
  const bad = (m) => { const e = new Error(m); e.status = 400; return e; };
  if (p.step !== undefined && !STEPS.includes(p.step)) throw bad('无效的步骤');
  if (p.provider !== undefined && p.provider !== null && !enablement.isEnabled(p.provider)) throw bad('无效的服务商');
  if (p.config_id !== undefined && p.config_id !== null && !Number.isInteger(p.config_id)) throw bad('无效的配置 ID');
  const next = { ...readState(db) };
  for (const k of ['step', 'provider', 'config_id']) if (p[k] !== undefined) next[k] = p[k];
  if (p.dismissed !== undefined) next.dismissed = !!p.dismissed;
  db.prepare('INSERT INTO global_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(KEY, JSON.stringify(next), new Date().toISOString());
  return getStatus(db);
}

/** Connectivity test of a saved config, resolved server-side so the key never returns to the browser. */
async function testSavedConfig(db, configId, deps = {}) {
  const test = deps.testConnection || aiConfigService.testConnection;
  const cfg = aiConfigService.listConfigsInternal(db).find((c) => c.id === Number(configId));
  if (!cfg) { const e = new Error('配置不存在'); e.status = 404; throw e; }
  if (!cfg.api_key) { const e = new Error('尚未保存 API Key'); e.status = 400; throw e; }
  try {
    await test({
      base_url: cfg.base_url,
      api_key: cfg.api_key,
      model: cfg.default_model || cfg.model,
      provider: cfg.provider,
      endpoint: cfg.endpoint,
      service_type: cfg.service_type,
    });
  } catch (err) {
    const e = new Error(secrets.redactText(err.message || '未知错误'));
    e.status = 400;
    throw e;
  }
  return { ok: true };
}

module.exports = { STEPS, stepsFor, getStatus, saveState, testSavedConfig, hasConfiguredKey };
