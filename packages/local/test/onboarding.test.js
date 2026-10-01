const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const secrets = require('../src/secrets');
const aiConfigService = require('../src/services/aiConfigService');
const onboarding = require('../src/services/onboardingService');
const enablement = require('../src/providers/enablement');

const log = { info() {}, warn() {}, error() {}, errorw() {}, warnw() {} };
// Fake key assembled at runtime so no key-like literal sits in the repo.
const FAKE_KEY = ['t', 'e', 's', 't'].join('') + '-' + crypto.randomBytes(8).toString('hex');

function openDb() {
  const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onb-')), 't.db'));
  runMigrationsAndEnsure(db);
  return db;
}

function memStore() {
  return new secrets.FileSecretStore({ cipher: secrets.createAesCipher(crypto.randomBytes(32)) });
}

describe('onboarding state', () => {
  before(() => secrets.setSecretStore(memStore()));
  after(() => { secrets.setSecretStore(null); enablement.resetEnabled(); });
  beforeEach(() => enablement.resetEnabled());

  it('is needed on a fresh database, starting at welcome', () => {
    const st = onboarding.getStatus(openDb());
    assert.deepEqual({ needed: st.needed, step: st.step, has_key: st.has_key }, { needed: true, step: 'welcome', has_key: false });
  });

  it('defaults to bailian only: no provider-choice step, provider implied', () => {
    const st = onboarding.getStatus(openDb());
    assert.deepEqual(st.providers, [{ id: 'bailian', label: '阿里云百炼' }]);
    assert.deepEqual(st.steps, ['welcome', 'key', 'test', 'done']);
    assert.equal(st.provider, 'bailian');
  });

  it('shows the provider step again once a second provider is enabled', () => {
    enablement.configureEnabled(['bailian', 'ark']);
    const db = openDb();
    const st = onboarding.getStatus(db);
    assert.deepEqual(st.steps, ['welcome', 'provider', 'key', 'test', 'done']);
    assert.deepEqual(st.providers.map((p) => p.id), ['bailian', 'ark']);
    assert.equal(st.provider, null);
    assert.equal(onboarding.saveState(db, { provider: 'ark' }).provider, 'ark');
  });

  it('refuses a provider that is not enabled', () => {
    const db = openDb();
    assert.throws(() => onboarding.saveState(db, { provider: 'ark' }), /服务商/);
  });

  it('resumes the saved step and provider; skipping hides it', () => {
    const db = openDb();
    onboarding.saveState(db, { step: 'key', provider: 'bailian' });
    let st = onboarding.getStatus(db);
    assert.equal(st.step, 'key');
    assert.equal(st.provider, 'bailian');
    assert.equal(st.needed, true);
    st = onboarding.saveState(db, { dismissed: true });
    assert.equal(st.needed, false);
    assert.equal(st.step, 'key');
  });

  it('rejects unknown steps and providers', () => {
    const db = openDb();
    assert.throws(() => onboarding.saveState(db, { step: 'nope' }), /步骤/);
    assert.throws(() => onboarding.saveState(db, { provider: 'openai' }), /服务商/);
    assert.throws(() => onboarding.saveState(db, { config_id: 'x' }), /配置/);
  });

  it('stops being needed once a key is configured, and never exposes it', () => {
    const db = openDb();
    const cfg = aiConfigService.createConfig(db, log, { service_type: 'text', name: 'w', provider: 'dashscope', base_url: 'https://example.invalid/v1', api_key: FAKE_KEY, model: ['m'] });
    const st = onboarding.getStatus(db);
    assert.equal(st.has_key, true);
    assert.equal(st.needed, false);
    assert.ok(!JSON.stringify(st).includes(FAKE_KEY));
    assert.ok(!JSON.stringify(aiConfigService.getConfig(db, cfg.id)).includes(FAKE_KEY));
  });
});

describe('onboarding connectivity test', () => {
  before(() => secrets.setSecretStore(memStore()));
  after(() => secrets.setSecretStore(null));

  function withConfig() {
    const db = openDb();
    const cfg = aiConfigService.createConfig(db, log, { service_type: 'text', name: 'w', provider: 'dashscope', base_url: 'https://example.invalid/v1', api_key: FAKE_KEY, model: ['qwen-plus'] });
    return { db, id: cfg.id };
  }

  it('calls the connection test with the server-side key', async () => {
    const { db, id } = withConfig();
    let seen;
    const r = await onboarding.testSavedConfig(db, id, { testConnection: async (o) => { seen = o; } });
    assert.deepEqual(r, { ok: true });
    assert.equal(seen.api_key, FAKE_KEY);
    assert.equal(seen.base_url, 'https://example.invalid/v1');
  });

  it('turns failures into 400 errors with the key redacted', async () => {
    const { db, id } = withConfig();
    await assert.rejects(
      onboarding.testSavedConfig(db, id, { testConnection: async () => { throw new Error(`bad ${FAKE_KEY}`); } }),
      (e) => e.status === 400 && !e.message.includes(FAKE_KEY) && e.message.includes('[REDACTED]'),
    );
  });

  it('404 for unknown config, 400 when no key saved', async () => {
    const { db } = withConfig();
    await assert.rejects(onboarding.testSavedConfig(db, 9999, { testConnection: async () => {} }), (e) => e.status === 404);
    const empty = aiConfigService.createConfig(db, log, { service_type: 'text', name: 'e', provider: 'dashscope', base_url: 'https://example.invalid/v1', api_key: '', model: [] });
    await assert.rejects(onboarding.testSavedConfig(db, empty.id, { testConnection: async () => {} }), (e) => e.status === 400);
  });
});
