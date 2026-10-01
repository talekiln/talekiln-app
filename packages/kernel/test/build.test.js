'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src');
const { checkInvariants } = require('./helpers');

test('parseScript：场景标题、对白、动作、旁白，忽略空行', () => {
  const scenes = K.parseScript('# 雨夜\n\n雨很大。\n阿宁：你来了。\n老周: 嗯。\n△收伞\n（沉默）\n# 清晨\n天亮。');
  assert.equal(scenes.length, 2);
  assert.deepEqual(scenes[0].lines.map((l) => [l.kind, l.speaker, l.text]), [
    ['scene_heading', '', '雨夜'], ['narration', '', '雨很大。'], ['dialogue', '阿宁', '你来了。'],
    ['dialogue', '老周', '嗯。'], ['action', '', '收伞'], ['action', '', '沉默'],
  ]);
  assert.equal(scenes[1].title, '清晨');
  assert.deepEqual(K.parseScript('没有标题的开头').map((s) => s.title), ['']);
  assert.deepEqual(K.parseScript(''), []);
});

test('buildGraphFromScript：只有行和 compose，合法且确定性', () => {
  const a = K.buildGraphFromScript('p', '# A\nx：y\n# B\nz');
  const b = K.buildGraphFromScript('p', '# A\nx：y\n# B\nz');
  assert.equal(K.toJSON(a), K.toJSON(b));
  assert.equal(a.project_id, 'p');
  assert.deepEqual(a.group_order, ['grp_1', 'grp_2']);
  assert.equal(K.nodesOfType(a, 'script_line').length, 4);
  assert.equal(K.nodesOfType(a, 'shot').length, 0);
  assert.ok(K.composeId(a));
  checkInvariants(a);
  const noCompose = K.buildGraphFromScript('p', 'x', { compose: false });
  assert.equal(K.composeId(noCompose), null);
  assert.equal(K.buildGraphFromScript('p', '').group_order.length, 0);
});

test('buildGraph：镜头带齐生成节点、连线、片段；不修改传入描述', () => {
  const desc = { project_id: 'q', scenes: [{ title: 'S', lines: [{ text: 'a' }, { text: 'b' }], shots: [{ title: 't', lines: [0, 1], legacy_id: 7, duration_ms: 1234 }] }] };
  const copy = structuredClone(desc);
  const g = K.buildGraph(desc);
  assert.deepEqual(desc, copy);
  assert.equal(g.nodes.shot_1.legacy_id, 7);
  assert.equal(g.nodes.shot_1.params.duration_ms, 1234);
  assert.equal(g.nodes.shot_1.params.title, 't');
  assert.deepEqual(K.linesOfShot(g, 'shot_1'), ['line_1', 'line_2']);
  assert.deepEqual(K.partsOfShot(g, 'shot_1'), { image: 'img_1', video: 'vid_1', narration: 'nar_1' });
  assert.deepEqual(g.nodes.compose_1.params.segments, [{ id: 'seg_1', shot_id: 'shot_1', in_ms: 0, out_ms: 1234, gap_before_ms: 0, transition: null }]);
  assert.deepEqual(g.layout, {});
  checkInvariants(g);
});
