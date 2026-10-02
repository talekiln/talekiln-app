'use strict';
// 项目图持久化：快照 + 只追加的事务日志（graph_ops）。
// 一次 commit = 一个 SQLite 事务：应用事务 -> 物化到旧表 -> 写日志 -> 视情况写快照。任何一步失败整体回滚。
// 撤销/重做同样写日志（带各自的 tx_id），重载时用同一个 History 按日志重放，图和撤销栈都能复原。
// 持久性：和队列一样依赖连接的 journal_mode=WAL；需要断电级保证时由调用方把 synchronous 设为 FULL。
const crypto = require('node:crypto');
const kernel = require('@talekiln/kernel');

const { KernelError, History, canonicalJSON } = kernel;

const DEFAULT_SNAPSHOT_EVERY = 20;
const MAX_UNDO_DEPTH = 200; // 快照里保留的撤销栈深度（超出丢弃最旧的，图本身不受影响）

const nowIso = () => new Date().toISOString();
const noProject = (episodeId) => new KernelError('GRAPH_NOT_FOUND', `episode ${episodeId} has no project graph (import legacy data first)`);

/** 快照 = 图 + 撤销/重做栈（栈里是事务和逆 op，都是纯 JSON）。 */
function encodeSnapshot(h) {
  return canonicalJSON({ graph: h.graph, past: h.past.slice(-MAX_UNDO_DEPTH), future: h.future });
}
function decodeSnapshot(text) {
  const s = JSON.parse(text);
  kernel.validateGraph(s.graph);
  const h = new History(s.graph);
  h.past = s.past || [];
  h.future = s.future || [];
  return h;
}

function applyBinds(graph, binds) {
  for (const [shotId, legacyId] of Object.entries(binds || {})) {
    if (graph.nodes[shotId]) graph.nodes[shotId].legacy_id = legacyId;
  }
}

/** 把一条日志重放到 history 上（重载与崩溃恢复用）。undo/redo 条目会核对目标 tx_id。 */
function replayEntry(h, entry, seq) {
  const corrupt = (m) => new KernelError('VALIDATION', `graph_ops seq ${seq}: ${m}`);
  if (entry.kind === 'apply') {
    h.apply(entry.tx);
  } else if (entry.kind === 'undo') {
    const top = h.past[h.past.length - 1];
    if (!top || top.tx.tx_id !== entry.target) throw corrupt(`undo target mismatch (${entry.target})`);
    h.undo();
  } else if (entry.kind === 'redo') {
    const top = h.future[h.future.length - 1];
    if (!top || top.tx.tx_id !== entry.target) throw corrupt(`redo target mismatch (${entry.target})`);
    h.redo();
  } else {
    throw corrupt(`unknown entry kind ${entry.kind}`);
  }
  applyBinds(h.graph, entry.binds);
}

function loadState(db, episodeId) {
  const row = db.prepare('SELECT snapshot, snapshot_seq FROM project_graphs WHERE episode_id = ?').get(Number(episodeId));
  if (!row) throw noProject(episodeId);
  const h = decodeSnapshot(row.snapshot);
  let seq = row.snapshot_seq;
  const rows = db.prepare('SELECT seq, tx FROM graph_ops WHERE episode_id = ? AND seq > ? ORDER BY seq').all(Number(episodeId), row.snapshot_seq);
  for (const r of rows) {
    replayEntry(h, JSON.parse(r.tx), r.seq);
    seq = r.seq;
  }
  return { history: h, seq, snapshotSeq: row.snapshot_seq };
}

function hasProject(db, episodeId) {
  return !!db.prepare('SELECT 1 FROM project_graphs WHERE episode_id = ?').get(Number(episodeId));
}

/** 读取项目：快照 + 重放其后的日志。返回 { graph, history, seq, canUndo, canRedo }。 */
function openProject(db, episodeId) {
  const s = loadState(db, episodeId);
  return { graph: s.history.graph, history: s.history, seq: s.seq, canUndo: s.history.canUndo(), canRedo: s.history.canRedo() };
}

/** 写入初始图（导入用）。已存在则不覆盖，返回 false。 */
function initProject(db, episodeId, graph) {
  kernel.validateGraph(graph);
  return db.transaction(() => {
    if (hasProject(db, episodeId)) return false;
    db.prepare('INSERT INTO project_graphs (episode_id, snapshot, snapshot_seq, updated_at) VALUES (?, ?, 0, ?)')
      .run(Number(episodeId), encodeSnapshot(new History(graph)), nowIso());
    return true;
  })();
}

