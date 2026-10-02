'use strict';
// P3-S 工作室版基础（本机）：清单纯函数、身份缓存与离线、角色门槛、角色 / 模板发布 -> 列表 -> 拉取往返（sha256 一致）、
// 篡改拒绝、更新覆盖同一本机角色、REST。对象存储用进程内假 S3（test/helpers/fakeS3.js），云端用假 cloudApi。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const secrets = require('../src/secrets');
const referenceLocks = require('../src/services/referenceLockService');
const { getGlobalSetting } = require('../src/services/settingsService');
const { createBackupService } = require('../src/backup/service');
const { createSpendService } = require('../src/spend');
const { createTemplateService } = require('../src/templates');
const { createStudioService, StudioError, manifest: M, IDENTITY_KEY } = require('../src/studio');
const studioRoutes = require('../src/routes/studio');
const { seededDb, log } = require('./helpers/kernelDb');
const { startFakeS3 } = require('./helpers/fakeS3');
const { ENTRIES } = require('../src/errors');

const noSleep = async () => {};
const STUDIO_A = { id: 'studio-a', name: '甲工作室', status: 'active', my_role: 'owner', seats: { limit: 3, used: 1, pending: 0, available: 2 } };
const STUDIO_B = { id: 'studio-b', name: '乙工作室', status: 'active', my_role: 'member', seats: { limit: 2, used: 2, pending: 0, available: 0 } };
// 1x1 PNG（公共领域的最小 PNG）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function fakeCloud(studios = [STUDIO_A, STUDIO_B]) {
  const calls = [];
  const state = { studios, fail: null, loggedIn: true };
  return {
    calls, state,
    request: async (method, pathname, opts = {}) => {
      calls.push({ method, pathname, body: opts.body });
      if (!state.loggedIn) { const e = new Error('NOT_LOGGED_IN'); e.name = 'AccountError'; e.code = 'NOT_LOGGED_IN'; throw e; }
      if (state.fail) { const e = new Error(state.fail); e.name = 'CloudError'; e.code = state.fail; e.network = state.fail === 'network'; e.status = state.fail === 'network' ? 0 : 403; throw e; }
      if (method === 'GET' && pathname === '/studios/mine') return { items: state.studios, issued_at: new Date().toISOString() };
      if (method === 'GET' && pathname.startsWith('/studios/')) return { ...state.studios[0], members: [{ account_id: 'me', email: 'me@example.com', role: 'owner', status: 'active' }], invites: [] };
      if (method === 'POST' && pathname === '/studios') { const s = { id: 'studio-new', name: opts.body.name, status: 'active', my_role: 'owner', seats: { limit: 3, used: 1, pending: 0, available: 2 } }; state.studios = [...state.studios, s]; return s; }
      if (method === 'POST' && pathname.endsWith('/invites')) return { id: 'inv-1', code: 'ABCDEFGH23', email: opts.body.email || null, role: opts.body.role || 'member' };
      if (method === 'POST' && pathname === '/studios/accept') return { studio: state.studios[0], member: { role: 'member' } };
      return { ok: true };
    },
  };
}

