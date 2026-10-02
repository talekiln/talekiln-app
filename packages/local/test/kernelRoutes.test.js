'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const kernel = require('@talekiln/kernel');
const kernelRoutes = require('../src/routes/kernel');
const { localTokenGuard } = require('../src/utils/localToken');
const { seededDb, sbRows, log } = require('./helpers/kernelDb');
const { ENTRIES } = require('../src/errors');

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
const rowOfShot = (g, shotId) => db.prepare('SELECT * FROM storyboards WHERE id = ?').get(g.nodes[shotId].legacy_id);
const graph = async () => (await call('GET', `/episodes/${ep}/graph`)).body.data.graph;

before(async () => {
  ({ db, episodeId: ep } = await seededDb());
  const app = express();
  app.use(localTokenGuard('tok'));
  app.use(express.json());
  const k = kernelRoutes(db, log);
  const r = express.Router();
  r.get('/episodes/:id/graph', k.getGraph);
  r.get('/episodes/:id/views/:view', k.getView);
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

describe('kernel REST', () => {
  it('requires the local token', async () => {
    const res = await fetch(`${base}/api/v1/episodes/${ep}/graph`);
    assert.equal(res.status, 401);
  });

  it('graph before import -> 404 GRAPH_NOT_FOUND', async () => {
    const r = await call('GET', `/episodes/${ep}/graph`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'GRAPH_NOT_FOUND');
    assert.ok(r.body.error.action);
    assert.equal((await call('POST', '/episodes/99999/import-legacy', {})).status, 404);
  });

  it('import-legacy: 201 first, 200 afterwards; graph and four views are served', async () => {
    const a = await call('POST', `/episodes/${ep}/import-legacy`, {});
    assert.equal(a.status, 201);
    assert.equal(a.body.data.created, true);
    assert.equal(a.body.data.shots, 5);
    assert.equal((await call('POST', `/episodes/${ep}/import-legacy`, {})).status, 200);
    const g = await call('GET', `/episodes/${ep}/graph`);
    assert.equal(g.status, 200);
    assert.equal(g.body.data.graph.version, 1);
    assert.ok(Array.isArray(g.body.data.stale));
    assert.equal(g.body.data.can_undo, false);
    for (const v of ['script', 'shots', 'timeline', 'canvas']) {
      const r = await call('GET', `/episodes/${ep}/views/${v}`);
      assert.equal(r.status, 200, v);
      assert.equal(r.body.data.view, v);
    }
    assert.equal((await call('GET', `/episodes/${ep}/views/shot`)).status, 200);
    const bad = await call('GET', `/episodes/${ep}/views/nope`);
    assert.equal(bad.status, 400);
    assert.equal((await call('GET', `/episodes/${ep}/views/constructor`)).status, 400);
    assert.equal((await call('GET', '/episodes/abc/graph')).status, 400);
  });

  it('script intent: rewriteLine changes the line, the shot dialogue, the stale set and the legacy row', async () => {
    const g0 = await graph();
    const shot = kernel.shotOrder(g0)[1];
    const line = kernel.spokenLines(g0, shot)[0];
    const r = await intent('script', 'rewriteLine', { line_id: line, patch: { text: '老周：改过的台词。' } }, 'i-rewrite');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.applied, true);
    assert.equal(r.body.data.tx_id, 'i-rewrite');
    assert.equal(r.body.data.can_undo, true);
    assert.ok(r.body.data.invalidated.length >= 1, 'narration of that shot becomes stale');
    const sv = (await call('GET', `/episodes/${ep}/views/shots`)).body.data.data;
    assert.equal(sv.groups.flatMap((x) => x.shots)[1].dialogue, '老周：改过的台词。');
    assert.equal(sbRows(db, ep)[1].dialogue, '老周：改过的台词。');
    const tv = (await call('GET', `/episodes/${ep}/views/timeline`)).body.data.data;
    assert.ok(tv.tracks[1].clips.some((c) => c.text === '老周：改过的台词。'));
    // 幂等：同 tx_id 再发一次是空操作
    const again = await intent('script', 'rewriteLine', { line_id: line, patch: { text: 'x' } }, 'i-rewrite');
    assert.equal(again.body.data.applied, false);
    assert.equal(sbRows(db, ep)[1].dialogue, '老周：改过的台词。');
  });

  it('shot / timeline / canvas intents all commit and keep the views consistent', async () => {
    let g = await graph();
    const s0 = kernel.shotOrder(g)[0];
    assert.equal((await intent('shot', 'setShotField', { shot_id: s0, patch: { title: '镜头一' } })).status, 200);
    assert.equal(sbRows(db, ep)[0].title, '镜头一');

    const seg = kernel.timelineView(await graph()).tracks[0].clips[0].id;
    const t = await intent('timeline', 'trimSegment', { segment_id: seg, in_ms: 500, out_ms: 2500 });
    assert.equal(t.status, 200);
    const tl = (await call('GET', `/episodes/${ep}/views/timeline`)).body.data.data;
    assert.equal(tl.tracks[0].clips[0].duration_ms, 2000);

    assert.equal((await intent('canvas', 'moveNode', { node_id: s0, x: 10, y: 20 })).status, 200);
    g = await graph();
    assert.deepEqual(g.layout[s0], { x: 10, y: 20 });
    const canvas = (await call('GET', `/episodes/${ep}/views/canvas`)).body.data.data;
    assert.deepEqual(canvas.nodes.find((n) => n.id === s0).layout, { x: 10, y: 20 });

    // 画布属性面板：setNodeParam（白名单 + 校验，带标签的事务，旧表同步）
    const vid = kernel.partsOfShot(g, s0).video;
    const np = await intent('canvas', 'setNodeParam', { node_id: vid, path: ['seed'], value: 4242 });
    assert.equal(np.status, 200);
    assert.equal(np.body.data.applied, true);
    assert.equal((await graph()).nodes[vid].params.seed, 4242);
    const tail = await intent('canvas', 'setNodeParam', { node_id: vid, path: ['tail_frame_hash'], value: 'tail:1' });
    assert.equal(tail.status, 200);
    const clear = await intent('canvas', 'setNodeParam', { node_id: vid, path: ['tail_frame_hash'], value: null });
    assert.equal(clear.status, 200);
    assert.ok(!('tail_frame_hash' in (await graph()).nodes[vid].params));
    for (const args of [{ node_id: vid, path: ['nope'], value: 1 }, { node_id: vid, path: ['seed'], value: 'x' }, { node_id: vid, path: ['seed'] }, { node_id: kernel.composeId(g), path: ['segments'], value: [] }]) {
      const bad = await intent('canvas', 'setNodeParam', args);
      assert.equal(bad.status, 400, JSON.stringify(args));
      assert.equal(bad.body.error.code, 'INTENT');
    }

    const before = kernel.shotOrder(g);
    const sh = await intent('shot', 'reorderShots', { group_id: g.group_order[g.group_order.length - 1], ids: kernel.orderOf(g, 'shot').slice().reverse().filter((id) => kernel.groupOf(g, id) === g.group_order[g.group_order.length - 1]) });
    assert.equal(sh.status, 200);
    assert.notDeepEqual(kernel.shotOrder(await graph()), before);
    const g2 = await graph();
    assert.deepEqual(sbRows(db, ep).slice().sort((a, b) => a.storyboard_number - b.storyboard_number).map((r) => r.id),
      kernel.shotOrder(g2).map((id) => g2.nodes[id].legacy_id));

    const add = await intent('shot', 'addShot', { group: g.group_order[0], params: { title: '新增', duration_ms: 1000 }, legacy_id: 12345 });
    assert.equal(add.status, 200);
    assert.ok(add.body.data.meta.shot_id);
    assert.equal(sbRows(db, ep).length, 6);
    assert.ok(!sbRows(db, ep).some((r) => r.id === 12345), 'client cannot choose legacy ids');
    assert.equal((await intent('canvas', 'addNodeAt', { type: 'script_line', params: { text: '新的一行' }, group: g.group_order[0] })).status, 200);
  });

  it('undo / redo through REST restore graph and legacy rows exactly', async () => {
    const g0 = await graph();
    const s0 = kernel.shotOrder(g0)[0];
    const title0 = rowOfShot(g0, s0).title;
    const r = await intent('shot', 'setShotField', { shot_id: s0, patch: { title: 'undo me' } });
    assert.equal(rowOfShot(g0, s0).title, 'undo me');
    const g1 = await graph();
    const u = await call('POST', `/episodes/${ep}/undo`, {});
    assert.equal(u.status, 200);
    assert.equal(rowOfShot(g0, s0).title, title0);
    assert.equal(u.body.data.can_redo, true);
    const rd = await call('POST', `/episodes/${ep}/redo`, { tx_id: 'redo-fixed' });
    assert.equal(rd.status, 200);
    assert.equal(rowOfShot(g0, s0).title, 'undo me');
    assert.equal(kernel.canonicalJSON(await graph()), kernel.canonicalJSON(g1));
    assert.equal((await call('POST', `/episodes/${ep}/redo`, { tx_id: 'redo-fixed' })).body.data.applied, false);
    assert.equal(r.status, 200);
  });

  it('raw tx: success, validation error 400 with kernel code, nothing persisted', async () => {
    const g = await graph();
    const s0 = kernel.shotOrder(g)[0];
    const ok = await call('POST', `/episodes/${ep}/tx`, { tx_id: 'raw-1', label: 'raw', ops: [{ op: 'setParam', node: s0, path: ['location'], value: '外景' }] });
    assert.equal(ok.status, 200);
    assert.equal(rowOfShot(g, s0).location, '外景');
    const rows = sbRows(db, ep);
    const seqBefore = (await call('GET', `/episodes/${ep}/graph`)).body.data.seq;

    const val = await call('POST', `/episodes/${ep}/tx`, { tx_id: 'raw-2', ops: [{ op: 'setParam', node: s0, path: ['duration_ms'], value: -5 }] });
    assert.equal(val.status, 400);
    assert.equal(val.body.error.code, 'VALIDATION');
    assert.ok(val.body.error.message && val.body.error.action);
    const op = await call('POST', `/episodes/${ep}/tx`, { tx_id: 'raw-3', ops: [{ op: 'explode' }] });
    assert.equal(op.status, 400);
    assert.equal(op.body.error.code, 'INVALID_OP');
    const nf = await call('POST', `/episodes/${ep}/tx`, { tx_id: 'raw-4', ops: [{ op: 'removeNode', id: 'ghost' }] });
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, 'NOT_FOUND');
    assert.equal((await call('POST', `/episodes/${ep}/tx`, { ops: [] })).body.error.code, 'INVALID_OP');
    assert.equal((await call('POST', `/episodes/${ep}/tx`, { tx_id: 'x', ops: 'no' })).body.error.code, 'INVALID_OP');
    assert.deepEqual(sbRows(db, ep), rows);
    assert.equal((await call('GET', `/episodes/${ep}/graph`)).body.data.seq, seqBefore);
  });

  it('intent errors: unknown view/intent (not whitelisted), missing args, kernel INTENT, graph validation', async () => {
    const g = await graph();
    const s0 = kernel.shotOrder(g)[0];
    for (const [view, name] of [['nope', 'x'], ['shot', 'nope'], ['shot', 'setVoice'], ['shot', 'recordGeneration'], ['shot', 'setShotReferences'], ['canvas', 'moveNodes'], ['shot', '__proto__'], ['shot', 'constructor']]) {
      const r = await intent(view, name, {});
      assert.equal(r.status, 400, `${view}.${name}`);
      assert.equal(r.body.error.code, 'INTENT');
    }
    const missing = await intent('shot', 'setShotField', { shot_id: s0 });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'INTENT');
    const ghost = await intent('shot', 'deleteShot', { shot_id: 'shot_999' });
    assert.equal(ghost.status, 400);
    assert.equal(ghost.body.error.code, 'INTENT');
    const noCompose = await intent('canvas', 'deleteNode', { node_id: kernel.composeId(g) });
    assert.equal(noCompose.status, 400);
    const badDur = await intent('shot', 'setShotField', { shot_id: s0, patch: { duration_ms: 0 } });
    assert.equal(badDur.status, 400);
    const badSeg = await intent('timeline', 'trimSegment', { segment_id: kernel.timelineView(g).tracks[0].clips[0].id, in_ms: 0, out_ms: 999999 });
    assert.equal(badSeg.status, 400);
    assert.equal(badSeg.body.error.code, 'VALIDATION');
    assert.equal((await call('POST', `/episodes/${ep}/intent`, { view: 'shot', name: 'deleteShot', args: { shot_id: s0 }, tx_id: '' })).status, 400);
  });

  it('undo with nothing left to undo -> 409', async () => {
    let last;
    for (let i = 0; i < 100; i++) {
      last = await call('POST', `/episodes/${ep}/undo`, {});
      if (last.status !== 200) break;
    }
    assert.equal(last.status, 409);
    assert.equal(last.body.error.code, 'NOTHING_TO_UNDO');
  });

  it('every intent in the whitelist is part of the spec list and every spec intent is whitelisted', () => {
    const spec = {
      script: ['rewriteLine', 'insertLine', 'deleteLine', 'splitLine', 'mergeLines', 'reorderLines'],
      shot: ['setShotField', 'splitShot', 'mergeShots', 'reorderShots', 'moveShotToGroup', 'addShot', 'deleteShot', 'regenerateShot', 'editShotRegion'],
      timeline: ['trimSegment', 'moveSegment', 'splitSegment', 'deleteSegment', 'setTransition', 'addMusic'],
      canvas: ['moveNode', 'setNodeParam', 'connectNodes', 'disconnectNodes', 'addNodeAt', 'deleteNode'],
    };
    for (const v of Object.keys(spec)) assert.deepEqual(Object.keys(kernelRoutes.INTENTS[v]).sort(), [...spec[v]].sort(), v);
    assert.deepEqual(Object.keys(kernelRoutes.INTENTS).sort(), Object.keys(spec).sort());
  });

  it('new error codes are in the table', () => {
    for (const c of ['INVALID_OP', 'VALIDATION', 'INTENT', 'GRAPH_NOT_FOUND', 'NOTHING_TO_UNDO', 'NOTHING_TO_REDO']) assert.ok(ENTRIES[c] && ENTRIES[c].scope === 'local', c);
  });
});
