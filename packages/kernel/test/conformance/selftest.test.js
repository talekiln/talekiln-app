'use strict';
// 套件自检（变异测试）：故意弄坏内核输出或测试数据，确认不变量/预言机/崩溃重放检查真的会失败；
// 以及套件抓到的内核缺陷的回归测试。
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../../src');
const O = require('./oracle');
const I = require('./invariants');
const S = require('./stories');
const H = require('./harness');

const story = () => S.loadStories().find((s) => s.id === 'gf-01');
const fresh = () => S.prepared(story());

/** 临时替换内核导出的某个函数（invariants 通过 K.xxx 调用，所以可被替换），跑完恢复。 */
function withPatch(name, wrap, fn) {
  const orig = K[name];
  K[name] = wrap(orig);
  try { return fn(); } finally { K[name] = orig; }
}

test('干净的图通过全部不变量', () => { I.checkGraph(fresh()); });

test('I1 会抓到：shotView 顺序与图不一致', () => {
  const g = fresh();
  withPatch('shotView', (orig) => (x) => { const v = orig(x); v.groups[0].shots.reverse(); return v; }, () => assert.throws(() => I.checkGraph(g), /I1/));
});
test('I1 会抓到：timelineView 少一个片段', () => {
  const g = fresh();
  withPatch('timelineView', (orig) => (x) => { const v = orig(x); v.tracks[0].clips.pop(); return v; }, () => assert.throws(() => I.checkGraph(g), /I1/));
});
test('I2 会抓到：scriptView 丢了一行 / 镜头对白与关联行不一致', () => {
  const g = fresh();
  withPatch('scriptView', (orig) => (x) => { const v = orig(x); v.groups[0].lines.pop(); return v; }, () => assert.throws(() => I.checkGraph(g), /I2/));
  withPatch('shotView', (orig) => (x) => { const v = orig(x); v.groups[0].shots[0].dialogue += '多余'; return v; }, () => assert.throws(() => I.checkGraph(g), /I2/));
});
test('I3 会抓到：时间线片段起点错 1ms / 总时长错', () => {
  const g = fresh();
  withPatch('timelineView', (orig) => (x) => { const v = orig(x); v.tracks[0].clips[1].start_ms += 1; return v; }, () => assert.throws(() => I.checkGraph(g), /I3/));
  withPatch('timelineView', (orig) => (x) => { const v = orig(x); v.duration_ms += 1; return v; }, () => assert.throws(() => I.checkGraph(g), /I3/));
});
test('I5 会抓到：内核 staleSet 漏报 / 采用版本的内容与预言机不符', () => {
  const g = fresh();
  withPatch('staleSet', () => () => ['compose_1'], () => assert.throws(() => I.checkGraph(g), /I5/));
  // 篡改：版本的 cache_key 仍等于内核当前 key（内核认为新鲜），但产出所依据的内容签名已不同 -> 预言机认为过期
  const bad = structuredClone(g);
  const img = O.chain(bad, O.shotsInOrder(bad)[0]).image;
  bad.versions[img][0].asset.hash = 'stale-content';
  assert.throws(() => I.checkGraph(bad), /I5/);
});
test('I8 会抓到：旧表对白或状态与投影不一致', () => {
  const g = fresh();
  withPatch('toLegacyRows', (orig) => (x) => { const r = orig(x); r.storyboards[0].dialogue += '!'; return r; }, () => assert.throws(() => I.checkGraph(g), /I8/));
  withPatch('toLegacyRows', (orig) => (x) => { const r = orig(x); r.storyboards[0].status = 'draft'; return r; }, () => assert.throws(() => I.checkGraph(g), /I8/));
});
test('I4 会抓到：布局事务却改变了过期集合', () => {
  const g = fresh();
  const tx = K.intents.canvas.moveNode(g, 'shot_1', { x: 1, y: 2 });
  const r = K.applyTx(g, tx);
  I.I4(g, r.graph, r); // 正常通过
  assert.throws(() => I.I4(g, r.graph, { ...r, invalidated: ['compose_1'] }));
  const tampered = structuredClone(r.graph);
  tampered.nodes.shot_1.params.title = '被偷偷改了';
  assert.throws(() => I.I4(g, tampered, r));
});
test('崩溃重放检查会抓到：日志缺一条 / 快照与日志不衔接', () => {
  const g = fresh();
  const t1 = K.intents.canvas.moveNode(g, 'shot_1', { x: 1, y: 2 }, { tx_id: 't1' });
  const g1 = K.applyTx(g, t1).graph;
  const t2 = K.intents.script.rewriteLine(g1, 'line_2', { text: '新' }, { tx_id: 't2' });
  const g2 = K.applyTx(g1, t2).graph;
  const rec = (x) => ({ json: K.toJSON(x), views: I.viewsJSON(x) });
  const states = [rec(g), rec(g1), rec(g2)];
  H.crashMatrix(states, [t1, t2], 2, 'ok'); // 正常通过
  assert.throws(() => H.crashMatrix(states, [t1], 2, 'missing'), /crash at boundary/);
  assert.throws(() => H.crashMatrix([states[0], states[0], states[2]], [t1, t2], 2, 'broken snapshot'));
});
test('写入范围检查会抓到：编辑写了声明之外的路径', () => {
  const g = fresh();
  const after = K.applyTx(g, K.intents.shot.setShotField(g, 'shot_1', { title: 'x' })).graph;
  H.writesConfined(g, after, [/^nodes\.shot_1\.params\.title$/], 'ok');
  assert.throws(() => H.writesConfined(g, after, [/^layout\./], 'bad'), /outside its allowance/);
});
test('预言机：手工小例子（独立于内核）', () => {
  // 两个镜头：改镜头 1 的一行台词 -> 只有镜头 1 的 image/video/narration + 合成过期
  const g = S.prepared(S.loadStories().find((s) => s.id === 'edge-narration'));
  const [a, b] = O.shotsInOrder(g);
  const line = O.linesOf(g, a)[0];
  const after = K.applyTx(g, K.intents.script.rewriteLine(g, line, { text: '改' })).graph;
  assert.deepEqual(O.expectedStale(after), [...O.chainIds(after, a), 'compose_1'].sort());
  assert.deepEqual(K.staleSet(after), O.expectedStale(after));
  assert.deepEqual(O.chainIds(after, b).filter((id) => O.expectedStale(after).includes(id)), []);
});

