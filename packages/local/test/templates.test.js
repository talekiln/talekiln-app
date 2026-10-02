'use strict';
// P3-T 模板市场：清单校验、权益判断、逐镜估价、一键套用（内核图 + 锁定参考图）、安装与验签。全部离线（云端用本地模拟）。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const AdmZip = require('adm-zip');
const kernel = require('@talekiln/kernel');
const store = require('../src/kernel/store');
const inputs = require('../src/kernel/inputs');
const referenceLocks = require('../src/services/referenceLockService');
const { createSpendService } = require('../src/spend');
const { createCloud } = require('../src/cloud');
const { createTemplateService, TemplateError, schema, isPro, proReason, loadPackage, DEFAULT_BUILTIN_DIR } = require('../src/templates');
const templateRoutes = require('../src/routes/templates');
const { seededDb, log } = require('./helpers/kernelDb');
const { startMockCloud, es256Sign, newKeyPair } = require('./helpers/mockCloud');
const { ENTRIES } = require('../src/errors');

const BUILTIN = ['official-guofeng-drama', 'official-knowledge-explainer', 'official-product-seeding'];
const readBuiltin = (id) => JSON.parse(fs.readFileSync(path.join(DEFAULT_BUILTIN_DIR, id, 'manifest.json'), 'utf8'));
const PRO_STATUS = { logged_in: true, account: { email: 'a@b.c', plan: 'pro', role: 'USER' }, licence: { state: 'valid', verified: true, plan: 'pro', entitlements: ['generate'], sub_end: null } };
const minimal = (over = {}) => ({
  id: 'tpl-min', name: '最小模板', version: '0.1.0', genre: 'test', tier: 'free', description: '',
  style: { name: '测试', prompt: '测试风格' },
  character_slots: [{ id: 'a', name: '甲' }],
  shots: [{ title: '一', duration_ms: 3000, prompt_template: '{{a}} 在 {{scene}}', character_slots: ['a'], scene_slot: '街头', lines: [{ kind: 'dialogue', speaker: 'a', text: '你好' }] }],
  ...over,
});

function service(db, extra = {}) {
  const spend = createSpendService(db);
  return { spend, svc: createTemplateService({ db, spend, log, listConfigs: () => [], getAccountStatus: async () => null, ...extra }) };
}

describe('manifest schema', () => {
  it('builtin packs validate, each 6–10 shots, exactly one pro example', () => {
    const tiers = [];
    for (const id of BUILTIN) {
      const m = readBuiltin(id);
      const v = schema.validateManifest(m);
      assert.deepEqual(v.errors, [], id);
      assert.equal(m.id, id);
      assert.ok(m.shots.length >= 6 && m.shots.length <= 10, `${id} shots ${m.shots.length}`);
      for (const s of m.shots) assert.match(s.prompt_template, /[一-龥]/);
      tiers.push(m.tier);
    }
    assert.equal(tiers.filter((t) => t === 'pro').length, 1);
  });

  it('rejects bad ids, tiers, durations, undeclared placeholders and duplicate slots', () => {
    const errs = (m) => schema.validateManifest(m).errors.map((e) => e.path);
    assert.ok(errs(minimal({ id: 'Bad Id' })).includes('id'));
    assert.ok(errs(minimal({ tier: 'gold' })).includes('tier'));
    assert.ok(errs(minimal({ version: '1' })).includes('version'));
    assert.ok(errs(minimal({ shots: [{ ...minimal().shots[0], duration_ms: 0 }] })).includes('shots[0].duration_ms'));
    assert.ok(errs(minimal({ shots: [{ ...minimal().shots[0], prompt_template: '{{ghost}} 出现' }] })).includes('shots[0].prompt_template'));
    assert.ok(errs(minimal({ shots: [{ ...minimal().shots[0], character_slots: [] }] })).includes('shots[0].character_slots'));
    assert.ok(errs(minimal({ character_slots: [{ id: 'a', name: '甲' }, { id: 'a', name: '乙' }] })).includes('character_slots[1].id'));
    assert.ok(errs(minimal({ character_slots: [{ id: 'scene', name: '甲' }] })).includes('character_slots[0].id'));
    assert.ok(errs(minimal({ shots: [{ ...minimal().shots[0], lines: [{ kind: 'song', text: 'x' }] }] })).includes('shots[0].lines[0].kind'));
    assert.ok(errs(minimal({ style: null })).includes('style'));
    assert.equal(schema.validateManifest('nope').ok, false);
    assert.equal(schema.validateManifest(minimal()).ok, true);
  });

  it('summaryOf derives counts, slots, style and music from the manifest', () => {
    const s = schema.summaryOf(readBuiltin('official-guofeng-drama'));
    assert.equal(s.shot_count, 8);
    assert.equal(s.total_duration_ms, 45000);
    assert.deepEqual(s.groups, ['开场', '冲突', '反转']);
    assert.equal(s.group_count, 3);
    assert.deepEqual(s.slots.map((x) => [x.id, x.required_by]), [['heroine', 7], ['hero', 4], ['villain', 1]]);
    assert.equal(s.style.preset, 'historical');
    assert.match(s.music_hint, /古筝/);
    assert.ok(s.line_count >= 8);
    assert.equal(schema.summaryOf(minimal()).group_count, 1);
  });

  it('templateDigest ignores key order and the signature field', () => {
    const m = minimal();
    const shuffled = JSON.parse(JSON.stringify({ shots: m.shots, style: m.style, id: m.id, character_slots: m.character_slots, name: m.name, version: m.version, genre: m.genre, tier: m.tier, description: m.description }));
    assert.equal(schema.templateDigest(m), schema.templateDigest(shuffled));
    assert.equal(schema.templateDigest({ ...m, signature: 'x.y.z' }), schema.templateDigest(m));
    assert.notEqual(schema.templateDigest({ ...m, name: '改名' }), schema.templateDigest(m));
    assert.match(schema.templateDigest(m), /^tpl-[0-9a-f]{64}$/);
  });

  it('renderPrompt fills slots, scene and style; unknown placeholders become empty', () => {
    const out = schema.renderPrompt('{{a}} 在 {{scene}}，{{style}}，{{ b }}。{{zzz}}', { slots: { a: '甲' }, scene: '街头', style: '写实', fallback: { b: '乙' } });
    assert.equal(out, '甲 在 街头，写实，乙。');
  });
});

