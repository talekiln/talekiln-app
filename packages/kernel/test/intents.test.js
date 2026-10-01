'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src');
const { fixtureGraph, adoptAll, checkInvariants } = require('./helpers');

const { script, shot, timeline, canvas } = K.intents;

/** 应用 tx：校验四视图不变量；逆 op 撤销后与原图逐字节相同；意图不改传入的图。 */
function run(g, tx) {
  const snap = K.toJSON(g);
  const r = K.applyTx(g, tx);
  assert.equal(K.toJSON(g), snap, 'intent/applyTx must not mutate the input graph');
  checkInvariants(r.graph);
  const back = K.applyTx(r.graph, { tx_id: `u-${tx.tx_id}`, ops: r.inverse }).graph;
  assert.equal(K.toJSON(back), snap, `undo of ${tx.label}`);
  return r;
}

test('意图只产出 Tx，tx_id 默认唯一，可指定', () => {
  const g = fixtureGraph();
  const a = script.rewriteLine(g, 'line_1', { text: 'x' });
  const b = script.rewriteLine(g, 'line_1', { text: 'x' });
  assert.notEqual(a.tx_id, b.tx_id);
  assert.equal(script.rewriteLine(g, 'line_1', { text: 'x' }, { tx_id: 'fixed' }).tx_id, 'fixed');
  assert.deepEqual(Object.keys(a).sort(), ['label', 'ops', 'tx_id']);
});

// ---------- 剧本 ----------

test('剧本：rewriteLine 改台词，镜头对白/字幕随之变化，无需任何拷贝', () => {
  const g = fixtureGraph();
  const r = run(g, script.rewriteLine(g, 'line_3', { text: '你来晚了。', speaker: '小宁' }));
  assert.equal(K.shotView(r.graph).groups[0].shots[1].dialogue, '你来晚了。');
  const sub = K.timelineView(r.graph).tracks.find((t) => t.kind === 'subtitle').clips.find((c) => c.storyboard_id === 102);
  assert.equal(sub.text, '你来晚了。');
  assert.equal(r.graph.nodes.line_3.params.speaker, '小宁');
  assert.equal(script.rewriteLine(g, 'line_3', { text: g.nodes.line_3.params.text }).ops.length, 0); // 无变化 = 空事务
  assert.throws(() => script.rewriteLine(g, 'line_3', { kind: 'zzz' }), { code: 'INTENT' });
  assert.throws(() => script.rewriteLine(g, 'shot_1', { text: 'x' }), { code: 'INTENT' });
});

test('剧本：insertLine 按行序号插入并挂镜头；deleteLine 级联', () => {
  const g = fixtureGraph();
  const r = run(g, script.insertLine(g, { group: 'grp_1', index: 1, kind: 'dialogue', speaker: '路人', text: '借过。', shot_ids: ['shot_1'] }));
  const lines = K.scriptView(r.graph).groups[0].lines;
  assert.equal(lines[1].text, '借过。');
  assert.deepEqual(lines[1].shot_ids, ['shot_1']);
  assert.equal(K.shotView(r.graph).groups[0].shots[0].dialogue, '借过。\n雨下了一整夜。');
  const end = run(g, script.insertLine(g, { group: 'grp_2', text: '尾', kind: 'narration' }));
  assert.equal(K.lineOrder(end.graph).at(-1), 'line_8');
  const del = run(r.graph, script.deleteLine(r.graph, 'line_8'));
  assert.ok(!del.graph.nodes.line_8);
});

