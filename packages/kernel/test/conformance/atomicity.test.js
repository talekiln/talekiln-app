'use strict';
// 事务全有或全无：被拒绝的事务不留任何痕迹（图、History、已应用集合、日志都不变），之后同一 tx_id 修正后仍可应用；
// 意图对乱参数只抛 KernelError，不抛 TypeError 之类的内部错误。
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../../src');
const O = require('./oracle');
const I = require('./invariants');
const S = require('./stories');

const { script, shot, timeline, canvas } = K.intents;
const raw = (id, ...ops) => ({ tx_id: id, label: 'raw', ops });

const gOf = (g, id) => g.group_order.find((x) => g.groups[x].children.includes(id));
function badTxs(g) {
  const shots = O.shotsInOrder(g);
  const [s0, s1] = shots;
  const c0 = O.chain(g, s0);
  const cid = O.composeNode(g);
  const segs = g.nodes[cid].params.segments;
  const line = O.linesInOrder(g)[0];
  const g0 = g.group_order[0];
  const bad = {
    'valid op followed by a missing node': raw('b1', { op: 'setParam', node: s0, path: ['title'], value: '半途' }, { op: 'removeNode', id: 'nope' }),
    'removing a shot node but leaving its segments': raw('b2', { op: 'removeNode', id: s0 }),
    'segment longer than its shot': raw('b3', { op: 'setComposeSegments', node: cid, segments: segs.map((s, i) => (i === 0 ? { ...s, out_ms: s.out_ms + 1 } : s)) }),
    'segment with empty range': raw('b4', { op: 'setComposeSegments', node: cid, segments: segs.map((s, i) => (i === 0 ? { ...s, in_ms: s.out_ms } : s)) }),
    'shot without any segment': raw('b5', { op: 'setComposeSegments', node: cid, segments: segs.filter((s) => s.shot_id !== s0) }),
    'edge with the wrong port type': raw('b6', { op: 'connect', edge: { id: 'e_bad', from: { node: c0.video, port: 'out' }, to: { node: s0, port: 'lines' }, type: 'derives' } }),
    'edge to a single-connection port that is already taken': raw('b7', { op: 'connect', edge: { id: 'e_bad', from: { node: s1, port: 'out' }, to: { node: c0.image, port: 'shot' }, type: 'derives' } }),
    'duplicate children': raw('b8', { op: 'setChildren', group: g0, ids: [...g.groups[g0].children, g.groups[g0].children[0]] }),
    ...(g.group_order.length > 1 ? { 'a shot in two groups': raw('b9', { op: 'setChildren', group: g.group_order.find((x) => x !== gOf(g, s0)), ids: [...g.groups[g.group_order.find((x) => x !== gOf(g, s0))].children, s0] }) } : {}),
    'duplicate node id': raw('b10', { op: 'addNode', node: { id: line, type: 'script_line', params: { kind: 'narration', text: 'x' } } }),
    'unknown op': raw('b11', { op: 'explode' }),
    'setParam through a non-object': raw('b12', { op: 'setParam', node: s0, path: ['title', 'x'], value: 1 }),
    'adopt a version that does not exist': raw('b13', { op: 'adoptVersion', node: c0.image, version_id: 'v_999' }),
    'non-finite layout coordinate': raw('b14', { op: 'setLayout', node: s0, pos: { x: Infinity, y: 0 } }),
    'NaN layout coordinate': raw('b15', { op: 'setLayout', node: s0, pos: { x: NaN, y: 0 } }),
    'non-finite param': raw('b16', { op: 'setParam', node: c0.image, path: ['seed'], value: NaN }),
    'tx without id': { ops: [] },
    'tx without ops': { tx_id: 'b19' },
  };
  return bad;
}

