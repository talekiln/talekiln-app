'use strict';
// P3-R 选镜改片：editShotRegion / adoptShotVersion 只产出事务；edit 进 cacheKey；与一致性套件的预言机、不变量一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src');
const { fixtureGraph, apply, checkInvariants } = require('./helpers');
const O = require('./conformance/oracle');
const INV = require('./conformance/invariants');

const { shot, canvas } = K.intents;
const RECT = { x: 0.25, y: 0.1, w: 0.5, h: 0.4 };

/** 按预言机约定“生成”一个节点：asset.hash = 该节点此刻的内容签名（不是内核的 cache_key）。 */
function generate(g, id, vid, extra = {}) {
  return apply(g, { tx_id: `gen-${vid}`, ops: [
    { op: 'addVersion', node: id, version: { id: vid, cache_key: K.cacheKeys(g)[id], asset: { ref: `asset/${vid}.mp4`, hash: O.contentHash(g, id), kind: g.nodes[id].type }, ...extra } },
    { op: 'adoptVersion', node: id, version_id: vid },
  ] });
}
/** 全部生成类节点各生成一版 -> 全新鲜。 */
function freshGraph() {
  let g = fixtureGraph();
  for (const id of K.staleSet(g)) g = generate(g, id, `v_${id}`);
  assert.deepEqual(K.staleSet(g), []);
  assert.deepEqual(O.expectedStale(g), []);
  return g;
}
const videoOf = (g, s) => K.partsOfShot(g, s).video;

/** 应用事务并做一致性检查：输入图不变；不变量；撤销后逐字节相同；预言机的过期集合与内核一致（I5）。 */
function run(g, tx) {
  const snap = K.toJSON(g);
  const r = K.applyTx(g, tx);
  assert.equal(K.toJSON(g), snap, 'intent/applyTx must not mutate the input graph');
  checkInvariants(r.graph);
  INV.checkGraph(r.graph);
  assert.deepEqual(K.staleSet(r.graph), O.expectedStale(r.graph), 'oracle agrees on the stale set');
  assert.deepEqual({ invalidated: r.invalidated, revalidated: r.revalidated }, O.expectedDiff(g, r.graph), 'oracle agrees on the diff');
  const back = K.applyTx(r.graph, { tx_id: `u-${tx.tx_id}`, ops: r.inverse }).graph;
  assert.equal(K.toJSON(back), snap, `undo of ${tx.label}`);
  // 快照重载后从零计算的结果一致
  assert.deepEqual(K.staleSet(K.fromJSON(K.toJSON(r.graph))), K.staleSet(r.graph));
  return r;
}

test('editShotRegion：只写 video.edit；视频与合成过期，首帧图、配音、其它镜头不动；可撤销', () => {
  const g = freshGraph();
  const vid = videoOf(g, 'shot_1');
  const tx = shot.editShotRegion(g, 'shot_1', { t0_ms: 1000, t1_ms: 2500, rect: RECT, prompt: ' 把伞换成红色 ' }, { tx_id: 'e1' });
  assert.equal(tx.label, 'editShotRegion');
  assert.deepEqual(tx.ops, [{ op: 'setParam', node: vid, path: ['edit'], value: { base: `v_${vid}`, mode: 'region', t0_ms: 1000, t1_ms: 2500, rect: RECT, prompt: '把伞换成红色' } }]);
  assert.deepEqual(tx.meta, { node: vid, edit: tx.ops[0].value });
  const r = run(g, tx);
  assert.deepEqual(r.invalidated, [vid, K.composeId(g)].sort());
  assert.deepEqual(r.revalidated, []);
  assert.equal(K.nodeState(r.graph, K.partsOfShot(g, 'shot_1').image), 'fresh');
  assert.equal(K.nodeState(r.graph, K.partsOfShot(g, 'shot_1').narration), 'fresh');
  for (const s of ['shot_2', 'shot_3', 'shot_4']) assert.equal(K.nodeState(r.graph, videoOf(g, s)), 'fresh', s);
  // 只有这个 video 节点的 edit 参数变了（预言机把对象拍平成叶子路径）
  const changed = O.changedPaths(g, r.graph);
  assert.equal(changed.length, 9, 'base, mode, prompt, t0_ms, t1_ms, rect.{x,y,w,h}');
  assert.ok(changed.every((p) => p.startsWith(`nodes.${vid}.params.edit.`)), changed.join());
  // 分镜视图把视频标成过期；旧版本仍采用、仍保留
  const sv = K.shotView(r.graph).groups[0].shots[0];
  assert.equal(sv.video, 'stale');
  assert.equal(K.adoptedVersion(r.graph, vid).id, `v_${vid}`);
});

