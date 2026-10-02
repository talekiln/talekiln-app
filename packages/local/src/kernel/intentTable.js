'use strict';
// REST 意图白名单（规格 §3 的意图层），供 routes/kernel.js（POST /intent）与导演模式（P3-D）共用。
// 每项把 JSON args 转成 kernel 意图的位置参数，返回 Tx；不在表里的意图（setVoice / recordGeneration / setShotReferences / moveNodes 等）不对外放行。
const kernel = require('@talekiln/kernel');

const { KernelError, intents: I } = kernel;

const need = (args, ...keys) => {
  for (const k of keys) if (args[k] === undefined || args[k] === null) throw new KernelError('INTENT', `missing arg: ${k}`);
};
const pos = (a) => (a.pos ? a.pos : { x: a.x, y: a.y });

const INTENTS = {
  script: {
    rewriteLine: (g, a, o) => { need(a, 'line_id', 'patch'); return I.script.rewriteLine(g, a.line_id, a.patch, o); },
    insertLine: (g, a, o) => { need(a, 'group'); return I.script.insertLine(g, a, o); },
    deleteLine: (g, a, o) => { need(a, 'line_id'); return I.script.deleteLine(g, a.line_id, o); },
    splitLine: (g, a, o) => { need(a, 'line_id', 'at'); return I.script.splitLine(g, a.line_id, a.at, o); },
    mergeLines: (g, a, o) => { need(a, 'a_id', 'b_id'); return I.script.mergeLines(g, a.a_id, a.b_id, { sep: a.sep }, o); },
    reorderLines: (g, a, o) => { need(a, 'group_id', 'ids'); return I.script.reorderLines(g, a.group_id, a.ids, o); },
  },
  shot: {
    setShotField: (g, a, o) => { need(a, 'shot_id', 'patch'); return I.shot.setShotField(g, a.shot_id, a.patch, o); },
    splitShot: (g, a, o) => { need(a, 'shot_id', 'at_line_index'); return I.shot.splitShot(g, a.shot_id, a.at_line_index, o); },
    mergeShots: (g, a, o) => { need(a, 'a_id', 'b_id'); return I.shot.mergeShots(g, a.a_id, a.b_id, o); },
    reorderShots: (g, a, o) => { need(a, 'group_id', 'ids'); return I.shot.reorderShots(g, a.group_id, a.ids, o); },
    moveShotToGroup: (g, a, o) => { need(a, 'shot_id', 'group_id'); return I.shot.moveShotToGroup(g, a.shot_id, a.group_id, a.index, o); },
    addShot: (g, a, o) => { need(a, 'group'); const { legacy_id, ...rest } = a; return I.shot.addShot(g, rest, o); }, // legacy_id 只由物化分配
    deleteShot: (g, a, o) => { need(a, 'shot_id'); return I.shot.deleteShot(g, a.shot_id, o); },
    regenerateShot: (g, a, o) => { need(a, 'shot_id'); return I.shot.regenerateShot(g, a.shot_id, { seed: a.seed, targets: a.targets }, o); },
  },
  timeline: {
    trimSegment: (g, a, o) => { need(a, 'segment_id'); return I.timeline.trimSegment(g, a.segment_id, { in_ms: a.in_ms, out_ms: a.out_ms }, o); },
    moveSegment: (g, a, o) => {
      need(a, 'segment_id');
      return I.timeline.moveSegment(g, a.segment_id, { gap_before_ms: a.gap_before_ms, before_segment_id: a.before_segment_id, after_segment_id: a.after_segment_id }, o);
    },
    splitSegment: (g, a, o) => { need(a, 'segment_id', 'at_ms'); return I.timeline.splitSegment(g, a.segment_id, a.at_ms, o); },
    deleteSegment: (g, a, o) => { need(a, 'segment_id'); return I.timeline.deleteSegment(g, a.segment_id, o); },
    setTransition: (g, a, o) => { need(a, 'segment_id'); return I.timeline.setTransition(g, a.segment_id, a.transition, o); },
    addMusic: (g, a, o) => I.timeline.addMusic(g, a, o),
  },
  canvas: {
    moveNode: (g, a, o) => { need(a, 'node_id'); return I.canvas.moveNode(g, a.node_id, pos(a), o); },
    // 属性面板改参数：白名单与取值校验在内核（NODE_PARAM_RULES）；value 可以是 null（清除可选参数），所以只检查 undefined
    setNodeParam: (g, a, o) => { need(a, 'node_id', 'path'); if (a.value === undefined) throw new KernelError('INTENT', 'missing arg: value'); return I.canvas.setNodeParam(g, a.node_id, a.path, a.value, o); },
    connectNodes: (g, a, o) => { need(a, 'from_id', 'to_id'); return I.canvas.connectNodes(g, a.from_id, a.to_id, { port: a.port }, o); },
    disconnectNodes: (g, a, o) => I.canvas.disconnectNodes(g, { edge_id: a.edge_id, from: a.from_id, to: a.to_id, port: a.port }, o),
    addNodeAt: (g, a, o) => { need(a, 'type'); const { type, ...rest } = a; return I.canvas.addNodeAt(g, type, rest, o); },
    deleteNode: (g, a, o) => { need(a, 'node_id'); return I.canvas.deleteNode(g, a.node_id, o); },
  },
};

const VIEW_ALIAS = { script: 'script', shot: 'shot', shots: 'shot', timeline: 'timeline', canvas: 'canvas' };
const viewOf = (v) => (typeof v === 'string' && Object.hasOwn(VIEW_ALIAS, v) ? VIEW_ALIAS[v] : null);

/** 白名单里的意图处理函数；不存在（含原型链上的名字）返回 null。 */
function lookupIntent(view, name) {
  const v = viewOf(view);
  const table = v && INTENTS[v];
  if (!table || typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(table, name)) return null;
  return { view: v, name, fn: table[name] };
}

module.exports = { INTENTS, VIEW_ALIAS, viewOf, lookupIntent };
