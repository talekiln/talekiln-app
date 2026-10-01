'use strict';
// 撤销/重做：栈里存的是事务，一个 tx = 一个撤销步。
const { applyTx } = require('./ops');
const { KernelError } = require('./graph');

class History {
  constructor(graph) {
    this.initial = graph;
    this.graph = graph;
    this.past = []; // { tx, inverse }
    this.future = []; // { tx }
    this.applied = new Set(); // 当前生效事务的 tx_id（撤销后移出，重做后移回）
  }

  /** 应用事务；同一 tx_id 重放为空操作（返回 applied:false）。失败抛错，状态不变。 */
  apply(tx) {
    const r = applyTx(this.graph, tx, { applied: this.applied });
    if (!r.applied) return r;
    this.graph = r.graph;
    this.past.push({ tx, inverse: r.inverse });
    this.future = [];
    return r;
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }

  /** 撤销最近一个事务，返回该次撤销的结果（含 invalidated/revalidated）；没有可撤销返回 null。 */
  undo() {
    const entry = this.past[this.past.length - 1];
    if (!entry) return null;
    const r = applyTx(this.graph, { tx_id: `undo:${entry.tx.tx_id}`, label: `undo ${entry.tx.label || ''}`.trim(), ops: entry.inverse });
    this.graph = r.graph;
    this.past.pop();
    this.applied.delete(entry.tx.tx_id);
    this.future.push({ tx: entry.tx });
    return r;
  }

  redo() {
    const entry = this.future[this.future.length - 1];
    if (!entry) return null;
    const r = applyTx(this.graph, entry.tx, { applied: this.applied });
    if (!r.applied) throw new KernelError('INVALID_OP', `redo: tx already applied: ${entry.tx.tx_id}`);
    this.graph = r.graph;
    this.future.pop();
    this.past.push({ tx: entry.tx, inverse: r.inverse });
    return r;
  }

  undoAll() { let n = 0; while (this.undo()) n++; return n; }
  redoAll() { let n = 0; while (this.redo()) n++; return n; }

  /** 当前生效的事务列表（按应用顺序）；对初始图 replay 即得到当前图。 */
  log() { return this.past.map((e) => e.tx); }
}

const createHistory = (graph) => new History(graph);

/** 在初始图上按顺序重放事务（tx_id 重复的会被跳过），崩溃恢复用。 */
function replay(initialGraph, txs) {
  const applied = new Set();
  let g = initialGraph;
  for (const tx of txs) g = applyTx(g, tx, { applied }).graph;
  return g;
}

module.exports = { History, createHistory, replay };