test('editShotRegion：相同修改 = 空事务；换范围 / 换基底 = 不同的 key', () => {
  const g = freshGraph();
  const vid = videoOf(g, 'shot_2');
  const args = { t0_ms: 0, t1_ms: 3000, rect: RECT, prompt: '雨更大一些' };
  const g1 = apply(g, shot.editShotRegion(g, 'shot_2', args));
  assert.equal(shot.editShotRegion(g1, 'shot_2', args).ops.length, 0, 'same edit on the same base is a no-op');
  const k1 = K.cacheKeys(g1)[vid];
  const g2 = apply(g1, shot.editShotRegion(g1, 'shot_2', { ...args, t1_ms: 4000 }));
  assert.notEqual(K.cacheKeys(g2)[vid], k1);
  // 改回原范围 -> key 回到 k1（参数值相同即相同 key）
  const g3 = apply(g2, shot.editShotRegion(g2, 'shot_2', args));
  assert.equal(K.cacheKeys(g3)[vid], k1);
  // 换了基底（采用另一个版本）后同样的修改是另一个 key
  const g4 = generate(g, vid, 'v_other');
  const g5 = apply(g4, shot.editShotRegion(g4, 'shot_2', args));
  assert.equal(g5.nodes[vid].params.edit.base, 'v_other');
  assert.notEqual(K.cacheKeys(g5)[vid], k1);
});

test('editShotRegion：校验（无采用视频、范围、区域、提示词、模式、超出片长）', () => {
  const g0 = fixtureGraph();
  assert.throws(() => shot.editShotRegion(g0, 'shot_1', { t0_ms: 0, t1_ms: 1000, rect: RECT, prompt: 'x' }), { code: 'INTENT', message: /no adopted video/ });
  const g = freshGraph();
  const bad = (args, re) => assert.throws(() => shot.editShotRegion(g, 'shot_1', args), { code: 'INTENT', message: re });
  bad({ t0_ms: 1000, t1_ms: 1000, rect: RECT, prompt: 'x' }, /t0 < t1/);
  bad({ t0_ms: -1, t1_ms: 1000, rect: RECT, prompt: 'x' }, /t0 < t1/);
  bad({ t0_ms: 0.5, t1_ms: 1000, rect: RECT, prompt: 'x' }, /integers/);
  bad({ t0_ms: 0, t1_ms: 4001, rect: RECT, prompt: 'x' }, /exceeds the video length \(4000 ms\)/); // shot_1 duration_ms 4000，版本没有真实片长
  bad({ t0_ms: 0, t1_ms: 1000, rect: { x: 0.8, y: 0, w: 0.5, h: 0.5 }, prompt: 'x' }, /inside the frame/);
  bad({ t0_ms: 0, t1_ms: 1000, rect: { x: 0, y: 0, w: 0, h: 0.5 }, prompt: 'x' }, /rect\.w/);
  bad({ t0_ms: 0, t1_ms: 1000, rect: { x: 'a', y: 0, w: 1, h: 1 }, prompt: 'x' }, /rect\.x/);
  bad({ t0_ms: 0, t1_ms: 1000, prompt: 'x' }, /rect must be an object/); // region 模式必须给区域
  bad({ t0_ms: 0, t1_ms: 1000, rect: RECT, prompt: '   ' }, /prompt/);
  bad({ t0_ms: 0, t1_ms: 1000, rect: RECT, prompt: 'x', mode: 'whole' }, /mode/);
  assert.throws(() => shot.editShotRegion(g, 'line_1', { t0_ms: 0, t1_ms: 1000, rect: RECT, prompt: 'x' }), { code: 'INTENT' });
  assert.throws(() => shot.editShotRegion(g, 'nope', { t0_ms: 0, t1_ms: 1000, rect: RECT, prompt: 'x' }), { code: 'INTENT' });
});

test('editShotRegion：segment 模式默认整幅画面；区域四舍五入到四位小数；真实片长优先于目标时长', () => {
  let g = freshGraph();
  const vid = videoOf(g, 'shot_3'); // duration_ms 3000
  const seg = shot.editShotRegion(g, 'shot_3', { t0_ms: 500, t1_ms: 1500, prompt: '整段重做', mode: 'segment' });
  assert.deepEqual(seg.ops[0].value.rect, { x: 0, y: 0, w: 1, h: 1 });
  const rounded = shot.editShotRegion(g, 'shot_3', { t0_ms: 0, t1_ms: 1000, rect: { x: 0.123456, y: 0.1, w: 0.333333, h: 0.5 }, prompt: 'x' });
  assert.deepEqual(rounded.ops[0].value.rect, { x: 0.1235, y: 0.1, w: 0.3333, h: 0.5 });
  // 采用版本带真实片长 2400ms：出点以它为准
  g = generate(g, vid, 'v_real', { metadata: { duration_ms: 2400 } });
  assert.throws(() => shot.editShotRegion(g, 'shot_3', { t0_ms: 0, t1_ms: 2500, prompt: 'x', mode: 'segment' }), { message: /\(2400 ms\)/ });
  assert.equal(shot.editShotRegion(g, 'shot_3', { t0_ms: 0, t1_ms: 2400, prompt: 'x', mode: 'segment' }).ops.length, 1);
});

