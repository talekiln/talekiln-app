'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const kernel = require('@talekiln/kernel');
const store = require('../src/kernel/store');
const legacy = require('../src/kernel/legacy');
const timelineService = require('../src/timeline/service');
const { seededDb, sbRows } = require('./helpers/kernelDb');

const eq = (a, b, m) => assert.equal(kernel.canonicalJSON(a), kernel.canonicalJSON(b), m);
const dump = (db, ep) => ({
  sb: sbRows(db, ep),
  ops: db.prepare('SELECT seq, tx_id FROM graph_ops WHERE episode_id = ? ORDER BY seq').all(ep),
  tl: timelineService.loadTimelineByEpisode(db, ep),
  snap: db.prepare('SELECT * FROM project_graphs WHERE episode_id = ?').get(ep),
});
const firstShot = (g) => kernel.shotOrder(g)[0];
const setTitle = (g, title, id) => kernel.intents.shot.setShotField(g, firstShot(g), { title }, { tx_id: id });

describe('importLegacy', () => {
  it('builds lines, shots with legacy_id, derives edges, adopted versions and segments from the sample episode', async () => {
    const { db, episodeId } = await seededDb();
    const r = legacy.importLegacy(db, episodeId);
    assert.equal(r.created, true);
    assert.equal(r.shots, 5);
    const { graph: g } = store.openProject(db, episodeId);
    const rows = sbRows(db, episodeId);
    assert.deepEqual(kernel.shotOrder(g).map((id) => g.nodes[id].legacy_id), rows.map((x) => x.id));
    // 5 个镜头里 3 个有对白、2 个有旁白，每行都连到自己的镜头
    const lines = kernel.nodesOfType(g, 'script_line');
    assert.ok(lines.length >= 5);
    for (const id of kernel.shotOrder(g)) assert.ok(kernel.linesOfShot(g, id).length >= 1);
    const shot2 = kernel.shotOrder(g)[1];
    assert.equal(kernel.shotDialogue(g, shot2), rows[1].dialogue);
    // 采用版本：图片 + 旁白音频，都是 fresh
    const view = kernel.shotView(g);
    for (const s of view.groups.flatMap((x) => x.shots)) {
      assert.equal(s.image, 'fresh');
      assert.equal(s.narration, 'fresh');
      assert.equal(s.video, 'none');
    }
    // 时间线 -> segments：与旧 timeline 的视频轨一致
    const tl = timelineService.loadTimelineByEpisode(db, episodeId);
    const vid = tl.tracks.find((t) => t.kind === 'video').clips;
    const tv = kernel.timelineView(g).tracks[0].clips;
    assert.deepEqual(tv.map((c) => [c.start_ms, c.duration_ms, c.asset_ref, c.storyboard_id]), vid.map((c) => [c.start_ms, c.duration_ms, c.asset_ref, c.storyboard_id]));
    assert.deepEqual(tv.map((c) => c.id), vid.map((c) => c.id), 'legacy clip ids become segment ids');
  });

  it('is idempotent: a second import does not overwrite the graph', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    store.commit(db, episodeId, (g) => setTitle(g, 'edited', 't1'));
    const before = store.openProject(db, episodeId).graph;
    const r = legacy.importLegacy(db, episodeId);
    assert.equal(r.created, false);
    eq(store.openProject(db, episodeId).graph, before);
  });

  it('unknown episode -> NOT_FOUND', async () => {
    const { db } = await seededDb();
    assert.throws(() => legacy.importLegacy(db, 9999), (e) => e.code === 'NOT_FOUND');
  });

  it('works without a timeline and without script text', async () => {
    const { db, episodeId } = await seededDb({ withTimeline: false });
    db.prepare('UPDATE episodes SET script_content = NULL WHERE id = ?').run(episodeId);
    legacy.importLegacy(db, episodeId);
    const { graph: g } = store.openProject(db, episodeId);
    assert.equal(kernel.timelineView(g).tracks[0].clips.length, 5);
  });
});

