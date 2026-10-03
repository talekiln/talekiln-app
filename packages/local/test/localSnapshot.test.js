'use strict';
// 本地快照：破坏性操作前自动存一份完整备份，保留最近 5 份，可按快照恢复成新项目。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const AdmZip = require('adm-zip');
const kernel = require('@talekiln/kernel');
const store = require('../src/kernel/store');
const legacy = require('../src/kernel/legacy');
const hooks = require('../src/backup/hooks');
const { createLocalSnapshots, KEEP } = require('../src/backup/localSnapshot');
const { setupRouter } = require('../src/routes/index.js');
const { loadConfig } = require('../src/config');
const { seededDb, log } = require('./helpers/kernelDb');

let ctx;
let cfg;
let dramaId;
let ep;
let snaps;

before(async () => {
  ctx = await seededDb();
  ep = ctx.episodeId;
  dramaId = ctx.db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(ep).drama_id;
  legacy.importLegacy(ctx.db, ep);
  cfg = { ...loadConfig() };
  cfg.storage = { ...(cfg.storage || {}), local_path: path.join(ctx.dir, 'storage') };
  snaps = createLocalSnapshots({ db: ctx.db, cfg, log, dir: path.join(ctx.dir, 'snapshots') });
});
after(() => hooks.setBeforeDestructive(null));

describe('localSnapshot', () => {
  it('keeps the last 5', () => assert.equal(KEEP, 5));

  it('snapshotEpisode writes a valid 1.5 package under snapshots/<dramaId>/ and returns {id, created_at, file}', () => {
    const s = snaps.snapshotEpisode(dramaId, 'regenerate-storyboard');
    assert.ok(s.id && s.created_at && s.file);
    assert.ok(path.resolve(s.file).startsWith(path.resolve(ctx.dir, 'snapshots', String(dramaId)) + path.sep), s.file);
    assert.ok(fs.existsSync(s.file));
    const pj = JSON.parse(new AdmZip(s.file).getEntry('project.json').getData().toString('utf8'));
    assert.equal(pj.version, '1.5');
    assert.ok(pj.episodes[0].kernel_file);
    const listed = snaps.listSnapshots(dramaId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, s.id);
    assert.equal(listed[0].reason, 'regenerate-storyboard');
    assert.equal(listed[0].created_at, s.created_at);
  });

  it('the 6th snapshot deletes the oldest (zip and sidecar), newest first', () => {
    const made = [snaps.listSnapshots(dramaId)[0]];
    for (let i = 2; i <= 6; i++) made.push(snaps.snapshotEpisode(dramaId, `r${i}`));
    const list = snaps.listSnapshots(dramaId);
    assert.equal(list.length, 5);
    assert.deepEqual(list.map((s) => s.id), made.slice(1).map((s) => s.id).reverse(), 'newest first, oldest gone');
    const dir = path.join(ctx.dir, 'snapshots', String(dramaId));
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.talekiln.zip')).length, 5);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 5, 'no orphan sidecars');
    assert.ok(!fs.existsSync(path.join(dir, `${made[0].id}.talekiln.zip`)));
  });

  it('restoreSnapshot brings back the snapshotted state as a new project; the current project is untouched', () => {
    const { db } = ctx;
    const shots = kernel.shotOrder(store.openProject(db, ep).graph);
    const s = snaps.snapshotEpisode(dramaId, 'before-edit');
    store.commit(db, ep, (g) => kernel.intents.shot.setShotField(g, shots[0], { title: '快照之后改的' }, { tx_id: 'after-snap' }), { tx_id: 'after-snap' });
    const cur = JSON.stringify(db.prepare('SELECT * FROM project_graphs WHERE episode_id = ?').all(ep));
    const dramas = db.prepare('SELECT COUNT(*) n FROM dramas').get().n;

    const r = snaps.restoreSnapshot(dramaId, s.id);
    assert.notEqual(r.drama_id, dramaId);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dramas').get().n, dramas + 1);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM project_graphs WHERE episode_id = ?').all(ep)), cur, 'current project unchanged');
    const newEp = db.prepare('SELECT id FROM episodes WHERE drama_id = ?').get(r.drama_id).id;
    const restored = store.openProject(db, newEp).graph;
    assert.notEqual(restored.nodes[shots[0]].params.title, '快照之后改的', 'restored state is the snapshotted one');
    assert.equal(store.openProject(db, ep).graph.nodes[shots[0]].params.title, '快照之后改的');
  });

  it('rejects unknown and path-traversal snapshot ids without touching anything', () => {
    const dramas = ctx.db.prepare('SELECT COUNT(*) n FROM dramas').get().n;
    for (const id of ['nope', '../../etc/passwd', '..', 's1_x/../../y', '']) {
      assert.throws(() => snaps.restoreSnapshot(dramaId, id), (e) => e.code === 'SNAPSHOT_NOT_FOUND', id);
    }
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM dramas').get().n, dramas);
  });

  it('list for a drama without snapshots is empty; a bad drama id is rejected', () => {
    assert.deepEqual(snaps.listSnapshots(987654), []);
    assert.throws(() => snaps.snapshotEpisode('../x', 'r'), (e) => e.code === 'SNAPSHOT_NOT_FOUND');
  });

  it('snapshotEpisode of a missing drama fails with SNAPSHOT_NOT_FOUND and leaves no file behind', () => {
    assert.throws(() => snaps.snapshotEpisode(987654, 'r'), (e) => e.code === 'SNAPSHOT_NOT_FOUND');
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'snapshots', '987654')) || fs.readdirSync(path.join(ctx.dir, 'snapshots', '987654')).length === 0);
  });
});

describe('setBeforeDestructive wiring', () => {
  it('is NOT wired by merely creating the service object, and IS reached at runtime once setupRouter ran', async () => {
    const own = await seededDb();
    legacy.importLegacy(own.db, own.episodeId);
    const ownDrama = own.db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(own.episodeId).drama_id;
    const ownCfg = { ...loadConfig() };
    ownCfg.storage = { ...(ownCfg.storage || {}), local_path: path.join(own.dir, 'storage') };

    hooks.setBeforeDestructive(null);
    await hooks.beforeDestructive(own.episodeId, 'noop');
    assert.ok(!fs.existsSync(path.join(own.dir, 'snapshots')), 'no handler -> no snapshot');

    const app = express();
    app.use('/api/v1', setupRouter(ownCfg, own.db, log, null, null, { storageRoot: path.join(own.dir, 'storage') }));

    const out = await hooks.beforeDestructive(own.episodeId, 'regenerate-storyboard');
    assert.ok(out && out.id && out.file, 'handler result is returned');
    const dir = path.join(own.dir, 'snapshots', String(ownDrama));
    assert.ok(fs.existsSync(dir), 'snapshots/<dramaId>/ created in the data dir next to the db');
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.talekiln.zip')).length, 1);
  });

  it('a failing snapshot never blocks the destructive action', async () => {
    hooks.setBeforeDestructive(null);
    const own = await seededDb();
    const app = express();
    app.use('/api/v1', setupRouter({ ...loadConfig(), storage: { local_path: path.join(own.dir, 'storage') } }, own.db, log, null, null, {}));
    own.db.prepare('DELETE FROM episodes').run(); // 找不到集 -> 快照失败
    assert.equal(await hooks.beforeDestructive(own.episodeId, 'x'), null);
  });
});
