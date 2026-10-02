const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const secrets = require('../src/secrets');
const aiConfigService = require('../src/services/aiConfigService');
const aiConfigRoutes = require('../src/routes/aiConfig');
const logger = require('../src/logger');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const KEY = 'sk-test-ABCDEFGH1234567890WXYZ';
const KEY_FAKE = 'sk-fake-0000111122223333';

function makeDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}
function makeStore(file) {
  return new secrets.FileSecretStore({
    cipher: secrets.createAesCipher(crypto.randomBytes(32).toString('hex')),
    filePath: file,
  });
}
function fakeRes() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const noopLog = { info() {}, warn() {}, error() {}, errorw() {}, warnw() {} };

describe('secret store', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-')); });
  afterEach(() => { secrets.setSecretStore(null); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('persists only ciphertext and survives restart (round-trip)', () => {
    const file = path.join(tmp, 'secrets.enc.json');
    const hex = crypto.randomBytes(32).toString('hex');
    const mk = () => new secrets.FileSecretStore({ cipher: secrets.createAesCipher(hex), filePath: file });
    const a = mk();
    a.set('ai_config:1', KEY);
    assert.equal(a.get('ai_config:1'), KEY);
    const onDisk = fs.readFileSync(file, 'utf8');
    assert.ok(!onDisk.includes(KEY));
    assert.ok(!onDisk.includes('ABCDEFGH'));
    const b = mk(); // 模拟重启
    assert.equal(b.get('ai_config:1'), KEY);
    b.delete('ai_config:1');
    assert.equal(mk().get('ai_config:1'), null);
  });

  it('refuses to store when cipher unavailable (no plaintext fallback)', () => {
    const store = new secrets.FileSecretStore({
      cipher: { isAvailable: () => false },
      filePath: path.join(tmp, 's.json'),
    });
    assert.throws(() => store.set('ai_config:1', KEY), { code: 'SECRET_STORE_UNAVAILABLE' });
    assert.ok(!fs.existsSync(path.join(tmp, 's.json')));
  });

  it('maskKey keeps only last 4 chars', () => {
    assert.equal(secrets.maskKey(KEY), '****WXYZ');
    assert.equal(secrets.maskKey('short'), '****');
    assert.equal(secrets.maskKey(''), '');
  });
});

describe('ai config key handling', () => {
  let tmp, db, store;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
    db = makeDb();
    store = makeStore(path.join(tmp, 'secrets.enc.json'));
    secrets.setSecretStore(store);
  });
  afterEach(() => { secrets.setSecretStore(null); fs.rmSync(tmp, { recursive: true, force: true }); });

  const req = { service_type: 'text', name: 'n', provider: 'openai', base_url: 'https://x.example', api_key: KEY };

  it('create/list/get responses are masked and DB column holds no key', () => {
    const routes = aiConfigRoutes(db, noopLog, {});
    const r1 = fakeRes();
    routes.create({ body: req }, r1);
    assert.equal(r1.code, 201);
    const id = r1.body.data.id;
    const r2 = fakeRes();
    routes.list({ query: {} }, r2);
    const r3 = fakeRes();
    routes.get({ params: { id: String(id) } }, r3);
    for (const r of [r1, r2, r3]) {
      const text = JSON.stringify(r.body);
      assert.ok(!text.includes(KEY), 'full key leaked');
      assert.ok(!text.includes('ABCDEFGH'), 'key middle leaked');
    }
    assert.equal(r3.body.data.api_key, '****WXYZ');
    assert.equal(r3.body.data.has_api_key, true);
    assert.equal(db.prepare('SELECT api_key FROM ai_service_configs WHERE id = ?').get(id).api_key, '');
    // 内部调用仍能拿到明文
    assert.equal(aiConfigService.listConfigsInternal(db, 'text')[0].api_key, KEY);
  });

  it('echoing the masked value back does not overwrite the key; new value does', () => {
    const c = aiConfigService.createConfig(db, noopLog, req);
    aiConfigService.updateConfig(db, noopLog, c.id, { api_key: c.api_key, name: 'renamed' });
    assert.equal(aiConfigService.resolveKey(c.id), KEY);
    aiConfigService.updateConfig(db, noopLog, c.id, { api_key: KEY_FAKE });
    assert.equal(aiConfigService.resolveKey(c.id), KEY_FAKE);
    aiConfigService.deleteConfig(db, noopLog, c.id);
    assert.equal(aiConfigService.resolveKey(c.id), '');
  });

  it('unavailable store: create returns 503 and leaves no row', () => {
    secrets.setSecretStore(new secrets.UnavailableSecretStore());
    const routes = aiConfigRoutes(db, noopLog, {});
    const res = fakeRes();
    routes.create({ body: req }, res);
    assert.equal(res.code, 503);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_service_configs').get().n, 0);
  });

  it('migrates legacy plaintext keys (encrypt, then blank) and is idempotent', () => {
    const ins = db.prepare("INSERT INTO ai_service_configs (service_type, provider, name, base_url, api_key, model) VALUES ('text','openai','legacy','https://x',?, '[]')");
    const id = ins.run(KEY).lastInsertRowid;
    const id2 = ins.run('').lastInsertRowid;
    const r = aiConfigService.migratePlaintextApiKeys(db, noopLog);
    assert.deepEqual(r, { migrated: 1, skipped: 0 });
    assert.equal(db.prepare('SELECT api_key FROM ai_service_configs WHERE id = ?').get(id).api_key, '');
    assert.equal(aiConfigService.resolveKey(id), KEY);
    assert.equal(aiConfigService.resolveKey(id2), '');
    assert.equal(aiConfigService.migratePlaintextApiKeys(db, noopLog).migrated, 0);
    // 重启：新 store 读同一文件，仍可解密
    const file = path.join(tmp, 'secrets.enc.json');
    assert.ok(!fs.readFileSync(file, 'utf8').includes(KEY));
    assert.equal(aiConfigService.listConfigs(db, 'text')[0].api_key, '****WXYZ');
  });

  it('migration leaves plaintext untouched when store unavailable', () => {
    secrets.setSecretStore(new secrets.UnavailableSecretStore());
    const id = db.prepare("INSERT INTO ai_service_configs (service_type, provider, name, base_url, api_key, model) VALUES ('text','o','l','u',?, '[]')").run(KEY).lastInsertRowid;
    const r = aiConfigService.migratePlaintextApiKeys(db, noopLog);
    assert.equal(r.skipped, 1);
    assert.equal(db.prepare('SELECT api_key FROM ai_service_configs WHERE id = ?').get(id).api_key, KEY);
  });

  it('restart round-trip: new store instance on same file serves the key', () => {
    const file = path.join(tmp, 'secrets.enc.json');
    const hex = crypto.randomBytes(32).toString('hex');
    const mk = () => new secrets.FileSecretStore({ cipher: secrets.createAesCipher(hex), filePath: file });
    secrets.setSecretStore(mk());
    const c = aiConfigService.createConfig(db, noopLog, req);
    secrets.setSecretStore(mk());
    assert.equal(aiConfigService.listConfigsInternal(db, 'text')[0].api_key, KEY);
    assert.equal(aiConfigService.getConfig(db, c.id).api_key, '****WXYZ');
  });

  it('logger never emits keys (known secret values, key-named fields, Bearer headers)', () => {
    const lines = [];
    const orig = console.log;
    console.log = (l) => lines.push(String(l));
    try {
      aiConfigService.createConfig(db, logger, req);
      logger.info('payload', { api_key: KEY_FAKE, nested: { Authorization: 'Bearer ' + KEY_FAKE } });
      logger.warn('raw ' + KEY + ' and Bearer ' + KEY_FAKE);
      logger.error('err', new Error('boom ' + KEY));
    } finally {
      console.log = orig;
    }
    const all = lines.join('\n');
    assert.ok(lines.length >= 4);
    assert.ok(!all.includes(KEY), all);
    assert.ok(!all.includes(KEY_FAKE), all);
    assert.ok(all.includes('[REDACTED]'));
  });
});
