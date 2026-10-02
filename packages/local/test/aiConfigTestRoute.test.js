'use strict';
/** POST /ai-configs/test：列表接口只回掩码 Key（C04），所以带 id 测试已保存配置时要在服务端用真 Key。 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const secrets = require('../src/secrets');
const aiConfigService = require('../src/services/aiConfigService');
const aiConfigRoutes = require('../src/routes/aiConfig');

const log = { info() {}, warn() {}, error() {} };
const FAKE_KEY = ['t', 'e', 's', 't'].join('') + '-' + crypto.randomBytes(8).toString('hex');

function openDb() {
  const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-')), 't.db'));
  runMigrationsAndEnsure(db);
  return db;
}
function mockRes() {
  const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
  return r;
}
async function call(db, body, impl) {
  const orig = aiConfigService.testConnection;
  aiConfigService.testConnection = impl;
  try {
    const res = mockRes();
    await aiConfigRoutes(db, log, {}).testConnection({ body }, res);
    return res;
  } finally { aiConfigService.testConnection = orig; }
}

describe('ai-configs test route with saved configs', () => {
  before(() => secrets.setSecretStore(new secrets.FileSecretStore({ cipher: secrets.createAesCipher(crypto.randomBytes(32)) })));
  after(() => secrets.setSecretStore(null));

  it('uses the saved key when the browser sends the masked one back with the config id', async () => {
    const db = openDb();
    const cfg = aiConfigService.createConfig(db, log, { service_type: 'text', name: 'w', provider: 'dashscope', base_url: 'https://example.invalid/v1', api_key: FAKE_KEY, model: ['qwen-plus'] });
    const listed = aiConfigService.listConfigs(db).find((c) => c.id === cfg.id);
    assert.ok(secrets.isMaskedKey(listed.api_key), 'list returns a masked key');
    let seen;
    const res = await call(db, { id: cfg.id, base_url: listed.base_url, api_key: listed.api_key, model: listed.model, provider: listed.provider, service_type: listed.service_type }, async (o) => { seen = o; });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(seen.api_key, FAKE_KEY);
    assert.equal(seen.base_url, 'https://example.invalid/v1');
  });

  it('a raw key typed into the form still wins over the saved one', async () => {
    const db = openDb();
    const cfg = aiConfigService.createConfig(db, log, { service_type: 'text', name: 'w', provider: 'dashscope', base_url: 'https://example.invalid/v1', api_key: FAKE_KEY, model: ['qwen-plus'] });
    let seen;
    await call(db, { id: cfg.id, base_url: 'https://example.invalid/v1', api_key: 'typed-' + FAKE_KEY }, async (o) => { seen = o; });
    assert.equal(seen.api_key, 'typed-' + FAKE_KEY);
  });

  it('masked key without a usable id is a 400, not a request to the vendor', async () => {
    const db = openDb();
    let called = false;
    const res = await call(db, { id: 9999, base_url: 'https://example.invalid/v1', api_key: '****abcd' }, async () => { called = true; });
    assert.equal(res.code, 400);
    assert.equal(called, false);
    const res2 = await call(db, { base_url: 'https://example.invalid/v1', api_key: '****abcd' }, async () => { called = true; });
    assert.equal(res2.code, 400);
    assert.equal(called, false);
  });

  it('vendor failure text comes back with the key redacted', async () => {
    const db = openDb();
    const cfg = aiConfigService.createConfig(db, log, { service_type: 'text', name: 'w', provider: 'dashscope', base_url: 'https://example.invalid/v1', api_key: FAKE_KEY, model: ['qwen-plus'] });
    const res = await call(db, { id: cfg.id, base_url: 'https://example.invalid/v1', api_key: '****' + FAKE_KEY.slice(-4) }, async () => { throw new Error(`Incorrect API key provided: ${FAKE_KEY}`); });
    assert.equal(res.code, 400);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(FAKE_KEY), text);
    assert.ok(text.includes('连接测试失败'));
  });
});
