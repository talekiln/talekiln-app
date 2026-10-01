'use strict';
// 画布视图的意图：只产出事务。moveNode 只改 layout（不影响 cacheKey / 过期集合）。
const G = require('../graph');
const U = require('./util');
const { applyTx } = require('../ops');
const { addShotOps, deleteShot } = require('./shot');
const { insertLine, deleteLine } = require('./script');

const isPos = (p) => p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y);

function moveNode(g, nodeId, pos, opts) {
  U.need(g, nodeId);
  if (!isPos(pos)) throw U.intentError('moveNode: pos must be {x,y} numbers');
  return U.mkTx('moveNode', [{ op: 'setLayout', node: nodeId, pos: { x: pos.x, y: pos.y } }], opts);
}

/** 批量移动（拖动多选），一个事务 = 一步撤销。 */
function moveNodes(g, positions, opts) {
  const ops = Object.entries(positions).map(([id, pos]) => {
    U.need(g, id);
    if (!isPos(pos)) throw U.intentError('moveNodes: pos must be {x,y} numbers');
    return { op: 'setLayout', node: id, pos: { x: pos.x, y: pos.y } };
  });
  return U.mkTx('moveNodes', ops, opts);
}

/** 用一次不落盘的试算把图校验错误（端口类型、环、容量）转成 INTENT 错误。 */
function dryRun(g, tx) {
  try { applyTx(g, tx); } catch (e) {
    if (e.code === 'VALIDATION') throw U.intentError(e.message);
    throw e;
  }
  return tx;
}

/** 连线。port 缺省时，若目标只有一个可接该类型的端口则自动推断；单连接端口已有边时替换旧边。 */
function connectNodes(g, fromId, toId, { port } = {}, opts) {
  const from = U.need(g, fromId);
  const to = U.need(g, toId);
  const ports = G.PORTS[to.type];
  let p = port;
  if (!p) {
    const cands = Object.keys(ports).filter((k) => ports[k].from === from.type);
    if (cands.length !== 1) throw U.intentError(`connectNodes: cannot infer port from ${from.type} to ${to.type}`);
    p = cands[0];
  }
  if (!ports[p]) throw U.intentError(`${to.type} has no input port ${p}`);
  const ops = [];
  if (!ports[p].multi) {
    // 单连接端口：已经是同一条边则什么也不做（恒等编辑）；否则替换旧边
    if (G.edgesTo(g, toId).some((e) => e.to.port === p && e.from.node === fromId)) return U.mkTx('connectNodes', [], opts);
    for (const e of G.edgesTo(g, toId)) if (e.to.port === p) ops.push({ op: 'disconnect', id: e.id });
  }
  ops.push(U.edgeOp(U.makeAlloc(g), fromId, toId, to.type, p));
  return dryRun(g, U.mkTx('connectNodes', ops, opts));
}

/** 断线：传 edge_id，或传 from/to（可选 port）。 */
function disconnectNodes(g, { edge_id, from, to, port }, opts) {
  const hits = g.edges.filter((e) => (edge_id ? e.id === edge_id : e.from.node === from && e.to.node === to && (!port || e.to.port === port)));
  if (!hits.length) throw U.intentError('disconnectNodes: no such edge');
  return U.mkTx('disconnectNodes', hits.map((e) => ({ op: 'disconnect', id: e.id })), opts);
}

/**
 * 在画布某处新建节点（同时写 layout）。script_line / shot 走各自的创建流程并放进 group（缺省第一个组）；
 * compose 全项目唯一，新建时为已有镜头补默认片段并接上已有的 video/narration。
 */
function addNodeAt(g, type, { x, y, params = {}, id, group, index } = {}, opts) {
  if (!G.NODE_TYPES.includes(type)) throw U.intentError(`unknown node type: ${type}`);
  const alloc = U.makeAlloc(g);
  const gid = group || g.group_order[0];
  let ops;
  let nodeId;
  if (type === 'script_line') {
    if (!gid) throw U.intentError('addNodeAt: no group to place the line in');
    const tx = insertLine(g, { group: gid, index, kind: params.kind, speaker: params.speaker, text: params.text, id }, opts);
    ops = tx.ops;
    nodeId = tx.meta.line_id;
  } else if (type === 'shot') {
    if (!gid) throw U.intentError('addNodeAt: no group to place the shot in');
    const r = addShotOps(g, alloc, { group: gid, index, params, id });
    ops = r.ops;
    nodeId = r.ids.shot;
  } else if (type === 'compose') {
    if (G.composeId(g)) throw U.intentError('addNodeAt: compose already exists');
    nodeId = id || alloc('compose');
    const segments = G.shotOrder(g).map((s) => ({
      id: alloc('seg'), shot_id: s, in_ms: 0, out_ms: g.nodes[s].params.duration_ms ?? G.DEFAULT_SHOT_MS, gap_before_ms: 0, transition: null,
    }));
    ops = [{ op: 'addNode', node: { id: nodeId, type, params: { ...G.defaultParams('compose'), ...structuredClone(params), segments } } }];
    for (const n of G.nodesOfType(g, 'video')) ops.push(U.edgeOp(alloc, n, nodeId, 'compose', 'video'));
    for (const n of G.nodesOfType(g, 'narration')) ops.push(U.edgeOp(alloc, n, nodeId, 'compose', 'narration'));
  } else {
    nodeId = id || alloc({ image: 'img', video: 'vid', narration: 'nar' }[type]);
    ops = [{ op: 'addNode', node: { id: nodeId, type, params: { ...G.defaultParams(type), ...structuredClone(params) } } }];
  }
  if (x !== undefined || y !== undefined) ops = [...ops, { op: 'setLayout', node: nodeId, pos: { x: x ?? 0, y: y ?? 0 } }];
  return U.mkTx('addNodeAt', ops, opts, { node_id: nodeId });
}

/** 删节点：剧本行/镜头走各自的删除流程（保持片段、连线一致）；compose 不允许从画布删；其余直接级联移除。 */
function deleteNode(g, nodeId, opts) {
  const n = U.need(g, nodeId);
  if (n.type === 'compose') throw U.intentError('deleteNode: the compose node cannot be deleted');
  if (n.type === 'shot') return deleteShot(g, nodeId, opts);
  if (n.type === 'script_line') return deleteLine(g, nodeId, opts);
  return U.mkTx('deleteNode', [{ op: 'removeNode', id: nodeId }], opts);
}

module.exports = { moveNode, moveNodes, connectNodes, disconnectNodes, addNodeAt, deleteNode };
