'use strict';
// 跨视图一致性：同一件事从不同视图做，结果是同一张图；来回切换不丢数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src');
const { fixtureGraph, adoptAll, apply, checkInvariants } = require('./helpers');

const { script, shot, timeline, canvas } = K.intents;
const projections = (g) => JSON.stringify([K.scriptView(g), K.shotView(g), K.timelineView(g)]);

test('改镜头顺序：分镜视图、时间线视图两种做法得到同一张图', () => {
  const g = adoptAll(fixtureGraph());
  const viaShots = apply(g, shot.reorderShots(g, 'grp_1', ['shot_2', 'shot_1']));
  const viaTimeline = apply(g, timeline.moveSegment(g, 'seg_1', { after_segment_id: 'seg_2' }));
  assert.equal(K.toJSON(viaShots), K.toJSON(viaTimeline));
  const viaMove = apply(g, shot.moveShotToGroup(g, 'shot_1', 'grp_1', 1));
  assert.equal(K.toJSON(viaMove), K.toJSON(viaShots));
  checkInvariants(viaShots);
});

test('改台词：剧本视图改、画布改参数（setParam）等价，其余视图都立刻跟上', () => {
  const g = fixtureGraph();
  const a = apply(g, script.rewriteLine(g, 'line_2', { text: '新旁白' }));
  const b = apply(g, { tx_id: 'raw', ops: [{ op: 'setParam', node: 'line_2', path: ['text'], value: '新旁白' }] });
  assert.equal(K.toJSON(a), K.toJSON(b));
  assert.equal(K.shotDialogue(a, 'shot_1'), '新旁白');
  assert.equal(K.timelineView(a).tracks[1].clips[0].text, '新旁白');
  assert.equal(K.canvasView(a).nodes.find((n) => n.id === 'line_2').params.text, '新旁白');
});

test('恒等编辑：每个视图做一次“什么也没改”的编辑，图不变（无损）', () => {
  const g = adoptAll(fixtureGraph());
  const seg = g.nodes.compose_1.params.segments[1];
  const identity = [
    script.rewriteLine(g, 'line_3', { text: g.nodes.line_3.params.text, speaker: g.nodes.line_3.params.speaker }),
    shot.setShotField(g, 'shot_2', { title: g.nodes.shot_2.params.title, duration_ms: g.nodes.shot_2.params.duration_ms }),
    shot.reorderShots(g, 'grp_1', ['shot_1', 'shot_2']),
    shot.moveShotToGroup(g, 'shot_2', 'grp_1', 1),
    timeline.trimSegment(g, seg.id, { in_ms: seg.in_ms, out_ms: seg.out_ms }),
    timeline.moveSegment(g, seg.id, { gap_before_ms: seg.gap_before_ms }),
    script.reorderLines(g, 'grp_1', ['line_1', 'line_2', 'line_3', 'line_4']),
    canvas.connectNodes(g, 'shot_1', 'img_1'),
  ];
  for (const tx of identity) {
    const r = K.applyTx(g, tx);
    assert.equal(K.toJSON(r.graph), K.toJSON(g), tx.label);
    assert.deepEqual(r.invalidated, [], tx.label);
  }
});

test('来回一圈：剧本 -> 生成分镜 -> 时间线 -> 画布，再回到剧本，数据无损', () => {
  const text = '# 雨夜\n旁白一句。\n阿宁：你来了。\n△阿宁收伞\n# 清晨\n老周：该走了。';
  let g = K.buildGraphFromScript('p', text);
  assert.equal(K.nodesOfType(g, 'shot').length, 0);
  const lines = K.lineOrder(g);
  assert.deepEqual(lines.map((l) => g.nodes[l].params.kind), ['scene_heading', 'narration', 'dialogue', 'action', 'scene_heading', 'dialogue']);
  const scriptBefore = JSON.stringify(K.scriptView(g).groups.map((x) => x.lines.map(({ id, kind, speaker, text: t }) => [id, kind, speaker, t])));

  // 剧本视图 -> 分镜：外部“生成分镜”给出镜头，内核只负责落图
  g = apply(g, shot.addShot(g, { group: 'grp_1', params: { title: 'S1', duration_ms: 4000 }, lines: [lines[1], lines[2]] }));
  g = apply(g, shot.addShot(g, { group: 'grp_1', params: { title: 'S2', duration_ms: 3000 }, lines: [lines[3]] }));
  g = apply(g, shot.addShot(g, { group: 'grp_2', params: { title: 'S3', duration_ms: 2000 }, lines: [lines[5]] }));
  checkInvariants(g);
  g = adoptAll(g);
  // 时间线：裁剪 + 切分 + 跨镜头移动
  g = apply(g, timeline.trimSegment(g, 'seg_1', { in_ms: 500 }));
  g = apply(g, timeline.splitSegment(g, 'seg_1', 2000));
  g = apply(g, timeline.moveSegment(g, 'seg_2', { after_segment_id: 'seg_3' }));
  checkInvariants(g);
  // 画布：移动、连线
  g = apply(g, canvas.moveNode(g, 'shot_2', { x: 300, y: 300 }));
  g = apply(g, canvas.connectNodes(g, lines[4], 'shot_3', { port: 'lines' }));
  checkInvariants(g);
  // 回到剧本视图：剧本的行内容（不含新增的关联）完全没变
  const scriptAfter = JSON.stringify(K.scriptView(g).groups.map((x) => x.lines.map(({ id, kind, speaker, text: t }) => [id, kind, speaker, t])));
  assert.equal(scriptAfter, scriptBefore);
  assert.ok(K.scriptView(g).groups[1].lines[0].shot_ids.includes('shot_3'));
});

test('多视图会话：所有视图的编辑可以按事务整体撤销重做，投影逐字节还原', () => {
  const g0 = adoptAll(fixtureGraph());
  const h = K.createHistory(g0);
  const snaps = [projections(g0)];
  const steps = [
    (x) => script.rewriteLine(x, 'line_5', { text: '天快亮了。' }),
    (x) => shot.splitShot(x, 'shot_4', 1),
    (x) => timeline.trimSegment(x, 'seg_2', { out_ms: 3000 }),
    (x) => canvas.moveNode(x, 'shot_1', { x: 1, y: 2 }),
    (x) => shot.reorderShots(x, 'grp_1', ['shot_2', 'shot_1']),
    (x) => canvas.deleteNode(x, 'img_3'),
    (x) => shot.regenerateShot(x, 'shot_3'),
  ];
  for (const s of steps) { h.apply(s(h.graph)); checkInvariants(h.graph); snaps.push(projections(h.graph)); }
  for (let i = steps.length - 1; i >= 0; i--) { h.undo(); assert.equal(projections(h.graph), snaps[i], `undo to ${i}`); }
  for (let i = 0; i < steps.length; i++) { h.redo(); assert.equal(projections(h.graph), snaps[i + 1], `redo to ${i + 1}`); }
});
