'use strict';
// 数据内核 REST（令牌校验由 app.js 的 localTokenGuard 统一处理）。
//   GET  /episodes/:id/graph            全图 + 过期集合
//   GET  /episodes/:id/views/:view      script | shots | timeline | canvas
//   POST /episodes/:id/tx               原始 op 事务 { tx_id, label, ops }
//   POST /episodes/:id/intent           意图 { view, name, args, tx_id? }，只放行规格里的意图
//   POST /episodes/:id/undo | redo      { tx_id? }
//   POST /episodes/:id/import-legacy    旧表 -> 项目图（幂等）
//   GET  /episodes/:id/versions         只读：每个生成类节点的版本列表（采用状态、是否匹配当前输入、产生时间、资产与元数据摘要）
//   GET  /episodes/:id/history          只读：graph_ops 日志（新在前）+ 每个事务当前是否生效 + 回到该步所需的撤销/重做步数
const kernel = require('@talekiln/kernel');
const response = require('../response');
const store = require('../kernel/store');
const legacy = require('../kernel/legacy');

const { KernelError, intents: I } = kernel;

const need = (args, ...keys) => {
  for (const k of keys) if (args[k] === undefined || args[k] === null) throw new KernelError('INTENT', `missing arg: ${k}`);
};
const pos = (a) => (a.pos ? a.pos : { x: a.x, y: a.y });

// 白名单：规格 §3 的意图层。每项把 JSON args 转成 kernel 意图的位置参数，返回 Tx。
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
    renameGroup: (g, a, o) => { need(a, 'group_id', 'title'); return I.canvas.renameGroup(g, a.group_id, a.title, o); },
  },
};
const VIEW_ALIAS = { script: 'script', shot: 'shot', shots: 'shot', timeline: 'timeline', canvas: 'canvas' };
const viewOf = (v) => (typeof v === 'string' && Object.hasOwn(VIEW_ALIAS, v) ? VIEW_ALIAS[v] : null);
const VIEW_FN = { script: kernel.scriptView, shots: kernel.shotView, timeline: kernel.timelineView, canvas: kernel.canvasView };

const STATUS = { NOT_FOUND: 404, GRAPH_NOT_FOUND: 404, NOTHING_TO_UNDO: 409, NOTHING_TO_REDO: 409 };

const HISTORY_DEFAULT = 200;
const HISTORY_MAX = 1000;

/**
 * 把一行 graph_ops 解成历史条目（只读展示用）。state 取自真实的撤销/重做栈：
 *   applied（在撤销栈里，undo_steps = 回到“刚做完这一步”需要撤销几步）、undone（在重做栈里，redo_steps = 重做几步能把它做回来）、
 *   discarded（被之后的新操作顶掉，或超出撤销栈深度，回不去）、event（undo/redo 记录本身）。
 */
function historyEntry(row, stacks) {
  const e = JSON.parse(row.tx);
  const base = { seq: row.seq, tx_id: row.tx_id, kind: e.kind, created_at: row.created_at };
  if (e.kind !== 'apply') {
    return { ...base, label: '', target: e.target, op_count: Array.isArray(e.ops) ? e.ops.length : 0, state: 'event' };
  }
  const ops = Array.isArray(e.tx && e.tx.ops) ? e.tx.ops : [];
  const kinds = {};
  const nodes = [];
  const added = [];
  const adopted = [];
  for (const op of ops) {
    kinds[op.op] = (kinds[op.op] || 0) + 1;
    if (typeof op.node === 'string' && !nodes.includes(op.node) && nodes.length < 8) nodes.push(op.node);
    if (op.op === 'addVersion' && op.version) added.push({ node: op.node, version_id: op.version.id });
    if (op.op === 'adoptVersion') adopted.push({ node: op.node, version_id: op.version_id ?? null });
  }
  const out = {
    ...base, label: (e.tx && e.tx.label) || '', op_count: ops.length, op_kinds: kinds, nodes, versions_added: added, versions_adopted: adopted,
  };
  const pi = stacks.past.indexOf(row.tx_id);
  const fi = stacks.future.indexOf(row.tx_id);
  if (pi >= 0) return { ...out, state: 'applied', undo_steps: stacks.past.length - 1 - pi };
  if (fi >= 0) return { ...out, state: 'undone', redo_steps: fi + 1 };
  return { ...out, state: 'discarded' };
}

const META_KEYS = ['duration_ms', 'voice', 'format', 'aspect_ratio'];
const short = (k) => (typeof k === 'string' ? k.slice(0, 12) : null);

/** 版本的元数据摘要：只挑展示用的几项，不带逐字时间戳等大字段。 */
function metaSummary(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  for (const k of META_KEYS) if (m[k] !== undefined && m[k] !== null) out[k] = m[k];
  const inputs = m.inputs && typeof m.inputs === 'object' ? m.inputs : null;
  if (inputs && inputs.model) out.model = inputs.model;
  return Object.keys(out).length ? out : null;
}