describe('pro entitlement', () => {
  const T = Date.UTC(2026, 9, 1);
  const lic = (over) => ({ logged_in: true, account: { plan: 'pro' }, licence: { state: 'valid', plan: 'pro', entitlements: [], sub_end: null, ...over } });
  it('needs login + valid/grace licence + paid plan + unexpired subscription', () => {
    assert.equal(isPro(null, T), false);
    assert.equal(isPro({ logged_in: false }, T), false);
    assert.equal(isPro(lic(), T), true);
    assert.equal(isPro(lic({ state: 'grace' }), T), true);
    assert.equal(isPro(lic({ state: 'expired' }), T), false);
    assert.equal(isPro(lic({ state: 'none' }), T), false);
    assert.equal(isPro(lic({ plan: 'free' }), T), false);
    assert.equal(isPro(lic({ plan: 'free', entitlements: ['templates:pro'] }), T), true);
    assert.equal(isPro(lic({ sub_end: new Date(T - 1).toISOString() }), T), false);
    assert.equal(isPro(lic({ sub_end: new Date(T + 86400_000).toISOString() }), T), true);
    assert.equal(isPro({ logged_in: true, account: { plan: 'pro' }, licence: { state: 'valid', entitlements: [] } }, T), true); // plan 落到 account.plan
  });
  it('explains why not', () => {
    assert.equal(proReason(lic(), T), null);
    assert.match(proReason(null, T), /登录/);
    assert.match(proReason(lic({ state: 'expired' }), T), /过期/);
    assert.match(proReason(lic({ plan: 'free' }), T), /套餐/);
    assert.match(proReason(lic({ sub_end: new Date(T - 1).toISOString() }), T), /到期/);
  });
});

