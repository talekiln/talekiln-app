/**
 * 撤销/重做命令历史（快照式，纯逻辑）。
 * record(before) 在每次编辑前传入编辑前的快照；undo(current)/redo(current) 返回应恢复的快照。
 * 相同 coalesceKey 且间隔不超过 coalesceMs 的连续记录合并为一步（如连续微调）。
 */
export function createHistory({ limit = 100, coalesceMs = 0, now = () => Date.now() } = {}) {
  let past = []
  let future = []
  let lastKey = null
  let lastAt = 0

  return {
    record(before, label = '', coalesceKey = null) {
      const t = now()
      if (coalesceKey && coalesceKey === lastKey && t - lastAt <= coalesceMs && past.length) {
        lastAt = t
        future = []
        return
      }
      past.push({ snapshot: before, label })
      if (past.length > limit) past.shift()
      future = []
      lastKey = coalesceKey
      lastAt = t
    },
    undo(current) {
      const e = past.pop()
      if (!e) return null
      future.push({ snapshot: current, label: e.label })
      lastKey = null
      return e.snapshot
    },
    redo(current) {
      const e = future.pop()
      if (!e) return null
      past.push({ snapshot: current, label: e.label })
      lastKey = null
      return e.snapshot
    },
    clear() {
      past = []
      future = []
      lastKey = null
    },
    get canUndo() { return past.length > 0 },
    get canRedo() { return future.length > 0 },
    get undoLabel() { return past.length ? past[past.length - 1].label : '' },
    get redoLabel() { return future.length ? future[future.length - 1].label : '' },
    get size() { return past.length },
  }
}
