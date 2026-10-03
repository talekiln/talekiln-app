'use strict';
// 完整项目备份（ZIP 1.5）：POST /dramas/:id/backup/full · POST /dramas/restore · 快照路由。
// docs/superpowers/plans/2026-10-03-four-view-unification.md Task 5（spec §10.3）
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const AdmZip = require('adm-zip');
const kernel = require('@talekiln/kernel');
const store = require('../src/kernel/store');
const legacy = require('../src/kernel/legacy');
const timelineService = require('../src/timeline/service');
const { setupRouter } = require('../src/routes/index.js');
const { loadConfig } = require('../src/config');
const { seededDb, log } = require('./helpers/kernelDb');

const servers = [];
let ctx;
let cfg;
let base;
let dramaId;
let ep;
let storage;
let REF;
let baseFiles = [];

function filesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}
const count = (sql) => ctx.db.prepare(sql).get().n;
const dramaCount = () => count('SELECT COUNT(*) n FROM dramas WHERE deleted_at IS NULL');

async function call(method, url, opts = {}) {
  const res = await fetch(`${base}/api/v1${url}`, { method, ...opts });
  return res;
}
async function postZip(buf, field = 'file') {
  const form = new FormData();
  if (buf) form.append(field, new Blob([buf], { type: 'application/zip' }), 'x.talekiln.zip');
  const res = await call('POST', '/dramas/restore', { body: form });
  return { status: res.status, body: await res.json() };
}

/** 源项目：旧表导入项目图，加一次带角色的编辑、一个带真实文件的已采用图片、一次普通编辑（撤销栈 3 层）。 */
function buildSource() {
  const { db, episodeId } = ctx;
  legacy.importLegacy(db, episodeId);
  const shots = kernel.shotOrder(store.openProject(db, episodeId).graph);
  store.commit(db, episodeId, (g) => kernel.intents.shot.setShotField(g, shots[1], { characters: [1] }, { tx_id: 'b1' }), { tx_id: 'b1' });
  store.commit(db, episodeId, (g) => kernel.intents.shot.recordGeneration(g, kernel.partsOfShot(g, shots[1]).image,
    { version_id: 'gen_b', asset: { ref: REF, kind: 'image', hash: 'hash-b' } }, { tx_id: 'b2' }), { tx_id: 'b2' });
  store.commit(db, episodeId, (g) => kernel.intents.shot.setShotField(g, shots[2], { title: '备份前改的标题' }, { tx_id: 'b3' }), { tx_id: 'b3' });
}

/** 一个原项目的“指纹”：所有会被恢复动到的表，用来证明原项目没被改。 */
function fingerprint() {
  const { db } = ctx;
  return JSON.stringify({
    dramas: db.prepare('SELECT * FROM dramas WHERE id = ?').all(dramaId),
    eps: db.prepare('SELECT * FROM episodes WHERE id = ?').all(ep),
    sb: db.prepare('SELECT * FROM storyboards WHERE episode_id = ? ORDER BY id').all(ep),
    graph: db.prepare('SELECT * FROM project_graphs WHERE episode_id = ?').all(ep),
    ops: db.prepare('SELECT * FROM graph_ops WHERE episode_id = ? ORDER BY seq').all(ep),
    map: db.prepare('SELECT * FROM graph_legacy_map WHERE episode_id = ? ORDER BY node_id').all(ep),
    tl: timelineService.loadTimelineByEpisode(db, ep),
    // 原项目已有的媒体文件：还在、内容没变（恢复新增的文件不算）
    files: baseFiles.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f).toString('base64') : null]),
  });
}

