'use strict';
// I2：真实片长（video 采用版本 metadata.duration_ms）与词级字幕块（narration 版本 metadata.cues）只影响投影，不改存储。
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src');
const { fixtureGraph, apply } = require('./helpers');

const I = K.intents;
const track = (tv, kind) => tv.tracks.find((t) => t.kind === kind);
const record = (g, node, extra) => apply(g, I.shot.recordGeneration(g, node, extra));

test('recordGeneration 保存 metadata；没有 metadata 时版本不带该字段', () => {
  let g = fixtureGraph();
  const vid = K.partsOfShot(g, 'shot_1').video;
  g = record(g, vid, { asset: { ref: 'a.mp4', hash: 'h', kind: 'video' } });
  assert.equal('metadata' in K.adoptedVersion(g, vid), false);
  const vid2 = K.partsOfShot(g, 'shot_2').video;
  g = record(g, vid2, { asset: { ref: 'b.mp4', hash: 'h2', kind: 'video' }, metadata: { duration_ms: 3000 } });
  assert.equal(K.adoptedVersion(g, vid2).metadata.duration_ms, 3000);
});

test('真实片长：未裁剪片段随真实时长伸缩，后面的镜头顺延；存储的目标时长与 segments 不变', () => {
  const g = fixtureGraph(); // shot_1 目标 4000
  const vid = K.partsOfShot(g, 'shot_1').video;
  for (const real of [2500, 4600]) {
    const g2 = record(g, vid, { asset: { ref: 'a.mp4', hash: `h${real}`, kind: 'video' }, metadata: { duration_ms: real } });
    const clips = track(K.timelineView(g2), 'video').clips;
    assert.equal(clips[0].duration_ms, real);
    assert.equal(clips[0].src_out_ms, real);
    assert.equal(clips[1].start_ms, real);
    assert.equal(K.timelineView(g2).duration_ms, K.timelineView(g).duration_ms - 4000 + real);
    assert.deepEqual(K.segmentsOfShot(g2, 'shot_1'), K.segmentsOfShot(g, 'shot_1'));
    assert.equal(g2.nodes.shot_1.params.duration_ms, 4000);
  }
});

test('真实片长：被裁过的片段裁到真实时长以内，不会超出素材', () => {
  let g = fixtureGraph();
  const seg = K.segmentsOfShot(g, 'shot_2')[0]; // 目标 6000
  g = apply(g, I.timeline.trimSegment(g, seg.id, { in_ms: 1000, out_ms: 5000 }));
  const vid = K.partsOfShot(g, 'shot_2').video;
  g = record(g, vid, { asset: { ref: 'b.mp4', hash: 'x', kind: 'video' }, metadata: { duration_ms: 3000 } });
  const c = track(K.timelineView(g), 'video').clips.find((x) => x.id === seg.id);
  assert.deepEqual([c.src_in_ms, c.src_out_ms, c.duration_ms], [1000, 3000, 2000]);
});

test('非法的 metadata.duration_ms（0、负数、小数、字符串）一律忽略，退回目标时长', () => {
  for (const bad of [0, -5, 1.5, '3000', null]) {
    let g = fixtureGraph();
    const vid = K.partsOfShot(g, 'shot_1').video;
    g = record(g, vid, { asset: { ref: 'a.mp4', hash: 'h', kind: 'video' }, metadata: { duration_ms: bad } });
    assert.equal(track(K.timelineView(g), 'video').clips[0].duration_ms, 4000, String(bad));
  }
});

test('词级字幕块：旁白新鲜时按块出多条字幕；行文字一改退回整镜单条文字字幕；cues 不进 params', () => {
  let g = fixtureGraph();
  const nar = K.partsOfShot(g, 'shot_2').narration;
  const cues = [{ start_ms: 0, end_ms: 800, text: '你还是' }, { start_ms: 900, end_ms: 1500, text: '来了' }];
  g = record(g, nar, { asset: { ref: 'n.mp3', hash: 'n1', kind: 'audio' }, metadata: { duration_ms: 1500, cues } });
  let tv = K.timelineView(g);
  const start = track(tv, 'video').clips.find((c) => c.storyboard_id === 102).start_ms;
  let subs = track(tv, 'subtitle').clips.filter((c) => c.storyboard_id === 102);
  assert.deepEqual(subs.map((c) => [c.id, c.start_ms, c.duration_ms, c.text]), [
    ['sub_shot_2_1', start, 800, '你还是'], ['sub_shot_2_2', start + 900, 600, '来了'],
  ]);
  assert.equal(track(tv, 'narration').clips.find((c) => c.storyboard_id === 102).duration_ms, 1500);
  assert.ok(!JSON.stringify(g.nodes.shot_2.params).includes('你还是来'));

  g = apply(g, I.script.rewriteLine(g, 'line_3', { text: '你终于来了。' }));
  tv = K.timelineView(g);
  subs = track(tv, 'subtitle').clips.filter((c) => c.storyboard_id === 102);
  assert.deepEqual(subs.map((c) => [c.id, c.text]), [['sub_shot_2', '你终于来了。']]);
});

test('字幕块超出镜头时间的部分被夹到镜头范围内', () => {
  let g = fixtureGraph();
  const nar = K.partsOfShot(g, 'shot_1').narration; // 目标 4000
  g = record(g, nar, { asset: { ref: 'n.mp3', hash: 'n2', kind: 'audio' }, metadata: { cues: [{ start_ms: 3500, end_ms: 9000, text: '雨下了一整夜' }, { start_ms: 8000, end_ms: 9000, text: '越界' }] } });
  const subs = track(K.timelineView(g), 'subtitle').clips.filter((c) => c.storyboard_id === 101);
  assert.deepEqual(subs.map((c) => [c.start_ms, c.duration_ms]), [[3500, 500]]);
});
