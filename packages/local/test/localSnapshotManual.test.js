'use strict';
// 手动本地快照：POST /dramas/:id/snapshots（删除项目前由前端调用）；已软删除项目的快照仍可列出 / 恢复。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const AdmZip = require('adm-zip');
const legacy = require('../src/kernel/legacy');
const hooks = require('../src/backup/hooks');
const { KEEP } = require('../src/backup/localSnapshot');
const { setupRouter } = require('../src/routes/index.js');
const { loadConfig } = require('../src/config');
const { seededDb, log } = require('./helpers/kernelDb');

const servers = [];
let ctx;
let base;
let dramaId;

async function call(method, url, body) {
  const opts = { method };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res = await fetch(`${base}/api/v1${url}`, opts);
  return { status: res.status, body: await res.json() };
}

before(async () => {
  ctx = await seededDb();
  dramaId = ctx.db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(ctx.episodeId).drama_id;
  legacy.importLegacy(ctx.db, ctx.episodeId);
  // 第二集：快照必须带上项目的全部集
  const now = new Date().toISOString();
  ctx.db.prepare(
    `INSERT INTO episodes (drama_id, episode_number, title, script_content, description, duration, status, created_at, updated_at) VALUES (?, 2, ?, ?, ?, 30, 'draft', ?, ?)`
  ).run(dramaId, '第二集', 'script two', 'desc two', now, now);
  const cfg = { ...loadConfig() };
  cfg.storage = { ...(cfg.storage || {}), local_path: path.join(ctx.dir, 'storage') };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter(cfg, ctx.db, log, null, null, { storageRoot: path.join(ctx.dir, 'storage') }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  servers.push(server);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { for (const s of servers) s.close(); hooks.setBeforeDestructive(null); });

describe('POST /dramas/:id/snapshots', () => {
  it('takes a full-project snapshot (all episodes) with default reason "manual" and returns 201 {id, created_at}', async () => {
    const r = await call('POST', `/dramas/${dramaId}/snapshots`);
    assert.equal(r.status, 201);
    assert.equal(r.body.success, true);
    assert.deepEqual(Object.keys(r.body.data).sort(), ['created_at', 'id']);
    assert.match(r.body.data.id, /^s\d{13}_[0-9a-f]{4}$/);
    assert.ok(!Number.isNaN(Date.parse(r.body.data.created_at)));

    const list = await call('GET', `/dramas/${dramaId}/snapshots`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data[0].id, r.body.data.id);
    assert.equal(list.body.data[0].reason, 'manual');
    assert.equal(list.body.data[0].created_at, r.body.data.created_at);
    assert.ok(list.body.data[0].size > 0);

    const file = path.join(ctx.dir, 'snapshots', String(dramaId), `${r.body.data.id}.talekiln.zip`);
    const pj = JSON.parse(new AdmZip(file).getEntry('project.json').getData().toString('utf8'));
    assert.equal(pj.version, '1.5');
    assert.equal(pj.episodes.length, 2, 'every episode of the project is in the snapshot');
    assert.deepEqual(pj.episodes.map((e) => e.title).includes('第二集'), true);
  });

  it('records a custom reason from the body', async () => {
    const r = await call('POST', `/dramas/${dramaId}/snapshots`, { reason: 'before-delete' });
    assert.equal(r.status, 201);
    const list = await call('GET', `/dramas/${dramaId}/snapshots`);
    assert.equal(list.body.data[0].id, r.body.data.id);
    assert.equal(list.body.data[0].reason, 'before-delete');
  });

  it('rejects a non-string reason with 400 and writes nothing', async () => {
    const before = (await call('GET', `/dramas/${dramaId}/snapshots`)).body.data.length;
    const r = await call('POST', `/dramas/${dramaId}/snapshots`, { reason: { x: 1 } });
    assert.equal(r.status, 400);
    assert.equal((await call('GET', `/dramas/${dramaId}/snapshots`)).body.data.length, before);
  });

  it('keeps only the last 5 snapshots', async () => {
    for (let i = 0; i < KEEP + 2; i++) assert.equal((await call('POST', `/dramas/${dramaId}/snapshots`, { reason: `n${i}` })).status, 201);
    const list = await call('GET', `/dramas/${dramaId}/snapshots`);
    assert.equal(list.body.data.length, KEEP);
    assert.equal(list.body.data[0].reason, `n${KEEP + 1}`);
    const dir = path.join(ctx.dir, 'snapshots', String(dramaId));
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.talekiln.zip')).length, KEEP);
  });

  it('404 for an unknown drama, a non-numeric id, and leaves no files', async () => {
    assert.equal((await call('POST', '/dramas/987654/snapshots')).status, 404);
    assert.equal((await call('POST', '/dramas/abc/snapshots')).status, 404);
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'snapshots', '987654')) || fs.readdirSync(path.join(ctx.dir, 'snapshots', '987654')).length === 0);
  });
});

describe('snapshots of a soft-deleted project', () => {
  let snapId;
  before(async () => {
    snapId = (await call('POST', `/dramas/${dramaId}/snapshots`, { reason: 'before-delete' })).body.data.id;
    assert.equal((await call('DELETE', `/dramas/${dramaId}`)).status, 200);
  });

  it('GET /dramas/:id/snapshots still lists them after the project is soft-deleted', async () => {
    assert.ok(ctx.db.prepare('SELECT deleted_at FROM dramas WHERE id = ?').get(dramaId).deleted_at, 'really soft-deleted');
    const list = await call('GET', `/dramas/${dramaId}/snapshots`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data[0].id, snapId);
    assert.equal(list.body.data[0].reason, 'before-delete');
  });

  it('restore still works (creates a new project with all episodes)', async () => {
    const r = await call('POST', `/dramas/${dramaId}/snapshots/${snapId}/restore`);
    assert.equal(r.status, 201);
    assert.notEqual(r.body.data.drama_id, dramaId);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM episodes WHERE drama_id = ? AND deleted_at IS NULL').get(r.body.data.drama_id).n, 2);
  });

  it('POST a new snapshot of the deleted project is 404', async () => {
    assert.equal((await call('POST', `/dramas/${dramaId}/snapshots`)).status, 404);
  });
});