before(async () => {
  ctx = await seededDb();
  ep = ctx.episodeId;
  dramaId = ctx.db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(ep).drama_id;
  storage = path.join(ctx.dir, 'storage');
  // 采用的图片指向一个真实文件，备份要把它带走
  const rel = `projects/sample-extra/gen_b.png`;
  fs.mkdirSync(path.join(storage, 'projects/sample-extra'), { recursive: true });
  fs.writeFileSync(path.join(storage, rel), Buffer.from('PNG-BYTES-b'));
  REF = `/static/${rel}`;
  buildSource();
  baseFiles = filesUnder(storage).sort();

  cfg = { ...loadConfig() };
  cfg.storage = { ...(cfg.storage || {}), local_path: storage };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter(cfg, ctx.db, log, null, null, { storageRoot: storage }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  servers.push(server);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { for (const s of servers) s.close(); });

describe('POST /dramas/:id/backup/full', () => {
  it('streams a *.talekiln.zip in format 1.5 with the kernel snapshot, original ids and the adopted media', async () => {
    const res = await call('POST', `/dramas/${dramaId}/backup/full`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/zip/);
    assert.match(decodeURIComponent(res.headers.get('content-disposition')), /\.talekiln\.zip/);
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(buf);
    const pj = JSON.parse(zip.getEntry('project.json').getData().toString('utf8'));
    assert.equal(pj.version, '1.5');
    const e0 = pj.episodes[0];
    assert.ok(/^kernel\/episode-.*\.json$/.test(e0.kernel_file), `kernel_file pointer: ${e0.kernel_file}`);
    assert.ok(zip.getEntry(e0.kernel_file), 'kernel entry exists');
    assert.ok(e0.storyboards.every((s) => Number.isInteger(s.original_id)), 'storyboards carry original_id');
    const snapJson = JSON.parse(zip.getEntry(e0.kernel_file).getData().toString('utf8'));
    assert.equal(snapJson.format, 'talekiln-kernel-snapshot');
    const zipPath = snapJson.media[REF];
    assert.ok(zipPath, 'the adopted image is mapped to a zip path');
    assert.equal(zip.getEntry(zipPath).getData().toString(), 'PNG-BYTES-b');
  });

  it('404 for a drama that does not exist', async () => {
    const res = await call('POST', '/dramas/987654/backup/full');
    assert.equal(res.status, 404);
  });
});

describe('POST /dramas/restore', () => {
  let backup;
  before(async () => {
    const res = await call('POST', `/dramas/${dramaId}/backup/full`);
    backup = Buffer.from(await res.arrayBuffer());
  });

  it('restores as a NEW project with undo history, versions, media and timeline; the original is untouched', async () => {
    const before = fingerprint();
    const dramasBefore = dramaCount();
    const r = await postZip(backup);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.success, true);
    const newDrama = r.body.data.drama_id;
    assert.notEqual(newDrama, dramaId);
    assert.equal(dramaCount(), dramasBefore + 1);
    assert.equal(fingerprint(), before, 'original project unchanged');

    const { db } = ctx;
    const newEp = db.prepare('SELECT id FROM episodes WHERE drama_id = ? AND deleted_at IS NULL').get(newDrama).id;
    assert.notEqual(newEp, ep);
    const src = store.openProject(db, ep);
    const dst = store.openProject(db, newEp);
    assert.equal(dst.history.past.length, src.history.past.length, 'undo stack restored');
    assert.equal(kernel.shotOrder(dst.graph).length, kernel.shotOrder(src.graph).length);
    // 采用的版本还在，指向新项目目录里的文件
    const shots = kernel.shotOrder(dst.graph);
    const adopted = JSON.stringify(dst.graph.adopted);
    assert.ok(adopted.includes('gen_b'), 'adopted version survives');
    assert.ok(!adopted.includes(REF), 'old media ref is rewritten');
    const m = /"ref":"(\/static\/[^"]+)"/.exec(JSON.stringify(dst.graph.versions));
    assert.ok(m, 'a media ref exists in the restored graph');
    const abs = path.join(storage, m[1].slice('/static/'.length));
    assert.ok(fs.existsSync(abs), 'the restored file exists on disk');
    assert.equal(fs.readFileSync(abs).toString(), 'PNG-BYTES-b');
    // 撤销在新项目里真的能走：撤销最后一次（改标题）
    const undone = store.undo(db, newEp);
    assert.ok(undone, 'undo works on the restored project');
    assert.notEqual(store.openProject(db, newEp).graph.nodes[shots[2]].params.title, '备份前改的标题');
    // 时间线物化
    assert.ok(timelineService.loadTimelineByEpisode(db, newEp), 'timeline exists');
    // 原项目的撤销栈没因此受影响
    assert.equal(fingerprint(), before);
  });

  it('restoring the same backup twice gives two independent projects', async () => {
    const a = await postZip(backup);
    const b = await postZip(backup);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.data.drama_id, b.body.data.drama_id);
  });

  it('corrupt zip -> 400 BACKUP_CORRUPT, nothing left behind', async () => {
    const dramas = dramaCount();
    const files = filesUnder(storage).length;
    const r = await postZip(Buffer.from('this is definitely not a zip file'));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'BACKUP_CORRUPT');
    assert.equal(dramaCount(), dramas);
    assert.equal(filesUnder(storage).length, files);
  });

  it('a zip without project.json -> 400 BACKUP_CORRUPT', async () => {
    const z = new AdmZip();
    z.addFile('hello.txt', Buffer.from('hi'));
    const r = await postZip(z.toBuffer());
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'BACKUP_CORRUPT');
  });

  it('a newer format version -> 400 BACKUP_VERSION_UNSUPPORTED, nothing left behind', async () => {
    const z = new AdmZip(backup);
    const pj = JSON.parse(z.getEntry('project.json').getData().toString('utf8'));
    pj.version = '9.0';
    z.updateFile('project.json', Buffer.from(JSON.stringify(pj)));
    const dramas = dramaCount();
    const files = filesUnder(storage).length;
    const r = await postZip(z.toBuffer());
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'BACKUP_VERSION_UNSUPPORTED');
    assert.equal(dramaCount(), dramas);
    assert.equal(filesUnder(storage).length, files);
  });

  it('missing file field -> 400', async () => {
    const r = await postZip(null);
    assert.equal(r.status, 400);
  });

  it('a failed restore leaves no half-built project and deletes the media it already copied', async () => {
    // 角色图先落盘，之后某个分镜字段绑定不了（对象）-> 事务回滚；文件也要被删
    const z = new AdmZip();
    z.addFile('media/characters/c.png', Buffer.from('IMG'));
    z.addFile('project.json', Buffer.from(JSON.stringify({
      version: '1.4',
      drama: { title: '会失败的项目' },
      characters: [{ name: '甲', image_file: 'media/characters/c.png' }],
      episodes: [{ episode_number: 1, title: '一', storyboards: [{ storyboard_number: 1, dialogue: { not: 'bindable' } }] }],
    })));
    const dramas = dramaCount();
    const chars = count('SELECT COUNT(*) n FROM characters');
    const sbs = count('SELECT COUNT(*) n FROM storyboards');
    const files = filesUnder(storage).sort();
    const r = await postZip(z.toBuffer());
    assert.ok(r.status >= 400, `status ${r.status}`);
    assert.equal(dramaCount(), dramas, 'no drama row');
    assert.equal(count('SELECT COUNT(*) n FROM characters'), chars, 'no character rows');
    assert.equal(count('SELECT COUNT(*) n FROM storyboards'), sbs, 'no storyboard rows');
    assert.deepEqual(filesUnder(storage).sort(), files, 'copied media deleted');
  });

  it('still imports a hand-built 1.4 package (no kernel, no original_id); the graph is rebuilt lazily', async () => {
    const z = new AdmZip();
    z.addFile('project.json', Buffer.from(JSON.stringify({
      version: '1.4',
      drama: { title: '老格式项目' },
      characters: [{ name: '乙' }],
      episodes: [{ episode_number: 1, title: '第一集', storyboards: [
        { storyboard_number: 1, title: 'a', description: 'd1', duration: 3, character_indices: [0] },
        { storyboard_number: 2, title: 'b', description: 'd2', duration: 4 },
      ] }],
    })));
    const r = await postZip(z.toBuffer());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { db } = ctx;
    const newEp = db.prepare('SELECT id FROM episodes WHERE drama_id = ?').get(r.body.data.drama_id).id;
    assert.equal(db.prepare('SELECT COUNT(*) n FROM storyboards WHERE episode_id = ?').get(newEp).n, 2);
    assert.equal(store.hasProject(db, newEp), false, 'no graph yet (lazy)');
    legacy.importLegacy(db, newEp);
    assert.equal(kernel.shotOrder(store.openProject(db, newEp).graph).length, 2);
  });

  it('the legacy /dramas/import endpoint still accepts a 1.5 package', async () => {
    const form = new FormData();
    form.append('file', new Blob([backup]), 'x.zip');
    const res = await call('POST', '/dramas/import', { body: form });
    assert.equal(res.status, 201);
  });
});

describe('snapshot routes', () => {
  it('lists snapshots newest first, and restoring one creates a new project', async () => {
    const empty = await (await call('GET', `/dramas/${dramaId}/snapshots`)).json();
    assert.equal(empty.success, true);
    assert.deepEqual(empty.data, []);

    const hooks = require('../src/backup/hooks');
    await hooks.beforeDestructive(ep, 'route-test');
    const list = await (await call('GET', `/dramas/${dramaId}/snapshots`)).json();
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].reason, 'route-test');
    assert.ok(list.data[0].id && list.data[0].created_at);

    const dramas = dramaCount();
    const res = await call('POST', `/dramas/${dramaId}/snapshots/${list.data[0].id}/restore`);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.notEqual(body.data.drama_id, dramaId);
    assert.equal(dramaCount(), dramas + 1);
  });

  it('unknown or malicious snapshot ids -> 404 and nothing is created', async () => {
    const dramas = dramaCount();
    for (const sid of ['nope', 's0000000000000_0000', '..%2F..%2Fx', '%2e%2e']) {
      const res = await call('POST', `/dramas/${dramaId}/snapshots/${sid}/restore`);
      assert.equal(res.status, 404, sid);
    }
    assert.equal(dramaCount(), dramas);
  });
});