// ---------- 套件抓到的内核缺陷：回归测试 ----------
test('回归：重排镜头必须让合成过期（compose 的 cacheKey 含镜头先后顺序）', () => {
  const g = S.prepared(S.loadStories().find((s) => s.id === 'edge-narration'));
  const grp = g.group_order[0];
  const ids = g.groups[grp].children.filter((c) => g.nodes[c].type === 'shot');
  const via = {
    reorderShots: K.intents.shot.reorderShots(g, grp, [ids[1], ids[0], ids[2]]),
    moveShotToGroup: K.intents.shot.moveShotToGroup(g, ids[0], grp, 1),
    moveSegment: K.intents.timeline.moveSegment(g, g.nodes.compose_1.params.segments.find((s) => s.shot_id === ids[0]).id, { after_segment_id: g.nodes.compose_1.params.segments.find((s) => s.shot_id === ids[1]).id }),
  };
  for (const [name, tx] of Object.entries(via)) {
    const r = K.applyTx(g, tx);
    assert.deepEqual(r.invalidated, ['compose_1'], `${name}: reordering shots changes the rendered video, so only compose becomes stale`);
    assert.deepEqual(K.staleSet(r.graph), ['compose_1']);
  }
  // 顺序不变（只是换了场景归属）时合成保持新鲜
  const g2 = S.prepared(S.loadStories().find((s) => s.id === 'edge-narration'));
  const last = g2.groups[g2.group_order[0]].children.filter((c) => g2.nodes[c].type === 'shot').slice(-1)[0];
  assert.deepEqual(K.applyTx(g2, K.intents.shot.moveShotToGroup(g2, last, g2.group_order[1], 0)).invalidated, []);
});

