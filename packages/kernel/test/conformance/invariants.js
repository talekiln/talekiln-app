'use strict';
// 设计文档 §7 的不变量 I1–I8（纯内核可检查的部分）。每个函数失败即抛 AssertionError，消息带 I 编号。
// 期望值尽量用 oracle.js 里独立读原始结构的推导，不直接拿内核的投影互相比较。
const assert = require('node:assert/strict');
const K = require('../../src');
const O = require('./oracle');

const J = (v) => JSON.stringify(v);
const tag = (name, f) => { try { f(); } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };

function views(g) {
  return { script: K.scriptView(g), shot: K.shotView(g), timeline: K.timelineView(g), canvas: K.canvasView(g) };
}
const viewsJSON = (g) => { const v = views(g); return { script: J(v.script), shot: J(v.shot), timeline: J(v.timeline), canvas: J(v.canvas) }; };

/** I1：镜头在 shotView / timelineView / canvasView 各出现一次，顺序一致。 */
function I1(g, v = views(g)) {
  const order = O.shotsInOrder(g);
  // shotView：按组展开恰为全项目顺序，且每个镜头只出现一次
  const svIds = v.shot.groups.flatMap((x) => x.shots.map((s) => s.id));
  assert.deepEqual(svIds, order, 'shotView order');
  assert.equal(new Set(svIds).size, svIds.length);
  v.shot.groups.forEach((grp, i) => assert.deepEqual(grp.shots.map((s) => s.id), g.groups[g.group_order[i]].children.filter((c) => g.nodes[c].type === 'shot')));
  // canvasView：镜头节点各一次；分组 children 里的镜头顺序一致；node.group 与分组一致
  const cShots = v.canvas.nodes.filter((n) => n.type === 'shot');
  assert.deepEqual(cShots.map((n) => n.id).sort(), [...order].sort(), 'canvas shots');
  assert.deepEqual(v.canvas.groups.flatMap((x) => x.children.filter((c) => g.nodes[c].type === 'shot')), order, 'canvas group order');
  for (const n of cShots) assert.equal(n.group, v.canvas.groups.find((x) => x.children.includes(n.id)).id);
  assert.equal(new Set(v.canvas.nodes.map((n) => n.id)).size, v.canvas.nodes.length);
  // timelineView
  const cid = O.composeNode(g);
  if (!cid) { assert.equal(v.timeline.duration_ms, 0); assert.ok(v.timeline.tracks.every((t) => !t.clips.length)); return; }
  const segs = g.nodes[cid].params.segments;
  const shotOfSeg = Object.fromEntries(segs.map((s) => [s.id, s.shot_id]));
  const vid = v.timeline.tracks.find((t) => t.kind === 'video').clips;
  const seq = vid.map((c) => shotOfSeg[c.id]);
  assert.ok(seq.every(Boolean), 'every video clip is a segment');
  const runs = seq.filter((s, i) => i === 0 || s !== seq[i - 1]);
  assert.deepEqual(runs, order, 'timeline shot order (and each shot contiguous)');
  assert.equal(vid.length, segs.length);
  for (const c of vid) assert.equal(c.storyboard_id, g.nodes[shotOfSeg[c.id]].legacy_id ?? null);
  for (const t of v.timeline.tracks.filter((x) => x.kind === 'subtitle' || x.kind === 'narration')) {
    const ids = t.clips.map((c) => c.id.replace(/^(sub|nar)_/, ''));
    assert.ok(ids.every((id) => g.nodes[id] && g.nodes[id].type === 'shot'), `${t.kind} clips reference shots`);
    assert.deepEqual(ids, order.filter((s) => ids.includes(s)), `${t.kind} order`);
    assert.equal(new Set(ids).size, ids.length);
  }
}

