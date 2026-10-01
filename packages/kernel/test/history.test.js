'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src');
const { fixtureGraph } = require('./helpers');

const I = K.intents;

test('一个事务 = 一个撤销步：多 op 事务一次撤销', () => {
  const g = fixtureGraph();
  const h = K.createHistory(g);
  h.apply(I.shot.splitShot(g, 'shot_2', 1, { tx_id: 'split' })); // 一个事务里几十个 op
  assert.ok(Object.keys(h.graph.nodes).length > Object.keys(g.nodes).length);
  assert.equal(h.past.length, 1);
  h.undo();
  assert.equal(K.toJSON(h.graph), K.toJSON(g));
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), true);
  h.redo();
  assert.equal(h.canRedo(), false);
  assert.ok(h.graph.nodes.shot_5);
});

test('undo/redo 返回带 invalidated/revalidated 的结果；空栈返回 null', () => {
  const h = K.createHistory(fixtureGraph());
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), null);
  h.apply(I.shot.regenerateShot(h.graph, 'shot_1', {}, { tx_id: 'r' }));
  const u = h.undo();
  assert.ok(Array.isArray(u.invalidated) && Array.isArray(u.revalidated));
});

test('新事务清空重做栈；同 tx_id 重放为空操作且不入栈', () => {
  const g = fixtureGraph();
  const h = K.createHistory(g);
  const t1 = I.shot.setShotField(g, 'shot_1', { title: 'A' }, { tx_id: 't1' });
  assert.equal(h.apply(t1).applied, true);
  assert.equal(h.apply(t1).applied, false);
  assert.equal(h.past.length, 1);
  h.undo();
  assert.equal(h.canRedo(), true);
  h.apply(I.shot.setShotField(h.graph, 'shot_1', { title: 'B' }, { tx_id: 't2' }));
  assert.equal(h.canRedo(), false);
  // 撤销后 t1 可以再次应用（它已不在生效集合里）
  h.undo();
  assert.equal(h.apply(t1).applied, true);
});

test('失败的事务不改变历史', () => {
  const g = fixtureGraph();
  const h = K.createHistory(g);
  assert.throws(() => h.apply({ tx_id: 'bad', label: 'bad', ops: [{ op: 'removeNode', id: 'ghost' }] }));
  assert.equal(h.past.length, 0);
  assert.equal(h.graph, g);
  assert.ok(!h.applied.has('bad'));
});

test('undoAll / redoAll / log / replay', () => {
  const g = fixtureGraph();
  const h = K.createHistory(g);
  const steps = [
    (x) => I.script.rewriteLine(x, 'line_2', { text: '新旁白' }, { tx_id: 'a' }),
    (x) => I.timeline.trimSegment(x, 'seg_1', { in_ms: 500 }, { tx_id: 'b' }),
    (x) => I.canvas.moveNode(x, 'shot_1', { x: 10, y: 10 }, { tx_id: 'c' }),
  ];
  for (const s of steps) h.apply(s(h.graph));
  const final = K.toJSON(h.graph);
  assert.deepEqual(h.log().map((t) => t.tx_id), ['a', 'b', 'c']);
  assert.equal(K.toJSON(K.replay(g, h.log())), final);
  assert.equal(K.toJSON(K.replay(g, [...h.log(), ...h.log()])), final); // 重复 tx_id 被跳过
  assert.equal(h.undoAll(), 3);
  assert.equal(K.toJSON(h.graph), K.toJSON(g));
  assert.equal(h.redoAll(), 3);
  assert.equal(K.toJSON(h.graph), final);
});
