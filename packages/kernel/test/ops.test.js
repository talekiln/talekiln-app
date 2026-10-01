'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src');
const { fixtureGraph, adoptAll } = require('./helpers');

const tx = (id, ops) => ({ tx_id: id, label: id, ops });
const json = (g) => K.toJSON(g);

/** 对每个 op 类型：应用 -> 逆 op 应用 -> 与原图逐字节相同。 */
function roundTrip(g, ops) {
  const r = K.applyTx(g, tx('t', ops));
  const back = K.applyTx(r.graph, tx('undo', r.inverse)).graph;
  assert.equal(json(back), json(g));
  return r;
}

test('addNode / removeNode（级联边、布局、版本、采用、组成员）互为逆', () => {
  let g = adoptAll(fixtureGraph());
  g = K.applyTx(g, tx('lay', [{ op: 'setLayout', node: 'vid_2', pos: { x: 5, y: 6 } }])).graph;
  const r = roundTrip(g, [{ op: 'removeNode', id: 'vid_2' }]);
  assert.ok(!r.graph.nodes.vid_2 && !r.graph.layout.vid_2 && !r.graph.versions.vid_2 && !r.graph.adopted.vid_2);
  assert.ok(r.graph.edges.every((e) => e.from.node !== 'vid_2' && e.to.node !== 'vid_2'));
  const lineRemoved = roundTrip(g, [{ op: 'removeNode', id: 'line_2' }]);
  assert.ok(!lineRemoved.graph.groups.grp_1.children.includes('line_2'));
  roundTrip(g, [{ op: 'addNode', node: { id: 'img_99', type: 'image', params: { seed: 1 } } }]);
});

test('addNode 校验：重复、未知类型', () => {
  const g = fixtureGraph();
  assert.throws(() => K.applyTx(g, tx('a', [{ op: 'addNode', node: { id: 'shot_1', type: 'shot', params: {} } }])), { code: 'INVALID_OP' });
  assert.throws(() => K.applyTx(g, tx('b', [{ op: 'addNode', node: { id: 'q', type: 'wat', params: {} } }])), { code: 'INVALID_OP' });
  assert.throws(() => K.applyTx(g, tx('c', [{ op: 'nope' }])), { code: 'INVALID_OP' });
  assert.throws(() => K.applyTx(g, { ops: [] }), { code: 'INVALID_OP' });
  assert.throws(() => K.applyTx(g, { tx_id: 'x' }), { code: 'INVALID_OP' });
});

test('setParam：嵌套路径、unset、逆 op 还原中间对象是否存在', () => {
  const g = fixtureGraph();
  const cid = K.composeId(g);
  const r1 = roundTrip(g, [{ op: 'setParam', node: 'shot_1', path: ['title'], value: '新标题' }]);
  assert.equal(r1.graph.nodes.shot_1.params.title, '新标题');
  const r2 = roundTrip(g, [{ op: 'setParam', node: cid, path: ['subtitle_overrides', 'line_2', 'color'], value: '#fff' }]);
  assert.equal(r2.graph.nodes[cid].params.subtitle_overrides.line_2.color, '#fff');
  const r3 = roundTrip(g, [{ op: 'setParam', node: 'shot_1', path: ['brand_new', 'a', 'b'], value: 1 }]); // 顶层键原本不存在
  assert.equal(r3.graph.nodes.shot_1.params.brand_new.a.b, 1);
  const r4 = roundTrip(g, [{ op: 'setParam', node: 'shot_1', path: ['title'], unset: true }]);
  assert.ok(!('title' in r4.graph.nodes.shot_1.params));
  const r5 = roundTrip(g, [{ op: 'setParam', node: 'shot_1', path: 'characters.0', value: '阿宁' }]);
  assert.deepEqual(r5.graph.nodes.shot_1.params.characters, ['阿宁']);
  assert.throws(() => K.applyTx(g, tx('x', [{ op: 'setParam', node: 'ghost', path: ['a'], value: 1 }])), { code: 'NOT_FOUND' });
  assert.throws(() => K.applyTx(g, tx('y', [{ op: 'setParam', node: 'shot_1', path: [], value: 1 }])), { code: 'INVALID_OP' });
});

test('setParam 不会别名事务里的值（后改事务对象不影响图）', () => {
  const g = fixtureGraph();
  const value = ['a'];
  const r = K.applyTx(g, tx('v', [{ op: 'setParam', node: 'shot_1', path: ['characters'], value }]));
  value.push('b');
  assert.deepEqual(r.graph.nodes.shot_1.params.characters, ['a']);
});