/** I2：每行在 scriptView 出现一次；镜头对白 = 关联行文字拼接；行 <-> 镜头关联双向一致。 */
function I2(g, v = views(g)) {
  const lines = O.linesInOrder(g);
  assert.deepEqual(v.script.groups.flatMap((x) => x.lines.map((l) => l.id)), lines, 'scriptView lines');
  for (const grp of v.script.groups) for (const l of grp.lines) {
    assert.deepEqual(l.shot_ids, O.shotsOfLine(g, l.id), `line ${l.id} shot_ids`);
    const n = g.nodes[l.id].params;
    assert.deepEqual([l.kind, l.speaker, l.text], [n.kind, n.speaker ?? '', n.text]);
  }
  for (const grp of v.shot.groups) for (const s of grp.shots) {
    const ls = O.linesOf(g, s.id);
    assert.deepEqual(s.line_ids, ls, `shot ${s.id} line_ids`);
    const spoken = ls.filter((l) => O.SPOKEN.includes(g.nodes[l].params.kind)).map((l) => g.nodes[l].params.text).join('\n');
    assert.equal(s.dialogue, spoken, `shot ${s.id} dialogue`);
    for (const l of ls) assert.ok(O.shotsOfLine(g, l).includes(s.id));
  }
  // 画布上的 line -> shot 边与剧本关联一一对应
  const cEdges = v.canvas.edges.filter((e) => g.nodes[e.from.node].type === 'script_line' && g.nodes[e.to.node].type === 'shot').map((e) => `${e.from.node}>${e.to.node}`).sort();
  const expect = O.shotsInOrder(g).flatMap((s) => O.linesOf(g, s).map((l) => `${l}>${s}`)).sort();
  assert.deepEqual(cEdges, expect, 'canvas edges == script associations');
  // 字幕：每个有对白文字的镜头一条，文字 = 对白
  const cid = O.composeNode(g);
  if (cid) {
    const subs = v.timeline.tracks.find((t) => t.kind === 'subtitle').clips;
    const want = O.shotsInOrder(g).map((s) => [`sub_${s}`, O.linesOf(g, s).filter((l) => O.SPOKEN.includes(g.nodes[l].params.kind)).map((l) => g.nodes[l].params.text).join('\n').trim()]).filter(([, t]) => t);
    assert.deepEqual(subs.map((c) => [c.id, c.text]), want, 'subtitle track');
  }
}

/** I3：时间线总时长 = 片段与 gap 之和（独立累加起点，逐片段比对）。 */
function I3(g, v = views(g)) {
  const cid = O.composeNode(g);
  if (!cid) return;
  const params = g.nodes[cid].params;
  let cursor = 0;
  const expect = [];
  for (const sid of O.shotsInOrder(g)) {
    for (const s of params.segments.filter((x) => x.shot_id === sid)) {
      cursor += s.gap_before_ms;
      expect.push([s.id, cursor, s.out_ms - s.in_ms]);
      cursor += s.out_ms - s.in_ms;
    }
  }
  const vid = v.timeline.tracks.find((t) => t.kind === 'video').clips;
  assert.deepEqual(vid.map((c) => [c.id, c.start_ms, c.duration_ms]), expect, 'video clip starts/durations');
  for (let i = 1; i < vid.length; i++) assert.ok(vid[i].start_ms >= vid[i - 1].start_ms + vid[i - 1].duration_ms, 'no overlap');
  const musicEnd = (params.music || []).reduce((a, m) => Math.max(a, m.start_ms + m.duration_ms), 0);
  assert.equal(v.timeline.duration_ms, Math.max(cursor, musicEnd), 'duration_ms');
  const total = params.segments.reduce((a, s) => a + s.gap_before_ms + s.out_ms - s.in_ms, 0);
  assert.equal(total, cursor, 'sum(segment + gap) == end of last clip');
  for (const t of v.timeline.tracks) for (const c of t.clips) {
    assert.ok(Number.isInteger(c.start_ms) && Number.isInteger(c.duration_ms) && c.duration_ms > 0, 'integer ms');
  }
}

/** I5：独立预言机 + 序列化重建后从零计算。 */
function I5(g, v = views(g)) {
  // 预言机（独立读原始结构）与内核一致
  assert.deepEqual(K.staleSet(g), O.expectedStale(g), 'staleSet == oracle');
  const keys = K.cacheKeys(g);
  const sigs = O.signatures(g);
  for (const id of Object.keys(g.nodes)) {
    if (!O.GENERATED.includes(g.nodes[id].type)) continue;
    const fresh = K.nodeState(g, id, keys) === 'fresh';
    assert.equal(fresh, O.isFresh(g, id, sigs), `nodeState(${id}) vs oracle`);
  }
  // 序列化 -> 重建 -> 从零计算
  const text = K.toJSON(g);
  const rebuilt = K.fromJSON(text);
  assert.equal(K.toJSON(rebuilt), text, 'toJSON(fromJSON(x)) is a fixpoint');
  assert.deepEqual(K.staleSet(rebuilt), K.staleSet(g));
  assert.deepEqual(K.cacheKeys(rebuilt), keys);
  const a = { script: J(v.script), shot: J(v.shot), timeline: J(v.timeline), canvas: J(v.canvas) };
  const b = viewsJSON(rebuilt);
  for (const name of ['script', 'shot', 'timeline', 'canvas']) assert.equal(a[name], b[name], `${name} view equals the one from the rebuilt graph`);
}

