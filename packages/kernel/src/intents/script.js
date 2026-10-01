'use strict';
// 剧本视图的意图：只产出事务。
const G = require('../graph');
const U = require('./util');

/** 改一行：patch 里可含 text / speaker / kind。台词文字只存在 script_line.text。 */
function rewriteLine(g, lineId, patch, opts) {
  const n = U.need(g, lineId, 'script_line');
  const ops = [];
  for (const k of ['text', 'speaker', 'kind']) {
    if (patch[k] !== undefined && patch[k] !== n.params[k]) ops.push({ op: 'setParam', node: lineId, path: [k], value: patch[k] });
  }
  if (patch.kind !== undefined && !G.LINE_KINDS.includes(patch.kind)) throw U.intentError(`bad line kind: ${patch.kind}`);
  return U.mkTx('rewriteLine', ops, opts);
}

/** 在场景组里按“行序号”插入一行，可同时挂到若干镜头（derives 边）。 */
function insertLine(g, { group, index, kind = 'narration', speaker = '', text = '', shot_ids = [], id }, opts) {
  const grp = U.needGroup(g, group);
  if (!G.LINE_KINDS.includes(kind)) throw U.intentError(`bad line kind: ${kind}`);
  const alloc = U.makeAlloc(g);
  const lineId = id || alloc('line');
  const ops = [{ op: 'addNode', node: { id: lineId, type: 'script_line', params: { kind, speaker, text } } }];
  ops.push({ op: 'setChildren', group, ids: U.insertAmong(g, grp.children, 'script_line', index, lineId) });
  for (const s of shot_ids) {
    U.need(g, s, 'shot');
    ops.push(U.edgeOp(alloc, lineId, s, 'shot', 'lines'));
  }
  return U.mkTx('insertLine', ops, opts, { line_id: lineId });
}

function deleteLine(g, lineId, opts) {
  U.need(g, lineId, 'script_line');
  return U.mkTx('deleteLine', [{ op: 'removeNode', id: lineId }], opts);
}

/** 在字符位置 at 把一行拆成两行（后半行紧跟其后，挂到同样的镜头）。 */
function splitLine(g, lineId, at, opts) {
  const n = U.need(g, lineId, 'script_line');
  const text = n.params.text;
  if (!Number.isInteger(at) || at <= 0 || at >= text.length) throw U.intentError('splitLine: at must fall strictly inside the text');
  const alloc = U.makeAlloc(g);
  const newId = alloc('line');
  const gid = G.groupOf(g, lineId);
  const children = [...g.groups[gid].children];
  children.splice(children.indexOf(lineId) + 1, 0, newId);
  const ops = [
    { op: 'setParam', node: lineId, path: ['text'], value: text.slice(0, at) },
    { op: 'addNode', node: { id: newId, type: 'script_line', params: { ...structuredClone(n.params), text: text.slice(at) } } },
    { op: 'setChildren', group: gid, ids: children },
  ];
  for (const s of G.shotsOfLine(g, lineId)) ops.push(U.edgeOp(alloc, newId, s, 'shot', 'lines'));
  return U.mkTx('splitLine', ops, opts, { line_id: newId });
}

/** 把 b 并入 a（须同组且相邻）。文字默认直接拼接（与 splitLine 互逆），b 的镜头关联并入 a。 */
function mergeLines(g, aId, bId, { sep = '' } = {}, opts) {
  const a = U.need(g, aId, 'script_line');
  const b = U.need(g, bId, 'script_line');
  const gid = G.groupOf(g, aId);
  if (gid !== G.groupOf(g, bId)) throw U.intentError('mergeLines: lines must be in the same group');
  const lines = g.groups[gid].children.filter((c) => g.nodes[c].type === 'script_line');
  if (lines.indexOf(bId) !== lines.indexOf(aId) + 1) throw U.intentError('mergeLines: b must directly follow a');
  const alloc = U.makeAlloc(g);
  const have = new Set(G.shotsOfLine(g, aId));
  const ops = [{ op: 'setParam', node: aId, path: ['text'], value: a.params.text + sep + b.params.text }];
  for (const s of G.shotsOfLine(g, bId)) if (!have.has(s)) ops.push(U.edgeOp(alloc, aId, s, 'shot', 'lines'));
  ops.push({ op: 'removeNode', id: bId });
  return U.mkTx('mergeLines', ops, opts);
}

/** 重排一个场景组里的行（ids 必须是该组全部行的排列）。 */
function reorderLines(g, groupId, ids, opts) {
  const grp = U.needGroup(g, groupId);
  return U.mkTx('reorderLines', [{ op: 'setChildren', group: groupId, ids: U.permuteAmong(g, grp.children, 'script_line', ids) }], opts);
}

module.exports = { rewriteLine, insertLine, deleteLine, splitLine, mergeLines, reorderLines };
