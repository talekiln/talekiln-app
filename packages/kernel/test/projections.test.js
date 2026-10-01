'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src');
const { fixtureGraph, adoptAll, apply, checkInvariants } = require('./helpers');
// F02 现有时间线校验器（测试里跨包引用，仅用于证明 timelineView 与 F02 同形）
const { validateTimeline, TRACK_KINDS } = require('../../local/src/timeline/service');

const I = K.intents;
const track = (tv, kind) => tv.tracks.find((t) => t.kind === kind);

test('scriptView：场景组 -> 有序行，每行带关联镜头', () => {
  const v = K.scriptView(fixtureGraph());
  assert.equal(v.groups.length, 2);
  assert.equal(v.groups[0].title, '雨夜');
  assert.deepEqual(v.groups[0].lines.map((l) => l.id), ['line_1', 'line_2', 'line_3', 'line_4']);
  assert.deepEqual(v.groups[0].lines[2], { id: 'line_3', kind: 'dialogue', speaker: '阿宁', text: '你还是来了。', shot_ids: ['shot_2'] });
  assert.deepEqual(v.groups[1].lines.map((l) => l.shot_ids), [['shot_3'], ['shot_4'], ['shot_4']]);
});

test('shotView：对白来自行、状态 none/stale/fresh、用时来自片段、带 cacheKey 摘要与 sceneKey', () => {
  let g = fixtureGraph();
  let s = K.shotView(g).groups[0].shots[1];
  assert.equal(s.dialogue, '你还是来了。');
  assert.equal(s.legacy_id, 102);
  assert.deepEqual([s.planned_ms, s.used_ms, s.segment_count], [6000, 6000, 1]);
  assert.deepEqual([s.image, s.video, s.narration], ['none', 'none', 'none']);
  assert.match(s.keys.video, /^[0-9a-f]{12}$/);
  assert.match(s.scene_key, /^[0-9a-f]{64}$/);
  g = adoptAll(g);
  assert.equal(K.shotView(g).groups[0].shots[1].video, 'fresh');
  g = apply(g, I.shot.regenerateShot(g, 'shot_2', { targets: ['video'] }));
  s = K.shotView(g).groups[0].shots[1];
  assert.deepEqual([s.image, s.video, s.narration], ['fresh', 'stale', 'fresh']);
  g = apply(g, I.timeline.trimSegment(g, 'seg_2', { in_ms: 1000, out_ms: 4000 }));
  s = K.shotView(g).groups[0].shots[1];
  assert.deepEqual([s.planned_ms, s.used_ms], [6000, 3000]);
  assert.equal(s.params.title, '阿宁近景'); // params 是副本
  s.params.title = 'x';
  assert.equal(g.nodes.shot_2.params.title, '阿宁近景');
});

test('timelineView：F02 同形，通过 F02 校验器；毫秒整数；storyboard_id = legacy_id', () => {
  const g = adoptAll(fixtureGraph());
  const tv = K.timelineView(g);
  assert.deepEqual(tv.tracks.map((t) => t.kind), TRACK_KINDS);
  assert.doesNotThrow(() => validateTimeline({ tracks: tv.tracks }));
  assert.equal(tv.duration_ms, 18000);
  const v = track(tv, 'video').clips;
  assert.deepEqual(v.map((c) => [c.start_ms, c.duration_ms, c.storyboard_id]), [[0, 4000, 101], [4000, 6000, 102], [10000, 3000, 103], [13000, 5000, 104]]);
  assert.deepEqual(Object.keys(v[0]).sort(), ['asset_kind', 'asset_ref', 'duration_ms', 'id', 'src_in_ms', 'src_out_ms', 'start_ms', 'storyboard_id', 'style', 'text', 'volume'].sort());
  assert.equal(v[0].asset_kind, 'video');
  const sub = track(tv, 'subtitle').clips;
  assert.deepEqual(sub.map((c) => [c.start_ms, c.duration_ms, c.text]), [
    [0, 4000, '雨下了一整夜。'], [4000, 6000, '你还是来了。'], [10000, 3000, '天亮了。'], [13000, 5000, '该走了。\n再等等。'],
  ]);
  const nar = track(tv, 'narration').clips;
  assert.equal(nar.length, 4);
  assert.deepEqual([nar[1].start_ms, nar[1].duration_ms, nar[1].src_in_ms, nar[1].src_out_ms, nar[1].asset_kind], [4000, 6000, 0, 6000, 'audio']);
  for (const k of ['video', 'subtitle', 'narration', 'music']) for (const c of track(tv, k).clips) for (const f of ['start_ms', 'duration_ms']) assert.ok(Number.isInteger(c[f]));
});

test('timelineView：确定性（同图同输出）、不含随机 id；无资产时 src 为 null 且仍通过 F02 校验', () => {
  const g = fixtureGraph();
  assert.equal(JSON.stringify(K.timelineView(g)), JSON.stringify(K.timelineView(K.cloneGraph(g))));
  const tv = K.timelineView(g);
  assert.doesNotThrow(() => validateTimeline({ tracks: tv.tracks }));
  assert.equal(track(tv, 'video').clips[0].asset_ref, null);
  assert.equal(track(tv, 'video').clips[0].src_in_ms, null);
  assert.equal(track(tv, 'narration').clips.length, 0); // 没有配音资产就没有配音片段
});