/** 每个生成类节点的版本列表。created_at 取自把该版本加进图的那条日志；导入 / 快照里没有对应日志的为 null。 */
function nodeVersions(db, episodeId, graph) {
  const created = new Map();
  const rows = db.prepare("SELECT tx, created_at FROM graph_ops WHERE episode_id = ? AND tx LIKE '%addVersion%' ORDER BY seq").all(episodeId);
  for (const r of rows) {
    const e = JSON.parse(r.tx);
    if (e.kind !== 'apply' || !e.tx || !Array.isArray(e.tx.ops)) continue;
    for (const op of e.tx.ops) if (op.op === 'addVersion' && op.version) created.set(`${op.node}|${op.version.id}`, r.created_at);
  }
  const keys = kernel.cacheKeys(graph);
  const describe = (id, shotId, kindLabel) => {
    const node = graph.nodes[id];
    const adopted = graph.adopted[id] || null;
    const list = (graph.versions[id] || []).map((v) => ({
      id: v.id,
      cache_key: short(v.cache_key),
      current: v.cache_key === keys[id],
      adopted: v.id === adopted,
      source: v.source || null,
      rebased_from: v.rebased_from || null,
      asset: v.asset ? { ref: v.asset.ref ?? null, kind: v.asset.kind ?? null, hash: short(v.asset.hash) } : null,
      metadata: metaSummary(v.metadata),
      created_at: created.get(`${id}|${v.id}`) || null,
    }));
    return { node: id, type: node.type, shot_id: shotId, adopted, state: kernel.nodeState(graph, id, keys), current_key: short(keys[id]), versions: list };
  };
  const out = [];
  for (const shotId of kernel.shotOrder(graph)) {
    const parts = kernel.partsOfShot(graph, shotId);
    for (const t of ['image', 'video', 'narration']) if (parts[t]) out.push(describe(parts[t], shotId));
  }
  const compose = kernel.composeId(graph);
  if (compose) out.push(describe(compose, null));
  return out;
}

function routes(db, log) {
  function guard(name, fn) {
    return (req, res) => {
      try {
        fn(req, res);
      } catch (err) {
        if (err instanceof KernelError) return response.error(res, STATUS[err.code] || 400, err.code, err.message);
        log.error('kernel ' + name, { error: err.message });
        response.internalError(res, err.message);
      }
    };
  }
  const ep = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new KernelError('INVALID_OP', 'episode id must be a positive integer');
    return id;
  };
  const summary = (r) => ({
    applied: r.applied, tx_id: r.tx_id, seq: r.seq, invalidated: r.invalidated, revalidated: r.revalidated,
    stale: kernel.staleSet(r.graph), can_undo: r.canUndo, can_redo: r.canRedo, ...(r.meta ? { meta: r.meta } : {}),
  });
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  return {
    getGraph: guard('graph', (req, res) => {
      const p = store.openProject(db, ep(req));
      response.success(res, { graph: p.graph, stale: kernel.staleSet(p.graph), seq: p.seq, can_undo: p.canUndo, can_redo: p.canRedo });
    }),
    getView: guard('view', (req, res) => {
      const v = viewOf(req.params.view);
      const key = v === 'shot' ? 'shots' : v;
      if (!key) return response.badRequest(res, 'view must be one of script, shots, timeline, canvas');
      const p = store.openProject(db, ep(req));
      response.success(res, { view: key, seq: p.seq, data: VIEW_FN[key](p.graph) });
    }),
    getVersions: guard('versions', (req, res) => {
      const id = ep(req);
      const p = store.openProject(db, id);
      response.success(res, { seq: p.seq, nodes: nodeVersions(db, id, p.graph) });
    }),
    getHistory: guard('history', (req, res) => {
      const id = ep(req);
      const p = store.openProject(db, id);
      const n = Number(req.query.limit);
      const limit = Number.isInteger(n) && n > 0 ? Math.min(n, HISTORY_MAX) : HISTORY_DEFAULT;
      const stacks = {
        past: p.history.past.map((x) => x.tx.tx_id), // 旧 -> 新
        future: p.history.future.map((x) => x.tx.tx_id).reverse(), // 重做顺序：下一步在最前
      };
      const rows = db.prepare('SELECT seq, tx_id, tx, created_at FROM graph_ops WHERE episode_id = ? ORDER BY seq DESC LIMIT ?').all(id, limit + 1);
      const entries = rows.slice(0, limit).map((r) => historyEntry(r, stacks));
      response.success(res, {
        seq: p.seq, can_undo: p.canUndo, can_redo: p.canRedo, undo_depth: stacks.past.length, redo_depth: stacks.future.length,
        truncated: rows.length > limit, entries,
      });
    }),
    postTx: guard('tx', (req, res) => {
      const b = body(req);
      if (typeof b.tx_id !== 'string' || !b.tx_id) throw new KernelError('INVALID_OP', 'tx_id required');
      if (!Array.isArray(b.ops)) throw new KernelError('INVALID_OP', 'ops must be an array');
      const r = store.commit(db, ep(req), { tx_id: b.tx_id, label: typeof b.label === 'string' ? b.label : '', ops: b.ops });
      response.success(res, summary(r));
    }),
    postIntent: guard('intent', (req, res) => {
      const b = body(req);
      const view = viewOf(b.view);
      const table = view && INTENTS[view];
      if (!table) throw new KernelError('INTENT', `unknown view: ${b.view}`);
      if (typeof b.name !== 'string' || !Object.prototype.hasOwnProperty.call(table, b.name)) throw new KernelError('INTENT', `unknown intent: ${view}.${b.name}`);
      const args = b.args && typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : {};
      if (b.tx_id !== undefined && (typeof b.tx_id !== 'string' || !b.tx_id)) throw new KernelError('INVALID_OP', 'tx_id must be a non-empty string');
      const opts = b.tx_id ? { tx_id: b.tx_id } : {};
      const r = store.commit(db, ep(req), (g) => table[b.name](g, args, opts), opts);
      response.success(res, summary(r));
    }),
    postUndo: guard('undo', (req, res) => response.success(res, summary(store.undo(db, ep(req), { tx_id: body(req).tx_id })))),
    postRedo: guard('redo', (req, res) => response.success(res, summary(store.redo(db, ep(req), { tx_id: body(req).tx_id })))),
    importLegacy: guard('import', (req, res) => {
      const r = legacy.importLegacy(db, ep(req));
      (r.created ? response.created : response.success)(res, r);
    }),
  };
}

routes.INTENTS = INTENTS;
module.exports = routes;
