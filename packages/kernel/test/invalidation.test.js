'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src');
const { fixtureGraph, adoptAll, apply } = require('./helpers');

const I = K.intents;

test('cacheKey：确定性、64 位十六进制、同输入同 key', () => {
  const a = fixtureGraph();
  const b = fixtureGraph();
  const ka = K.cacheKeys(a);
  assert.deepEqual(ka, K.cacheKeys(b));
  for (const k of Object.values(ka)) assert.match(k, /^[0-9a-f]{64}$/);
});

test('cacheKey 不含 layout 与 legacy_id', () => {
  const g = fixtureGraph();
  const moved = apply(g, I.canvas.moveNode(g, 'shot_1', { x: 99, y: 99 }));
  assert.deepEqual(K.cacheKeys(moved), K.cacheKeys(g));
  const withLegacy = K.cloneGraph(g);
  withLegacy.nodes.shot_1.legacy_id = 12345;
  assert.deepEqual(K.cacheKeys(withLegacy), K.cacheKeys(g));
});

test('改行文字：只波及所属镜头的 image/video/narration 与 compose', () => {
  const g = fixtureGraph();
  const t = I.script.rewriteLine(g, 'line_6', { text: '改了' });
  const g2 = apply(g, t);
  const k1 = K.cacheKeys(g);
  const k2 = K.cacheKeys(g2);
  const changed = Object.keys(k1).filter((id) => k1[id] !== k2[id]).sort();
  assert.deepEqual(changed, ['compose_1', 'img_4', 'line_6', 'nar_4', 'shot_4', 'vid_4'].sort());
});

test('配音 key 只依赖镜头的行与自身参数：改画面提示词不使配音过期', () => {
  const g = adoptAll(fixtureGraph());
  const g2 = apply(g, I.shot.setShotField(g, 'shot_1', { image_prompt: '新的画面' }));
  const stale = K.staleSet(g2);
  assert.ok(stale.includes('img_1') && stale.includes('vid_1'));
  assert.ok(!stale.includes('nar_1'));
  const g3 = apply(g, I.shot.setVoice(g, 'shot_1', { voice: 'warm' }));
  assert.deepEqual(K.staleSet(g3), ['compose_1', 'nar_1']);
});

test('行顺序影响 key（对白拼接顺序），行内关联集合不变时 reorder 会让镜头下游过期', () => {
  const g = adoptAll(fixtureGraph());
  const g2 = apply(g, I.script.reorderLines(g, 'grp_2', ['line_5', 'line_7', 'line_6']));
  // line_6、line_7 属 shot_4，相对顺序对调，对白文字顺序也变：shot_4 下游过期
  assert.deepEqual(K.staleSet(g2), ['compose_1', 'img_4', 'nar_4', 'vid_4']);
});

test('过期 = 没有采用版本，或采用版本的 cacheKey != 当前 key', () => {
  const g = fixtureGraph();
  assert.equal(K.nodeState(g, 'vid_1'), 'none');
  assert.ok(K.staleSet(g).includes('vid_1'));
  const g2 = adoptAll(g);
  assert.equal(K.nodeState(g2, 'vid_1'), 'fresh');
  assert.equal(K.nodeState(g2, 'shot_1'), 'source');
  const g3 = apply(g2, I.shot.regenerateShot(g2, 'shot_1', { targets: ['video'] }));
  assert.equal(K.nodeState(g3, 'vid_1'), 'stale');
  assert.equal(K.nodeState(g3, 'img_1'), 'fresh'); // 只换视频种子，图片不动
});

test('regenerateShot 保留旧版本并可换回（撤销后恢复为 fresh）', () => {
  const g = adoptAll(fixtureGraph());
  const t = I.shot.regenerateShot(g, 'shot_2', {});
  const r = K.applyTx(g, t);
  assert.equal(r.graph.versions.vid_2.length, 1); // 旧版本还在
  assert.ok(r.invalidated.includes('vid_2') && r.invalidated.includes('img_2'));
  const back = K.applyTx(r.graph, { tx_id: 'u', ops: r.inverse });
  assert.deepEqual(back.revalidated, r.invalidated);
});