const defaultMaterialize = (db, episodeId, graph) => require('./legacy').materialize(db, episodeId, graph);

/**
 * 在一个 SQLite 事务里执行一次变更。mutate(history) 对 history 做 apply/undo/redo，返回 { entry, result, id }。
 * txId 已在日志里 = 空操作（applied:false）。
 */
function run(db, episodeId, txId, mutate, opts = {}) {
  const every = opts.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
  const materialize = opts.materialize === undefined ? defaultMaterialize : opts.materialize;
  const ep = Number(episodeId);
  return db.transaction(() => {
    const state = loadState(db, ep);
    const h = state.history;
    if (txId && db.prepare('SELECT 1 FROM graph_ops WHERE episode_id = ? AND tx_id = ?').get(ep, txId)) {
      return { applied: false, tx_id: txId, graph: h.graph, seq: state.seq, canUndo: h.canUndo(), canRedo: h.canRedo(), invalidated: [], revalidated: [] };
    }
    const { entry, result, id } = mutate(h);
    if (materialize) {
      const m = materialize(db, ep, h.graph);
      if (m && m.binds && Object.keys(m.binds).length) { entry.binds = m.binds; applyBinds(h.graph, m.binds); }
    }
    const seq = Number(db.prepare('INSERT INTO graph_ops (episode_id, tx_id, tx, created_at) VALUES (?, ?, ?, ?)')
      .run(ep, id, canonicalJSON(entry), nowIso()).lastInsertRowid);
    if (seq - state.snapshotSeq >= every) {
      db.prepare('UPDATE project_graphs SET snapshot = ?, snapshot_seq = ?, updated_at = ? WHERE episode_id = ?')
        .run(encodeSnapshot(h), seq, nowIso(), ep);
    } else {
      db.prepare('UPDATE project_graphs SET updated_at = ? WHERE episode_id = ?').run(nowIso(), ep);
    }
    return {
      applied: true, tx_id: id, graph: h.graph, seq, canUndo: h.canUndo(), canRedo: h.canRedo(),
      invalidated: result.invalidated || [], revalidated: result.revalidated || [], meta: entry.tx && entry.tx.meta,
    };
  })();
}

/**
 * 提交事务。txOrBuilder 为 Tx，或 (graph) => Tx（意图层用：在同一个 SQLite 事务里基于最新图构造，
 * 此时用 opts.tx_id 给出幂等键）。同一 tx_id 重放为空操作（applied:false）。
 * 失败抛 KernelError，图、日志、旧表都不变。
 */
function commit(db, episodeId, txOrBuilder, opts = {}) {
  const preId = typeof txOrBuilder === 'function' ? opts.tx_id : txOrBuilder && txOrBuilder.tx_id;
  return run(db, episodeId, preId, (h) => {
    const tx = typeof txOrBuilder === 'function' ? txOrBuilder(h.graph) : txOrBuilder;
    const r = h.apply(tx);
    return { entry: { kind: 'apply', tx }, result: r, id: tx.tx_id };
  }, opts);
}

/** 撤销最近一步；opts.tx_id 作为这次撤销的幂等键。没有可撤销抛 NOTHING_TO_UNDO。 */
function undo(db, episodeId, opts = {}) {
  const id = opts.tx_id || `undo-${crypto.randomUUID()}`;
  return run(db, episodeId, id, (h) => {
    const top = h.past[h.past.length - 1];
    if (!top) throw new KernelError('NOTHING_TO_UNDO', 'nothing to undo');
    const r = h.undo();
    return { entry: { kind: 'undo', tx_id: id, target: top.tx.tx_id, ops: top.inverse }, result: r, id };
  }, opts);
}

function redo(db, episodeId, opts = {}) {
  const id = opts.tx_id || `redo-${crypto.randomUUID()}`;
  return run(db, episodeId, id, (h) => {
    const top = h.future[h.future.length - 1];
    if (!top) throw new KernelError('NOTHING_TO_REDO', 'nothing to redo');
    const r = h.redo();
    return { entry: { kind: 'redo', tx_id: id, target: top.tx.tx_id, ops: top.tx.ops }, result: r, id };
  }, opts);
}

module.exports = { openProject, initProject, hasProject, commit, undo, redo, DEFAULT_SNAPSHOT_EVERY, MAX_UNDO_DEPTH };