for (const story of S.loadStories()) {
  test(`被拒绝的事务不留痕迹 @ ${story.id}`, () => {
    const g = S.prepared(story);
    const hist = new K.History(g);
    const good = canvas.moveNode(g, O.shotsInOrder(g)[0], { x: 1, y: 2 }, { tx_id: 'good-1' });
    hist.apply(good);
    const snapshot = K.toJSON(hist.graph);
    const log = hist.log().map((t) => t.tx_id);
    const appliedBefore = [...hist.applied].sort();
    for (const [name, tx] of Object.entries(badTxs(hist.graph))) {
      const applied = new Set(hist.applied);
      assert.throws(() => hist.apply(tx), (e) => e instanceof K.KernelError, `${name}: must be rejected with a KernelError`);
      assert.throws(() => K.applyTx(hist.graph, tx, { applied }), (e) => e instanceof K.KernelError, `${name}: applyTx rejects too`);
      assert.equal(K.toJSON(hist.graph), snapshot, `${name}: graph untouched`);
      assert.deepEqual(hist.log().map((t) => t.tx_id), log, `${name}: log untouched`);
      assert.deepEqual([...hist.applied].sort(), appliedBefore, `${name}: applied-set untouched`);
      assert.deepEqual([...applied].sort(), appliedBefore, `${name}: applyTx did not record the failed tx_id`);
      assert.equal(hist.canRedo(), false);
    }
    I.checkGraph(hist.graph);
    // 失败不占用 tx_id：同一个 id 随后用合法内容仍可应用
    const fixed = { tx_id: 'b1', label: 'fixed', ops: [{ op: 'setParam', node: O.shotsInOrder(g)[0], path: ['title'], value: '修正后' }] };
    assert.equal(hist.apply(fixed).applied, true);
    assert.equal(hist.apply(fixed).applied, false);
    I.checkGraph(hist.graph);
    // 撤销栈只包含成功的事务
    assert.equal(hist.undoAll(), 2);
    assert.equal(K.toJSON(hist.graph), K.toJSON(g));
  });

  test(`意图对错误参数只抛 KernelError @ ${story.id}`, () => {
    const g = S.prepared(story);
    const s0 = O.shotsInOrder(g)[0];
    const l0 = O.linesInOrder(g)[0];
    const seg = g.nodes[O.composeNode(g)].params.segments[0];
    const grp = g.group_order[0];
    const calls = {
      'script.rewriteLine(missing)': () => script.rewriteLine(g, 'nope', { text: 'x' }),
      'script.rewriteLine(bad kind)': () => script.rewriteLine(g, l0, { kind: 'poem' }),
      'script.rewriteLine(on a shot)': () => script.rewriteLine(g, s0, { text: 'x' }),
      'script.insertLine(missing group)': () => script.insertLine(g, { group: 'nope', text: 'x' }),
      'script.insertLine(missing shot)': () => script.insertLine(g, { group: grp, text: 'x', shot_ids: ['nope'] }),
      'script.splitLine(out of range)': () => script.splitLine(g, l0, 0),
      'script.splitLine(past end)': () => script.splitLine(g, l0, 100000),
      'script.mergeLines(not adjacent)': () => script.mergeLines(g, l0, O.linesInOrder(g)[2]),
      'script.reorderLines(not a permutation)': () => script.reorderLines(g, grp, ['nope']),
      'shot.setShotField(bad duration)': () => shot.setShotField(g, s0, { duration_ms: -5 }),
      'shot.setShotField(float duration)': () => shot.setShotField(g, s0, { duration_ms: 1.5 }),
      'shot.splitShot(bad index)': () => shot.splitShot(g, s0, 99),
      'shot.mergeShots(same shot)': () => shot.mergeShots(g, s0, s0),
      'shot.reorderShots(bad ids)': () => shot.reorderShots(g, grp, ['nope']),
      'shot.moveShotToGroup(missing group)': () => shot.moveShotToGroup(g, s0, 'nope', 0),
      'shot.regenerateShot(bad target)': () => shot.regenerateShot(g, s0, { targets: ['narration'] }),
      'shot.setVoice(missing shot)': () => shot.setVoice(g, 'nope', { voice: 'x' }),
      'shot.recordGeneration(on a shot)': () => shot.recordGeneration(g, s0, { asset: null }),
      'timeline.trimSegment(missing)': () => timeline.trimSegment(g, 'nope', { in_ms: 0 }),
      'timeline.trimSegment(non-integer)': () => timeline.trimSegment(g, seg.id, { in_ms: 0.5 }),
      'timeline.moveSegment(self)': () => timeline.moveSegment(g, seg.id, { before_segment_id: seg.id }),
      'timeline.moveSegment(negative gap)': () => timeline.moveSegment(g, seg.id, { gap_before_ms: -1 }),
      'timeline.splitSegment(at the edge)': () => timeline.splitSegment(g, seg.id, seg.in_ms),
      'timeline.deleteSegment(missing)': () => timeline.deleteSegment(g, 'nope'),
      'timeline.addMusic(no asset)': () => timeline.addMusic(g, { start_ms: 0, duration_ms: 1 }),
      'timeline.addMusic(zero duration)': () => timeline.addMusic(g, { asset_ref: 'a', start_ms: 0, duration_ms: 0 }),
      'canvas.moveNode(missing)': () => canvas.moveNode(g, 'nope', { x: 1, y: 1 }),
      'canvas.moveNode(NaN)': () => canvas.moveNode(g, s0, { x: NaN, y: 1 }),
      'canvas.connectNodes(wrong types)': () => canvas.connectNodes(g, O.chain(g, s0).video, s0),
      'canvas.connectNodes(cannot infer port)': () => canvas.connectNodes(g, O.chain(g, s0).video, O.chain(g, s0).narration),
      'canvas.disconnectNodes(no edge)': () => canvas.disconnectNodes(g, { from: 'a', to: 'b' }),
      'canvas.addNodeAt(unknown type)': () => canvas.addNodeAt(g, 'poem', {}),
      'canvas.addNodeAt(second compose)': () => canvas.addNodeAt(g, 'compose', {}),
      'canvas.deleteNode(compose)': () => canvas.deleteNode(g, O.composeNode(g)),
      'canvas.deleteNode(missing)': () => canvas.deleteNode(g, 'nope'),
    };
    for (const [name, f] of Object.entries(calls)) {
      assert.throws(f, (e) => e instanceof K.KernelError, `${name}: expected a KernelError`);
    }
    assert.equal(K.toJSON(g), K.toJSON(S.prepared(story)), 'intents never mutate the graph they read');
  });
}