describe('materialize round trip', () => {
  it('import then materialize leaves storyboards untouched and the timeline equal on the fields that matter', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    const before = { sb: sbRows(db, episodeId), tl: timelineService.loadTimelineByEpisode(db, episodeId) };
    const { graph } = store.openProject(db, episodeId);
    legacy.materialize(db, episodeId, graph);
    const after = { sb: sbRows(db, episodeId), tl: timelineService.loadTimelineByEpisode(db, episodeId) };
    // storyboards：逐行逐列完全相同（没有无谓写入，updated_at 也不变）
    assert.deepEqual(after.sb, before.sb);
    // timeline：视频/旁白/音乐轨一致；字幕多出的只有“旁白镜头”的字幕（旧装配只取 dialogue 列）
    const kinds = (tl, k) => tl.tracks.find((t) => t.kind === k).clips.map((c) => [c.start_ms, c.duration_ms, c.src_in_ms, c.src_out_ms, c.asset_ref, c.asset_kind, c.storyboard_id]);
    for (const k of ['video', 'narration', 'music']) assert.deepEqual(kinds(after.tl, k), kinds(before.tl, k), k);
    assert.equal(after.tl.duration_ms, before.tl.duration_ms);
    const subs = (tl) => tl.tracks.find((t) => t.kind === 'subtitle').clips;
    const dialogueIds = new Set(before.sb.filter((s) => s.dialogue).map((s) => s.id));
    assert.deepEqual(subs(after.tl).filter((c) => dialogueIds.has(c.storyboard_id)).map((c) => [c.storyboard_id, c.text, c.start_ms, c.duration_ms]),
      subs(before.tl).map((c) => [c.storyboard_id, c.text, c.start_ms, c.duration_ms]));
    assert.equal(subs(after.tl).length, 5);
  });

  it('a commit writes derived columns, keeps ids stable and adds status mapping', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    const ids = sbRows(db, episodeId).map((r) => r.id);
    store.commit(db, episodeId, (g) => setTitle(g, '新标题', 'c1'));
    const rows = sbRows(db, episodeId);
    assert.deepEqual(rows.map((r) => r.id), ids);
    assert.equal(rows[0].title, '新标题');
    assert.equal(rows[0].status, 'completed');
    assert.equal(rows[1].title, sbRows(db, episodeId)[1].title);
  });

  it('delete shot -> soft delete; undo restores the same row; redo deletes it again', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    const target = sbRows(db, episodeId)[2].id;
    store.commit(db, episodeId, (g) => kernel.intents.shot.deleteShot(g, kernel.shotOrder(g)[2], { tx_id: 'd1' }));
    let row = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(target);
    assert.ok(row.deleted_at);
    assert.deepEqual(db.prepare('SELECT storyboard_number FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number').all(episodeId).map((r) => r.storyboard_number), [1, 2, 3, 4]);
    assert.equal(timelineService.loadTimelineByEpisode(db, episodeId).tracks[0].clips.length, 4);
    store.undo(db, episodeId);
    row = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(target);
    assert.equal(row.deleted_at, null);
    assert.equal(timelineService.loadTimelineByEpisode(db, episodeId).tracks[0].clips.length, 5);
    store.redo(db, episodeId);
    assert.ok(db.prepare('SELECT deleted_at FROM storyboards WHERE id = ?').get(target).deleted_at);
  });

  it('a shot created in the graph gets a storyboards row, a bound legacy_id and a timeline clip; undo/redo reuses the row', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    const r = store.commit(db, episodeId, (g) => kernel.intents.shot.addShot(g, { group: g.group_order[g.group_order.length - 1], params: { title: 'new shot', duration_ms: 2000 } }, { tx_id: 'a1' }));
    const shotId = r.meta.shot_id;
    const lid = r.graph.nodes[shotId].legacy_id;
    assert.ok(Number.isInteger(lid));
    const row = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(lid);
    assert.equal(row.title, 'new shot');
    assert.equal(row.duration, 2);
    assert.equal(row.status, 'pending');
    const clips = timelineService.loadTimelineByEpisode(db, episodeId).tracks[0].clips;
    assert.equal(clips[clips.length - 1].storyboard_id, lid);
    // reload sees the binding
    assert.equal(store.openProject(db, episodeId).graph.nodes[shotId].legacy_id, lid);
    store.undo(db, episodeId);
    assert.ok(db.prepare('SELECT deleted_at FROM storyboards WHERE id = ?').get(lid).deleted_at);
    const redone = store.redo(db, episodeId);
    assert.equal(redone.graph.nodes[shotId].legacy_id, lid);
    assert.equal(db.prepare('SELECT deleted_at FROM storyboards WHERE id = ?').get(lid).deleted_at, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM storyboards WHERE episode_id = ?').get(episodeId).n, 6);
    eq(store.openProject(db, episodeId).graph, redone.graph);
  });

  it('status mapping: processing/failed are kept; completed falls back to pending without assets', () => {
    assert.equal(legacy.deriveStatus('processing', true), 'processing');
    assert.equal(legacy.deriveStatus('failed', false), 'failed');
    assert.equal(legacy.deriveStatus('draft', true), 'completed');
    assert.equal(legacy.deriveStatus('draft', false), 'draft');
    assert.equal(legacy.deriveStatus('pending', false), 'pending');
    assert.equal(legacy.deriveStatus('completed', false), 'pending');
  });

  it('does not clear a video_url that legacy generation wrote outside the kernel', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    const id = sbRows(db, episodeId)[0].id;
    db.prepare('UPDATE storyboards SET video_url = ? WHERE id = ?').run('/v/legacy.mp4', id);
    store.commit(db, episodeId, (g) => setTitle(g, 'x', 'k1'));
    assert.equal(db.prepare('SELECT video_url FROM storyboards WHERE id = ?').get(id).video_url, '/v/legacy.mp4');
  });
});

