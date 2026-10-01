'use strict';
// GET /episodes/:id/history：只读的 graph_ops 日志视图（版本历史界面用）。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const kernel = require('@talekiln/kernel');
const kernelRoutes = require('../src/routes/kernel');
const { localTokenGuard } = require('../src/utils/localToken');
const { seededDb, log } = require('./helpers/kernelDb');

let server;
let base;
let db;
let ep;

async function call(method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-talekiln-token': 'tok' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const intent = (view, name, args, tx_id) => call('POST', `/episodes/${ep}/intent`, { view, name, args, tx_id });
const history = (q = '') => call('GET', `/episodes/${ep}/history${q}`);
const graph = async () => (await call('GET', `/episodes/${ep}/graph`)).body.data.graph;
const opCount = () => db.prepare('SELECT COUNT(*) AS n FROM graph_ops WHERE episode_id = ?').get(ep).n;

before(async () => {
  ({ db, episodeId: ep } = await seededDb());
  const app = express();
  app.use(localTokenGuard('tok'));
  app.use(express.json());
  const k = kernelRoutes(db, log);
  const r = express.Router();
  r.get('/episodes/:id/graph', k.getGraph);
  r.get('/episodes/:id/history', k.getHistory);
  r.get('/episodes/:id/versions', k.getVersions);
  r.post('/episodes/:id/tx', k.postTx);
  r.post('/episodes/:id/intent', k.postIntent);
  r.post('/episodes/:id/undo', k.postUndo);
  r.post('/episodes/:id/redo', k.postRedo);
  r.post('/episodes/:id/import-legacy', k.importLegacy);
  app.use('/api/v1', r);
  await new Promise((ok) => { server = app.listen(0, '127.0.0.1', ok); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe('GET /episodes/:id/history', () => {
  it('needs the token, a valid id and a project graph', async () => {
    assert.equal((await fetch(`${base}/api/v1/episodes/${ep}/history`)).status, 401);
    assert.equal((await call('GET', '/episodes/abc/history')).status, 400);
    const r = await history();
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'GRAPH_NOT_FOUND');
  });

  it('empty log right after import', async () => {
    assert.equal((await call('POST', `/episodes/${ep}/import-legacy`, {})).status, 201);
    const r = await history();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.entries, []);
    assert.equal(r.body.data.can_undo, false);
    assert.equal(r.body.data.undo_depth, 0);
    assert.equal(r.body.data.truncated, false);
  });

  it('lists transactions newest first with label, op summary, state and undo steps', async () => {
    const g = await graph();
    const shots = kernel.shotOrder(g);
    assert.equal((await intent('shot', 'setShotField', { shot_id: shots[0], patch: { title: '历史一' } }, 'h-1')).status, 200);
    assert.equal((await intent('shot', 'setShotField', { shot_id: shots[1], patch: { title: '历史二' } }, 'h-2')).status, 200);
    // 一次“生成结果”：新增版本并采用（与生成服务写入同形的原始事务）
    const imageNode = Object.values(g.nodes).find((n) => n.type === 'image').id;
    const keys = kernel.cacheKeys(g);
    const tx = await call('POST', `/episodes/${ep}/tx`, {
      tx_id: 'h-3', label: 'recordGeneration',
      ops: [
        { op: 'addVersion', node: imageNode, version: { id: 'hist_v1', cache_key: keys[imageNode], asset: { ref: 'images/x.png', kind: 'image', hash: 'abc' } } },
        { op: 'adoptVersion', node: imageNode, version_id: 'hist_v1' },
      ],
    });
    assert.equal(tx.status, 200);

    const before = opCount();
    const r = await history();
    assert.equal(opCount(), before, 'GET writes nothing');
    const e = r.body.data.entries;
    assert.deepEqual(e.map((x) => x.tx_id), ['h-3', 'h-2', 'h-1']);
    assert.ok(e[0].seq > e[1].seq && e[1].seq > e[2].seq);
    assert.equal(e[0].label, 'recordGeneration');
    assert.deepEqual(e[0].op_kinds, { addVersion: 1, adoptVersion: 1 });
    assert.deepEqual(e[0].versions_added, [{ node: imageNode, version_id: 'hist_v1' }]);
    assert.deepEqual(e[0].versions_adopted, [{ node: imageNode, version_id: 'hist_v1' }]);
    assert.deepEqual(e[0].nodes, [imageNode]);
    assert.ok(Number.isFinite(Date.parse(e[0].created_at)));
    assert.deepEqual(e.map((x) => [x.state, x.undo_steps]), [['applied', 0], ['applied', 1], ['applied', 2]]);
    assert.equal(e[2].label, 'setShotField');
    assert.equal(r.body.data.undo_depth, 3);
  });

  it('undo marks the entry undone (redo_steps) and logs an event; a new edit discards it', async () => {
    assert.equal((await call('POST', `/episodes/${ep}/undo`, { tx_id: 'u-1' })).status, 200);
    let r = (await history()).body.data;
    assert.equal(r.entries[0].kind, 'undo');
    assert.equal(r.entries[0].state, 'event');
    assert.equal(r.entries[0].target, 'h-3');
    const byId = Object.fromEntries(r.entries.filter((x) => x.kind === 'apply').map((x) => [x.tx_id, x]));
    assert.equal(byId['h-3'].state, 'undone');
    assert.equal(byId['h-3'].redo_steps, 1);
    assert.equal(byId['h-2'].state, 'applied');
    assert.equal(byId['h-2'].undo_steps, 0);
    assert.equal(r.can_redo, true);
    assert.equal(r.redo_depth, 1);

    // 两步撤销：h-2 也在重做栈里，重做顺序先 h-2 后 h-3
    assert.equal((await call('POST', `/episodes/${ep}/undo`, { tx_id: 'u-2' })).status, 200);
    r = (await history()).body.data;
    const m = Object.fromEntries(r.entries.filter((x) => x.kind === 'apply').map((x) => [x.tx_id, x]));
    assert.equal(m['h-2'].redo_steps, 1);
    assert.equal(m['h-3'].redo_steps, 2);

    // 新的编辑顶掉重做栈：h-2 / h-3 回不去了
    const shots = kernel.shotOrder(await graph());
    assert.equal((await intent('shot', 'setShotField', { shot_id: shots[2], patch: { title: '历史四' } }, 'h-4')).status, 200);
    r = (await history()).body.data;
    const n = Object.fromEntries(r.entries.filter((x) => x.kind === 'apply').map((x) => [x.tx_id, x]));
    assert.equal(n['h-2'].state, 'discarded');
    assert.equal(n['h-3'].state, 'discarded');
    assert.equal(n['h-2'].undo_steps, undefined);
    assert.equal(n['h-4'].state, 'applied');
    assert.equal(n['h-1'].undo_steps, 1);
    assert.equal(r.can_redo, false);
  });

  it('limit truncates the list (newest kept) without changing the states', async () => {
    const full = (await history()).body.data;
    const two = (await history('?limit=2')).body.data;
    assert.equal(two.entries.length, 2);
    assert.equal(two.truncated, true);
    assert.deepEqual(two.entries, full.entries.slice(0, 2));
    assert.equal((await history('?limit=0')).body.data.entries.length, full.entries.length, 'invalid limit falls back to the default');
    assert.equal((await history('?limit=abc')).body.data.truncated, false);
  });

  it('jumping by the reported steps reaches the intended state', async () => {
    const e = (await history()).body.data.entries.find((x) => x.tx_id === 'h-1');
    for (let i = 0; i < e.undo_steps; i++) assert.equal((await call('POST', `/episodes/${ep}/undo`, {})).status, 200);
    const g = await graph();
    const shots = kernel.shotOrder(g);
    assert.equal(g.nodes[shots[0]].params.title, '历史一');
    assert.notEqual(g.nodes[shots[2]].params.title, '历史四');
    const after1 = (await history()).body.data.entries.find((x) => x.tx_id === 'h-1');
    assert.equal(after1.undo_steps, 0);
  });

  it('versions: per generated node, adopted / current flags, creation time, asset summary; adopt via raw tx moves the flag', async () => {
    // 回到 h-3 的状态：重做不可能（已被顶掉），所以直接新建两个版本再切换采用
    const g = await graph();
    const imageNode = Object.values(g.nodes).find((n) => n.type === 'image').id;
    const keys = kernel.cacheKeys(g);
    const mk = (id, ref, key) => ({ id, cache_key: key, asset: { ref, kind: 'image', hash: 'h'.repeat(64) }, metadata: { duration_ms: 1200, words: [{ w: 'x' }], inputs: { model: 'm1' } }, source: 'ai-task:9' });
    const add = await call('POST', `/episodes/${ep}/tx`, {
      tx_id: 'v-1', label: 'recordGeneration',
      ops: [
        { op: 'addVersion', node: imageNode, version: mk('vA', 'images/a.png', keys[imageNode]) },
        { op: 'addVersion', node: imageNode, version: mk('vB', 'images/b.png', 'oldkey-not-current') },
        { op: 'adoptVersion', node: imageNode, version_id: 'vA' },
      ],
    });
    assert.equal(add.status, 200);
    const before = opCount();
    const r = await call('GET', `/episodes/${ep}/versions`);
    assert.equal(r.status, 200);
    assert.equal(opCount(), before, 'GET writes nothing');
    const n = r.body.data.nodes.find((x) => x.node === imageNode);
    assert.equal(n.type, 'image');
    assert.ok(n.shot_id);
    assert.equal(n.adopted, 'vA');
    assert.equal(n.state, 'fresh');
    const byId = Object.fromEntries(n.versions.map((v) => [v.id, v]));
    assert.equal(byId.vA.adopted, true);
    assert.equal(byId.vA.current, true);
    assert.equal(byId.vB.adopted, false);
    assert.equal(byId.vB.current, false);
    assert.equal(byId.vA.asset.ref, 'images/a.png');
    assert.equal(byId.vA.asset.hash.length, 12);
    assert.deepEqual(byId.vA.metadata, { duration_ms: 1200, model: 'm1' }, 'big fields such as word timestamps are not exposed');
    assert.ok(Number.isFinite(Date.parse(byId.vA.created_at)));
    assert.ok(r.body.data.nodes.some((x) => x.type === 'compose' && x.shot_id === null));

    // 采用另一个版本：走原始 /tx（内核已有 op），采用标记移动、节点变过期、可撤销
    const adopt = await call('POST', `/episodes/${ep}/tx`, { tx_id: 'v-2', label: 'adoptVersion', ops: [{ op: 'adoptVersion', node: imageNode, version_id: 'vB' }] });
    assert.equal(adopt.status, 200);
    const n2 = (await call('GET', `/episodes/${ep}/versions`)).body.data.nodes.find((x) => x.node === imageNode);
    assert.equal(n2.adopted, 'vB');
    assert.equal(n2.state, 'stale');
    assert.equal(n2.versions.find((v) => v.id === 'vA').adopted, false);
    assert.equal((await call('POST', `/episodes/${ep}/undo`, {})).status, 200);
    assert.equal((await call('GET', `/episodes/${ep}/versions`)).body.data.nodes.find((x) => x.node === imageNode).adopted, 'vA');
  });

  it('versions: 400 / 404 like the other read routes', async () => {
    assert.equal((await call('GET', '/episodes/0/versions')).status, 400);
    assert.equal((await call('GET', '/episodes/999999/versions')).status, 404);
  });
});
