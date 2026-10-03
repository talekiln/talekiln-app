'use strict';
// 重新生成分镜 = 一次可撤销的内核事务（docs/kernel-design.md §12.5）：
//   生成新分镜 -> 同一事务里删除全部旧镜头、加入新镜头（并物化回旧表）；撤销 / 重做各一步；
//   日志里没有“重置”：旧条目保留，seq 单调增加。
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const kernel = require('@talekiln/kernel');
const { checkGraph } = require('../../kernel/test/conformance/invariants');
const aiClient = require('../src/services/aiClient');
const taskService = require('../src/services/taskService');
const dramaRoutes = require('../src/routes/drama');
const kernelRoutes = require('../src/routes/kernel');
const hooks = require('../src/backup/hooks');
const compat = require('../src/kernel/compat');
const store = require('../src/kernel/store');
const { seededDb, log } = require('./helpers/kernelDb');

let server;
let base;
let db;
let ep;
let router = (req, res, next) => next();

async function call(method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const live = () => db.prepare('SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id').all(ep);
const allRows = () => db.prepare('SELECT * FROM storyboards WHERE episode_id = ? ORDER BY id').all(ep);
const graph = () => store.openProject(db, ep).graph;
const ops = () => db.prepare('SELECT seq, tx_id, tx FROM graph_ops WHERE episode_id = ? ORDER BY seq').all(ep);
const COLS = ['id', 'storyboard_number', 'segment_index', 'segment_title', 'title', 'description', 'location', 'time', 'duration', 'dialogue', 'narration', 'action',
  'image_prompt', 'video_prompt', 'characters', 'shot_type', 'angle', 'movement', 'local_path'];
const norm = (c, v) => (c === 'characters' ? kernel.canonicalJSON(JSON.parse(v || '[]')) : v == null ? '' : v);
const rowsSnap = () => live().map((r) => Object.fromEntries(COLS.map((c) => [c, norm(c, r[c])])));
const state = () => JSON.stringify({
  g: kernel.canonicalJSON(graph()),
  views: ['scriptView', 'shotView', 'timelineView', 'canvasView'].map((n) => kernel.canonicalJSON(kernel[n](graph()))),
  rows: rowsSnap(),
});
function firstDiff(a, b, path = '') {
  if (a === b) return null;
  if (typeof a === 'string' && typeof b === 'string') {
    try { return firstDiff(JSON.parse(a), JSON.parse(b), path); } catch (_) { return `${path}: ${a.slice(0, 120)} != ${b.slice(0, 120)}`; }
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${path}/${k}`); if (d) return d; }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}
const same = (a, b, msg) => assert.ok(a === b, `${msg}: ${firstDiff(a, b)}`);
const adoptedImages = (g) => kernel.shotOrder(g).map((s) => {
  const img = kernel.partsOfShot(g, s).image;
  const v = img && kernel.adoptedVersion(g, img);
  return [g.nodes[s].legacy_id, v ? v.asset.ref : null];
});

const AI_SHOTS = [
  { shot_number: 1, title: '雨夜站台', shot_type: '中景', angle: '平视', movement: '推', location: '站台', time: '夜', action: '阿宁撑伞走向站台', dialogue: '阿宁：末班车还有吗', narration: '雨一直在下', result: '她停下脚步', atmosphere: '冷', emotion: '焦急', duration: 4, segment_index: 0, segment_title: '开场' },
  { shot_number: 2, title: '车灯', shot_type: '特写', angle: '低角度', movement: '固定', location: '站台', time: '夜', action: '远处亮起车灯', dialogue: '', narration: '车来了', result: '', atmosphere: '', emotion: '', duration: 3, segment_index: 0, segment_title: '开场' },
  { shot_number: 3, title: '上车', shot_type: '全景', angle: '平视', movement: '摇', location: '车内', time: '夜', action: '老周点头示意', dialogue: '老周：上来吧', narration: '', result: '车门关闭', atmosphere: '暖', emotion: '平静', duration: 5, segment_index: 1, segment_title: '结尾' },
];
const aiText = (items = AI_SHOTS) => JSON.stringify(items);

const realGenerateText = aiClient.generateText;
let hookCalls;

async function waitTask(id, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const t = taskService.getTask(db, id);
    if (t && (t.status === 'completed' || t.status === 'failed')) return t;
    if (Date.now() - t0 > ms) throw new Error(`task ${id} did not finish: ${t && t.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const resultOf = (t) => (typeof t.result === 'string' ? JSON.parse(t.result) : t.result);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', (req, res, next) => router(req, res, next));
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); aiClient.generateText = realGenerateText; hooks.setBeforeDestructive(null); });

beforeEach(async () => {
  ({ db, episodeId: ep } = await seededDb());
  const r = express.Router();
  const k = kernelRoutes(db, log);
  r.post('/episodes/:id/undo', k.postUndo);
  r.post('/episodes/:id/redo', k.postRedo);
  r.post('/episodes/:episode_id/storyboards', dramaRoutes(db, {}, log).generateStoryboard);
  router = r;
  compat.ensureGraph(db, ep);
  // 先产生一条普通日志，用来证明重新生成不会清掉历史
  compat.updateStoryboard(db, log, live()[0].id, { title: '改过的标题' });
  hookCalls = [];
  hooks.setBeforeDestructive((episodeId, reason) => { hookCalls.push({ episodeId, reason, liveBefore: live().length, opsBefore: ops().length }); });
  aiClient.generateText = async (_db, _log, _t, _u, _s, opts = {}) => {
    if (opts.streamCallback) opts.streamCallback(aiText().slice(0, 5));
    return aiText();
  };
});
afterEach(() => { aiClient.generateText = realGenerateText; hooks.setBeforeDestructive(null); });

describe('compat.replaceEpisodeShots', () => {
  it('replaces every shot in one undoable transaction and keeps the log', () => {
    const oldIds = live().map((r) => r.id);
    const before = state();
    const logBefore = ops();
    const r = compat.replaceEpisodeShots(db, ep, [
      { segment_index: 0, segment_title: 'A', body: { title: 'n1', description: 'd1', duration: 4, action: '跑', dialogue: '阿宁：嗨', narration: '旁白' } },
      { segment_index: 1, segment_title: 'B', body: { title: 'n2', description: 'd2', duration: 3 } },
    ], { txId: 'regen-unit-1' });
    assert.equal(r.tx_id, 'regen-unit-1');
    assert.equal(r.applied, true);
    assert.equal(r.can_undo, true);
    assert.equal(r.legacy_ids.length, 2);
    assert.deepEqual(live().map((x) => x.title), ['n1', 'n2']);
    assert.deepEqual(live().map((x) => x.storyboard_number), [1, 2]);
    assert.deepEqual(live().map((x) => x.segment_title), ['A', 'B']);
    assert.equal(live()[0].dialogue, '阿宁：嗨');
    assert.ok(oldIds.every((id) => db.prepare('SELECT deleted_at FROM storyboards WHERE id = ?').get(id).deleted_at));
    checkGraph(graph());
    const after = ops();
    assert.equal(after.length, logBefore.length + 1, 'exactly one log entry');
    assert.deepEqual(after.slice(0, logBefore.length), logBefore, 'earlier log entries untouched');
    assert.equal(JSON.parse(after[after.length - 1].tx).kind, 'apply');
    for (let i = 1; i < after.length; i++) assert.ok(after[i].seq > after[i - 1].seq);

    store.undo(db, ep);
    same(state(), before, 'undo'); // 图逐字节回到原样（导入的旧版本在预言机下本来就不满足 I5，所以撤销后不再跑 checkGraph）
    store.redo(db, ep);
    assert.deepEqual(live().map((x) => x.title), ['n1', 'n2']);
    checkGraph(graph());
  });

  it('is idempotent for the same txId', () => {
    const items = [{ segment_index: 0, segment_title: '', body: { title: 'x', description: 'y' } }];
    compat.replaceEpisodeShots(db, ep, items, { txId: 'regen-unit-2' });
    const n = ops().length;
    const again = compat.replaceEpisodeShots(db, ep, items, { txId: 'regen-unit-2' });
    assert.equal(again.applied, false);
    assert.equal(ops().length, n);
  });

  it('rejects an empty replacement without touching anything', () => {
    const before = state();
    const n = ops().length;
    assert.throws(() => compat.replaceEpisodeShots(db, ep, [], {}), /at least one/i);
    same(state(), before, 'state');
    assert.equal(ops().length, n);
  });
});

describe('POST /episodes/:id/storyboards', () => {
  it('replaces the shots with the new storyboard in one undoable step', async () => {
    const oldRows = rowsSnap();
    const oldAdopted = adoptedImages(graph());
    assert.ok(oldAdopted.some(([, ref]) => ref), 'seed has adopted first-frame versions');
    const before = state();
    const logBefore = ops();

    const r = await call('POST', `/episodes/${ep}/storyboards`, { storyboard_count: 3 });
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.ok(d.task_id);
    assert.equal(d.can_undo, true);
    assert.ok(d.tx_id);
    const task = await waitTask(d.task_id);
    assert.equal(task.status, 'completed', task.error);
    const res = resultOf(task);
    assert.equal(res.can_undo, true);
    assert.equal(res.tx_id, d.tx_id);
    assert.equal(res.total, 3);

    // 1. 镜头数与内容是新分镜
    const rows = live();
    assert.deepEqual(rows.map((x) => x.title), ['雨夜站台', '车灯', '上车']);
    assert.deepEqual(rows.map((x) => x.storyboard_number), [1, 2, 3]);
    assert.deepEqual(rows.map((x) => x.segment_title), ['开场', '开场', '结尾']);
    assert.equal(rows[0].dialogue, '阿宁：末班车还有吗');
    assert.equal(rows[0].narration, '雨一直在下');
    assert.ok(rows[0].video_prompt && rows[0].image_prompt);
    assert.equal(kernel.shotView(graph()).groups.flatMap((x) => x.shots).length, 3);
    assert.deepEqual(res.storyboards.map((x) => x.id), rows.map((x) => x.id));
    // 角色补全在同一事务里完成：文本里出现的角色名写进了镜头
    const ach = JSON.parse(rows[0].characters).map((c) => c.name);
    assert.ok(ach.includes('阿宁'), `characters of shot 1: ${rows[0].characters}`);

    // 5. 日志：没有重置，旧条目原样保留，只多一条 apply
    const logAfter = ops();
    assert.equal(logAfter.length, logBefore.length + 1);
    assert.deepEqual(logAfter.slice(0, logBefore.length), logBefore);
    assert.equal(logAfter[logAfter.length - 1].tx_id, d.tx_id);
    assert.equal(JSON.parse(logAfter[logAfter.length - 1].tx).kind, 'apply');
    for (let i = 1; i < logAfter.length; i++) assert.ok(logAfter[i].seq > logAfter[i - 1].seq);
    // 6. 不变量
    checkGraph(graph());
    // 备份钩子在替换之前被调用，且只调用一次
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0].reason, 'regenerate-storyboard');
    assert.equal(Number(hookCalls[0].episodeId), ep);
    assert.equal(hookCalls[0].liveBefore, 5, 'old shots were still there when the hook ran');
    assert.equal(hookCalls[0].opsBefore, logBefore.length);
    const newState = state();

    // 3. 撤销：镜头 id、首帧采用版本、旧表行都恢复
    const u = await call('POST', `/episodes/${ep}/undo`, {});
    assert.equal(u.status, 200);
    assert.equal(u.body.data.can_redo, true);
    same(state(), before, 'after undo');
    assert.deepEqual(rowsSnap(), oldRows);
    assert.deepEqual(adoptedImages(graph()), oldAdopted);
    assert.equal(live().length, 5);
    for (const row of res.storyboards) assert.ok(db.prepare('SELECT deleted_at FROM storyboards WHERE id = ?').get(row.id).deleted_at, 'new rows are soft-deleted after undo');

    // 4. 重做：回到新分镜（同样的行 id）
    const rd = await call('POST', `/episodes/${ep}/redo`, {});
    assert.equal(rd.status, 200);
    same(state(), newState, 'after redo');
    assert.deepEqual(live().map((x) => x.id), res.storyboards.map((x) => x.id));
    checkGraph(graph());
    assert.equal(ops().length, logBefore.length + 3);
  });

  it('keeps everything when generation fails', async () => {
    aiClient.generateText = async () => { throw new Error('upstream down'); };
    const before = state();
    const raw = JSON.stringify(allRows());
    const n = ops().length;
    const r = await call('POST', `/episodes/${ep}/storyboards`, {});
    assert.equal(r.status, 200);
    const task = await waitTask(r.body.data.task_id);
    assert.equal(task.status, 'failed');
    same(state(), before, 'state');
    assert.equal(JSON.stringify(allRows()), raw);
    assert.equal(ops().length, n);
    assert.equal(hookCalls.length, 0, 'no snapshot is taken for a run that destroys nothing');
  });

  it('does not touch the old shots while the model is still streaming', async () => {
    const seen = [];
    aiClient.generateText = async (_db, _log, _t, _u, _s, opts) => {
      const text = aiText();
      opts.streamCallback(text.slice(0, 120));
      seen.push(live().length);
      opts.streamCallback(text);
      seen.push(live().length, ops().length);
      return text;
    };
    const n = ops().length;
    const r = await call('POST', `/episodes/${ep}/storyboards`, {});
    await waitTask(r.body.data.task_id);
    assert.deepEqual(seen, [5, 5, n]);
    assert.equal(live().length, 3);
  });

  it('recovers the streamed part when the connection drops, still as one undoable step', async () => {
    const pad = 'x'.repeat(260);
    const two = aiText(AI_SHOTS.slice(0, 2).map((s) => ({ ...s, action: `${s.action}${pad}` })));
    aiClient.generateText = async (_db, _log, _t, _u, _s, opts) => {
      opts.streamCallback(`${two.slice(0, -1)},{"shot_number":3,"title":"半`);
      throw new Error('read ECONNRESET');
    };
    const before = state();
    const r = await call('POST', `/episodes/${ep}/storyboards`, {});
    const task = await waitTask(r.body.data.task_id);
    assert.equal(task.status, 'completed', task.error);
    const res = resultOf(task);
    assert.equal(res.truncated, true);
    assert.equal(res.total, 2);
    assert.equal(res.can_undo, true);
    assert.deepEqual(live().map((x) => x.title), ['雨夜站台', '车灯']);
    checkGraph(graph());
    await call('POST', `/episodes/${ep}/undo`, {});
    same(state(), before, 'after undo');
  });
});
