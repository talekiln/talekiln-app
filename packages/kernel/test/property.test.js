'use strict';
// 属性测试：用种子随机数生成四种视图的随机编辑序列，检查内核的全局性质。
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src');
const { fixtureGraph, adoptAll, checkInvariants, prng } = require('./helpers');

const { script, shot, timeline, canvas } = K.intents;
const WORDS = ['雨', '夜', '你好', '再见', '走吧', '等等', '天亮了', '。', '，', '？'];
const CANVAS_REJECTABLE = new Set(['connectNodes', 'addNodeAt', 'disconnectNodes']);

/** 随机生成一个意图事务；条件不满足返回 null。返回 { name, tx }。 */
function randomIntent(g, r) {
  const lines = K.lineOrder(g);
  const shots = K.shotOrder(g);
  const cid = K.composeId(g);
  const segs = cid ? g.nodes[cid].params.segments : [];
  const nodes = Object.keys(g.nodes);
  const groups = g.group_order;
  const gen = [
    ['rewriteLine', 3, () => lines.length && script.rewriteLine(g, r.pick(lines), { text: r.pick(WORDS) + r.pick(WORDS) })],
    ['insertLine', 2, () => groups.length && script.insertLine(g, {
      group: r.pick(groups), index: r.int(6), kind: r.pick(K.LINE_KINDS), speaker: 's', text: r.pick(WORDS),
      shot_ids: shots.length ? r.shuffle(shots).slice(0, r.int(3)) : [],
    })],
    ['deleteLine', 1, () => lines.length > 3 && script.deleteLine(g, r.pick(lines))],
    ['splitLine', 1, () => { const c = lines.filter((l) => g.nodes[l].params.text.length >= 2); return c.length && (() => { const id = r.pick(c); return script.splitLine(g, id, 1 + r.int(g.nodes[id].params.text.length - 1)); })(); }],
    ['mergeLines', 1, () => {
      const id = r.pick(lines.length ? lines : [null]);
      if (!id) return null;
      const grp = K.groupOf(g, id);
      const gl = g.groups[grp].children.filter((c) => g.nodes[c].type === 'script_line');
      const nxt = gl[gl.indexOf(id) + 1];
      return nxt ? script.mergeLines(g, id, nxt, { sep: r.pick(['', ' ']) }) : null;
    }],
    ['reorderLines', 1, () => { if (!groups.length) return null; const gid = r.pick(groups); return script.reorderLines(g, gid, r.shuffle(g.groups[gid].children.filter((c) => g.nodes[c].type === 'script_line'))); }],
    ['setShotField', 3, () => shots.length && shot.setShotField(g, r.pick(shots), r.pick([
      { title: r.pick(WORDS) }, { image_prompt: r.pick(WORDS) }, { duration_ms: 500 + r.int(8000) }, { characters: [r.pick(WORDS)] },
    ]))],
    ['addShot', 2, () => groups.length && shot.addShot(g, {
      group: r.pick(groups), index: r.int(5), params: { title: 'n', duration_ms: 500 + r.int(5000) },
      lines: lines.length ? r.shuffle(lines).slice(0, r.int(3)) : [],
    })],
    ['deleteShot', 1, () => shots.length > 2 && shot.deleteShot(g, r.pick(shots))],
    ['splitShot', 1, () => { if (!shots.length) return null; const id = r.pick(shots); return shot.splitShot(g, id, r.int(K.linesOfShot(g, id).length + 1)); }],
    ['mergeShots', 1, () => shots.length > 2 && (() => { const [a, b] = r.shuffle(shots); return shot.mergeShots(g, a, b); })()],
    ['reorderShots', 2, () => { if (!groups.length) return null; const gid = r.pick(groups); return shot.reorderShots(g, gid, r.shuffle(g.groups[gid].children.filter((c) => g.nodes[c].type === 'shot'))); }],
    ['moveShotToGroup', 2, () => shots.length && groups.length && shot.moveShotToGroup(g, r.pick(shots), r.pick(groups), r.int(5))],
    ['regenerateShot', 2, () => shots.length && shot.regenerateShot(g, r.pick(shots), r.pick([{}, { targets: ['video'] }, { targets: ['image'] }, { seed: r.int(5) }]))],
    ['recordGeneration', 4, () => { const gn = nodes.filter((n) => K.GENERATED_TYPES.includes(g.nodes[n].type)); if (!gn.length) return null; const id = r.pick(gn); return shot.recordGeneration(g, id, { version_id: `v_${r.int(1e9)}`, asset: { ref: `a/${id}.bin`, hash: `h${r.int(1e9)}`, kind: g.nodes[id].type } }); }],
    ['setVoice', 1, () => shots.length && shot.setVoice(g, r.pick(shots), { voice: r.pick(['a', 'b', 'c']), speed: r.pick([1, 1.2]) })],
    ['trimSegment', 3, () => { if (!segs.length) return null; const s = r.pick(segs); const dur = g.nodes[s.shot_id].params.duration_ms; const a = r.int(dur - 1); return timeline.trimSegment(g, s.id, { in_ms: a, out_ms: a + 1 + r.int(dur - a) }); }],
    ['moveSegment', 2, () => {
      if (!segs.length) return null;
      const s = r.pick(segs);
      const o = segs.filter((x) => x.id !== s.id);
      const mode = r.int(3);
      if (mode === 0 || !o.length) return timeline.moveSegment(g, s.id, { gap_before_ms: r.int(900) });
      return timeline.moveSegment(g, s.id, mode === 1 ? { before_segment_id: r.pick(o).id } : { after_segment_id: r.pick(o).id });
    }],
    ['splitSegment', 2, () => { const c = segs.filter((s) => s.out_ms - s.in_ms >= 2); if (!c.length) return null; const s = r.pick(c); return timeline.splitSegment(g, s.id, s.in_ms + 1 + r.int(s.out_ms - s.in_ms - 1)); }],
    ['deleteSegment', 1, () => segs.length > 2 && timeline.deleteSegment(g, r.pick(segs).id)],
    ['setTransition', 1, () => segs.length && timeline.setTransition(g, r.pick(segs).id, r.pick([null, 'fade', 'wipe']))],
    ['addMusic', 1, () => cid && timeline.addMusic(g, { asset_ref: 'bgm.mp3', start_ms: r.int(5000), duration_ms: 1 + r.int(9000), volume: 0.5 })],
    ['moveNode', 8, () => nodes.length && canvas.moveNode(g, r.pick(nodes), { x: r.int(2000) - 500, y: r.int(2000) - 500 })],
    ['moveNodes', 1, () => nodes.length && canvas.moveNodes(g, Object.fromEntries(r.shuffle(nodes).slice(0, 3).map((n) => [n, { x: r.int(100), y: r.int(100) }])))],
    ['connectNodes', 2, () => nodes.length > 1 && canvas.connectNodes(g, r.pick(nodes), r.pick(nodes))],
    ['disconnectNodes', 1, () => g.edges.length && canvas.disconnectNodes(g, { edge_id: r.pick(g.edges).id })],
    ['addNodeAt', 2, () => canvas.addNodeAt(g, r.pick(['script_line', 'shot', 'image', 'video', 'narration']), { x: r.int(500), y: r.int(500), group: groups.length ? r.pick(groups) : undefined })],
    ['deleteNode', 2, () => { const c = nodes.filter((n) => g.nodes[n].type !== 'compose'); return c.length > 4 && canvas.deleteNode(g, r.pick(c)); }],
    ['adoptVersion', 1, () => { const vs = Object.keys(g.versions); if (!vs.length) return null; const n = r.pick(vs); return { tx_id: `adopt-${r.int(1e9)}`, label: 'adoptVersion', ops: [{ op: 'adoptVersion', node: n, version_id: r.pick(g.versions[n]).id }] }; }],
  ];
  const total = gen.reduce((a, x) => a + x[1], 0);
  let k = r.int(total);
  for (const [name, w, f] of gen) {
    if (k < w) {
      let tx;
      try { tx = f(); } catch (e) { if (e instanceof K.KernelError && e.code === 'INTENT') return null; throw e; }
      return tx ? { name, tx } : null;
    }
    k -= w;
  }
  return null;
}

