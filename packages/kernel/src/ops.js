'use strict';
// 原子 op 与事务。applyTx 是纯函数：在克隆上顺序应用，事务末尾整体校验，失败则原图不动（全有或全无）。
const G = require('./graph');
const { KernelError, clone, isObj } = G;
const { snapshotStale, diffStale } = require('./invalidation');

const bad = (m) => new KernelError('INVALID_OP', m);
const need = (g, id, what = 'node') => {
  const n = g.nodes[id];
  if (!n) throw new KernelError('NOT_FOUND', `${what} not found: ${id}`);
  return n;
};
const needGroup = (g, id) => {
  if (!g.groups[id]) throw new KernelError('NOT_FOUND', `group not found: ${id}`);
  return g.groups[id];
};

// 每个 handler：就地修改克隆图，返回“逆 op 数组”（按撤销时应执行的顺序）。
const HANDLERS = {
  addNode(g, op) {
    const n = op.node;
    if (!isObj(n) || typeof n.id !== 'string' || !n.id) throw bad('addNode: node.id required');
    if (g.nodes[n.id]) throw bad(`addNode: node exists: ${n.id}`);
    if (!G.NODE_TYPES.includes(n.type)) throw bad(`addNode: unknown type ${n.type}`);
    const node = { id: n.id, type: n.type, params: clone(n.params ?? {}) };
    if (n.legacy_id !== undefined && n.legacy_id !== null) node.legacy_id = n.legacy_id;
    g.nodes[n.id] = node;
    return [{ op: 'removeNode', id: n.id }];
  },

  // 级联：边、布局、版本、采用、组成员一起移除；逆 op restoreNode 原样放回（含边下标）。
  removeNode(g, op) {
    const node = need(g, op.id);
    const edges = [];
    g.edges.forEach((e, index) => { if (e.from.node === op.id || e.to.node === op.id) edges.push({ index, edge: clone(e) }); });
    const members = [];
    for (const gid of g.group_order) {
      const i = g.groups[gid].children.indexOf(op.id);
      if (i >= 0) members.push({ group: gid, index: i });
    }
    const inv = {
      op: 'restoreNode', node: clone(node), edges, members,
      layout: clone(g.layout[op.id]), versions: clone(g.versions[op.id]), adopted: g.adopted[op.id],
    };
    g.edges = g.edges.filter((e) => e.from.node !== op.id && e.to.node !== op.id);
    for (const m of members) g.groups[m.group].children.splice(g.groups[m.group].children.indexOf(op.id), 1);
    delete g.nodes[op.id];
    delete g.layout[op.id];
    delete g.versions[op.id];
    delete g.adopted[op.id];
    return [inv];
  },
  restoreNode(g, op) {
    if (g.nodes[op.node.id]) throw bad(`restoreNode: node exists: ${op.node.id}`);
    g.nodes[op.node.id] = clone(op.node);
    for (const { index, edge } of op.edges) g.edges.splice(index, 0, clone(edge));
    for (const m of op.members) g.groups[m.group].children.splice(m.index, 0, op.node.id);
    if (op.layout !== undefined) g.layout[op.node.id] = clone(op.layout);
    if (op.versions !== undefined) g.versions[op.node.id] = clone(op.versions);
    if (op.adopted !== undefined) g.adopted[op.node.id] = op.adopted;
    return [{ op: 'removeNode', id: op.node.id }];
  },

  setParam(g, op) {
    const n = need(g, op.node);
    const path = Array.isArray(op.path) ? op.path : String(op.path).split('.');
    if (!path.length || path.some((k) => typeof k !== 'string' && typeof k !== 'number')) throw bad('setParam: bad path');
    const top = path[0];
    // 逆 op 还原整个顶层键，保证撤销后与之前逐字节相同（含中间对象是否存在）
    const had = Object.prototype.hasOwnProperty.call(n.params, top);
    const inv = had ? { op: 'setParam', node: op.node, path: [top], value: clone(n.params[top]) } : { op: 'setParam', node: op.node, path: [top], unset: true };
    if (op.unset) {
      let cur = n.params;
      for (let i = 0; i < path.length - 1; i++) { cur = cur[path[i]]; if (cur === undefined || cur === null) return [inv]; }
      if (Array.isArray(cur)) cur.splice(Number(path[path.length - 1]), 1); else delete cur[path[path.length - 1]];
      return [inv];
    }
    let cur = n.params;
    for (let i = 0; i < path.length - 1; i++) {
      if (cur[path[i]] === undefined || cur[path[i]] === null) cur[path[i]] = {};
      cur = cur[path[i]];
      if (typeof cur !== 'object') throw bad('setParam: path crosses a non-object');
    }
    cur[path[path.length - 1]] = clone(op.value);
    return [inv];
  },
  setComposeSegments(g, op) {
    const n = need(g, op.node);
    if (n.type !== 'compose') throw bad('setComposeSegments: node is not compose');
    return HANDLERS.setParam(g, { node: op.node, path: ['segments'], value: op.segments });
  },

  connect(g, op) {
    const e = op.edge;
    if (!isObj(e) || typeof e.id !== 'string' || !isObj(e.from) || !isObj(e.to)) throw bad('connect: malformed edge');
    if (g.edges.some((x) => x.id === e.id)) throw bad(`connect: edge exists: ${e.id}`);
    need(g, e.from.node);
    need(g, e.to.node);
    const edge = { id: e.id, from: { node: e.from.node, port: e.from.port }, to: { node: e.to.node, port: e.to.port }, type: e.type };
    if (op.index === undefined) g.edges.push(edge); else g.edges.splice(op.index, 0, edge);
    return [{ op: 'disconnect', id: e.id }];
  },
  disconnect(g, op) {
    const index = g.edges.findIndex((e) => e.id === op.id);
    if (index < 0) throw new KernelError('NOT_FOUND', `edge not found: ${op.id}`);
    const [edge] = g.edges.splice(index, 1);
    return [{ op: 'connect', edge, index }];
  },

  addGroup(g, op) {
    const grp = op.group;
    if (!isObj(grp) || typeof grp.id !== 'string' || !grp.id) throw bad('addGroup: group.id required');
    if (g.groups[grp.id]) throw bad(`addGroup: group exists: ${grp.id}`);
    g.groups[grp.id] = { id: grp.id, title: grp.title ?? '', children: clone(grp.children ?? []) };
    if (op.index === undefined) g.group_order.push(grp.id); else g.group_order.splice(op.index, 0, grp.id);
    return [{ op: 'removeGroup', id: grp.id }];
  },
  removeGroup(g, op) {
    const grp = needGroup(g, op.id);
    const index = g.group_order.indexOf(op.id);
    g.group_order.splice(index, 1);
    delete g.groups[op.id];
    return [{ op: 'addGroup', group: clone(grp), index }];
  },
  setGroupTitle(g, op) {
    const grp = needGroup(g, op.group);
    const prev = grp.title;
    grp.title = op.title;
    return [{ op: 'setGroupTitle', group: op.group, title: prev }];
  },
  setChildren(g, op) {
    const grp = needGroup(g, op.group);
    if (!Array.isArray(op.ids)) throw bad('setChildren: ids must be an array');
    const prev = grp.children;
    grp.children = [...op.ids];
    return [{ op: 'setChildren', group: op.group, ids: prev }];
  },
  setGroupOrder(g, op) {
    if (!Array.isArray(op.ids)) throw bad('setGroupOrder: ids must be an array');
    const prev = g.group_order;
    g.group_order = [...op.ids];
    return [{ op: 'setGroupOrder', ids: prev }];
  },

  setLayout(g, op) {
    need(g, op.node);
    const prev = g.layout[op.node];
    if (op.pos === null || op.pos === undefined) delete g.layout[op.node];
    else g.layout[op.node] = { x: op.pos.x, y: op.pos.y };
    return [{ op: 'setLayout', node: op.node, pos: prev ? clone(prev) : null }];
  },

  addVersion(g, op) {
    need(g, op.node);
    const v = op.version;
    if (!isObj(v) || typeof v.id !== 'string' || !v.id) throw bad('addVersion: version.id required');
    const list = g.versions[op.node] || (g.versions[op.node] = []);
    if (list.some((x) => x.id === v.id)) throw bad(`addVersion: version exists: ${v.id}`);
    if (op.index === undefined) list.push(clone(v)); else list.splice(op.index, 0, clone(v));
    return [{ op: 'removeVersion', node: op.node, id: v.id }];
  },
  removeVersion(g, op) {
    const list = g.versions[op.node] || [];
    const index = list.findIndex((x) => x.id === op.id);
    if (index < 0) throw new KernelError('NOT_FOUND', `version not found: ${op.id}`);
    const [v] = list.splice(index, 1);
    if (!list.length) delete g.versions[op.node];
    if (g.adopted[op.node] === op.id) throw bad('removeVersion: version is adopted');
    return [{ op: 'addVersion', node: op.node, version: v, index }];
  },
  adoptVersion(g, op) {
    need(g, op.node);
    const prev = g.adopted[op.node];
    const vid = op.version_id ?? null;
    if (vid === null) delete g.adopted[op.node];
    else {
      if (!(g.versions[op.node] || []).some((v) => v.id === vid)) throw new KernelError('NOT_FOUND', `version not found: ${vid}`);
      g.adopted[op.node] = vid;
    }
    return [{ op: 'adoptVersion', node: op.node, version_id: prev ?? null }];
  },
};