test('剧本：splitLine / mergeLines 互逆（图逐字节相同）', () => {
  const g = fixtureGraph();
  const s = run(g, script.splitLine(g, 'line_3', 2));
  const [a, b] = ['line_3', 'line_8'];
  assert.equal(s.graph.nodes[a].params.text + s.graph.nodes[b].params.text, g.nodes.line_3.params.text);
  assert.deepEqual(K.shotsOfLine(s.graph, b), ['shot_2']);
  assert.deepEqual(K.lineOrder(s.graph).slice(0, 5), ['line_1', 'line_2', 'line_3', 'line_8', 'line_4']);
  const m = run(s.graph, script.mergeLines(s.graph, a, b));
  // 内容回到原样（新分配的 id 已删除；边 id 可能不同，所以比较投影而不是整图）
  assert.equal(JSON.stringify(K.scriptView(m.graph)), JSON.stringify(K.scriptView(g)));
  assert.equal(JSON.stringify(K.shotView(m.graph)), JSON.stringify(K.shotView(g)));
  assert.deepEqual(K.cacheKeys(m.graph), K.cacheKeys(g)); // 恒等编辑：key 全部不变
  assert.throws(() => script.splitLine(g, 'line_3', 0), { code: 'INTENT' });
  assert.throws(() => script.mergeLines(g, 'line_1', 'line_3'), { code: 'INTENT' }); // 不相邻
  assert.throws(() => script.mergeLines(g, 'line_4', 'line_5'), { code: 'INTENT' }); // 不同组
});

test('剧本：mergeLines 把 b 的镜头关联并入 a', () => {
  let g = fixtureGraph();
  g = K.applyTx(g, script.insertLine(g, { group: 'grp_1', index: 4, text: '尾行', shot_ids: ['shot_1'] })).graph; // line_8 属 shot_1
  const r = run(g, script.mergeLines(g, 'line_4', 'line_8', { sep: '|' }));
  assert.equal(r.graph.nodes.line_4.params.text, '阿宁收起伞。|尾行');
  assert.deepEqual(K.shotsOfLine(r.graph, 'line_4'), ['shot_1', 'shot_2']);
});

test('剧本：reorderLines 只动行的位置，不动镜头', () => {
  const g = fixtureGraph();
  const r = run(g, script.reorderLines(g, 'grp_1', ['line_4', 'line_3', 'line_2', 'line_1']));
  assert.deepEqual(K.lineOrder(r.graph).slice(0, 4), ['line_4', 'line_3', 'line_2', 'line_1']);
  assert.deepEqual(K.shotOrder(r.graph), K.shotOrder(g));
  assert.throws(() => script.reorderLines(g, 'grp_1', ['line_1']), { code: 'INTENT' });
  assert.throws(() => script.reorderLines(g, 'grp_1', ['line_1', 'line_1', 'line_2', 'line_3']), { code: 'INTENT' });
});

// ---------- 分镜 ----------

test('分镜：setShotField 改字段；duration_ms 变化时片段跟随', () => {
  const g = fixtureGraph();
  const r = run(g, shot.setShotField(g, 'shot_1', { title: '新', duration_ms: 6000 }));
  assert.equal(r.graph.nodes.shot_1.params.duration_ms, 6000);
  const seg = K.segmentsOfShot(r.graph, 'shot_1')[0];
  assert.deepEqual([seg.in_ms, seg.out_ms], [0, 6000]); // 未裁剪的整段延长
  // 缩短：被裁过的片段裁到新时长之内
  const trimmed = K.applyTx(g, timeline.trimSegment(g, 'seg_2', { in_ms: 1000, out_ms: 5000 })).graph;
  const s = run(trimmed, shot.setShotField(trimmed, 'shot_2', { duration_ms: 3000 }));
  const seg2 = K.segmentsOfShot(s.graph, 'shot_2')[0];
  assert.deepEqual([seg2.in_ms, seg2.out_ms], [1000, 3000]);
  assert.throws(() => shot.setShotField(g, 'shot_1', { duration_ms: 0 }), { code: 'INTENT' });
  assert.equal(shot.setShotField(g, 'shot_1', { title: g.nodes.shot_1.params.title }).ops.length, 0);
});