function runSession(seed, steps) {
  const r = prng(seed);
  const initial = adoptAll(fixtureGraph());
  const h = K.createHistory(initial);
  const stats = {};
  let applied = 0;
  let layoutOnly = 0;
  for (let i = 0; i < steps * 4 && applied < steps; i++) {
    const pick = randomIntent(h.graph, r);
    if (!pick) continue;
    const before = h.graph;
    let res;
    try {
      res = h.apply(pick.tx);
    } catch (e) {
      // 画布连线/新建允许被图校验拒绝（端口、容量）；其他意图一旦产出就必须合法
      if (e instanceof K.KernelError && e.code === 'VALIDATION' && CANVAS_REJECTABLE.has(pick.name)) continue;
      e.message = `seed ${seed} step ${applied} ${pick.name}: ${e.message}`;
      throw e;
    }
    applied++;
    stats[pick.name] = (stats[pick.name] || 0) + 1;
    checkInvariants(h.graph);
    if (res.layout_only) {
      layoutOnly++;
      assert.deepEqual(K.cacheKeys(h.graph), K.cacheKeys(before), 'layout-only tx changed cacheKeys');
      assert.deepEqual(K.staleSet(h.graph), K.staleSet(before), 'layout-only tx changed staleSet');
      assert.deepEqual(res.invalidated.concat(res.revalidated), []);
    }
    // invalidated/revalidated 与前后 staleSet 的差一致
    const sb = new Set(K.staleSet(before));
    const sa = new Set(K.staleSet(h.graph));
    for (const id of res.invalidated) assert.ok(!sb.has(id) && sa.has(id) && before.nodes[id]);
    for (const id of res.revalidated) assert.ok(sb.has(id) && !sa.has(id) && before.nodes[id]);
  }
  return { initial, h, stats, applied, layoutOnly };
}