test('adoptShotVersion：采用改片结果 -> 参数跟随配方（新鲜）；采用回原版本 -> 清除 edit（仍新鲜）', () => {
  const g = freshGraph();
  const vid = videoOf(g, 'shot_1');
  const base = `v_${vid}`;
  const tx = shot.editShotRegion(g, 'shot_1', { t0_ms: 1000, t1_ms: 2000, rect: RECT, prompt: '换成红伞' }, { tx_id: 'e' });
  const edited = apply(g, tx);
  const edit = edited.nodes[vid].params.edit;
  const key = K.cacheKeys(edited)[vid];
  // 服务把改片结果记成新版本（不采用）：cache_key 取建任务时的值，metadata.edit 记配方
  const withResult = apply(edited, { tx_id: 'res', ops: [{ op: 'addVersion', node: vid, version: {
    id: 'edit_1', cache_key: key, asset: { ref: 'asset/edit_1.mp4', hash: O.contentHash(edited, vid), kind: 'video' }, metadata: { edit, duration_ms: 4000 }, source: 'region-edit:1',
  } }] });
  assert.equal(K.nodeState(withResult, vid), 'stale', '结果未采用前仍过期（采用的是旧版本）');
  assert.deepEqual(K.staleSet(withResult), O.expectedStale(withResult));

  // 采用结果：只多一个 adoptVersion（参数已经一致）
  const a = shot.adoptShotVersion(withResult, 'shot_1', { version_id: 'edit_1' }, { tx_id: 'a1' });
  assert.deepEqual(a.ops, [{ op: 'adoptVersion', node: vid, version_id: 'edit_1' }]);
  const r1 = run(withResult, a);
  assert.deepEqual(r1.revalidated, [vid], '视频新鲜；合成的 key 含改后的视频 key，仍需重新合成');
  assert.equal(K.nodeState(r1.graph, vid), 'fresh');
  assert.equal(K.nodeState(r1.graph, K.composeId(g)), 'stale');
  assert.equal(shot.adoptShotVersion(r1.graph, 'shot_1', { version_id: 'edit_1' }).ops.length, 0, '已采用且参数一致 = 空事务');

  // 采用回原版本：清除 edit，key 回到整镜生成时的值 -> 新鲜，而不是误报过期
  const b = shot.adoptShotVersion(r1.graph, 'shot_1', { version_id: base }, { tx_id: 'a2' });
  assert.deepEqual(b.ops, [{ op: 'setParam', node: vid, path: ['edit'], unset: true }, { op: 'adoptVersion', node: vid, version_id: base }]);
  const r2 = run(r1.graph, b);
  assert.deepEqual(r2.revalidated, [K.composeId(g)], '回到整镜生成的 key：合成也回到新鲜');
  assert.equal(K.nodeState(r2.graph, vid), 'fresh');
  assert.ok(!('edit' in r2.graph.nodes[vid].params));
  assert.equal(K.cacheKeys(r2.graph)[vid], K.cacheKeys(g)[vid]);
  // 再采用结果：参数重新写回配方
  const c = shot.adoptShotVersion(r2.graph, 'shot_1', { version_id: 'edit_1' });
  assert.equal(c.ops.length, 2);
  assert.deepEqual(c.ops[0].value, edit);
  assert.equal(K.nodeState(apply(r2.graph, c), vid), 'fresh');
  // 普通的 adoptVersion op 不跟随配方：采用回原版本会显示过期（版本历史抽屉的旧路径，文档已说明）
  const plain = apply(r1.graph, { tx_id: 'p', ops: [{ op: 'adoptVersion', node: vid, version_id: base }] });
  assert.equal(K.nodeState(plain, vid), 'stale');
  assert.throws(() => shot.adoptShotVersion(g, 'shot_1', { version_id: 'nope' }), { code: 'INTENT', message: /version not found/ });
});

test('画布 setNodeParam 可读写 video.edit（同一套校验）；清除用 null', () => {
  const g = freshGraph();
  const vid = videoOf(g, 'shot_1');
  const edit = { base: `v_${vid}`, mode: 'region', t0_ms: 0, t1_ms: 1000, rect: RECT, prompt: 'x' };
  const g1 = apply(g, canvas.setNodeParam(g, vid, 'edit', edit));
  assert.deepEqual(g1.nodes[vid].params.edit, edit);
  assert.equal(K.nodeState(g1, vid), 'stale');
  assert.throws(() => canvas.setNodeParam(g, vid, 'edit', { ...edit, rect: { x: 0.12345, y: 0, w: 0.5, h: 0.5 } }), { code: 'INTENT', message: /4 decimals/ });
  assert.throws(() => canvas.setNodeParam(g, vid, 'edit', { ...edit, base: '' }), { code: 'INTENT', message: /base/ });
  assert.throws(() => canvas.setNodeParam(g, vid, 'edit', { ...edit, t1_ms: 0 }), { code: 'INTENT' });
  assert.throws(() => canvas.setNodeParam(g, vid, 'edit', 'nope'), { code: 'INTENT' });
  const g2 = apply(g1, canvas.setNodeParam(g1, vid, 'edit', null));
  assert.equal(K.toJSON(g2), K.toJSON(g));
  assert.equal(K.checkEdit(edit), null);
  assert.deepEqual(K.normalizeRect({ x: 0, y: 0, w: 1, h: 1 }), { rect: { x: 0, y: 0, w: 1, h: 1 } });
  assert.match(K.normalizeRect(null).error, /object/);
});