test('分镜：addShot 建好 image/video/narration、连线、默认片段；deleteShot 全部清理', () => {
  const g = fixtureGraph();
  const t = shot.addShot(g, { group: 'grp_1', index: 1, params: { title: '插入', duration_ms: 2000 }, lines: ['line_2'] });
  const r = run(g, t);
  const id = t.meta.shot_id;
  assert.deepEqual(K.shotOrder(r.graph).slice(0, 3), ['shot_1', id, 'shot_2']);
  assert.ok(K.partsOfShot(r.graph, id).video);
  assert.deepEqual(K.segmentsOfShot(r.graph, id).map((s) => [s.in_ms, s.out_ms]), [[0, 2000]]);
  assert.deepEqual(K.shotsOfLine(r.graph, 'line_2'), ['shot_1', id]);
  const d = run(r.graph, shot.deleteShot(r.graph, id));
  assert.ok(!d.graph.nodes[id]);
  assert.equal(Object.keys(d.graph.nodes).length, Object.keys(g.nodes).length);
  assert.deepEqual(K.shotsOfLine(d.graph, 'line_2'), ['shot_1']); // 行保留
});

test('分镜：splitShot 克隆镜头与生成节点，两边 video 都过期（要重新生成），行按位置分配', () => {
  const g = adoptAll(fixtureGraph());
  const t = shot.splitShot(g, 'shot_2', 1);
  const r = run(g, t);
  const n = t.meta.shot_id;
  assert.deepEqual(K.shotOrder(r.graph).slice(0, 3), ['shot_1', 'shot_2', n]);
  assert.deepEqual(K.linesOfShot(r.graph, 'shot_2'), ['line_3']);
  assert.deepEqual(K.linesOfShot(r.graph, n), ['line_4']);
  const stale = K.staleSet(r.graph);
  assert.ok(stale.includes('vid_2') && stale.includes(K.partsOfShot(r.graph, n).video));
  assert.equal(K.nodeState(r.graph, K.partsOfShot(r.graph, n).video), 'none');
  assert.equal(K.nodeState(r.graph, 'vid_1'), 'fresh'); // 无关镜头不受影响
  assert.deepEqual(r.graph.nodes[K.partsOfShot(r.graph, n).image].params, g.nodes.img_2.params);
  assert.equal(r.graph.nodes[n].legacy_id, undefined);
  assert.throws(() => shot.splitShot(g, 'shot_2', 9), { code: 'INTENT' });
});

test('分镜：mergeShots 并入行、时长相加、删除 b 及其片段', () => {
  const g = adoptAll(fixtureGraph());
  const r = run(g, shot.mergeShots(g, 'shot_1', 'shot_2'));
  assert.ok(!r.graph.nodes.shot_2);
  assert.deepEqual(K.linesOfShot(r.graph, 'shot_1'), ['line_1', 'line_2', 'line_3', 'line_4']);
  assert.equal(r.graph.nodes.shot_1.params.duration_ms, 10000);
  assert.deepEqual(K.segmentsOfShot(r.graph, 'shot_1').map((s) => [s.in_ms, s.out_ms]), [[0, 10000]]);
  assert.ok(K.staleSet(r.graph).includes('vid_1'));
  assert.throws(() => shot.mergeShots(g, 'shot_1', 'shot_1'), { code: 'INTENT' });
});

test('分镜：reorderShots / moveShotToGroup 改变全项目唯一的顺序，时间线随之改变', () => {
  const g = fixtureGraph();
  const r = run(g, shot.reorderShots(g, 'grp_1', ['shot_2', 'shot_1']));
  const order = K.timelineView(r.graph).tracks[0].clips.map((c) => c.storyboard_id);
  assert.deepEqual(order, [102, 101, 103, 104]);
  const m = run(g, shot.moveShotToGroup(g, 'shot_1', 'grp_2', 1));
  assert.deepEqual(K.shotOrder(m.graph), ['shot_2', 'shot_3', 'shot_1', 'shot_4']);
  assert.equal(K.groupOf(m.graph, 'shot_1'), 'grp_2');
  const same = run(g, shot.moveShotToGroup(g, 'shot_1', 'grp_1', 5));
  assert.deepEqual(K.shotOrder(same.graph), ['shot_2', 'shot_1', 'shot_3', 'shot_4']);
  assert.throws(() => shot.reorderShots(g, 'grp_1', ['shot_1']), { code: 'INTENT' });
});

