'use strict';
const assert = require('node:assert/strict');
const K = require('../src');

/** 确定性夹具：两个场景、7 行、4 个镜头（手写，非真实 AI 输出）。 */
function fixtureGraph() {
  return K.buildGraph({
    project_id: 'p1',
    scenes: [
      {
        title: '雨夜',
        lines: [
          { kind: 'scene_heading', text: '雨夜 · 街角' },
          { kind: 'narration', text: '雨下了一整夜。' },
          { kind: 'dialogue', speaker: '阿宁', text: '你还是来了。' },
          { kind: 'action', text: '阿宁收起伞。' },
        ],
        shots: [
          { title: '街角全景', duration_ms: 4000, legacy_id: 101, lines: [0, 1] },
          { title: '阿宁近景', duration_ms: 6000, legacy_id: 102, lines: [2, 3] },
        ],
      },
      {
        title: '清晨',
        lines: [
          { kind: 'narration', text: '天亮了。' },
          { kind: 'dialogue', speaker: '老周', text: '该走了。' },
          { kind: 'dialogue', speaker: '阿宁', text: '再等等。' },
        ],
        shots: [
          { title: '窗外', duration_ms: 3000, legacy_id: 103, lines: [0] },
          { title: '对话', duration_ms: 5000, legacy_id: 104, lines: [1, 2] },
        ],
      },
    ],
  });
}

/** 全部节点都采用当前版本（每个生成节点各记一次），得到“全新鲜”的图。 */
function adoptAll(g) {
  let cur = g;
  for (const id of K.staleSet(g)) {
    const t = K.intents.shot.recordGeneration(cur, id, { asset: { ref: `asset/${id}.bin`, hash: `h-${id}`, kind: cur.nodes[id].type } }, { tx_id: `gen:${id}` });
    cur = K.applyTx(cur, t).graph;
  }
  return cur;
}

function apply(g, tx) { return K.applyTx(g, tx).graph; }

/** 四视图一致性不变量（对应设计文档 I1–I3、I5 的内核层部分）。返回 void，失败抛断言。 */
function checkInvariants(g) {
  K.validateGraph(g);
  const shots = K.shotOrder(g);
  const lines = K.lineOrder(g);
  const sv = K.shotView(g);
  const scv = K.scriptView(g);
  const cv = K.canvasView(g);
  const tv = K.timelineView(g);

  // I1：每个镜头在 shotView / canvasView 各出现一次且顺序一致；有 compose 时在 timelineView 也如此
  assert.deepEqual(sv.groups.flatMap((x) => x.shots.map((s) => s.id)), shots);
  assert.deepEqual(cv.nodes.filter((n) => n.type === 'shot').map((n) => n.id).sort(), [...shots].sort());
  assert.equal(new Set(cv.nodes.map((n) => n.id)).size, cv.nodes.length);
  const cid = K.composeId(g);
  if (cid) {
    const video = tv.tracks.find((t) => t.kind === 'video').clips;
    const segShots = K.nodesOfType(g, 'compose').length ? video.map((c) => g.nodes[cid].params.segments.find((s) => s.id === c.id).shot_id) : [];
    const dedup = segShots.filter((s, i) => segShots.indexOf(s) === i);
    assert.deepEqual(dedup, shots, 'timeline shot order == shot order');
    assert.equal(video.length, g.nodes[cid].params.segments.length);
  } else {
    assert.equal(tv.duration_ms, 0);
  }
  // I2：每行在 scriptView 一次；镜头对白 = 关联行文字拼接
  assert.deepEqual(scv.groups.flatMap((x) => x.lines.map((l) => l.id)), lines);
  for (const gs of sv.groups) {
    for (const s of gs.shots) {
      const spoken = K.linesOfShot(g, s.id).filter((l) => K.SPOKEN_KINDS.includes(g.nodes[l].params.kind)).map((l) => g.nodes[l].params.text).join('\n');
      assert.equal(s.dialogue, spoken);
    }
  }
  for (const gl of scv.groups) for (const l of gl.lines) for (const sid of l.shot_ids) assert.ok(K.linesOfShot(g, sid).includes(l.id));
  // I3：时间线总时长 = 视频轨片段与 gap 之和（音乐可能更长，取最大）
  if (cid) {
    const segs = g.nodes[cid].params.segments;
    const sum = segs.reduce((a, s) => a + s.gap_before_ms + (s.out_ms - s.in_ms), 0);
    const musicEnd = (g.nodes[cid].params.music || []).reduce((a, m) => Math.max(a, m.start_ms + m.duration_ms), 0);
    assert.equal(tv.duration_ms, Math.max(sum, musicEnd));
  }
  // I5：序列化再重建后从零计算，与原图一致
  const rebuilt = K.fromJSON(K.toJSON(g));
  assert.deepEqual(K.staleSet(rebuilt), K.staleSet(g));
  assert.deepEqual(K.cacheKeys(rebuilt), K.cacheKeys(g));
  assert.equal(JSON.stringify(K.timelineView(rebuilt)), JSON.stringify(tv));
}

/** mulberry32 种子随机数 */
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = { next, int: (n) => Math.floor(next() * n), pick: (arr) => arr[Math.floor(next() * arr.length)] };
  r.shuffle = (arr) => { const a2 = [...arr]; for (let i = a2.length - 1; i > 0; i--) { const j = r.int(i + 1); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; };
  return r;
}

module.exports = { fixtureGraph, adoptAll, apply, checkInvariants, prng };