/** I8：toLegacyRows 内部一致（storyboards 行 <-> shotView <-> timeline clips 的 storyboard_id）。 */
function I8(g, v = views(g)) {
  const rows = K.toLegacyRows(g);
  const order = O.shotsInOrder(g);
  assert.equal(rows.storyboards.length, order.length);
  const svShots = Object.fromEntries(v.shot.groups.flatMap((x) => x.shots).map((s) => [s.id, s]));
  const legacySeen = new Set();
  const sigs = O.signatures(g);
  rows.storyboards.forEach((r, i) => {
    const id = order[i];
    const n = g.nodes[id];
    const s = svShots[id];
    assert.equal(r.shot_id, id);
    assert.equal(r.storyboard_number, i + 1);
    assert.equal(r.legacy_id, n.legacy_id ?? null);
    if (r.legacy_id !== null) { assert.ok(!legacySeen.has(r.legacy_id), 'legacy_id unique'); legacySeen.add(r.legacy_id); }
    const gid = g.group_order.find((x) => g.groups[x].children.includes(id));
    assert.equal(r.scene_group_id, gid);
    assert.equal(r.scene_title, g.groups[gid].title);
    assert.equal(r.dialogue, s.dialogue);
    assert.equal(Math.round(r.duration * 1000), s.planned_ms); // 旧表 duration 是秒（浮点），毫秒经四舍五入还原
    assert.equal(r.title, n.params.title ?? '');
    assert.deepEqual(JSON.parse(r.characters), n.params.characters ?? []);
    const action = O.linesOf(g, id).filter((l) => g.nodes[l].params.kind === 'action').map((l) => g.nodes[l].params.text).join('\n');
    assert.equal(r.action, action);
    const vNode = O.chain(g, id).video;
    const fresh = vNode ? O.isFresh(g, vNode, sigs) : false;
    assert.equal(r.status, fresh ? 'completed' : 'draft', `status of ${id}`);
    const ver = vNode && g.adopted[vNode] ? g.versions[vNode].find((x) => x.id === g.adopted[vNode]) : null;
    assert.equal(r.video_url, ver && ver.asset && ver.asset.ref ? ver.asset.ref : null);
  });
  assert.equal(J(rows.timeline), J(v.timeline), 'legacy timeline == timelineView');
  // timeline clips <-> storyboard 行：同一 legacy_id 的片段数和总时长 = shotView 的 segment_count / used_ms
  const clips = rows.timeline.tracks.find((t) => t.kind === 'video').clips;
  if (O.composeNode(g)) {
    for (const r of rows.storyboards) {
      if (r.legacy_id === null) continue;
      const mine = clips.filter((c) => c.storyboard_id === r.legacy_id);
      const s = svShots[r.shot_id];
      assert.equal(mine.length, s.segment_count, `clips of storyboard ${r.legacy_id}`);
      assert.equal(mine.reduce((a, c) => a + c.duration_ms, 0), s.used_ms);
    }
    assert.ok(clips.every((c) => c.storyboard_id === null || legacySeen.has(c.storyboard_id)), 'every clip points at a storyboard row');
  }
}

/** 单张图上的全部静态不变量（I1、I2、I3、I5、I8 + 图校验）。 */
function checkGraph(g) {
  tag('validate', () => K.validateGraph(g));
  const v = views(g);
  tag('I1', () => I1(g, v));
  tag('I2', () => I2(g, v));
  tag('I3', () => I3(g, v));
  tag('I5', () => I5(g, v));
  tag('I8', () => I8(g, v));
}

/** I4：只改 layout 的事务，cacheKey / staleSet / 场景缓存键 / 除 layout 外的图 / 其余三个视图都不变。 */
function I4(before, after, result) {
  assert.deepEqual(result.invalidated, []);
  assert.deepEqual(result.revalidated, []);
  assert.equal(result.layout_only, true);
  assert.deepEqual(K.cacheKeys(after), K.cacheKeys(before), 'cacheKeys unchanged');
  assert.deepEqual(K.staleSet(after), K.staleSet(before), 'staleSet unchanged');
  for (const s of O.shotsInOrder(before)) assert.equal(K.sceneKey(after, s), K.sceneKey(before, s));
  const strip = (g) => { const c = structuredClone(g); c.layout = {}; return K.toJSON(c); };
  assert.equal(strip(after), strip(before), 'everything except layout unchanged');
  const a = viewsJSON(before);
  const b = viewsJSON(after);
  for (const name of ['script', 'shot', 'timeline']) assert.equal(a[name], b[name], `${name} view untouched by a layout edit`);
}

module.exports = { views, viewsJSON, I1, I2, I3, I4, I5, I8, checkGraph, tag };