test('分镜：regenerateShot 换种子；setVoice 只动配音；缺节点时为空事务', () => {
  const g = adoptAll(fixtureGraph());
  const r = run(g, shot.regenerateShot(g, 'shot_1', { seed: 42 }));
  assert.equal(r.graph.nodes.vid_1.params.seed, 42);
  assert.equal(r.graph.nodes.img_1.params.seed, 42);
  assert.equal(r.graph.versions.vid_1.length, 1); // 不覆盖旧版本
  const v = run(g, shot.setVoice(g, 'shot_1', { voice: 'deep', speed: 1.2 }));
  assert.equal(v.graph.nodes.nar_1.params.voice, 'deep');
  assert.throws(() => shot.regenerateShot(g, 'shot_1', { targets: ['compose'] }), { code: 'INTENT' });
  assert.throws(() => shot.recordGeneration(g, 'shot_1', {}), { code: 'INTENT' });
});

// ---------- 时间线 ----------

test('时间线：trim / split / setTransition / delete', () => {
  const g = fixtureGraph();
  const tr = run(g, timeline.trimSegment(g, 'seg_1', { in_ms: 500, out_ms: 3500 }));
  const c1 = K.timelineView(tr.graph).tracks[0].clips[0];
  assert.deepEqual([c1.start_ms, c1.duration_ms], [0, 3000]);
  assert.equal(K.timelineView(tr.graph).tracks[0].clips[1].start_ms, 3000); // 后面的片段前移
  assert.equal(tr.graph.nodes.shot_1.params.duration_ms, 4000); // 生成时长不变
  assert.throws(() => K.applyTx(g, timeline.trimSegment(g, 'seg_1', { out_ms: 9999 })), { code: 'VALIDATION' });
  assert.throws(() => timeline.trimSegment(g, 'nope', {}), { code: 'INTENT' });

  const sp = run(g, timeline.splitSegment(g, 'seg_2', 2000));
  const segs = K.segmentsOfShot(sp.graph, 'shot_2');
  assert.deepEqual(segs.map((s) => [s.in_ms, s.out_ms]), [[0, 2000], [2000, 6000]]);
  assert.equal(K.timelineView(sp.graph).duration_ms, 18000); // 切开不改总时长
  assert.equal(K.timelineView(sp.graph).tracks[1].clips.length, 4); // 字幕按镜头一条，不随片段增多
  assert.throws(() => timeline.splitSegment(g, 'seg_2', 0), { code: 'INTENT' });

  const tt = run(g, timeline.setTransition(g, 'seg_2', 'fade'));
  assert.deepEqual(K.timelineView(tt.graph).tracks[0].clips[1].style, { transition: 'fade' });

  const del = run(sp.graph, timeline.deleteSegment(sp.graph, segs[0].id));
  assert.equal(K.segmentsOfShot(del.graph, 'shot_2').length, 1);
});

test('时间线：删除镜头的最后一个片段 = 删除整个镜头', () => {
  const g = fixtureGraph();
  const r = run(g, timeline.deleteSegment(g, 'seg_3'));
  assert.ok(!r.graph.nodes.shot_3);
  assert.deepEqual(K.shotOrder(r.graph), ['shot_1', 'shot_2', 'shot_4']);
  assert.ok(!K.shotView(r.graph).groups[1].shots.some((s) => s.id === 'shot_3'));
});

test('时间线：moveSegment 同镜头 = 改 gap / 片段换位；跨镜头 = 改镜头顺序（可跨组）', () => {
  const g = fixtureGraph();
  const gap = run(g, timeline.moveSegment(g, 'seg_2', { gap_before_ms: 500 }));
  const clips = K.timelineView(gap.graph).tracks[0].clips;
  assert.equal(clips[1].start_ms, 4500);
  assert.equal(K.timelineView(gap.graph).duration_ms, 18500);
  assert.deepEqual(K.shotOrder(gap.graph), K.shotOrder(g)); // 顺序没变

  const sp = K.applyTx(g, timeline.splitSegment(g, 'seg_2', 2000)).graph; // seg_2 / seg_5（同属 shot_2）
  const swap = run(sp, timeline.moveSegment(sp, 'seg_5', { before_segment_id: 'seg_2' }));
  assert.deepEqual(K.segmentsOfShot(swap.graph, 'shot_2').map((s) => s.id), ['seg_5', 'seg_2']);
  assert.deepEqual(K.shotOrder(swap.graph), K.shotOrder(g));

  const cross = run(g, timeline.moveSegment(g, 'seg_1', { after_segment_id: 'seg_2' }));
  assert.deepEqual(K.shotOrder(cross.graph), ['shot_2', 'shot_1', 'shot_3', 'shot_4']);
  const crossGroup = run(g, timeline.moveSegment(g, 'seg_1', { before_segment_id: 'seg_4' }));
  assert.deepEqual(K.shotOrder(crossGroup.graph), ['shot_2', 'shot_3', 'shot_1', 'shot_4']);
  assert.equal(K.groupOf(crossGroup.graph, 'shot_1'), 'grp_2');
  assert.throws(() => timeline.moveSegment(g, 'seg_1', { after_segment_id: 'seg_1' }), { code: 'INTENT' });
  assert.throws(() => timeline.moveSegment(g, 'seg_1', { gap_before_ms: -5 }), { code: 'INTENT' });
});

