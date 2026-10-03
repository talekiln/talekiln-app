// 全局撤销 / 重做快捷键判定（纯函数）。原先在 ViewSwitcher 里，随它移到顶栏。
// 返回 'undo' | 'redo' | null。输入框、可编辑文本、时间线视图（它有自己的快捷键）里不接管。
export function undoRedoIntent(e, currentView) {
  if (!e || e.altKey) return null
  if (!(e.ctrlKey || e.metaKey)) return null
  if (currentView === 'timeline') return null
  const tag = String(e.target?.tagName || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return null
  const k = String(e.key || '').toLowerCase()
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (k === 'y') return 'redo'
  return null
}
