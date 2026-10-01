import { ref, computed } from 'vue'
import {
  ACTIONS, buildKeymap, loadOverrides, saveOverrides, diffOverrides, findConflicts, conflictsFor,
  resolveAction, normalizeCombo, isEditableTarget,
} from '@/utils/keymap'

const overrides = ref(loadOverrides())
const keymap = computed(() => buildKeymap(overrides.value))
const conflicts = computed(() => findConflicts(keymap.value))

function commit(next) {
  overrides.value = next
  saveOverrides(next)
}

/** 绑定某动作的组合键列表（有冲突时仍写入，由 UI 标红提示） */
function setBinding(actionId, combos) {
  const next = { ...keymap.value, [actionId]: combos.map(normalizeCombo).filter(Boolean) }
  commit(diffOverrides(next))
}

function resetAction(actionId) {
  const next = { ...overrides.value }
  delete next[actionId]
  commit(next)
}

function resetAll() {
  commit({})
}

/**
 * 创建 keydown 处理器：handlers 为 { actionId: (event) => void|false }。
 * 处理函数返回 false 表示未处理（不拦截浏览器默认行为）。
 */
function createKeyHandler(handlers, scopes) {
  return (e) => {
    if (e.defaultPrevented || e.isComposing || isEditableTarget(e.target)) return
    const id = resolveAction(keymap.value, e, scopes)
    const fn = id && handlers[id]
    if (!fn) return
    if (fn(e) === false) return
    e.preventDefault()
  }
}

export function useKeymap() {
  return {
    actions: ACTIONS, overrides, keymap, conflicts, setBinding, resetAction, resetAll,
    conflictsFor: (id, c) => conflictsFor(keymap.value, id, c), createKeyHandler,
  }
}