describe('template service', () => {
  let db;
  let episodeId;
  let dramaId;
  let svc;
  let spend;

  before(async () => {
    ({ db, episodeId } = await seededDb());
    dramaId = db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(episodeId).drama_id;
    ({ svc, spend } = service(db));
  });

  it('lists builtin packs with tier, use_count and summary', async () => {
    const r = await svc.list();
    assert.deepEqual(r.items.map((i) => i.id).sort(), BUILTIN);
    for (const it of r.items) {
      assert.equal(it.source, 'builtin');
      assert.equal(it.signature_status, 'official');
      assert.equal(it.use_count, 0);
      assert.ok(['free', 'pro'].includes(it.tier));
      assert.ok(it.summary.shot_count >= 6);
    }
    assert.equal(r.pro_available, false);
    assert.match(r.pro_reason, /登录/);
    const g = svc.get('official-guofeng-drama');
    assert.equal(g.manifest.shots.length, 8);
    assert.throws(() => svc.get('nope'), (e) => e instanceof TemplateError && e.status === 404);
  });

  it('estimate: total equals the sum of per-shot image + video estimates', () => {
    const est = svc.estimate('official-guofeng-drama');
    assert.equal(est.items.length, 8);
    const sum = est.items.reduce((a, x) => a + x.subtotal, 0);
    assert.ok(Math.abs(est.total - sum) < 1e-9);
    assert.equal(est.total, est.check.total);
    // 与逐镜单独估价一致（同一张价格表）
    let manual = 0;
    for (const it of est.items) {
      manual += spend.estimate({ provider: it.image.provider, kind: 'image', params: { model: it.image.model, n: 1 } }).estimate;
      manual += spend.estimate({ provider: it.video.provider, kind: 'video', params: { model: it.video.model, duration: it.seconds } }).estimate;
    }
    assert.ok(Math.abs(est.total - manual) < 1e-9);
    assert.ok(est.total > 0);
    assert.equal(est.known, true);
    assert.equal(est.currency, 'CNY');
    assert.equal(est.provider_ready, false); // 没有 Key：仍给估算
    assert.equal(est.items[0].seconds, 5);
    assert.ok(est.max >= est.total);
  });

  it('apply (new project): builds a valid graph in one tx, clones mapped characters, bumps use_count', async () => {
    const r = await svc.apply('official-guofeng-drama', { mode: 'new', title: '错嫁测试', characterMap: { heroine: 1 } });
    assert.equal(r.mode, 'new');
    assert.notEqual(r.drama_id, dramaId);
    assert.equal(r.episode_number, 1);
    assert.equal(r.shots, 8);
    assert.equal(r.groups, 3);
    assert.equal(r.use_count, 1);
    const g = store.openProject(db, r.episode_id).graph;
    kernel.validateGraph(g);
    assert.equal(kernel.shotOrder(g).length, 8);
    assert.deepEqual(g.group_order.map((id) => g.groups[id].title), ['开场', '冲突', '反转']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM graph_ops WHERE episode_id = ?').get(r.episode_id).n, 1, 'one transaction');
    // 角色：映射的克隆到新项目（保留名字），没映射的按槽位新建
    const chars = db.prepare('SELECT id, name, drama_id FROM characters WHERE drama_id = ? ORDER BY id').all(r.drama_id);
    assert.deepEqual(chars.map((c) => c.name), ['阿宁', '顾长宁', '柳姨娘']);
    const heroine = r.characters.find((c) => c.slot === 'heroine');
    assert.equal(heroine.mapped, true);
    assert.equal(heroine.cloned_from, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM episode_characters WHERE episode_id = ?').get(r.episode_id).n, 3);
    // 物化到旧表：镜头行、角色 id、提示词已替换占位符
    const rows = db.prepare('SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number').all(r.episode_id);
    assert.equal(rows.length, 8);
    assert.equal(rows[0].title, '红绸落雨');
    assert.deepEqual(JSON.parse(rows[0].characters), [heroine.character_id]);
    assert.match(rows[0].description, /阿宁/);
    assert.doesNotMatch(rows[0].description, /\{\{/);
    assert.match(rows[0].image_prompt, /唐宋美学/);
    assert.match(rows[1].dialogue, /沈家的事/);
    assert.equal(rows[0].duration, 5);
    const drama = db.prepare('SELECT * FROM dramas WHERE id = ?').get(r.drama_id);
    assert.equal(drama.title, '错嫁测试');
    assert.equal(drama.genre, 'guofeng');
    assert.equal(drama.style, 'historical');
    assert.match(JSON.parse(drama.metadata).music_hint, /古筝/);
    assert.equal(drama.total_episodes, 1);
    assert.equal(svc.get('official-guofeng-drama').use_count, 1);
  });

  it('apply (next episode): reuses the project characters and their locked references in the same tx', async () => {
    referenceLocks.setLock(db, 'character', 2, { local_path: 'chars/laozhou.png' });
    const r = await svc.apply('official-product-seeding', { mode: 'episode', dramaId, characterMap: { host: 2 } });
    assert.equal(r.drama_id, dramaId);
    assert.equal(r.episode_number, 2);
    assert.equal(r.characters[0].character_id, 2);
    assert.equal(r.characters[0].mapped, true);
    assert.equal(r.characters[0].cloned_from, null);
    assert.equal(r.characters[0].locked, true);
    const g = store.openProject(db, r.episode_id).graph;
    kernel.validateGraph(g);
    const expected = inputs.hashRef(referenceLocks.lockToRefUrl(referenceLocks.getLock(db, 'character', 2)));
    const withHost = kernel.shotOrder(g).filter((s) => g.nodes[s].params.characters.includes(2));
    assert.equal(withHost.length, 5);
    for (const s of withHost) assert.deepEqual(g.nodes[kernel.partsOfShot(g, s).image].params.reference_hashes, [expected]);
    const noHost = kernel.shotOrder(g).filter((s) => !g.nodes[s].params.characters.length);
    assert.equal(noHost.length, 1);
    assert.equal(g.nodes[kernel.partsOfShot(g, noHost[0]).image].params.reference_hashes, undefined);
    // 与生成前的输入同步规则一致：再同步一次没有变化
    assert.deepEqual(inputs.inputOps(db, g, kernel.shotOrder(g), { tail: false }), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM graph_ops WHERE episode_id = ?').get(r.episode_id).n, 1);
    assert.equal(db.prepare('SELECT total_episodes FROM dramas WHERE id = ?').get(dramaId).total_episodes, 2);
    const r2 = await svc.apply('official-product-seeding', { mode: 'episode', dramaId });
    assert.equal(r2.episode_number, 3);
    assert.equal(r2.characters[0].mapped, false);
    assert.equal(svc.get('official-product-seeding').use_count, 2);
  });

  it('apply (new project) copies the locked reference onto the cloned character', async () => {
    const r = await svc.apply('official-product-seeding', { mode: 'new', characterMap: { host: 2 } });
    const id = r.characters[0].character_id;
    assert.notEqual(id, 2);
    assert.equal(referenceLocks.getLock(db, 'character', id).local_path, 'chars/laozhou.png');
    const g = store.openProject(db, r.episode_id).graph;
    const expected = inputs.hashRef('/static/chars/laozhou.png');
    assert.deepEqual(g.nodes[kernel.partsOfShot(g, kernel.shotOrder(g)[0]).image].params.reference_hashes, [expected]);
  });

  it('apply rejects bad mode, unknown slots, foreign characters, missing project; nothing is written', async () => {
    const count = () => db.prepare('SELECT (SELECT COUNT(*) FROM dramas) AS d, (SELECT COUNT(*) FROM episodes) AS e, (SELECT COUNT(*) FROM characters) AS c').get();
    const before0 = count();
    const rej = (p, code, status) => assert.rejects(p, (e) => e instanceof TemplateError && e.code === code && e.status === status);
    await rej(svc.apply('official-guofeng-drama', { mode: 'clone' }), 'TEMPLATE_INVALID', 400);
    await rej(svc.apply('official-guofeng-drama', { mode: 'new', characterMap: { ghost: 1 } }), 'TEMPLATE_INVALID', 400);
    await rej(svc.apply('official-guofeng-drama', { mode: 'new', characterMap: { heroine: 'abc' } }), 'TEMPLATE_INVALID', 400);
    await rej(svc.apply('official-guofeng-drama', { mode: 'new', characterMap: { heroine: 99999 } }), 'TEMPLATE_INVALID', 400);
    await rej(svc.apply('official-guofeng-drama', { mode: 'episode' }), 'TEMPLATE_INVALID', 400);
    await rej(svc.apply('official-guofeng-drama', { mode: 'episode', dramaId: 99999 }), 'NOT_FOUND', 404);
    const foreign = db.prepare('SELECT id FROM characters WHERE drama_id != ? LIMIT 1').get(dramaId).id;
    await rej(svc.apply('official-guofeng-drama', { mode: 'episode', dramaId, characterMap: { heroine: foreign } }), 'TEMPLATE_INVALID', 400);
    await rej(svc.apply('nope', { mode: 'new' }), 'NOT_FOUND', 404);
    assert.deepEqual(count(), before0);
  });

  it('pro templates are gated by the account status', async () => {
    await assert.rejects(svc.apply('official-knowledge-explainer', { mode: 'new' }), (e) => e.code === 'TEMPLATE_PRO_REQUIRED' && e.status === 403);
    assert.equal(svc.get('official-knowledge-explainer').use_count, 0);
    const pro = createTemplateService({ db, spend, log, listConfigs: () => [], getAccountStatus: async () => PRO_STATUS });
    assert.equal((await pro.list()).pro_available, true);
    const r = await pro.apply('official-knowledge-explainer', { mode: 'new' });
    assert.equal(r.shots, 7);
    kernel.validateGraph(store.openProject(db, r.episode_id).graph);
    const expired = createTemplateService({ db, spend, log, listConfigs: () => [], getAccountStatus: async () => ({ ...PRO_STATUS, licence: { ...PRO_STATUS.licence, state: 'expired' } }) });
    await assert.rejects(expired.apply('official-knowledge-explainer', { mode: 'new' }), (e) => e.code === 'TEMPLATE_PRO_REQUIRED');
    assert.equal(svc.get('official-knowledge-explainer').use_count, 1);
  });

  it('re-syncing builtins keeps use_count and refreshes the manifest', async () => {
    const before1 = svc.get('official-guofeng-drama').use_count;
    db.prepare("UPDATE installed_templates SET manifest = '{}' WHERE id = 'official-guofeng-drama'").run();
    const again = createTemplateService({ db, spend, log, listConfigs: () => [], getAccountStatus: async () => null });
    const row = again.get('official-guofeng-drama');
    assert.equal(row.use_count, before1);
    assert.equal(row.manifest.shots.length, 8);
  });
});

describe('install / remove', () => {
  let db;
  let svc;
  let dir;
  before(async () => {
    ({ db } = await seededDb());
    ({ svc } = service(db));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
  });

  const packDir = (m, name) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m));
    return d;
  };

  it('installs from a folder as unsigned/local, lists it next to builtins and removes it', async () => {
    const m = { ...readBuiltin('official-guofeng-drama'), id: 'my-guofeng', name: '我的国风', version: '2.0.0' };
    const r = await svc.install({ path: packDir(m, 'folder') });
    assert.equal(r.source, 'local');
    assert.equal(r.signature_status, 'unsigned');
    assert.equal(r.signature.reason, 'no_signature');
    assert.equal(r.replaced, false);
    assert.equal(r.version, '2.0.0');
    assert.equal((await svc.list()).items.length, 4);
    const r2 = await svc.install({ path: path.join(dir, 'folder', 'manifest.json') }); // 直接给 manifest.json 也行
    assert.equal(r2.replaced, true);
    assert.deepEqual(svc.remove('my-guofeng'), { id: 'my-guofeng', removed: true });
    assert.throws(() => svc.remove('my-guofeng'), (e) => e.status === 404);
  });

  it('installs from a .lytpl zip (manifest at root or in a single top folder)', async () => {
    const m = { ...readBuiltin('official-product-seeding'), id: 'zip-seeding', version: '1.1.0' };
    const z1 = new AdmZip();
    z1.addFile('manifest.json', Buffer.from(JSON.stringify(m)));
    const f1 = path.join(dir, 'a.lytpl');
    z1.writeZip(f1);
    assert.equal((await svc.install({ path: f1 })).id, 'zip-seeding');
    const z2 = new AdmZip();
    z2.addFile('pack/manifest.json', Buffer.from(JSON.stringify({ ...m, id: 'zip-nested' })));
    z2.addFile('pack/cover.png', Buffer.from('png'));
    const f2 = path.join(dir, 'b.zip');
    z2.writeZip(f2);
    assert.equal((await svc.install({ path: f2 })).id, 'zip-nested');
    assert.equal(loadPackage(f2).kind, 'zip');
    const z3 = new AdmZip();
    z3.addFile('readme.txt', Buffer.from('x'));
    const f3 = path.join(dir, 'c.lytpl');
    z3.writeZip(f3);
    await assert.rejects(svc.install({ path: f3 }), (e) => e.code === 'TEMPLATE_PACKAGE_INVALID');
    await assert.rejects(svc.install({ path: path.join(dir, 'missing') }), (e) => e.code === 'TEMPLATE_PACKAGE_INVALID');
    fs.writeFileSync(path.join(dir, 'bad.lytpl'), 'not a zip');
    await assert.rejects(svc.install({ path: path.join(dir, 'bad.lytpl') }), (e) => e.code === 'TEMPLATE_PACKAGE_INVALID');
    await assert.rejects(svc.install({}), (e) => e.code === 'TEMPLATE_PACKAGE_INVALID');
  });

  it('refuses invalid manifests and never touches builtin ids', async () => {
    await assert.rejects(svc.install({ manifest: minimal({ tier: 'vip' }) }), (e) => e.code === 'TEMPLATE_INVALID' && e.details.errors.length === 1);
    await assert.rejects(svc.install({ path: packDir({ ...minimal(), shots: [] }, 'bad') }), (e) => e.code === 'TEMPLATE_INVALID');
    fs.writeFileSync(path.join(packDir(minimal(), 'badjson'), 'manifest.json'), '{nope');
    await assert.rejects(svc.install({ path: path.join(dir, 'badjson') }), (e) => e.code === 'TEMPLATE_PACKAGE_INVALID');
    await assert.rejects(svc.install({ manifest: { ...readBuiltin('official-guofeng-drama'), version: '9.9.9' } }), (e) => e.code === 'TEMPLATE_BUILTIN_READONLY' && e.status === 409);
    assert.throws(() => svc.remove('official-guofeng-drama'), (e) => e.code === 'TEMPLATE_BUILTIN_READONLY');
    assert.equal(svc.get('official-guofeng-drama').version, '1.0.0');
  });
});

describe('signature verification against the cloud JWKS', () => {
  const T0 = Date.UTC(2026, 9, 1);
  let mock;
  before(async () => { mock = await startMockCloud({ now: () => T0 }); });
  after(() => mock.close());

  const signed = (m, privateKey = mock.st.keys.privateKey, kid = 'k1') => ({ ...m, signature: es256Sign({ alg: 'ES256', kid }, schema.templateDigest(m), privateKey) });
  async function withCloud(baseUrl) {
    const { db } = await seededDb();
    const cloud = createCloud({ config: { cloud: { base_url: baseUrl } }, db, log: {} });
    const { svc } = service(db, { cloud });
    return { db, svc, cloud };
  }

  it('official when the signature verifies with the published key; tampering or foreign keys are refused', async () => {
    const { svc, db } = await withCloud(mock.url);
    const m = { ...minimal(), id: 'cloud-one' };
    const r = await svc.install({ manifest: signed(m), source: 'cloud' });
    assert.equal(r.signature_status, 'official');
    assert.equal(r.source, 'cloud');
    assert.equal(r.signature.kid, 'k1');
    assert.ok(mock.st.calls.includes('GET /.well-known/licence-jwks.json'));
    assert.ok(db.prepare("SELECT value FROM global_settings WHERE key = 'cloud.jwks'").get(), 'key cached');
    // 改过内容
    await assert.rejects(svc.install({ manifest: { ...signed(m), name: '被改过' } }), (e) => e.code === 'TEMPLATE_SIGNATURE_INVALID');
    // 别人的密钥冒充 k1
    await assert.rejects(svc.install({ manifest: signed(m, newKeyPair().privateKey) }), (e) => e.code === 'TEMPLATE_SIGNATURE_INVALID');
    // 云端不认识的 kid
    await assert.rejects(svc.install({ manifest: signed(m, mock.st.keys.privateKey, 'k9') }), (e) => e.code === 'TEMPLATE_SIGNATURE_INVALID');
    // 签名格式不对
    await assert.rejects(svc.install({ manifest: { ...m, signature: 'garbage' } }), (e) => e.code === 'TEMPLATE_SIGNATURE_INVALID');
    assert.equal(svc.get('cloud-one').signature_status, 'official');
    // 本地未安装的云端清单 / 已安装的标注
    const fake = { http: { request: async () => ({ items: [{ manifest: signed(m), sha256: 'abc', kid: 'k1' }, { manifest: { bad: true } }] }) }, isConfigured: () => true, account: null };
    const { svc: svc2 } = service(db, { cloud: fake });
    const cat = await svc2.cloudCatalog();
    assert.equal(cat.items.length, 1);
    assert.equal(cat.items[0].installed, true);
    assert.equal(cat.items[0].installed_version, '0.1.0');
  });

  it('offline with no cached key: installs as unsigned (never as official); later verification can upgrade it', async () => {
    const { svc } = await withCloud(mock.url);
    const m = { ...minimal(), id: 'cloud-offline' };
    mock.st.down = true;
    try {
      const r = await svc.install({ manifest: signed(m), source: 'cloud' });
      assert.equal(r.signature_status, 'unsigned');
      assert.equal(r.signature.reason, 'key_unavailable');
    } finally { mock.st.down = false; }
    const r2 = await svc.install({ manifest: signed(m), source: 'cloud' });
    assert.equal(r2.signature_status, 'official');
    assert.equal(r2.replaced, true);
  });

  it('without a configured cloud, signed manifests install as unsigned and the cloud catalog is unavailable', async () => {
    const { svc } = await withCloud('https://cloud.talekiln.example');
    const r = await svc.install({ manifest: signed({ ...minimal(), id: 'no-cloud' }) });
    assert.equal(r.signature_status, 'unsigned');
    await assert.rejects(svc.cloudCatalog(), (e) => e.code === 'CLOUD_NOT_CONFIGURED' && e.status === 503);
  });
});

describe('routes', () => {
  let server;
  let base;
  let db;
  let dramaId;
  before(async () => {
    ({ db } = await seededDb());
    dramaId = db.prepare('SELECT id FROM dramas').get().id;
    const { svc } = service(db, { cloud: { http: { request: async () => { const e = new Error('boom'); e.name = 'CloudError'; e.network = true; throw e; } }, isConfigured: () => true, account: null } });
    const app = express();
    app.use(express.json());
    const t = templateRoutes(svc, log);
    const r = express.Router();
    r.get('/templates', t.list);
    r.get('/templates/cloud', t.cloud);
    r.post('/templates/install', t.install);
    r.get('/templates/:id', t.get);
    r.post('/templates/:id/estimate', t.estimate);
    r.post('/templates/:id/apply', t.apply);
    r.delete('/templates/:id', t.remove);
    app.use('/api/v1', r);
    await new Promise((ok) => { server = app.listen(0, '127.0.0.1', ok); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  const call = async (method, p, body) => {
    const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  it('list / get / estimate / apply / install / delete', async () => {
    const l = await call('GET', '/templates');
    assert.equal(l.status, 200);
    assert.equal(l.body.data.items.length, 3);
    assert.equal(l.body.data.pro_available, false);
    const g = await call('GET', '/templates/official-guofeng-drama');
    assert.equal(g.body.data.summary.shot_count, 8);
    assert.equal((await call('GET', '/templates/nope')).status, 404);
    assert.equal((await call('GET', '/templates/..%2F..')).status, 404);
    const e = await call('POST', '/templates/official-guofeng-drama/estimate');
    assert.equal(e.status, 200);
    assert.equal(e.body.data.items.length, 8);
    const a = await call('POST', '/templates/official-guofeng-drama/apply', { mode: 'episode', drama_id: dramaId, character_map: { heroine: 1 } });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.data.episode_number, 2);
    const pro = await call('POST', '/templates/official-knowledge-explainer/apply', { mode: 'new' });
    assert.equal(pro.status, 403);
    assert.equal(pro.body.error.code, 'TEMPLATE_PRO_REQUIRED');
    assert.ok(pro.body.error.action);
    const bad = await call('POST', '/templates/official-guofeng-drama/apply', { mode: 'episode', drama_id: dramaId, character_map: { nobody: 1 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'TEMPLATE_INVALID');
    const inst = await call('POST', '/templates/install', { manifest: { ...minimal(), id: 'via-http' } });
    assert.equal(inst.status, 201);
    assert.equal(inst.body.data.signature_status, 'unsigned');
    const inv = await call('POST', '/templates/install', { manifest: { ...minimal(), id: 'via-http', tier: 'x' } });
    assert.equal(inv.status, 400);
    assert.equal(inv.body.error.code, 'TEMPLATE_INVALID');
    assert.equal((await call('DELETE', '/templates/via-http')).status, 200);
    assert.equal((await call('DELETE', '/templates/official-guofeng-drama')).status, 409);
    const c = await call('GET', '/templates/cloud');
    assert.equal(c.status, 503);
    assert.equal(c.body.error.code, 'CLOUD_UNREACHABLE');
    for (const code of ['TEMPLATE_INVALID', 'TEMPLATE_PRO_REQUIRED', 'TEMPLATE_SIGNATURE_INVALID', 'TEMPLATE_PACKAGE_INVALID', 'TEMPLATE_BUILTIN_READONLY', 'CLOUD_UNREACHABLE', 'CLOUD_NOT_CONFIGURED']) assert.ok(ENTRIES[code], code);
  });
});