// ---------- 生成输入（参考图 / 尾帧 / 模型）进 cacheKey：预言机与内核各自推导 ----------
test('预言机会抓到：内核的 cacheKey 漏掉生成输入参数（参考图、尾帧、模型）', () => {
  const g = fresh();
  const T = O.shotsInOrder(g)[1];
  const c = O.chain(g, T);
  const edits = {
    'image.reference_hashes': K.intents.shot.setShotReferences(g, T, { reference_hashes: ['ref:a'] }),
    'video.tail_frame_hash': K.intents.shot.setShotReferences(g, T, { tail_frame_hash: 'tail:a' }),
    'image.model': K.intents.shot.setShotReferences(g, T, { image_model: 'm-a' }),
    'video.model': K.intents.shot.setShotReferences(g, T, { video_model: 'm-b' }),
  };
  for (const [name, tx] of Object.entries(edits)) {
    const after = K.applyTx(g, tx).graph;
    assert.ok(O.expectedStale(after).includes(c.video) && O.expectedStale(after).includes('compose_1'), `${name}: oracle sees the downstream go stale`);
    assert.deepEqual(K.staleSet(after), O.expectedStale(after), `${name}: kernel agrees with the oracle`);
    I.checkGraph(after);
    // 变异：假装内核的 cacheKey 不看这些参数（旧行为）——I5 必须报警
    const blind = (orig) => (x) => {
      const y = structuredClone(x);
      for (const n of Object.values(y.nodes)) for (const k of ['reference_hashes', 'tail_frame_hash']) delete n.params[k];
      for (const id of [c.image, c.video]) y.nodes[id].params.model = 'default';
      return orig(y);
    };
    withPatch('cacheKeys', blind, () => assert.throws(() => I.checkGraph(after), /I5/, `${name}: a kernel blind to generation inputs is caught`));
  }
});

test('setNodeParam / setShotReferences：校验与空事务', () => {
  const g = fresh();
  const T = O.shotsInOrder(g)[0];
  const c = O.chain(g, T);
  const { canvas, shot } = K.intents;
  for (const [label, fn] of Object.entries({
    'unknown param': () => canvas.setNodeParam(g, c.video, ['nope'], 1),
    'segments are not editable here': () => canvas.setNodeParam(g, O.composeNode(g), ['segments'], []),
    'bad seed type': () => canvas.setNodeParam(g, c.image, ['seed'], 'x'),
    'nested path': () => canvas.setNodeParam(g, c.image, ['model', 'x'], 'x'),
    'required param cannot be cleared': () => canvas.setNodeParam(g, c.image, ['model'], null),
    'bad hash list': () => canvas.setNodeParam(g, c.image, ['reference_hashes'], [1]),
    'param of another type': () => canvas.setNodeParam(g, c.image, ['tail_frame_hash'], 'x'),
    'missing node': () => canvas.setNodeParam(g, 'nope', ['seed'], 1),
    'bad line kind': () => canvas.setNodeParam(g, O.linesInOrder(g)[0], ['kind'], 'poem'),
    'shot without video node reference': () => shot.setShotReferences(g, 'nope', {}),
  })) assert.throws(fn, (e) => e instanceof K.KernelError && ['INTENT', 'NOT_FOUND'].includes(e.code), label);
  assert.equal(canvas.setNodeParam(g, c.image, ['seed'], g.nodes[c.image].params.seed).ops.length, 0, 'same value = empty tx');
  assert.equal(canvas.setNodeParam(g, c.image, ['seed'], 5, { tx_id: 'x' }).label, 'setNodeParam');
  // 设置再清除：回到与从未设置过完全相同的图（cacheKey 也相同）
  const set = K.applyTx(g, shot.setShotReferences(g, T, { reference_hashes: ['r'], tail_frame_hash: 't' })).graph;
  const back = K.applyTx(set, shot.setShotReferences(set, T, { reference_hashes: [], tail_frame_hash: null })).graph;
  assert.equal(K.toJSON(back), K.toJSON(g));
  assert.deepEqual(K.staleSet(back), []);
  // 镜头时长经 setNodeParam 与 setShotField 一致（片段联动）
  const d = g.nodes[T].params.duration_ms + 500;
  assert.equal(K.toJSON(K.applyTx(g, canvas.setNodeParam(g, T, ['duration_ms'], d, { tx_id: 'a' })).graph), K.toJSON(K.applyTx(g, shot.setShotField(g, T, { duration_ms: d }, { tx_id: 'a' })).graph));
});