test('timelineView：只有图片资产时 asset_kind 为 image；gap、转场、音乐、裁剪、切分都体现', () => {
  let g = fixtureGraph();
  g = apply(g, I.shot.recordGeneration(g, 'img_1', { version_id: 'i1', asset: { ref: 'a.png', hash: 'ha' } }));
  g = apply(g, I.timeline.moveSegment(g, 'seg_2', { gap_before_ms: 250 }));
  g = apply(g, I.timeline.setTransition(g, 'seg_2', 'fade'));
  g = apply(g, I.timeline.splitSegment(g, 'seg_3', 1000));
  g = apply(g, I.timeline.addMusic(g, { id: 'm1', asset_ref: 'bgm.mp3', start_ms: 500, duration_ms: 2000, src_in_ms: 100, volume: 0.3 }));
  const tv = K.timelineView(g);
  assert.doesNotThrow(() => validateTimeline({ tracks: tv.tracks }));
  const v = track(tv, 'video').clips;
  assert.equal(v[0].asset_kind, 'image');
  assert.equal(v[1].start_ms, 4250);
  assert.deepEqual(v[1].style, { transition: 'fade' });
  assert.deepEqual(v.slice(2, 4).map((c) => [c.start_ms, c.duration_ms]), [[10250, 1000], [11250, 2000]]);
  assert.deepEqual(track(tv, 'music').clips[0], {
    id: 'm1', start_ms: 500, duration_ms: 2000, src_in_ms: 100, src_out_ms: 2100, asset_ref: 'bgm.mp3', asset_kind: 'audio',
    storyboard_id: null, volume: 0.3, text: null, style: null,
  });
  // 字幕按镜头：切分后的镜头字幕覆盖它的全部片段
  const sub = track(tv, 'subtitle').clips.find((c) => c.storyboard_id === 103);
  assert.deepEqual([sub.start_ms, sub.duration_ms], [10250, 3000]);
  checkInvariants(g);
});

test('timelineView：字幕样式覆盖来自 compose.subtitle_overrides（按镜头首个有声行）', () => {
  let g = fixtureGraph();
  g = apply(g, { tx_id: 'ov', ops: [{ op: 'setParam', node: 'compose_1', path: ['subtitle_overrides', 'line_3'], value: { color: '#ff0' } }] });
  const sub = track(K.timelineView(g), 'subtitle').clips.find((c) => c.storyboard_id === 102);
  assert.deepEqual(sub.style, { color: '#ff0' });
});

test('timelineView：没有 compose 时是四条空轨', () => {
  const g = K.buildGraph({ scenes: [{ title: 'a', lines: [{ text: 'x' }], shots: [{ lines: [0] }] }], compose: false });
  const tv = K.timelineView(g);
  assert.equal(tv.duration_ms, 0);
  assert.deepEqual(tv.tracks.map((t) => t.clips.length), [0, 0, 0, 0]);
  checkInvariants(g);
});

test('canvasView：节点含 layout（缺省为确定性自动布局）与过期标记，分组带摘要', () => {
  let g = adoptAll(fixtureGraph());
  g = apply(g, I.script.rewriteLine(g, 'line_3', { text: '改' }));
  g = apply(g, I.canvas.moveNode(g, 'shot_1', { x: 7, y: 8 }));
  const cv = K.canvasView(g);
  const n = (id) => cv.nodes.find((x) => x.id === id);
  assert.deepEqual(n('shot_1').layout, { x: 7, y: 8 });
  assert.equal(n('shot_1').layout_auto, false);
  assert.equal(n('shot_2').layout_auto, true);
  assert.deepEqual(n('line_1').layout, { x: 0, y: 0 });
  assert.equal(n('vid_2').stale, true);
  assert.equal(n('vid_2').state, 'stale');
  assert.equal(n('vid_1').stale, false);
  assert.equal(n('shot_1').state, 'source');
  assert.equal(cv.edges.length, g.edges.length);
  assert.deepEqual(cv.groups[0].summary, { lines: 4, shots: 2, stale: 3 }); // shot_2 的 image/video/narration
  assert.deepEqual(cv.groups[1].summary, { lines: 3, shots: 2, stale: 0 });
  assert.equal(JSON.stringify(K.canvasView(g)), JSON.stringify(K.canvasView(K.cloneGraph(g))));
});

test('toLegacyRows：storyboards 行与 timeline', () => {
  let g = adoptAll(fixtureGraph());
  g = apply(g, I.shot.regenerateShot(g, 'shot_2', { targets: ['video'] }));
  const rows = K.toLegacyRows(g);
  assert.equal(rows.storyboards.length, 4);
  const r2 = rows.storyboards[1];
  assert.equal(r2.legacy_id, 102);
  assert.equal(r2.storyboard_number, 2);
  assert.equal(r2.duration, 6);
  assert.equal(r2.dialogue, '你还是来了。');
  assert.equal(r2.action, '阿宁收起伞。');
  assert.equal(r2.title, '阿宁近景');
  assert.equal(r2.scene_title, '雨夜');
  assert.equal(r2.status, 'draft'); // video 已过期
  assert.equal(rows.storyboards[0].status, 'completed');
  assert.equal(rows.storyboards[0].video_url, 'asset/vid_1.bin');
  assert.equal(r2.characters, '[]');
  assert.deepEqual(rows.timeline, K.timelineView(g));
  assert.equal(rows.storyboards.map((x) => x.storyboard_number).join(), '1,2,3,4');
});