test('connect / disconnect 互为逆，边下标保持', () => {
  const g = fixtureGraph();
  const e = g.edges[3];
  const r = roundTrip(g, [{ op: 'disconnect', id: e.id }]);
  assert.ok(!r.graph.edges.some((x) => x.id === e.id));
  roundTrip(g, [{ op: 'connect', edge: { id: 'new', from: { node: 'line_5', port: 'out' }, to: { node: 'shot_1', port: 'lines' }, type: 'derives' } }]);
  assert.throws(() => K.applyTx(g, tx('d', [{ op: 'disconnect', id: 'ghost' }])), { code: 'NOT_FOUND' });
  assert.throws(() => K.applyTx(g, tx('d2', [{ op: 'connect', edge: { id: e.id, from: e.from, to: e.to, type: e.type } }])), { code: 'INVALID_OP' });
});

test('addGroup / removeGroup / setGroupTitle / setChildren / setGroupOrder 互为逆', () => {
  const g = fixtureGraph();
  roundTrip(g, [{ op: 'addGroup', group: { id: 'grp_9', title: '新场景' } }]);
  roundTrip(g, [{ op: 'addGroup', group: { id: 'grp_9', title: '新场景' }, index: 0 }]);
  roundTrip(g, [{ op: 'setGroupTitle', group: 'grp_1', title: '改名' }]);
  roundTrip(g, [{ op: 'setGroupOrder', ids: ['grp_2', 'grp_1'] }]);
  const swap = [...g.groups.grp_1.children].reverse();
  roundTrip(g, [{ op: 'setChildren', group: 'grp_1', ids: swap }]);
  // 删有成员的组 -> 成员失去归属 -> 校验失败；清空后可删
  assert.throws(() => K.applyTx(g, tx('rg', [{ op: 'removeGroup', id: 'grp_1' }])), { code: 'VALIDATION' });
  const withEmpty = K.applyTx(g, tx('ag', [{ op: 'addGroup', group: { id: 'grp_9', title: '空' }, index: 1 }])).graph;
  const rg = roundTrip(withEmpty, [{ op: 'removeGroup', id: 'grp_9' }]);
  assert.ok(!rg.graph.groups.grp_9);
  assert.deepEqual(rg.graph.group_order, ['grp_1', 'grp_2']);
});

test('setLayout：增、改、删，逆还原；只改 layout 的事务 layout_only 且不改 cacheKey/staleSet', () => {
  const g = adoptAll(fixtureGraph());
  const before = { keys: K.cacheKeys(g), stale: K.staleSet(g) };
  const r = roundTrip(g, [{ op: 'setLayout', node: 'shot_1', pos: { x: 1, y: 2 } }]);
  assert.equal(r.layout_only, true);
  assert.deepEqual(K.cacheKeys(r.graph), before.keys);
  assert.deepEqual(K.staleSet(r.graph), before.stale);
  assert.deepEqual(r.invalidated, []);
  assert.deepEqual(r.revalidated, []);
  const r2 = K.applyTx(r.graph, tx('l2', [{ op: 'setLayout', node: 'shot_1', pos: { x: 9, y: 9 } }, { op: 'setLayout', node: 'shot_2', pos: { x: 1, y: 1 } }]));
  assert.deepEqual(r2.graph.layout, { shot_1: { x: 9, y: 9 }, shot_2: { x: 1, y: 1 } });
  const r3 = K.applyTx(r2.graph, tx('l3', [{ op: 'setLayout', node: 'shot_1', pos: null }]));
  assert.ok(!('shot_1' in r3.graph.layout));
  assert.equal(K.applyTx(g, tx('mix', [{ op: 'setLayout', node: 'shot_1', pos: { x: 0, y: 0 } }, { op: 'setParam', node: 'shot_1', path: ['title'], value: 'x' }])).layout_only, false);
});

test('addVersion / adoptVersion 互为逆；采用不存在的版本报错', () => {
  const g = fixtureGraph();
  const r = roundTrip(g, [
    { op: 'addVersion', node: 'vid_1', version: { id: 'v1', cache_key: 'k', asset: { ref: 'a', hash: 'h' } } },
    { op: 'adoptVersion', node: 'vid_1', version_id: 'v1' },
  ]);
  assert.equal(r.graph.adopted.vid_1, 'v1');
  assert.throws(() => K.applyTx(g, tx('a', [{ op: 'adoptVersion', node: 'vid_1', version_id: 'nope' }])), { code: 'NOT_FOUND' });
  assert.throws(() => K.applyTx(g, tx('b', [
    { op: 'addVersion', node: 'vid_1', version: { id: 'v1' } }, { op: 'addVersion', node: 'vid_1', version: { id: 'v1' } },
  ])), { code: 'INVALID_OP' });
  const g2 = adoptAll(g);
  roundTrip(g2, [{ op: 'adoptVersion', node: 'vid_1', version_id: null }]);
  roundTrip(g2, [{ op: 'addVersion', node: 'vid_1', version: { id: 'v2', cache_key: 'z' } }, { op: 'adoptVersion', node: 'vid_1', version_id: 'v2' }]);
});

