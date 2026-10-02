'use strict';
// 旧写接口经内核（docs/kernel-design.md §11）：每个改道的接口——
//   1. 改动同时出现在四个视图（script / shots / timeline / canvas）和旧表行里；
//   2. 经 POST /episodes/:id/undo 撤销后回到原状；
//   3. 校验失败（400/409）时图、日志、旧表一字不动。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const music = require('../src/music');
const kernel = require('@talekiln/kernel');
const storyboardRoutes = require('../src/routes/storyboards');
const scriptgenRoutes = require('../src/routes/scriptgen');
const timelineRoutes = require('../src/routes/timelines');
const musicRoutes = require('../src/routes/music');
const kernelRoutes = require('../src/routes/kernel');
const timelineService = require('../src/timeline');
const compat = require('../src/kernel/compat');
const store = require('../src/kernel/store');
const { seededDb, log } = require('./helpers/kernelDb');

let server;
let base;
let db;
let ep;
let library;

async function call(method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const live = () => db.prepare('SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id').all(ep);
const graph = () => store.openProject(db, ep).graph;
const seq = () => store.openProject(db, ep).seq;
const view = (name) => kernel[name](graph());
const shotsFlat = () => view('shotView').groups.flatMap((x) => x.shots);
const timelineRows = () => {
  const t = timelineService.loadTimelineByEpisode(db, ep);
  return t.tracks.map((tr) => [tr.kind, tr.volume, tr.muted, tr.clips.map((c) => [c.id, c.start_ms, c.duration_ms, c.src_in_ms, c.src_out_ms, c.asset_ref, c.storyboard_id, c.text, c.style])]);
};
const COLS = ['id', 'storyboard_number', 'segment_index', 'segment_title', 'title', 'description', 'location', 'time', 'duration', 'dialogue', 'narration', 'action', 'atmosphere',
  'image_prompt', 'video_prompt', 'characters', 'shot_type', 'angle', 'movement'];
// 物化把空文本列写成 ''（NULL 与 '' 在旧页面里等价），快照里统一成 ''
const normCol = (c, v) => (c === 'characters' ? kernel.canonicalJSON(JSON.parse(v || '[]')) : v == null ? '' : v);
const rowsSnap = () => live().map((r) => Object.fromEntries(COLS.map((c) => [c, normCol(c, r[c])])));

/** 四个视图 + 旧表行 + 旧时间线行的完整快照（撤销应让它逐字节回到原样）。 */
const state = () => JSON.stringify({
  g: kernel.canonicalJSON(graph()),
  views: ['scriptView', 'shotView', 'timelineView', 'canvasView'].map((n) => kernel.canonicalJSON(view(n))),
  rows: rowsSnap(),
  timeline: timelineRows(),
});
/** 两个快照第一处不同的位置（排错用）。 */
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
const logCount = () => db.prepare('SELECT COUNT(*) n FROM graph_ops WHERE episode_id = ?').get(ep).n;
/** 整表快照（含 updated_at），用来证明被拒绝的请求什么都没写。 */
const rawState = () => JSON.stringify({
  sb: db.prepare('SELECT * FROM storyboards WHERE episode_id = ? ORDER BY id').all(ep),
  tl: db.prepare('SELECT * FROM timelines WHERE episode_id = ?').all(ep),
  clips: db.prepare('SELECT c.* FROM timeline_clips c JOIN timelines t ON t.id = c.timeline_id WHERE t.episode_id = ? ORDER BY c.id').all(ep),
  tracks: db.prepare('SELECT tr.* FROM timeline_tracks tr JOIN timelines t ON t.id = tr.timeline_id WHERE t.episode_id = ? ORDER BY tr.id').all(ep),
  ops: logCount(),
});

/** I1/I2/I8 的轻量版：四个视图与旧表一致。 */
function assertConsistent() {
  const g = graph();
  const order = kernel.shotOrder(g);
  const ids = order.map((s) => g.nodes[s].legacy_id);
  assert.deepEqual(shotsFlat().map((s) => s.id), order, 'shotView order');
  assert.deepEqual(view('timelineView').tracks[0].clips.map((c) => c.storyboard_id).filter((v, i, a) => a.indexOf(v) === i), ids, 'timelineView order');
  assert.deepEqual(view('canvasView').nodes.filter((n) => n.type === 'shot').map((n) => n.id).sort(), [...order].sort(), 'canvasView nodes');
  assert.deepEqual(live().map((r) => r.id), ids, 'legacy rows order');
  assert.deepEqual(live().map((r) => r.storyboard_number), ids.map((_, i) => i + 1));
  const lines = view('scriptView').groups.flatMap((x) => x.lines).map((l) => l.id).sort();
  assert.deepEqual(lines, kernel.nodesOfType(g, 'script_line'), 'scriptView lines');
  const tl = view('timelineView');
  const rows = timelineService.loadTimelineByEpisode(db, ep);
  assert.equal(rows.duration_ms, tl.duration_ms);
  const strip = (id) => id.replace(`e${ep}_`, '');
  assert.deepEqual(rows.tracks.find((t) => t.kind === 'video').clips.map((c) => [strip(c.id), c.start_ms, c.duration_ms]), tl.tracks[0].clips.map((c) => [c.id, c.start_ms, c.duration_ms]));
}

/** 执行一次编辑：返回 { before, after }，并断言一致性。 */
async function edit(fn) {
  const before = state();
  const r = await fn();
  assert.ok(r.status >= 200 && r.status < 300, `edit failed: ${r.status} ${JSON.stringify(r.body)}`);
  assertConsistent();
  const after = state();
  assert.notEqual(after, before, 'the edit changed something');
  return { before, after, r };
}
async function undoTo(before, after) {
  const u = await call('POST', `/episodes/${ep}/undo`, {});
  assert.equal(u.status, 200, JSON.stringify(u.body));
  same(state(), before, 'undo restores graph, views and legacy rows');
  assertConsistent();
  const re = await call('POST', `/episodes/${ep}/redo`, {});
  assert.equal(re.status, 200);
  same(state(), after, 'redo restores the edit');
  assert.equal((await call('POST', `/episodes/${ep}/undo`, {})).status, 200);
  same(state(), before, 'second undo');
}
/** 被拒绝的请求：状态码/错误码对，且什么都没写。 */
async function rejected(fn, status, code) {
  const raw = rawState();
  const st = state();
  const s0 = seq();
  const r = await fn();
  assert.equal(r.status, status, JSON.stringify(r.body));
  if (code) assert.equal(r.body.error.code, code);
  assert.ok(r.body.error.action, 'error table entry');
  assert.equal(rawState(), raw, 'legacy tables untouched');
  assert.equal(state(), st);
  assert.equal(seq(), s0, 'log untouched');
}

before(async () => {
  ({ db, episodeId: ep } = await seededDb());
  library = music.createMusicLibrary(db, { storageRoot: require('node:os').tmpdir(), probe: async () => 12000 });
  const sb = storyboardRoutes(db, log);
  const sg = scriptgenRoutes(db, log);
  const tl = timelineRoutes(db, log);
  const mu = musicRoutes(db, library, log);
  const k = kernelRoutes(db, log);
  const app = express();
  app.use(express.json());
  const r = express.Router();
  r.post('/storyboards', sb.create);
  r.post('/storyboards/batch-infer-params', sb.batchInferParams);
  r.post('/storyboards/:id/insert-before', sb.insertBefore);
  r.get('/storyboards/:id', sb.getOne);
  r.put('/storyboards/:id', sb.update);
  r.delete('/storyboards/:id', sb.delete);
  r.put('/episodes/:episode_id/storyboards/order', sg.reorder);
  r.get('/timelines/episode/:episode_id', tl.getByEpisode);
  r.post('/timelines/episode/:episode_id/assemble', tl.assemble);
  r.put('/timelines/:id', tl.save);
  r.post('/timelines/:id/clips', tl.addClip);
  r.patch('/timelines/:id/clips/:clip_id', tl.patchClip);
  r.post('/timelines/:id/music', mu.attach);
  r.post('/episodes/:id/undo', k.postUndo);
  r.post('/episodes/:id/redo', k.postRedo);
  app.use('/api/v1', r);
  await new Promise((ok) => { server = app.listen(0, '127.0.0.1', ok); });
  // Client and server share this event loop, and the helpers below do long synchronous snapshot work between
  // requests. Under a parallel full-package run the server's 5 s keep-alive timer can fire in the same turn
  // in which undici reuses that idle socket, so the request lands on a socket the server is destroying
  // (ECONNRESET). Keep-alive brings nothing here; disable it so every request gets a fresh socket.
  server.keepAliveTimeout = 0;
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe('storyboard routes through the kernel', () => {
  it('first write imports the graph automatically', async () => {
    assert.equal(store.hasProject(db, ep), false);
    const sbs = live();
    const r = await call('PUT', `/storyboards/${sbs[0].id}`, { title: '开场' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.title, '开场');
    assert.equal(store.hasProject(db, ep), true);
    assertConsistent();
  });

  it('POST /storyboards: new shot with dialogue lands at the given position in every view; undo reverts', async () => {
    const n0 = live().length;
    const { before, after, r } = await edit(() => call('POST', '/storyboards', {
      episode_id: ep, storyboard_number: 2, title: '新镜头', description: '雨夜', duration: 3, dialogue: '老周：下雨了。', action: '老周抬头', scene_id: 77, result: '结果文本',
    }));
    assert.equal(r.status, 201);
    assert.equal(r.body.data.storyboard_number, 2);
    assert.equal(r.body.data.title, '新镜头');
    assert.equal(r.body.data.duration, 3);
    assert.equal(r.body.data.scene_id, 77, 'non-graph column still written');
    assert.equal(r.body.data.result, '结果文本');
    assert.equal(live().length, n0 + 1);
    const sh = shotsFlat();
    assert.equal(sh[1].params.title, '新镜头');
    assert.equal(sh[1].dialogue, '老周：下雨了。');
    assert.equal(sh[1].legacy_id, r.body.data.id);
    const g = graph();
    assert.ok(view('scriptView').groups.flatMap((x) => x.lines).some((l) => l.text === '老周：下雨了。' && l.shot_ids.includes(sh[1].id)));
    assert.ok(view('canvasView').nodes.some((nd) => nd.id === sh[1].id));
    assert.equal(view('timelineView').tracks[0].clips.filter((c) => c.storyboard_id === r.body.data.id)[0].duration_ms, 3000);
    assert.equal(live()[1].action, '老周抬头');
    assert.ok(g.nodes[sh[1].id]);
    await undoTo(before, after);
  });

  it('POST /storyboards: unknown episode -> 404, bad duration -> 400, nothing written', async () => {
    await rejected(() => call('POST', '/storyboards', { episode_id: 999999, title: 'x' }), 404, 'NOT_FOUND');
    await rejected(() => call('POST', '/storyboards', { episode_id: ep, title: 'x', duration: -3 }), 400, 'INTENT');
  });

  it('insert-before: blank shot before the target, everything after shifts; undo reverts', async () => {
    const target = live()[2];
    const { before, after, r } = await edit(() => call('POST', `/storyboards/${target.id}/insert-before`, {}));
    assert.equal(r.status, 201);
    assert.equal(r.body.data.storyboard_number, 3);
    assert.equal(live()[3].id, target.id);
    assert.equal(live()[3].storyboard_number, 4);
    assert.equal(r.body.data.status, 'pending');
    await undoTo(before, after);
    assert.equal((await call('POST', '/storyboards/999999/insert-before', {})).status, 404);
  });

  it('PUT /storyboards/:id: graph fields, dialogue lines, duration and non-graph columns together; undo reverts the graph part', async () => {
    const t = live()[1];
    const { before, after, r } = await edit(() => call('PUT', `/storyboards/${t.id}`, {
      title: '改过的标题', description: '改过的描述', video_prompt: 'vp-new', movement: '推镜', duration: 2.5,
      dialogue: '甲：你好。\n乙：再见。', characters: ['甲', '乙'], universal_segment_text: 'direct-col',
    }));
    assert.equal(r.body.data.title, '改过的标题');
    assert.equal(r.body.data.dialogue, '甲：你好。\n乙：再见。');
    assert.equal(r.body.data.duration, 2.5);
    assert.equal(r.body.data.universal_segment_text, 'direct-col');
    const sh = shotsFlat()[1];
    assert.equal(sh.params.title, '改过的标题');
    assert.equal(sh.params.duration_ms, 2500);
    assert.equal(sh.dialogue.includes('乙：再见。'), true);
    assert.equal(view('timelineView').tracks[0].clips.find((c) => c.storyboard_id === t.id).duration_ms >= 1, true);
    assert.ok(view('timelineView').tracks[1].clips.some((c) => c.text && c.text.includes('乙：再见。')));
    assert.ok(view('canvasView').nodes.find((n) => n.id === sh.id).params.title === '改过的标题');
    assert.ok(view('scriptView').groups.flatMap((x) => x.lines).some((l) => l.text === '乙：再见。'));
    await undoTo(before, after);
    assert.equal(live()[1].universal_segment_text, 'direct-col', 'direct columns are not part of the graph history');
  });

  it('PUT /storyboards/:id: no-op edit adds no undo step; unknown id -> 404; segment_title of a missing scene -> 409', async () => {
    const t = live()[0];
    const s0 = seq();
    const same = await call('PUT', `/storyboards/${t.id}`, { title: t.title, dialogue: t.dialogue });
    assert.equal(same.status, 200);
    assert.equal(seq(), s0);
    assert.equal((await call('PUT', '/storyboards/999999', { title: 'x' })).status, 404);
    await rejected(() => call('PUT', `/storyboards/${t.id}`, { title: 'zzz', segment_title: '不存在的段落' }), 409, 'GRAPH_UNSUPPORTED_EDIT');
    await rejected(() => call('PUT', `/storyboards/${t.id}`, { title: 'zzz', duration: 'abc' }), 400, 'INTENT');
  });

  it('PUT /storyboards/:id: direct columns only never touch the graph', async () => {
    const t = live()[0];
    const s0 = seq();
    const r = await call('PUT', `/storyboards/${t.id}`, { result: 'r', status: 'completed' });
    assert.equal(r.status, 200);
    assert.equal(seq(), s0);
    assert.equal(db.prepare('SELECT result FROM storyboards WHERE id = ?').get(t.id).result, 'r');
  });

  it('DELETE /storyboards/:id: gone from every view (lines stay in the script); undo brings the row back', async () => {
    const t = live()[3];
    const { before, after } = await edit(() => call('DELETE', `/storyboards/${t.id}`));
    assert.equal(db.prepare('SELECT deleted_at FROM storyboards WHERE id = ?').get(t.id).deleted_at != null, true);
    assert.ok(!shotsFlat().some((s) => s.legacy_id === t.id));
    assert.ok(!view('timelineView').tracks[0].clips.some((c) => c.storyboard_id === t.id));
    assert.ok(!view('canvasView').nodes.some((n) => n.legacy_id === t.id));
    await undoTo(before, after);
    assert.equal((await call('DELETE', '/storyboards/999999')).status, 404);
    assert.equal((await call('GET', `/storyboards/${t.id}`)).status, 200);
  });

  it('PUT /episodes/:id/storyboards/order: reorders every view; cross-scene moves join the new neighbour scene; bad ids -> 400', async () => {
    const ids = live().map((r) => r.id);
    const want = [ids[3], ids[0], ids[1], ids[2], ...ids.slice(4)];
    const { before, after } = await edit(() => call('PUT', `/episodes/${ep}/storyboards/order`, { ids: want }));
    assert.deepEqual(live().map((r) => r.id), want);
    await undoTo(before, after);
    const rev = ids.slice().reverse();
    const e2 = await edit(() => call('PUT', `/episodes/${ep}/storyboards/order`, { ids: rev }));
    assert.deepEqual(live().map((r) => r.id), rev);
    await undoTo(e2.before, e2.after);
    await rejected(() => call('PUT', `/episodes/${ep}/storyboards/order`, { ids: ids.slice(1) }), 400);
    await rejected(() => call('PUT', `/episodes/${ep}/storyboards/order`, { ids: [...ids.slice(1), 424242] }), 400);
  });

  it('batch-infer-params: movement goes through the graph, lighting/depth stay direct; undo reverts movement', async () => {
    // 运镜只能从已有的中文运镜归一成枚举：先给两个镜头写上中文运镜
    for (const r of live().slice(0, 2)) assert.equal((await call('PUT', `/storyboards/${r.id}`, { movement: '推镜', description: '黄昏的街头' })).status, 200);
    const { before, after, r } = await edit(() => call('POST', '/storyboards/batch-infer-params', { episode_id: ep, overwrite: true }));
    assert.equal(r.body.data.total, live().length);
    const sh = shotsFlat();
    assert.notEqual(sh[0].params.movement, '推镜', 'normalised to the enum value');
    assert.ok(sh[0].params.movement);
    for (const s of sh) assert.equal(live().find((x) => x.id === s.legacy_id).movement || '', s.params.movement || '');
    assert.ok(live().some((x) => x.lighting_style), 'lighting is a direct column');
    await undoTo(before, after);
    assert.equal(live()[0].movement, '推镜');
    assert.equal((await call('POST', '/storyboards/batch-infer-params', {})).status, 400);
  });

  it('prompt writers (polish video_prompt, characters back-fill) commit through setShotFields and survive later materialisation', async () => {
    const t = live()[0];
    const { before, after } = await edit(async () => {
      compat.setShotFields(db, [{ id: t.id, patch: { video_prompt: 'polished!' } }]);
      return { status: 200, body: {} };
    });
    assert.equal(shotsFlat()[0].params.video_prompt, 'polished!');
    assert.equal(live()[0].video_prompt, 'polished!');
    // 再做一次无关编辑触发物化：润色结果不能被盖回去
    assert.equal((await call('PUT', `/storyboards/${live()[1].id}`, { title: '另一个镜头' })).status, 200);
    assert.equal(live()[0].video_prompt, 'polished!');
    assert.equal((await call('POST', `/episodes/${ep}/undo`, {})).status, 200);
    await undoTo(before, after);
  });

  it('split-by-audio (kernel part): one shot becomes one per speaker in every view; undo reverts', async () => {
    // splitStoryboardByAudio 本身在仓库里无法运行（引用了未定义的 parseDialogueToEntries / loadCharactersForStoryboardPrompt 等，
    // 与本改动无关）；这里直接测它的图写入部分 compat.splitShotByPlans。
    const t = live()[4];
    assert.equal((await call('PUT', `/storyboards/${t.id}`, { dialogue: '甲：第一句话说得很长很长。\n乙：第二句。', narration: '旁白一句', action: '' })).status, 200);
    const n0 = live().length;
    const plans = [
      { title: '甲对白', duration: 5, dialogue: '甲：第一句话说得很长很长。', narration: null, action: '镜头聚焦甲', result: 'r1', shot_type: '近景', movement: '推镜' },
      { title: '乙对白', duration: 6, dialogue: '乙：第二句。', narration: null, action: '镜头聚焦乙', result: 'r2', shot_type: '近景', movement: '固定' },
      { title: '画外旁白', duration: 7, dialogue: null, narration: '旁白一句', action: '', result: 'r3', shot_type: '近景', movement: '固定' },
    ];
    let ids;
    const { before, after } = await edit(async () => {
      const row = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(t.id);
      ids = compat.splitShotByPlans(db, row, plans);
      return { status: 200, body: ids };
    });
    assert.equal(ids.length, 3);
    assert.equal(ids[0], t.id);
    assert.equal(live().length, n0 + 2);
    const sh = shotsFlat();
    const i = sh.findIndex((s) => s.legacy_id === t.id);
    assert.deepEqual(sh.slice(i, i + 3).map((s) => s.legacy_id), ids);
    assert.equal(sh[i].dialogue, '甲：第一句话说得很长很长。');
    assert.equal(sh[i + 1].dialogue, '乙：第二句。');
    assert.equal(sh[i + 2].dialogue, '旁白一句');
    assert.deepEqual(sh.slice(i, i + 3).map((s) => s.params.duration_ms), [5000, 6000, 7000]);
    assert.equal(sh[i].video, 'none', 'adopted video is released on the shot that was split');
    assert.equal(view('timelineView').tracks[0].clips.filter((c) => ids.includes(c.storyboard_id)).length, 3);
    assert.equal(live().find((r) => r.id === ids[1]).title, '乙对白');
    assert.equal(live().find((r) => r.id === ids[2]).narration, '旁白一句');
    await undoTo(before, after);
  });
});

describe('timeline routes through the kernel', () => {
  const tl = () => timelineService.loadTimelineByEpisode(db, ep);
  const vclips = () => tl().tracks.find((t) => t.kind === 'video').clips;
  const track = (t, kind) => t.tracks.find((x) => x.kind === kind);

  it('assemble: first call 201 builds from the graph, second 409, replace 200 resets segments and music', async () => {
    // 种子里已有 assembleFromStoryboard 生成的时间线：没有 replace -> 409
    await rejected(() => call('POST', `/timelines/episode/${ep}/assemble`, {}), 409, 'CONFLICT');
    const { before, after, r } = await edit(async () => {
      // 先制造一些改动，再整体重装
      const id = tl().id;
      const seg = vclips()[0].id;
      assert.equal((await call('PATCH', `/timelines/${id}/clips/${seg}`, { op: 'split', at_ms: 1000 })).status, 200);
      const rr = await call('POST', `/timelines/episode/${ep}/assemble`, { replace: true });
      return rr;
    });
    assert.equal(r.status, 200);
    assert.equal(vclips().length, live().length);
    assert.equal(view('timelineView').tracks[0].clips.length, live().length);
    assert.equal(r.body.data.id, tl().id);
    // 回到 assemble 之前（含那次拆分）
    assert.equal((await call('POST', `/episodes/${ep}/undo`, {})).status, 200);
    assert.equal(vclips().length, live().length + 1);
    assert.equal((await call('POST', `/episodes/${ep}/undo`, {})).status, 200);
    void before; void after;
    assertConsistent();
  });

  it('assemble on an episode without storyboards -> 400 NO_STORYBOARDS', async () => {
    const e = Number(db.prepare("INSERT INTO episodes (drama_id, script_content) VALUES (1, '')").run().lastInsertRowid);
    const r = await call('POST', `/timelines/episode/${e}/assemble`, {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'NO_STORYBOARDS');
    assert.equal(store.hasProject(db, e), false);
  });

  it('assemble picks up assets the old pipeline wrote straight into storyboards', async () => {
    const t = live()[0];
    db.prepare('UPDATE storyboards SET video_url = ? WHERE id = ?').run('videos/fresh.mp4', t.id);
    const r = await call('POST', `/timelines/episode/${ep}/assemble`, { replace: true });
    assert.equal(r.status, 200);
    assert.equal(vclips().find((c) => c.storyboard_id === t.id).asset_ref, 'videos/fresh.mp4');
    assertConsistent();
    assert.equal((await call('POST', `/episodes/${ep}/undo`, {})).status, 200);
  });

  it('PATCH trim: the segment, timeline view, rows and canvas agree; undo reverts', async () => {
    const id = tl().id;
    const c = vclips()[1];
    const { before, after } = await edit(() => call('PATCH', `/timelines/${id}/clips/${c.id}`, { op: 'trim', duration_ms: c.duration_ms - 500 }));
    assert.equal(vclips()[1].duration_ms, c.duration_ms - 500);
    const seg = graph().nodes[kernel.composeId(graph())].params.segments.find((s) => s.id === c.id.replace(`e${ep}_`, ''));
    assert.equal(seg.out_ms - seg.in_ms, c.duration_ms - 500);
    assert.equal(view('timelineView').tracks[0].clips[1].duration_ms, c.duration_ms - 500);
    await undoTo(before, after);
  });

  it('PATCH move: absolute start positions are kept through gap_before_ms; overlap -> 409 OVERLAP untouched', async () => {
    const id = tl().id;
    const cs = vclips();
    const last = cs[cs.length - 1];
    const { before, after } = await edit(() => call('PATCH', `/timelines/${id}/clips/${last.id}`, { op: 'move', start_ms: last.start_ms + 700 }));
    assert.equal(vclips()[vclips().length - 1].start_ms, last.start_ms + 700);
    assert.deepEqual(vclips().slice(0, -1).map((c) => c.start_ms), cs.slice(0, -1).map((c) => c.start_ms));
    const seg = graph().nodes[kernel.composeId(graph())].params.segments.find((s) => s.id === last.id.replace(`e${ep}_`, ''));
    assert.equal(seg.gap_before_ms, 700);
    await undoTo(before, after);
    await rejected(() => call('PATCH', `/timelines/${id}/clips/${last.id}`, { op: 'move', start_ms: 0 }), 409, 'OVERLAP');
    await rejected(() => call('PATCH', `/timelines/${id}/clips/zzz`, { op: 'move', start_ms: 5 }), 404, 'NOT_FOUND');
  });

  it('PATCH split: two segments of one shot; subtitle and narration spans follow; undo reverts', async () => {
    const id = tl().id;
    const c = vclips()[0];
    const { before, after, r } = await edit(() => call('PATCH', `/timelines/${id}/clips/${c.id}`, { op: 'split', at_ms: c.start_ms + 1000 }));
    assert.equal(r.body.data.clip_ids.length, 2);
    assert.equal(vclips().length, live().length + 1);
    assert.ok(vclips().some((x) => x.id === r.body.data.clip_ids[1]), 'returned clip id exists in the timeline');
    assert.equal(kernel.segmentsOfShot(graph(), kernel.shotOrder(graph())[0]).length, 2);
    await undoTo(before, after);
  });

  it('PATCH delete of a shot\'s last video clip deletes the shot everywhere (kernel deleteSegment); undo restores it', async () => {
    const id = tl().id;
    const c = vclips()[2];
    const n0 = live().length;
    const { before, after } = await edit(() => call('PATCH', `/timelines/${id}/clips/${c.id}`, { op: 'delete' }));
    assert.equal(live().length, n0 - 1);
    assert.ok(!shotsFlat().some((s) => s.legacy_id === c.storyboard_id));
    await undoTo(before, after);
  });

  it('POST /timelines/:id/clips on the music track and POST /timelines/:id/music', async () => {
    const id = tl().id;
    library.list(); // 内置曲目在第一次 list 时写入库
    const added = await edit(() => call('POST', `/timelines/${id}/clips`, { track: 'music', start_ms: 0, duration_ms: 2000, asset_ref: 'library/music/a.mp3', volume: 0.5 }));
    assert.equal(added.r.status, 201);
    assert.ok(track(tl(), 'music').clips.some((c) => c.id === added.r.body.data.clip_id && c.volume === 0.5));
    const cid = kernel.composeId(graph());
    assert.equal(graph().nodes[cid].params.music.length, 1);
    assert.equal(view('timelineView').tracks[3].clips.length, 1);
    await undoTo(added.before, added.after);

    const att = await edit(() => call('POST', `/timelines/${id}/music`, { music_id: 'builtin-calm', loop: true }));
    assert.equal(att.r.status, 201);
    assert.ok(att.r.body.data.clip_ids.length >= 1);
    assert.equal(track(att.r.body.data.timeline, 'music').clips.length, att.r.body.data.clip_ids.length);
    assert.equal(graph().nodes[cid].params.music.length, att.r.body.data.clip_ids.length);
    await undoTo(att.before, att.after);
    await rejected(() => call('POST', `/timelines/${id}/music`, { music_id: 'nope' }), 404);
  });

  it('PUT /timelines/:id: reorder + trim + music + track volume in one save; version bumps; undo reverts the graph part', async () => {
    const cur = tl();
    const v = track(cur, 'video').clips;
    const edited = structuredClone(cur);
    const ev = track(edited, 'video');
    // 第 1、2 个片段互换：第 2 个排到最前
    const [a, b] = [ev.clips[0], ev.clips[1]];
    const total = a.duration_ms + b.duration_ms;
    b.start_ms = 0;
    a.start_ms = b.duration_ms;
    assert.equal(a.start_ms + a.duration_ms, total);
    ev.clips.sort((x, y) => x.start_ms - y.start_ms);
    track(edited, 'music').clips.push({ id: 'm-new', start_ms: 100, duration_ms: 900, asset_ref: 'library/music/x.mp3', asset_kind: 'audio', src_in_ms: 0, src_out_ms: 900, volume: 1, text: null, style: null, storyboard_id: null });
    track(edited, 'music').volume = 0.7;
    const before = state();
    const r = await call('PUT', `/timelines/${cur.id}`, edited);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.version, cur.version + 1);
    assert.equal(track(r.body.data, 'music').volume, 0.7);
    assert.equal(track(r.body.data, 'video').clips[0].storyboard_id, v[1].storyboard_id);
    assert.deepEqual(live().slice(0, 2).map((x) => x.id), [v[1].storyboard_id, v[0].storyboard_id]);
    assertConsistent();
    assert.ok(graph().nodes[kernel.composeId(graph())].params.music.some((m) => m.id === 'm-new'));
    assert.equal((await call('POST', `/episodes/${ep}/undo`, {})).status, 200);
    assertConsistent();
    assert.deepEqual(live().slice(0, 2).map((x) => x.id), [v[0].storyboard_id, v[1].storyboard_id]);
    void before;
  });

  it('PUT /timelines/:id: subtitle text and style edits map to script lines and subtitle_overrides', async () => {
    const cur = tl();
    const sub = track(cur, 'subtitle');
    const target = sub.clips[0];
    const edited = structuredClone(cur);
    const ec = track(edited, 'subtitle').clips[0];
    ec.text = '改写后的字幕';
    ec.style = { color: '#ff0' };
    const { before, after } = await edit(() => call('PUT', `/timelines/${cur.id}`, edited));
    const shot = kernel.shotOrder(graph()).find((s) => graph().nodes[s].legacy_id === target.storyboard_id);
    assert.equal(kernel.shotDialogue(graph(), shot), '改写后的字幕');
    assert.equal(live().find((r) => r.id === target.storyboard_id).dialogue || live().find((r) => r.id === target.storyboard_id).narration, '改写后的字幕');
    const out = track(tl(), 'subtitle').clips.find((c) => c.storyboard_id === target.storyboard_id);
    assert.equal(out.text, '改写后的字幕');
    assert.deepEqual(out.style, { color: '#ff0' });
    assert.ok(view('scriptView').groups.flatMap((x) => x.lines).some((l) => l.text === '改写后的字幕'));
    await undoTo(before, after);
  });

  it('PUT /timelines/:id: cases the graph cannot express are rejected with an error-table code and change nothing', async () => {
    const cur = tl();
    const put = (mut) => () => { const e = structuredClone(cur); mut(e); return call('PUT', `/timelines/${cur.id}`, e); };
    // 视频片段没有分镜
    await rejected(put((e) => { track(e, 'video').clips[0].storyboard_id = null; }), 409, 'GRAPH_UNSUPPORTED_EDIT');
    // 手改视频片段素材 / 样式
    await rejected(put((e) => { track(e, 'video').clips[0].asset_ref = 'other.mp4'; }), 409, 'GRAPH_UNSUPPORTED_EDIT');
    await rejected(put((e) => { track(e, 'video').clips[0].style = { filter: 'sepia' }; }), 409, 'GRAPH_UNSUPPORTED_EDIT');
    // 删除字幕 / 配音（由台词行与生成结果推导）
    await rejected(put((e) => { track(e, 'subtitle').clips.shift(); }), 409, 'GRAPH_UNSUPPORTED_EDIT');
    await rejected(put((e) => { track(e, 'narration').clips.shift(); }), 409, 'GRAPH_UNSUPPORTED_EDIT');
    await rejected(put((e) => { track(e, 'narration').clips[0].asset_ref = 'x.wav'; }), 409, 'GRAPH_UNSUPPORTED_EDIT');
    // 字幕行数对不上台词行数
    await rejected(put((e) => { track(e, 'subtitle').clips[0].text = 'a\nb\nc\nd'; }), 409, 'GRAPH_UNSUPPORTED_EDIT');
    // 同一分镜的片段被别的分镜隔开
    await rejected(() => {
      const e = structuredClone(cur);
      const v = track(e, 'video').clips;
      const [a, b] = [v[0], v[1]];
      const half = Math.floor(a.duration_ms / 2);
      const a2 = { ...a, id: 'a-second', start_ms: b.start_ms + b.duration_ms, duration_ms: a.duration_ms - half, src_in_ms: a.src_in_ms + half };
      a.duration_ms = half;
      a.src_out_ms = a.src_in_ms + half;
      // 把 a2 放到 b 之后，同时为避免重叠把后面的挪开
      const shift = a2.duration_ms;
      for (const c of v.slice(2)) c.start_ms += shift;
      v.push(a2);
      v.sort((x, y) => x.start_ms - y.start_ms);
      b.start_ms = a.start_ms + a.duration_ms;
      a2.start_ms = b.start_ms + b.duration_ms;
      return call('PUT', `/timelines/${cur.id}`, e);
    }, 409, 'TIMELINE_ORDER_UNSUPPORTED');
    // 旧规则照旧：重叠 409 OVERLAP、非法值 400、版本过期 409 CONFLICT
    await rejected(put((e) => { track(e, 'video').clips[1].start_ms = 0; }), 409, 'OVERLAP');
    await rejected(put((e) => { track(e, 'video').clips[0].duration_ms = -1; }), 400, 'BAD_REQUEST');
    await rejected(() => call('PUT', `/timelines/${cur.id}`, { ...cur, version: cur.version + 50 }), 409, 'CONFLICT');
    // 片段超出镜头生成时长：内核校验失败 -> 400 VALIDATION，整体回滚
    await rejected(put((e) => { const v = track(e, 'video').clips; const c = v[v.length - 1]; c.duration_ms += 99999; c.src_out_ms += 99999; }), 400, 'VALIDATION');
  });
});

describe('whole-episode rebuild and legacy sync', () => {
  it('resetGraph drops the graph; the next write re-imports from the rows that exist then', async () => {
    const t = live()[0];
    db.prepare('UPDATE storyboards SET title = ? WHERE id = ?').run('整集重建后的标题', t.id); // 旧流程直接写（此时图尚未知情）
    compat.resetGraph(db, ep);
    assert.equal(store.hasProject(db, ep), false);
    const r = await call('PUT', `/storyboards/${t.id}`, { description: '又改了一次' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.title, '整集重建后的标题', 'not clobbered by a stale graph');
    assert.equal(shotsFlat()[0].params.description, '又改了一次');
    assertConsistent();
  });
});
