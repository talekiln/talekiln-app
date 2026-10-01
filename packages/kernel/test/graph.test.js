'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src');
const { fixtureGraph } = require('./helpers');

const mutated = (fn) => { const g = K.cloneGraph(fixtureGraph()); fn(g); return g; };
const rejects = (g, re) => assert.throws(() => K.validateGraph(g), (e) => e instanceof K.KernelError && e.code === 'VALIDATION' && re.test(e.message));

test('canonicalJSON: 键排序、数组保序、跳过 undefined', () => {
  assert.equal(K.canonicalJSON({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
  assert.equal(K.canonicalJSON({ a: 1, b: 2 }), K.canonicalJSON({ b: 2, a: 1 }));
  assert.throws(() => K.canonicalJSON({ a: NaN }), K.KernelError);
});

test('emptyGraph 合法；toJSON/fromJSON 往返逐字节一致', () => {
  const e = K.emptyGraph('x');
  assert.ok(K.validateGraph(e));
  const g = fixtureGraph();
  assert.equal(K.toJSON(K.fromJSON(K.toJSON(g))), K.toJSON(g));
  assert.ok(K.graphEquals(g, K.cloneGraph(g)));
});

test('fixtureGraph 通过校验，且 compose 为每个镜头都有片段', () => {
  const g = fixtureGraph();
  assert.ok(K.validateGraph(g));
  assert.equal(K.nodesOfType(g, 'shot').length, 4);
  assert.equal(g.nodes[K.composeId(g)].params.segments.length, 4);
});

test('校验：端口类型/边类型/容量', () => {
  rejects(mutated((g) => g.edges.push({ id: 'x', from: { node: 'line_1', port: 'out' }, to: { node: 'img_1', port: 'shot' }, type: 'derives' })), /accepts shot/);
  rejects(mutated((g) => { g.edges[0].type = 'feeds'; }), /type must be/);
  rejects(mutated((g) => { g.edges[0].to.port = 'nope'; }), /no input port/);
  rejects(mutated((g) => g.edges.push({ id: 'x', from: { node: 'img_2', port: 'out' }, to: { node: 'vid_1', port: 'image' }, type: 'derives' })), /single connection/);
  rejects(mutated((g) => g.edges.push({ ...g.edges[0], id: 'dup' })), /duplicate connection/);
  rejects(mutated((g) => g.edges.push({ ...g.edges[0] })), /duplicate edge id/);
  rejects(mutated((g) => { g.edges[0].from.port = 'in'; }), /output port/);
});

test('校验：端口类型规则本身是分层 DAG，回边被端口规则拒绝（环检测为纵深防御）', () => {
  const g = fixtureGraph();
  const back = K.cloneGraph(g);
  back.edges.push({ id: 'z', from: { node: 'vid_1', port: 'out' }, to: { node: 'img_1', port: 'shot' }, type: 'derives' });
  rejects(back, /accepts shot/);
  const selfLoop = K.cloneGraph(g);
  selfLoop.edges.push({ id: 'z', from: { node: 'img_1', port: 'out' }, to: { node: 'img_1', port: 'shot' }, type: 'derives' });
  rejects(selfLoop, /accepts shot/);
});

test('校验：组成员关系', () => {
  rejects(mutated((g) => { g.groups.grp_1.children.push('shot_1'); }), /duplicate children/);
  rejects(mutated((g) => { g.groups.grp_2.children.push('shot_1'); }), /exactly one group/);
  rejects(mutated((g) => { g.groups.grp_1.children = g.groups.grp_1.children.filter((c) => c !== 'shot_1'); }), /exactly one group/);
  rejects(mutated((g) => { g.groups.grp_1.children.push('img_1'); }), /must be script_line or shot/);
  rejects(mutated((g) => { g.groups.grp_1.children.push('ghost'); }), /missing/);
  rejects(mutated((g) => { g.group_order = ['grp_1']; }), /permutation/);
});

test('校验：片段', () => {
  const seg = (g) => g.nodes[K.composeId(g)].params.segments;
  rejects(mutated((g) => { seg(g)[0].shot_id = 'ghost'; }), /missing shot/);
  rejects(mutated((g) => { seg(g)[0].out_ms = 4001; }), /exceeds shot duration/);
  rejects(mutated((g) => { seg(g)[0].in_ms = 4000; }), /invalid range/);
  rejects(mutated((g) => { seg(g)[0].in_ms = 1.5; }), /invalid range/);
  rejects(mutated((g) => { seg(g)[0].gap_before_ms = -1; }), /gap_before_ms/);
  rejects(mutated((g) => { seg(g)[1].id = seg(g)[0].id; }), /duplicate segment id/);
  rejects(mutated((g) => { seg(g).pop(); }), /has no segment/);
  rejects(mutated((g) => g.nodes.cc = { id: 'cc', type: 'compose', params: {} }), /at most one compose/);
});

test('校验：节点、layout、版本、采用', () => {
  rejects(mutated((g) => { g.nodes.line_1.id = 'zzz'; }), /key\/id mismatch/);
  rejects(mutated((g) => { g.nodes.line_1.params.kind = 'x'; }), /bad kind/);
  rejects(mutated((g) => { g.nodes.shot_1.params.duration_ms = 0; }), /duration_ms/);
  rejects(mutated((g) => { g.layout.ghost = { x: 1, y: 1 }; }), /layout for missing/);
  rejects(mutated((g) => { g.layout.shot_1 = { x: 'a', y: 1 }; }), /malformed/);
  rejects(mutated((g) => { g.versions.vid_1 = []; }), /non-empty/);
  rejects(mutated((g) => { g.adopted.vid_1 = 'nope'; }), /missing version/);
  rejects(mutated((g) => { g.version = 2; }), /version must be 1/);
});

test('查询：顺序、行与镜头关联、对白、片段', () => {
  const g = fixtureGraph();
  assert.deepEqual(K.shotOrder(g), ['shot_1', 'shot_2', 'shot_3', 'shot_4']);
  assert.equal(K.lineOrder(g).length, 7);
  assert.deepEqual(K.linesOfShot(g, 'shot_2'), ['line_3', 'line_4']);
  assert.deepEqual(K.shotsOfLine(g, 'line_3'), ['shot_2']);
  assert.deepEqual(K.partsOfShot(g, 'shot_1'), { image: 'img_1', video: 'vid_1', narration: 'nar_1' });
  assert.equal(K.shotDialogue(g, 'shot_1'), '雨下了一整夜。'); // scene_heading 不算对白
  assert.equal(K.shotDialogue(g, 'shot_4'), '该走了。\n再等等。');
  assert.equal(K.segmentsOfShot(g, 'shot_3').length, 1);
  assert.equal(K.groupOf(g, 'shot_3'), 'grp_2');
});