test('recordGeneration 后 fresh；采用旧版本：key 对不上则仍是 stale', () => {
  let g = adoptAll(fixtureGraph());
  g = apply(g, I.shot.regenerateShot(g, 'shot_1', { targets: ['video'] }));
  assert.equal(K.nodeState(g, 'vid_1'), 'stale');
  g = apply(g, I.shot.recordGeneration(g, 'vid_1', { version_id: 'v_new', asset: { ref: 'new.mp4', hash: 'hnew' } }));
  assert.equal(K.nodeState(g, 'vid_1'), 'fresh');
  const old = g.versions.vid_1.find((v) => v.id !== 'v_new').id;
  g = apply(g, { tx_id: 'adopt-old', ops: [{ op: 'adoptVersion', node: 'vid_1', version_id: old }] });
  assert.equal(K.nodeState(g, 'vid_1'), 'stale');
});

test('trim 只让 compose 过期，不让 video/narration 过期；sceneKey 只变被裁镜头', () => {
  const g = adoptAll(fixtureGraph());
  const before = Object.fromEntries(K.shotOrder(g).map((s) => [s, K.sceneKey(g, s)]));
  const g2 = apply(g, I.timeline.trimSegment(g, 'seg_2', { in_ms: 1000 }));
  assert.deepEqual(K.staleSet(g2), ['compose_1']);
  const after = Object.fromEntries(K.shotOrder(g2).map((s) => [s, K.sceneKey(g2, s)]));
  for (const s of K.shotOrder(g)) assert.equal(after[s] !== before[s], s === 'shot_2');
});

test('sceneKey：含 video/narration 资产 hash、片段 in/out、烧进画面的字幕文字与样式；不含音乐、gap、转场（G02 不渲染转场）、位置', () => {
  const g = adoptAll(fixtureGraph());
  const base = K.sceneKey(g, 'shot_3');
  const withMusic = apply(g, I.timeline.addMusic(g, { asset_ref: 'm.mp3', start_ms: 0, duration_ms: 1000 }));
  assert.equal(K.sceneKey(withMusic, 'shot_3'), base);
  const gap = apply(g, I.timeline.moveSegment(g, 'seg_3', { gap_before_ms: 700 }));
  assert.equal(K.sceneKey(gap, 'shot_3'), base);
  const tr = apply(g, I.timeline.setTransition(g, 'seg_3', 'fade'));
  assert.equal(K.sceneKey(tr, 'shot_3'), base, 'G02 plan.rs does not read transitions');
  const line = K.linesOfShot(g, 'shot_3').find((l) => K.SPOKEN_KINDS.includes(g.nodes[l].params.kind));
  const text = apply(g, I.script.rewriteLine(g, line, { text: '改过的字幕' }));
  assert.notEqual(K.sceneKey(text, 'shot_3'), base, 'subtitles are burned in: text edit changes the scene');
  assert.equal(K.sceneKey(text, 'shot_1'), K.sceneKey(g, 'shot_1'));
  const style = apply(g, { tx_id: 'style', ops: [{ op: 'setParam', node: 'compose_1', path: ['subtitle_overrides'], value: { [line]: { font_size: 44 } } }] });
  assert.notEqual(K.sceneKey(style, 'shot_3'), base, 'subtitle style is part of the scene');
  const newAsset = apply(g, I.shot.recordGeneration(g, 'nar_3', { version_id: 'n2', asset: { ref: 'n2.mp3', hash: 'other' } }));
  assert.notEqual(K.sceneKey(newAsset, 'shot_3'), base);
  const newVideo = apply(g, I.shot.recordGeneration(g, 'vid_3', { version_id: 'v2', asset: { ref: 'v2.mp4', hash: 'other' } }));
  assert.notEqual(K.sceneKey(newVideo, 'shot_3'), base);
  assert.equal(K.sceneKey(newVideo, 'shot_1'), K.sceneKey(g, 'shot_1'));
});

test('diffStale 只统计前后都存在的生成节点', () => {
  const snap = (stale, keys, types) => ({ stale, keys, types });
  const d = K.diffStale(
    snap(['a'], { a: 1, b: 1, c: 1 }, { a: 'image', b: 'image', c: 'shot' }),
    snap(['b', 'c'], { a: 1, b: 1, c: 1 }, { a: 'image', b: 'image', c: 'shot' }),
  );
  assert.deepEqual(d, { invalidated: ['b'], revalidated: ['a'] });
});