test('时间线：addMusic 不改 sceneKey 与 staleSet 之外的视图；非法参数拒绝', () => {
  const g = adoptAll(fixtureGraph());
  const r = run(g, timeline.addMusic(g, { asset_ref: 'bgm.mp3', start_ms: 1000, duration_ms: 20000, volume: 0.5 }));
  const music = K.timelineView(r.graph).tracks[3].clips;
  assert.equal(music.length, 1);
  assert.equal(K.timelineView(r.graph).duration_ms, 21000);
  assert.deepEqual(K.staleSet(r.graph), ['compose_1']); // 只有合成过期
  assert.throws(() => timeline.addMusic(g, { asset_ref: 'x', start_ms: -1, duration_ms: 5 }), { code: 'INTENT' });
  assert.throws(() => timeline.addMusic(g, { start_ms: 0, duration_ms: 5 }), { code: 'INTENT' });
});

// ---------- 画布 ----------

test('画布：moveNode 只改 layout，key 与 staleSet 完全不变', () => {
  const g = adoptAll(fixtureGraph());
  const r = run(g, canvas.moveNode(g, 'vid_1', { x: 10.5, y: -3 }));
  assert.equal(r.layout_only, true);
  assert.deepEqual(K.cacheKeys(r.graph), K.cacheKeys(g));
  assert.deepEqual(r.invalidated.concat(r.revalidated), []);
  assert.deepEqual(K.canvasView(r.graph).nodes.find((n) => n.id === 'vid_1').layout, { x: 10.5, y: -3 });
  assert.equal(JSON.stringify(K.shotView(r.graph)), JSON.stringify(K.shotView(g)));
  assert.equal(JSON.stringify(K.timelineView(r.graph)), JSON.stringify(K.timelineView(g)));
  assert.equal(JSON.stringify(K.scriptView(r.graph)), JSON.stringify(K.scriptView(g)));
  const many = run(g, canvas.moveNodes(g, { shot_1: { x: 1, y: 1 }, shot_2: { x: 2, y: 2 } }));
  assert.equal(many.layout_only, true);
  assert.throws(() => canvas.moveNode(g, 'shot_1', { x: 'a', y: 1 }), { code: 'INTENT' });
});