for (const seed of [1, 2, 3, 7, 42, 2024]) {
  test(`随机 200 个事务 (seed ${seed})：undo-all = 初始图，redo-all = 终态，重放 = 现图，layout 事务不动失效`, () => {
    const { initial, h, applied, layoutOnly, stats } = runSession(seed, 200);
    assert.equal(applied, 200);
    assert.ok(layoutOnly > 5, 'should exercise layout-only txs');
    assert.ok(Object.keys(stats).length >= 15, `coverage: ${Object.keys(stats).length} intent kinds`);
    const finalJSON = K.toJSON(h.graph);
    const initialJSON = K.toJSON(initial);

    // 重放：对序列化再重建的初始图按日志重放，与现图逐字节相同（崩溃恢复 I7 的内核层）
    const fresh = K.fromJSON(initialJSON);
    assert.equal(K.toJSON(K.replay(fresh, h.log())), finalJSON);
    // 日志经 JSON 往返（模拟落盘）也一样
    const logged = JSON.parse(JSON.stringify(h.log()));
    assert.equal(K.toJSON(K.replay(fresh, logged)), finalJSON);

    // 终态的投影在序列化重建后逐字节相同
    const rebuilt = K.fromJSON(finalJSON);
    for (const f of ['scriptView', 'shotView', 'timelineView', 'canvasView', 'toLegacyRows']) {
      assert.equal(JSON.stringify(K[f](rebuilt)), JSON.stringify(K[f](h.graph)), f);
    }

    // 逐个撤销到初始；每一步的图都能在重做时还原
    const states = [];
    while (h.canUndo()) { states.push(K.toJSON(h.graph)); h.undo(); }
    assert.equal(K.toJSON(h.graph), initialJSON);
    assert.deepEqual(h.graph, initial); // 深度相等（不只是规范 JSON）
    const fwd = [];
    while (h.canRedo()) { h.redo(); fwd.push(K.toJSON(h.graph)); }
    assert.equal(K.toJSON(h.graph), finalJSON);
    assert.deepEqual(fwd.slice(0, -1), states.slice().reverse().slice(0, -1)); // 重做路径与撤销路径一致
  });
}

test('随机会话中同一 tx_id 重放全部是空操作', () => {
  const { h } = runSession(5, 60);
  const snap = K.toJSON(h.graph);
  for (const tx of h.log()) assert.equal(h.apply(tx).applied, false);
  assert.equal(K.toJSON(h.graph), snap);
});

test('随机会话中任意中间点撤销一半再继续编辑，重做栈被清空且图保持合法', () => {
  const r = prng(11);
  const { h } = runSession(11, 80);
  for (let i = 0; i < 40; i++) h.undo();
  assert.ok(h.canRedo());
  let more = 0;
  while (more < 10) {
    const p = randomIntent(h.graph, r);
    if (!p) continue;
    try { h.apply(p.tx); more++; } catch (e) { if (!(e instanceof K.KernelError && CANVAS_REJECTABLE.has(p.name))) throw e; }
  }
  assert.equal(h.canRedo(), false);
  checkInvariants(h.graph);
});