describe('store: persistence', () => {
  it('crash/reload: log replay without snapshot equals the live graph, including undo/redo stacks', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    const opts = { snapshotEvery: 1000 }; // 不写快照：重载完全靠日志重放
    let live;
    live = store.commit(db, episodeId, (g) => setTitle(g, 'one', 'p1'), opts);
    live = store.commit(db, episodeId, (g) => kernel.intents.canvas.moveNode(g, firstShot(g), { x: 5, y: 6 }, { tx_id: 'p2' }), opts);
    live = store.commit(db, episodeId, (g) => kernel.intents.shot.splitShot(g, kernel.shotOrder(g)[1], 0, { tx_id: 'p3' }), opts);
    live = store.undo(db, episodeId, { ...opts, tx_id: 'u1' });
    live = store.redo(db, episodeId, { ...opts, tx_id: 'r1' });
    live = store.undo(db, episodeId, { ...opts, tx_id: 'u2' });
    assert.equal(db.prepare('SELECT snapshot_seq FROM project_graphs WHERE episode_id = ?').get(episodeId).snapshot_seq, 0);
    const re = store.openProject(db, episodeId);
    eq(re.graph, live.graph);
    assert.equal(re.seq, live.seq);
    assert.equal(re.canUndo, live.canUndo);
    assert.equal(re.canRedo, true);
    // 重载后撤销栈仍可继续用，并与继续在内存里操作的结果一致
    const next = store.undo(db, episodeId, opts);
    eq(next.graph, store.openProject(db, episodeId).graph);
    // 撤销到底，再与导入时的图比较
    while (store.openProject(db, episodeId).canUndo) store.undo(db, episodeId, opts);
    const base = JSON.parse(db.prepare('SELECT snapshot FROM project_graphs WHERE episode_id = ?').get(episodeId).snapshot).graph;
    eq(store.openProject(db, episodeId).graph, base);
  });

  it('snapshots are written every N ops and reload from snapshot + tail equals the live graph', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    const base = store.openProject(db, episodeId).graph;
    let live;
    for (let i = 1; i <= 7; i++) live = store.commit(db, episodeId, (g) => setTitle(g, `t${i}`, `s${i}`), { snapshotEvery: 3 });
    const snap = db.prepare('SELECT snapshot_seq FROM project_graphs WHERE episode_id = ?').get(episodeId).snapshot_seq;
    assert.ok(snap > 0 && snap < live.seq, `snapshot_seq ${snap}, last seq ${live.seq}`);
    eq(store.openProject(db, episodeId).graph, live.graph);
    // 快照里带着撤销栈：重载后能一路撤销到导入状态
    let n = 0;
    while (store.openProject(db, episodeId).canUndo) { store.undo(db, episodeId, { snapshotEvery: 3 }); n++; }
    assert.equal(n, 7);
    eq(store.openProject(db, episodeId).graph, base);
  });

  it('tx_id replay is a no-op (no log row, no legacy write), also for undo/redo ids', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    const a = store.commit(db, episodeId, (g) => setTitle(g, 'dup', 'same'));
    assert.equal(a.applied, true);
    const mid = dump(db, episodeId);
    const b = store.commit(db, episodeId, (g) => setTitle(g, 'other', 'same'), { tx_id: 'same' });
    assert.equal(b.applied, false);
    const raw = store.commit(db, episodeId, { tx_id: 'same', label: 'x', ops: [] });
    assert.equal(raw.applied, false);
    assert.deepEqual(dump(db, episodeId), mid);
    store.undo(db, episodeId, { tx_id: 'u-1' });
    const afterUndo = dump(db, episodeId);
    assert.equal(store.undo(db, episodeId, { tx_id: 'u-1' }).applied, false);
    assert.deepEqual(dump(db, episodeId), afterUndo);
  });

  it('atomic: a failing tx leaves graph, ops log, snapshot and legacy rows untouched', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    store.commit(db, episodeId, (g) => setTitle(g, 'ok', 'good'));
    const before = dump(db, episodeId);
    const graphBefore = store.openProject(db, episodeId).graph;
    // 前半成功、后半违反校验（连到不存在的节点）
    const bad = { tx_id: 'bad', label: 'bad', ops: [{ op: 'setParam', node: firstShot(graphBefore), path: ['title'], value: 'half' }, { op: 'removeNode', id: 'nope' }] };
    assert.throws(() => store.commit(db, episodeId, bad), (e) => e.code === 'NOT_FOUND');
    const invalid = { tx_id: 'bad2', label: 'bad', ops: [{ op: 'setParam', node: firstShot(graphBefore), path: ['title'], value: 'half' }, { op: 'setParam', node: firstShot(graphBefore), path: ['duration_ms'], value: -1 }] };
    assert.throws(() => store.commit(db, episodeId, invalid), (e) => e.code === 'VALIDATION');
    assert.deepEqual(dump(db, episodeId), before);
    eq(store.openProject(db, episodeId).graph, graphBefore);
  });

  it('atomic: a materialize failure rolls back the log and earlier legacy writes', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    const before = dump(db, episodeId);
    const failing = (d, ep, g) => { legacy.materialize(d, ep, g); throw new Error('disk full'); };
    assert.throws(() => store.commit(db, episodeId, (g) => setTitle(g, 'lost', 'm1'), { materialize: failing }), /disk full/);
    assert.deepEqual(dump(db, episodeId), before);
    assert.equal(store.openProject(db, episodeId).seq, 0);
  });

  it('undo/redo with empty stacks -> NOTHING_TO_UNDO / NOTHING_TO_REDO', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    assert.throws(() => store.undo(db, episodeId), (e) => e.code === 'NOTHING_TO_UNDO');
    assert.throws(() => store.redo(db, episodeId), (e) => e.code === 'NOTHING_TO_REDO');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM graph_ops').get().n, 0);
  });

  it('commit on an episode without a graph -> GRAPH_NOT_FOUND', async () => {
    const { db, episodeId } = await seededDb();
    assert.throws(() => store.commit(db, episodeId, { tx_id: 'x', ops: [] }), (e) => e.code === 'GRAPH_NOT_FOUND');
  });

  it('view equivalence after reload: all four projections are byte-identical', async () => {
    const { db, episodeId } = await seededDb();
    legacy.importLegacy(db, episodeId);
    const live = store.commit(db, episodeId, (g) => kernel.intents.timeline.splitSegment(g, kernel.timelineView(g).tracks[0].clips[0].id, 1500, { tx_id: 'v1' }), { snapshotEvery: 1000 });
    const re = store.openProject(db, episodeId).graph;
    for (const f of [kernel.scriptView, kernel.shotView, kernel.timelineView, kernel.canvasView]) eq(f(re), f(live.graph));
  });
});