async function setup({ srv, studios } = {}) {
  const seeded = await seededDb({ withTimeline: false });
  const storageRoot = path.join(seeded.dir, 'storage');
  fs.mkdirSync(storageRoot, { recursive: true });
  const cfg = { storage: { local_path: storageRoot } };
  secrets.setSecretStore(new secrets.FileSecretStore({ cipher: secrets.createAesCipher(Buffer.alloc(32, 9)) }));
  const backup = createBackupService({ db: seeded.db, config: cfg, log, clientOptions: { sleep: noSleep } });
  if (srv) backup.putSettings({ endpoint: srv.url, bucket: srv.bucket, prefix: 'talekiln', access_key: srv.accessKey, secret_key: srv.secretKey, auto: 'off' });
  const spend = createSpendService(seeded.db);
  const templates = createTemplateService({ db: seeded.db, spend, log, listConfigs: () => [], getAccountStatus: async () => null });
  const cloudApi = fakeCloud(studios);
  const cloud = { isConfigured: () => true, account: { status: async () => ({ logged_in: true, account: { email: 'me@example.com' } }) } };
  const svc = createStudioService({ db: seeded.db, storageRoot, cloud, cloudApi, backup, templates, log, clientOptions: { sleep: noSleep } });
  const dramaId = seeded.db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(seeded.episodeId).drama_id;
  // 一个带主图、四视图、额外图与锁定参考图的角色
  const put = (rel, buf) => { const abs = path.join(storageRoot, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, buf); return rel; };
  const main = put('characters/1/main.png', PNG);
  const four = put('characters/1/four.png', Buffer.concat([PNG, Buffer.from([1])]));
  const extra = put('characters/1/extra.jpg', Buffer.concat([PNG, Buffer.from([2])]));
  const locked = put('characters/1/locked.png', Buffer.concat([PNG, Buffer.from([3])]));
  const r = seeded.db.prepare(`INSERT INTO characters (drama_id, name, role, description, appearance, image_url, local_path, four_view_image_url, extra_images, identity_anchors, created_at, updated_at)
    VALUES (?, '林小满', '女主', '咖啡师', '短发', ?, ?, ?, ?, ?, ?, ?)`).run(dramaId, `/static/${main}`, main, `/static/${four}`, JSON.stringify([extra, 'https://example.com/remote.png']), JSON.stringify({ eyes: 'brown' }), '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  const characterId = Number(r.lastInsertRowid);
  referenceLocks.setLock(seeded.db, 'character', characterId, { image_url: `/static/${locked}`, local_path: locked });
  return { ...seeded, storageRoot, backup, templates, cloudApi, svc, dramaId, characterId, files: { main, four, extra, locked } };
}

const sha = (b) => M.sha256Hex(b);

describe('studio manifest (pure)', () => {
  it('keys, list prefix and manifest key parsing', () => {
    const k = M.keysFor('talekiln', 'studio-a', 'character', 'c-abc');
    assert.equal(k.manifest, 'talekiln/shared/studio-a/characters/c-abc/manifest.json');
    assert.equal(k.file('main-123.png'), 'talekiln/shared/studio-a/characters/c-abc/files/main-123.png');
    assert.equal(M.keysFor('', 's', 'template', 'official-x').template, 'shared/s/templates/official-x/template.json');
    assert.equal(M.listPrefix('talekiln', 'studio-a', 'template'), 'talekiln/shared/studio-a/templates/');
    assert.deepEqual(M.parseManifestKey(k.manifest, 'talekiln'), { studio_id: 'studio-a', kind: 'character', shared_id: 'c-abc' });
    assert.equal(M.parseManifestKey('talekiln/shared/studio-a/characters/c-abc/files/x.png', 'talekiln'), null);
    assert.equal(M.parseManifestKey('other/shared/studio-a/characters/c-abc/manifest.json', 'talekiln'), null);
    assert.equal(M.parseManifestKey('talekiln/dramas/1/x.json', 'talekiln'), null);
    assert.throws(() => M.keysFor('p', '../x', 'character', 'c'), /studio/);
    assert.throws(() => M.keysFor('p', 's', 'character', 'a/b'), /shared/);
    assert.throws(() => M.keysFor('p', 's', 'scene', 'c'), /kind/);
    assert.equal(M.fileNameFor('main', 'abcdef0123456789', 'C:/x/My Pic.PNG'), 'main-abcdef012345.png');
    assert.equal(M.contentTypeOf('a.webp'), 'image/webp');
    assert.match(M.newSharedId('character'), /^c-[0-9a-f]{16}$/);
    assert.match(M.newSharedId('template'), /^t-[0-9a-f]{16}$/);
  });

  it('character manifest is sealed with a digest; validation catches tampering and wrong owner', () => {
    const files = [{ role: 'main', name: 'main-aaaaaaaaaaaa.png', key: 'k/main', sha256: 'a'.repeat(64), size: 10 }];
    const m = M.buildCharacterManifest({ studioId: 'studio-a', sharedId: 'c-1', version: 2, character: { name: '甲', role: '女主', description: '', appearance: null }, files, author: { email: 'me@example.com' }, sourceCharacterId: 7, now: new Date('2026-10-02T00:00:00Z') });
    assert.equal(m.schema, M.SCHEMAS.character);
    assert.deepEqual(m.fields, { name: '甲', role: '女主' }, '空字段不进清单');
    assert.equal(m.files[0].content_type, 'image/png');
    assert.equal(m.source.character_id, 7);
    assert.equal(m.sha256, M.manifestDigest(m));
    assert.deepEqual(M.validateManifest(m, { kind: 'character', studioId: 'studio-a', sharedId: 'c-1' }), { ok: true, errors: [] });
    const tampered = { ...m, name: '乙' };
    assert.match(M.validateManifest(tampered).errors[0].message, /摘要不一致/);
    assert.equal(M.validateManifest(m, { kind: 'template' }).ok, false);
    assert.equal(M.validateManifest(m, { studioId: 'studio-b' }).ok, false);
    assert.equal(M.validateManifest(m, { sharedId: 'c-2' }).ok, false);
    assert.equal(M.validateManifest({ ...m, files: [{ ...files[0], sha256: 'zz' }] }).ok, false);
    assert.equal(M.validateManifest(null).ok, false);
    const s = M.summaryOf(m);
    assert.deepEqual([s.shared_id, s.version, s.file_count, s.total_size, s.roles], ['c-1', 2, 1, 10, ['main']]);
  });

  it('template manifest wraps the package file', () => {
    const tm = { id: 'tpl-x', name: '模板', version: '1.2.0', genre: 'g', tier: 'free' };
    const m = M.buildTemplateManifest({ studioId: 's', templateManifest: tm, version: 1, templateFile: { name: 'template.json', key: 'k', sha256: 'b'.repeat(64), size: 5 }, author: null });
    assert.equal(m.kind, 'template');
    assert.equal(m.id, 'tpl-x');
    assert.equal(m.fields.template_version, '1.2.0');
    assert.deepEqual(m.author, { account_id: null, email: null });
    assert.equal(M.validateManifest(m, { kind: 'template', studioId: 's', sharedId: 'tpl-x' }).ok, true);
  });

  it('error codes exist for every STUDIO_* code the service throws', () => {
    for (const c of ['STUDIO_NOT_LOGGED_IN', 'STUDIO_NOT_MEMBER', 'STUDIO_FORBIDDEN', 'STUDIO_INVALID_MANIFEST', 'STUDIO_CHECKSUM', 'CLOUD_UNREACHABLE', 'CLOUD_NOT_CONFIGURED', 'BACKUP_NOT_CONFIGURED']) {
      assert.ok(ENTRIES[c], c);
      assert.equal(ENTRIES[c].scope, 'local');
    }
  });
});

describe('studio identity', () => {
  it('syncs from the cloud, caches, falls back to cache when offline, clears on logout; current studio selection', async () => {
    const { svc, cloudApi, db } = await setup();
    const first = await svc.identity();
    assert.equal(first.online, true, '没有缓存时第一次会问云端');
    assert.deepEqual(first.studios.map((s) => s.id), ['studio-a', 'studio-b']);
    assert.equal(first.current_studio_id, 'studio-a');
    assert.equal(cloudApi.calls.length, 1);
    const cachedView = await svc.identity();
    assert.equal(cachedView.online, null);
    assert.equal(cloudApi.calls.length, 1, '有缓存且不要求同步时不问云端');
    assert.equal(svc.setCurrent('studio-b').current_studio_id, 'studio-b');
    assert.throws(() => svc.setCurrent('studio-zzz'), (e) => e instanceof StudioError && e.code === 'STUDIO_NOT_MEMBER');
    cloudApi.state.fail = 'network';
    const offline = await svc.identity({ sync: true });
    assert.equal(offline.online, false);
    assert.equal(offline.error, 'CLOUD_UNREACHABLE');
    assert.equal(offline.current_studio_id, 'studio-b');
    cloudApi.state.fail = null;
    cloudApi.state.loggedIn = false;
    await assert.rejects(svc.identity({ sync: true }), (e) => e.code === 'STUDIO_NOT_LOGGED_IN' && e.status === 401);
    assert.equal(getGlobalSetting(db, IDENTITY_KEY, null), null, '退出登录后清掉缓存');
    cloudApi.state.loggedIn = true;
    cloudApi.state.fail = 'network';
    await assert.rejects(svc.identity({ sync: true }), (e) => e.code === 'CLOUD_UNREACHABLE' && e.status === 502, '没缓存又连不上就报错');
  });

  it('member management is forwarded to the cloud and refreshes identity', async () => {
    const { svc, cloudApi } = await setup();
    const created = await svc.createStudio({ name: '新工作室' });
    assert.equal(created.id, 'studio-new');
    assert.ok(cloudApi.calls.some((c) => c.method === 'POST' && c.pathname === '/studios'));
    assert.ok(cloudApi.calls.some((c) => c.method === 'GET' && c.pathname === '/studios/mine'), '创建后同步身份');
    assert.deepEqual((await svc.identity()).studios.map((s) => s.id), ['studio-a', 'studio-b', 'studio-new']);
    const inv = await svc.invite('studio-a', { email: 'x@example.com', role: 'member' });
    assert.equal(inv.code, 'ABCDEFGH23');
    await svc.accept({ code: 'ABCDEFGH23' });
    await svc.removeMember('studio-a', 'u2');
    await svc.setRole('studio-a', 'u2', { role: 'admin' });
    assert.equal((await svc.detail('studio-a')).members.length, 1);
    cloudApi.state.fail = 'seat_limit';
    await assert.rejects(svc.invite('studio-a', {}), (e) => e.code === 'SEAT_LIMIT' && e.status === 403);
    cloudApi.state.fail = 'forbidden';
    await assert.rejects(svc.setRole('studio-a', 'u2', { role: 'admin' }), (e) => e.code === 'STUDIO_FORBIDDEN');
  });
});

describe('studio shared library (fake S3)', () => {
  let srv;
  before(async () => { srv = await startFakeS3({ accessKey: 'ci', secretKey: 'ci-throwaway-minio', bucket: 'tk-test' }); });
  after(async () => { await srv.close(); });

  it('refuses without object storage settings, and refuses publishing for plain members', async () => {
    const { svc, characterId } = await setup();
    await assert.rejects(svc.listShared('studio-a', 'character'), (e) => e.code === 'BACKUP_NOT_CONFIGURED' && e.status === 503);
    const { svc: svc2, characterId: cid2 } = await setup({ srv });
    await assert.rejects(svc2.publishCharacter(cid2, { studio_id: 'studio-b' }), (e) => e.code === 'STUDIO_FORBIDDEN' && e.status === 403 && e.details.my_role === 'member');
    await assert.rejects(svc2.publishCharacter(cid2, { studio_id: 'studio-x' }), (e) => e.code === 'STUDIO_NOT_MEMBER');
    await assert.rejects(svc2.publishCharacter(999999, { studio_id: 'studio-a' }), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(svc.listShared('studio-a', 'scene'), (e) => e.code === 'BAD_REQUEST');
    void characterId;
  });

  it('character: publish -> list -> pull round trip keeps every sha256; update bumps version and overwrites the pulled character', async () => {
    const a = await setup({ srv });
    srv.objects.clear();
    const pub = await a.svc.publishCharacter(a.characterId, { studio_id: 'studio-a' });
    assert.match(pub.shared_id, /^c-/);
    assert.equal(pub.version, 1);
    assert.equal(pub.updated, false);
    assert.deepEqual(pub.files.map((f) => f.role).sort(), ['extra', 'four_view', 'locked_reference', 'main']);
    assert.deepEqual(pub.skipped, [{ role: 'extra', ref: 'https://example.com/remote.png', reason: 'remote' }]);
    assert.equal(pub.manifest.author.email, 'me@example.com');
    assert.deepEqual(pub.manifest.fields.identity_anchors, JSON.stringify({ eyes: 'brown' }));
    // 桶里：清单 + 4 个文件，键在 shared/<studio>/characters/<id>/ 下，文件哈希等于本机文件哈希
    const keys = [...srv.objects.keys()].map((k) => k.slice('tk-test/'.length)).sort();
    assert.equal(keys.length, 5);
    assert.ok(keys.every((k) => k.startsWith(`talekiln/shared/studio-a/characters/${pub.shared_id}/`)), keys.join('\n'));
    const mainFile = pub.manifest.files.find((f) => f.role === 'main');
    assert.equal(mainFile.sha256, sha(fs.readFileSync(path.join(a.storageRoot, a.files.main))));
    assert.equal(sha(srv.objects.get(`tk-test/${mainFile.key}`).body), mainFile.sha256);
    assert.equal(pub.manifest.files.find((f) => f.role === 'locked_reference').sha256, sha(fs.readFileSync(path.join(a.storageRoot, a.files.locked))));
    assert.equal(pub.record.direction, 'published');
    assert.equal(pub.record.local_id, String(a.characterId));

    // 发布者看到的列表：mine
    const mine = await a.svc.listShared('studio-a', 'character');
    assert.equal(mine.items.length, 1);
    assert.equal(mine.items[0].state, 'mine');
    assert.equal(mine.items[0].file_count, 4);
    assert.equal(mine.can_publish, true);

    // 另一台机器（member）拉取
    const b = await setup({ srv, studios: [{ ...STUDIO_A, my_role: 'member' }] });
    const list = await b.svc.listShared('studio-a', 'character');
    assert.equal(list.items[0].state, 'not_pulled');
    assert.equal(list.can_publish, false);
    await assert.rejects(b.svc.pullCharacter('studio-a', pub.shared_id, {}), (e) => e.code === 'BAD_REQUEST' && /drama_id/.test(e.message));
    await assert.rejects(b.svc.pullCharacter('studio-a', pub.shared_id, { drama_id: 999999 }), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(b.svc.pullCharacter('studio-a', 'c-nope', { drama_id: b.dramaId }), (e) => e.code === 'NOT_FOUND');
    const pulled = await b.svc.pullCharacter('studio-a', pub.shared_id, { drama_id: b.dramaId });
    assert.equal(pulled.updated, false);
    assert.equal(pulled.version, 1);
    const ch = b.db.prepare('SELECT * FROM characters WHERE id = ?').get(pulled.character_id);
    assert.equal(ch.name, '林小满');
    assert.equal(ch.role, '女主');
    assert.equal(ch.drama_id, b.dramaId);
    assert.equal(ch.identity_anchors, JSON.stringify({ eyes: 'brown' }));
    assert.match(ch.local_path, new RegExp(`^studio/studio-a/characters/${pub.shared_id}/main-`));
    assert.equal(ch.image_url, `/static/${ch.local_path}`);
    assert.match(ch.four_view_image_url, /^\/static\/studio\/studio-a\/characters\/.*\/four_view-/);
    const extras = JSON.parse(ch.extra_images);
    assert.equal(extras.length, 1);
    assert.match(extras[0], /\/extra-/);
    // 落盘的文件与发布端逐字节一致
    for (const [role, rel] of Object.entries(a.files)) {
      const want = sha(fs.readFileSync(path.join(a.storageRoot, rel)));
      const got = pulled.files.find((f) => f.sha256 === want);
      assert.ok(got, `${role} 文件在拉取结果里`);
      const abs = path.join(b.storageRoot, 'studio', 'studio-a', 'characters', pub.shared_id, got.name);
      assert.equal(sha(fs.readFileSync(abs)), want, `${role} 落盘哈希一致`);
    }
    const lock = referenceLocks.getLock(b.db, 'character', pulled.character_id);
    assert.ok(lock && /locked_reference-/.test(lock.local_path), '锁定参考图落到本机并重新锁定');
    assert.equal(pulled.locked_reference, `/static/${lock.local_path}`);
    assert.equal((await b.svc.listShared('studio-a', 'character')).items[0].state, 'pulled');
    assert.equal(b.svc.records('studio-a', 'character')[0].direction, 'pulled');

    // 发布端更新：版本 2，同一个 shared_id；拉取端看到 update_available，更新覆盖同一个本机角色
    a.db.prepare("UPDATE characters SET name = '林小满（改）' WHERE id = ?").run(a.characterId);
    fs.writeFileSync(path.join(a.storageRoot, a.files.main), Buffer.concat([PNG, Buffer.from([9])]));
    const pub2 = await a.svc.publishCharacter(a.characterId, { studio_id: 'studio-a' });
    assert.equal(pub2.shared_id, pub.shared_id);
    assert.equal(pub2.version, 2);
    assert.equal(pub2.updated, true);
    assert.equal((await a.svc.listShared('studio-a', 'character')).items.length, 1, '同一个条目，不是两个');
    const l2 = await b.svc.listShared('studio-a', 'character');
    assert.equal(l2.items[0].state, 'update_available');
    assert.equal(l2.items[0].version, 2);
    assert.equal(l2.items[0].pulled_version, 1);
    const pulled2 = await b.svc.pullCharacter('studio-a', pub.shared_id, {});
    assert.equal(pulled2.updated, true);
    assert.equal(pulled2.character_id, pulled.character_id, '覆盖同一个本机角色');
    assert.equal(b.db.prepare('SELECT name FROM characters WHERE id = ?').get(pulled.character_id).name, '林小满（改）');
    assert.equal(b.db.prepare("SELECT COUNT(*) AS n FROM characters WHERE local_path LIKE 'studio/%'").get().n, 1, '更新不新建角色');
    assert.equal((await b.svc.listShared('studio-a', 'character')).items[0].state, 'pulled');

    // 篡改：改文件 -> 409 STUDIO_CHECKSUM 且本机不变；改清单 -> 列表里标为 invalid，拉取 400
    const c = await setup({ srv, studios: [STUDIO_A] });
    const key = `tk-test/${pub2.manifest.files.find((f) => f.role === 'main').key}`;
    const orig = srv.objects.get(key);
    srv.objects.set(key, { ...orig, body: Buffer.concat([orig.body, Buffer.from('x')]) });
    await assert.rejects(c.svc.pullCharacter('studio-a', pub.shared_id, { drama_id: c.dramaId }), (e) => e.code === 'STUDIO_CHECKSUM' && e.status === 409 && !!e.details.file);
    assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM characters WHERE local_path LIKE 'studio/%'").get().n, 0, '校验失败不写库');
    assert.equal(fs.existsSync(path.join(c.storageRoot, 'studio')), false, '校验失败不落盘');
    srv.objects.set(key, orig);
    const mkey = `tk-test/talekiln/shared/studio-a/characters/${pub.shared_id}/manifest.json`;
    const morig = srv.objects.get(mkey);
    const bad = JSON.parse(morig.body.toString('utf8'));
    bad.name = '被改过';
    srv.objects.set(mkey, { ...morig, body: Buffer.from(JSON.stringify(bad)) });
    const l3 = await c.svc.listShared('studio-a', 'character');
    assert.equal(l3.items.length, 0);
    assert.equal(l3.invalid.length, 1);
    await assert.rejects(c.svc.pullCharacter('studio-a', pub.shared_id, { drama_id: c.dramaId }), (e) => e.code === 'STUDIO_INVALID_MANIFEST' && e.status === 400);
    srv.objects.set(mkey, morig);
    // 不是成员的工作室：连列表都拒绝（对象存储层面的前缀隔离由服务器策略保证）
    await assert.rejects(c.svc.listShared('studio-b', 'character'), (e) => e.code === 'STUDIO_NOT_MEMBER');
  });

  it('template: publish a builtin -> list -> pull installs it (builtin id is refused locally, a renamed copy installs)', async () => {
    const a = await setup({ srv });
    srv.objects.clear();
    const { items } = await a.templates.list();
    const builtin = items.find((t) => t.source === 'builtin');
    assert.ok(builtin);
    await assert.rejects(a.svc.publishTemplate('nope-template', { studio_id: 'studio-a' }), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(a.svc.publishTemplate(builtin.id, { studio_id: 'studio-b' }), (e) => e.code === 'STUDIO_FORBIDDEN');
    const pub = await a.svc.publishTemplate(builtin.id, { studio_id: 'studio-a' });
    assert.equal(pub.shared_id, builtin.id);
    assert.equal(pub.version, 1);
    assert.equal(pub.manifest.fields.template_version, builtin.version);
    const tkey = `tk-test/talekiln/shared/studio-a/templates/${builtin.id}/template.json`;
    assert.equal(sha(srv.objects.get(tkey).body), pub.manifest.files[0].sha256);
    const list = await a.svc.listShared('studio-a', 'template');
    assert.equal(list.items[0].state, 'mine');
    assert.equal(list.items[0].fields.template_version, builtin.version);
    // 拉取端：同 id 的内置模板不能被覆盖（模板服务的规则），错误原样透传
    const b = await setup({ srv, studios: [{ ...STUDIO_A, my_role: 'member' }] });
    await assert.rejects(b.svc.pullTemplate('studio-a', builtin.id), (e) => e.name === 'TemplateError' && e.code === 'TEMPLATE_BUILTIN_READONLY');
    // 发布一个改了 id 的副本（模拟工作室自己的模板）
    const custom = { ...a.templates.get(builtin.id).manifest, id: 'studio-a-custom', name: '工作室自定义模板', version: '0.1.0' };
    delete custom.signature;
    await a.templates.install({ manifest: custom, source: 'local' });
    const pub2 = await a.svc.publishTemplate('studio-a-custom', { studio_id: 'studio-a' });
    assert.equal(pub2.version, 1);
    const pulled = await b.svc.pullTemplate('studio-a', 'studio-a-custom');
    assert.equal(pulled.template_id, 'studio-a-custom');
    assert.equal(pulled.template.source, 'local');
    assert.equal(b.templates.get('studio-a-custom').manifest.name, '工作室自定义模板');
    const bl = await b.svc.listShared('studio-a', 'template');
    assert.deepEqual(bl.items.map((i) => [i.shared_id, i.state]).sort(), [[builtin.id, 'not_pulled'], ['studio-a-custom', 'pulled']]);
    // 篡改 template.json -> 409
    const k2 = `tk-test/talekiln/shared/studio-a/templates/studio-a-custom/template.json`;
    const o = srv.objects.get(k2);
    srv.objects.set(k2, { ...o, body: Buffer.from(o.body.toString('utf8').replace('工作室自定义模板', '改了')) });
    await assert.rejects(b.svc.pullTemplate('studio-a', 'studio-a-custom'), (e) => e.code === 'STUDIO_CHECKSUM');
    srv.objects.set(k2, o);
  });

  it('REST: identity, list, publish / pull, errors carry codes', async () => {
    const a = await setup({ srv });
    srv.objects.clear();
    const app = express();
    app.use(express.json());
    const st = studioRoutes(a.svc, log);
    const r = express.Router();
    r.get('/studio/identity', st.identity);
    r.put('/studio/current', st.setCurrent);
    r.get('/studio/shared/:kind', st.listShared);
    r.post('/studio/shared/characters/publish', st.publishCharacter);
    r.post('/studio/shared/characters/pull', st.pullCharacter);
    r.post('/studio/shared/templates/publish', st.publishTemplate);
    r.get('/studio/records', st.records);
    r.get('/studio/studios/:id', st.detail);
    r.post('/studio/studios/:id/invites', st.invite);
    app.use('/api/v1', r);
    const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json() };
    };
    try {
      const id = await call('GET', '/studio/identity?sync=1');
      assert.equal(id.status, 200);
      assert.equal(id.json.data.current_studio_id, 'studio-a');
      assert.equal((await call('PUT', '/studio/current', { studio_id: 'studio-b' })).json.data.current_studio_id, 'studio-b');
      assert.equal((await call('PUT', '/studio/current', {})).json.error.code, 'BAD_REQUEST');
      assert.equal((await call('PUT', '/studio/current', { studio_id: 'zzz' })).status, 403);
      assert.equal((await call('GET', '/studio/shared/scenes')).json.error.code, 'BAD_REQUEST');
      // 当前是 studio-b（member）：发布被拒；指定 studio-a 可以
      const denied = await call('POST', '/studio/shared/characters/publish', { character_id: a.characterId });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error.code, 'STUDIO_FORBIDDEN');
      assert.equal((await call('POST', '/studio/shared/characters/publish', {})).json.error.code, 'BAD_REQUEST');
      const pub = await call('POST', '/studio/shared/characters/publish', { character_id: a.characterId, studio_id: 'studio-a' });
      assert.equal(pub.status, 201, JSON.stringify(pub.json));
      const list = await call('GET', '/studio/shared/characters?studio_id=studio-a');
      assert.equal(list.json.data.items[0].state, 'mine');
      const pull = await call('POST', '/studio/shared/characters/pull', { studio_id: 'studio-a', shared_id: pub.json.data.shared_id, drama_id: a.dramaId });
      assert.equal(pull.status, 201, JSON.stringify(pull.json));
      assert.ok(pull.json.data.character_id);
      const rec = await call('GET', '/studio/records?studio_id=studio-a&kind=characters');
      assert.deepEqual(rec.json.data.items.map((x) => x.direction).sort(), ['published', 'pulled']);
      assert.equal((await call('GET', `/studio/studios/studio-a`)).json.data.members.length, 1);
      assert.equal((await call('POST', `/studio/studios/studio-a/invites`, { role: 'member' })).status, 201);
      const tpl = await call('POST', '/studio/shared/templates/publish', { template_id: 'nope', studio_id: 'studio-a' });
      assert.equal(tpl.status, 404);
      assert.equal(tpl.json.error.code, 'NOT_FOUND');
    } finally {
      await new Promise((res) => server.close(res));
    }
  });
});