test('画布：connectNodes 推断端口、替换单连接端口、拒绝非法连线；disconnectNodes', () => {
  const g = fixtureGraph();
  const r = run(g, canvas.connectNodes(g, 'line_1', 'shot_2')); // 只有 lines 端口可接
  assert.deepEqual(K.linesOfShot(r.graph, 'shot_2'), ['line_1', 'line_3', 'line_4']);
  assert.deepEqual(K.shotsOfLine(r.graph, 'line_1'), ['shot_1', 'shot_2']);
  // video.image 是单连接端口：连另一张图会替换旧边
  const rep = run(g, canvas.connectNodes(g, 'img_2', 'vid_1', { port: 'image' }));
  assert.deepEqual(K.edgesTo(rep.graph, 'vid_1').filter((e) => e.to.port === 'image').map((e) => e.from.node), ['img_2']);
  assert.throws(() => canvas.connectNodes(g, 'img_1', 'shot_1'), { code: 'INTENT' }); // shot 不接 image
  // 重新连同一条边 = 替换成自身：合法，图的 key 不变
  const same = run(g, canvas.connectNodes(g, 'shot_1', 'vid_1'));
  assert.deepEqual(K.cacheKeys(same.graph), K.cacheKeys(g));
  assert.throws(() => canvas.connectNodes(g, 'line_1', 'shot_2', { port: 'nope' }), { code: 'INTENT' });
  assert.throws(() => canvas.connectNodes(g, 'line_1', 'shot_1'), { code: 'INTENT' }); // 已存在同一连接

  const e = g.edges.find((x) => x.from.node === 'line_3' && x.to.node === 'shot_2');
  const d = run(g, canvas.disconnectNodes(g, { edge_id: e.id }));
  assert.deepEqual(K.linesOfShot(d.graph, 'shot_2'), ['line_4']);
  assert.equal(K.shotDialogue(d.graph, 'shot_2'), ''); // 行不再属于该镜头：镜头对白随之变化
  const d2 = run(g, canvas.disconnectNodes(g, { from: 'line_3', to: 'shot_2', port: 'lines' }));
  assert.deepEqual(K.linesOfShot(d2.graph, 'shot_2'), ['line_4']);
  assert.throws(() => canvas.disconnectNodes(g, { edge_id: 'ghost' }), { code: 'INTENT' });
});

test('画布：addNodeAt 各类型；compose 唯一；带 layout', () => {
  const g = fixtureGraph();
  const s = canvas.addNodeAt(g, 'shot', { x: 5, y: 6, group: 'grp_2', params: { title: '画布新建' } });
  const rs = run(g, s);
  const id = s.meta.node_id;
  assert.deepEqual(rs.graph.layout[id], { x: 5, y: 6 });
  assert.equal(K.shotOrder(rs.graph).at(-1), id); // 镜头同样出现在时间线与分镜视图
  assert.equal(K.timelineView(rs.graph).tracks[0].clips.at(-1).duration_ms, 5000);
  const l = canvas.addNodeAt(g, 'script_line', { group: 'grp_1', params: { kind: 'action', text: '画布新行' } });
  const rl = run(g, l);
  assert.equal(rl.graph.nodes[l.meta.node_id].params.text, '画布新行');
  const img = canvas.addNodeAt(g, 'image', { x: 1, y: 2 });
  const ri = run(g, img);
  assert.equal(ri.graph.nodes[img.meta.node_id].type, 'image');
  assert.throws(() => canvas.addNodeAt(g, 'compose', {}), { code: 'INTENT' });
  assert.throws(() => canvas.addNodeAt(g, 'wat', {}), { code: 'INTENT' });
  assert.equal(canvas.addNodeAt(g, 'image', {}).ops.some((o) => o.op === 'setLayout'), false); // 不给坐标就不写 layout
});

test('画布：deleteNode —— 镜头/行走各自流程；compose 不可删；生成节点直接移除', () => {
  const g = adoptAll(fixtureGraph());
  const sh = run(g, canvas.deleteNode(g, 'shot_2'));
  assert.ok(!sh.graph.nodes.shot_2 && !sh.graph.nodes.vid_2);
  assert.equal(K.timelineView(sh.graph).tracks[0].clips.length, 3);
  const ln = run(g, canvas.deleteNode(g, 'line_3'));
  assert.ok(ln.invalidated.includes('vid_2')); // 少了一行台词，所属镜头下游过期
  const im = run(g, canvas.deleteNode(g, 'img_1'));
  assert.ok(im.invalidated.includes('vid_1'));
  assert.equal(K.partsOfShot(im.graph, 'shot_1').image, null);
  assert.throws(() => canvas.deleteNode(g, 'compose_1'), { code: 'INTENT' });
  // 画布删掉 video 后，时间线退回用图片，分镜视图显示 none
  const dv = run(g, canvas.deleteNode(g, 'vid_1'));
  assert.equal(K.shotView(dv.graph).groups[0].shots[0].video, 'none');
  assert.equal(K.timelineView(dv.graph).tracks[0].clips[0].asset_kind, 'image');
});