test('setComposeSegments：逆还原；非 compose 节点报错；非法片段整事务回滚', () => {
  const g = fixtureGraph();
  const cid = K.composeId(g);
  const segs = structuredClone(g.nodes[cid].params.segments);
  segs[0].out_ms = 1000;
  const r = roundTrip(g, [{ op: 'setComposeSegments', node: cid, segments: segs }]);
  assert.equal(r.graph.nodes[cid].params.segments[0].out_ms, 1000);
  assert.throws(() => K.applyTx(g, tx('x', [{ op: 'setComposeSegments', node: 'shot_1', segments: [] }])), { code: 'INVALID_OP' });
  segs[0].out_ms = 99999;
  assert.throws(() => K.applyTx(g, tx('y', [{ op: 'setComposeSegments', node: cid, segments: segs }])), { code: 'VALIDATION' });
});

test('原子性：事务中途失败，传入的图一字节不变；成功也不改传入的图', () => {
  const g = fixtureGraph();
  const snap = json(g);
  assert.throws(() => K.applyTx(g, tx('boom', [
    { op: 'setParam', node: 'shot_1', path: ['title'], value: 'ok' },
    { op: 'removeNode', id: 'ghost' },
  ])));
  assert.equal(json(g), snap);
  // 每个 op 单独看都合法，但终态违反“每个 shot 在且仅在一个 group”
  assert.throws(() => K.applyTx(g, tx('inv', [{ op: 'setChildren', group: 'grp_2', ids: [...g.groups.grp_2.children, 'shot_1'] }])), { code: 'VALIDATION' });
  assert.equal(json(g), snap);
  K.applyTx(g, tx('okay', [{ op: 'setParam', node: 'shot_1', path: ['title'], value: 'ok' }]));
  assert.equal(json(g), snap);
});

test('事务内中间态可违反不变量，只看终态（先删后补）', () => {
  const g = fixtureGraph();
  const ids = g.groups.grp_2.children;
  const r = K.applyTx(g, tx('move', [
    { op: 'setChildren', group: 'grp_2', ids: [...ids, 'shot_1'] }, // 中间态：shot_1 同时在两组
    { op: 'setChildren', group: 'grp_1', ids: g.groups.grp_1.children.filter((c) => c !== 'shot_1') },
  ]));
  assert.equal(K.groupOf(r.graph, 'shot_1'), 'grp_2');
});

test('tx_id 幂等：同一 tx_id 重放是空操作，且失败的事务不占用 tx_id', () => {
  const g = fixtureGraph();
  const applied = new Set();
  const t = tx('same', [{ op: 'setParam', node: 'shot_1', path: ['title'], value: 'A' }]);
  const r1 = K.applyTx(g, t, { applied });
  assert.equal(r1.applied, true);
  const r2 = K.applyTx(r1.graph, t, { applied });
  assert.equal(r2.applied, false);
  assert.equal(r2.graph, r1.graph);
  assert.deepEqual(r2.inverse, []);
  const failing = tx('fail', [{ op: 'removeNode', id: 'ghost' }]);
  assert.throws(() => K.applyTx(g, failing, { applied }));
  assert.ok(!applied.has('fail'));
});

test('invalidated / revalidated：改行台词让下游过期，改回则恢复', () => {
  const g = adoptAll(fixtureGraph());
  assert.deepEqual(K.staleSet(g), []);
  const r = K.applyTx(g, tx('edit', [{ op: 'setParam', node: 'line_3', path: ['text'], value: '你来晚了。' }]));
  // line_3 属于 shot_2：shot_2 的 image/video/narration 与 compose 过期，其他镜头不受影响
  assert.deepEqual(r.invalidated, [K.composeId(g), 'img_2', 'nar_2', 'vid_2'].sort());
  assert.deepEqual(K.staleSet(r.graph), r.invalidated);
  const back = K.applyTx(r.graph, tx('revert', [{ op: 'setParam', node: 'line_3', path: ['text'], value: '你还是来了。' }]));
  assert.deepEqual(back.revalidated, r.invalidated);
  assert.deepEqual(K.staleSet(back.graph), []);
  assert.deepEqual(back.invalidated, []);
});

test('新建节点不算 invalidated；删除节点也不算', () => {
  const g = adoptAll(fixtureGraph());
  const r = K.applyTx(g, tx('add', [{ op: 'addNode', node: { id: 'img_99', type: 'image', params: {} } }]));
  assert.deepEqual(r.invalidated, []);
  const r2 = K.applyTx(g, tx('rm', [{ op: 'removeNode', id: 'img_1' }]));
  assert.ok(!r2.invalidated.includes('img_1'));
  assert.ok(r2.invalidated.includes('vid_1')); // video 少了 image 输入
});
