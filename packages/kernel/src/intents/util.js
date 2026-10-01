'use strict';
// 意图层共用工具：意图只产出 Tx，不改图。
const { randomUUID } = require('node:crypto');
const G = require('../graph');
const { KernelError, PORTS } = G;

const intentError = (m) => new KernelError('INTENT', m);

/** tx_id 默认随机；测试可传 opts.tx_id 固定。meta 为附带信息（新建节点 id 等），不参与应用。 */
function mkTx(label, ops, opts = {}, meta) {
  const tx = { tx_id: opts.tx_id || randomUUID(), label, ops };
  if (meta) tx.meta = meta;
  return tx;
}

/** 确定性 id 分配：前缀_序号，序号取现有最大值+1。 */
function makeAlloc(g) {
  const max = {};
  const note = (id) => {
    const m = /^([a-z]+)_(\d+)$/.exec(String(id));
    if (m) max[m[1]] = Math.max(max[m[1]] || 0, Number(m[2]));
  };
  Object.keys(g.nodes).forEach(note);
  g.edges.forEach((e) => note(e.id));
  Object.keys(g.groups).forEach(note);
  const c = G.composeId(g);
  if (c) {
    (g.nodes[c].params.segments || []).forEach((s) => note(s.id));
    (g.nodes[c].params.music || []).forEach((s) => note(s.id));
  }
  return (prefix) => {
    max[prefix] = (max[prefix] || 0) + 1;
    return `${prefix}_${max[prefix]}`;
  };
}

function need(g, id, type) {
  const n = g.nodes[id];
  if (!n) throw intentError(`node not found: ${id}`);
  if (type && n.type !== type) throw intentError(`${id} is ${n.type}, expected ${type}`);
  return n;
}
function needGroup(g, id) {
  if (!g.groups[id]) throw intentError(`group not found: ${id}`);
  return g.groups[id];
}

/** 构造 connect op；toType 单独传入，因为目标可能是同一事务里新建、图里还没有的节点。 */
function edgeOp(alloc, from, to, toType, port) {
  return { op: 'connect', edge: { id: alloc('e'), from: { node: from, port: 'out' }, to: { node: to, port }, type: PORTS[toType][port].edge } };
}

/**
 * 在 children 里为某类型节点算插入位置：index 是该类型子序列里的下标；
 * 超出则放在该类型最后一个之后（没有同类型时放末尾）。返回新的 children 数组。
 */
function insertAmong(g, children, type, index, id) {
  const same = children.filter((c) => g.nodes[c] && g.nodes[c].type === type);
  const out = [...children];
  if (index === undefined || index >= same.length) {
    const at = same.length ? out.indexOf(same[same.length - 1]) + 1 : out.length;
    out.splice(at, 0, id);
  } else {
    out.splice(out.indexOf(same[Math.max(0, index)]), 0, id);
  }
  return out;
}

/** 用 ids 的新顺序替换 children 里该类型节点所占的位置（其他类型不动）。 */
function permuteAmong(g, children, type, ids) {
  const same = children.filter((c) => g.nodes[c].type === type);
  if (ids.length !== same.length || new Set(ids).size !== ids.length || !ids.every((i) => same.includes(i))) {
    throw intentError(`ids must be a permutation of the group's ${type}s`);
  }
  let k = 0;
  return children.map((c) => (g.nodes[c].type === type ? ids[k++] : c));
}

function composeOf(g) {
  const id = G.composeId(g);
  return id ? { id, node: g.nodes[id], segments: structuredClone(g.nodes[id].params.segments || []) } : null;
}
function findSegment(g, segId) {
  const c = composeOf(g);
  const index = c ? c.segments.findIndex((s) => s.id === segId) : -1;
  if (index < 0) throw intentError(`segment not found: ${segId}`);
  return { compose: c, index, seg: c.segments[index] };
}
const segOp = (composeId, segments) => ({ op: 'setComposeSegments', node: composeId, segments });

/** 把一个镜头移到目标组，放在 targetShot 之前/之后（或目标组所有镜头之后）。返回 ops。 */
function placeShotOps(g, shotId, toGroup, { beforeShot, afterShot, index } = {}) {
  const from = G.groupOf(g, shotId);
  const children = {};
  for (const gid of new Set([from, toGroup])) children[gid] = [...g.groups[gid].children];
  children[from].splice(children[from].indexOf(shotId), 1);
  const dest = children[toGroup];
  const pivot = beforeShot || afterShot;
  if (pivot) {
    const at = dest.indexOf(pivot);
    if (at < 0) throw intentError(`${pivot} is not in group ${toGroup}`);
    dest.splice(beforeShot ? at : at + 1, 0, shotId);
  } else {
    const shots = dest.filter((c) => g.nodes[c].type === 'shot');
    if (index === undefined || index >= shots.length) dest.splice(shots.length ? dest.indexOf(shots[shots.length - 1]) + 1 : dest.length, 0, shotId);
    else dest.splice(dest.indexOf(shots[Math.max(0, index)]), 0, shotId);
  }
  return Object.keys(children).map((gid) => ({ op: 'setChildren', group: gid, ids: children[gid] }));
}

module.exports = {
  intentError, mkTx, makeAlloc, need, needGroup, edgeOp, insertAmong, permuteAmong, composeOf, findSegment, segOp, placeShotOps,
};