const OP_NAMES = Object.keys(HANDLERS);

function checkTx(tx) {
  if (!isObj(tx) || typeof tx.tx_id !== 'string' || !tx.tx_id) throw bad('tx.tx_id required');
  if (!Array.isArray(tx.ops)) throw bad('tx.ops must be an array');
}

/** 就地对 g 应用 ops，返回整事务的逆 op（已按撤销顺序排好）。不校验图。 */
function runOps(g, ops) {
  const inverse = [];
  for (const op of ops) {
    if (!isObj(op) || !HANDLERS[op.op]) throw bad(`unknown op: ${op && op.op}`);
    inverse.unshift(...HANDLERS[op.op](g, op));
  }
  return inverse;
}

/**
 * 应用事务（纯函数）：返回 { graph, applied, tx_id, inverse, invalidated, revalidated, layout_only }。
 * - 任一 op 或最终校验失败：抛 KernelError，传入的图不变；
 * - opts.applied（Set）：已应用过的 tx_id 为空操作（applied:false，graph 原样返回）；成功后会把 tx_id 加进该集合；
 * - inverse 可直接作为新事务的 ops 用于撤销。
 */
function applyTx(graph, tx, opts = {}) {
  checkTx(tx);
  const applied = opts.applied;
  if (applied && applied.has(tx.tx_id)) {
    return { graph, applied: false, tx_id: tx.tx_id, inverse: [], invalidated: [], revalidated: [], layout_only: false };
  }
  const before = snapshotStale(graph);
  const g = G.cloneGraph(graph);
  const inverse = runOps(g, tx.ops);
  if (!opts.skipValidate) G.validateGraph(g);
  const after = snapshotStale(g);
  const { invalidated, revalidated } = diffStale(before, after);
  if (applied) applied.add(tx.tx_id);
  return {
    graph: g, applied: true, tx_id: tx.tx_id, inverse, invalidated, revalidated,
    layout_only: tx.ops.length > 0 && tx.ops.every((o) => o.op === 'setLayout'),
  };
}

module.exports = { OP_NAMES, applyTx };
