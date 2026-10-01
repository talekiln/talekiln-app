import { ref, computed } from 'vue'
import {
  ACTIONS, buildKeymap, loadOverrides, saveOverrides, diffOverrides, findConflicts, conflictsFor,
  resolveAction, normalizeCombo, isEditableTarget,
} from '@/utils/keymap'
import {
  actionsForPreset, loadPreset, savePreset, exportKeymap, parseKeymapImport, isPreset, PRESETS, presetKeymap,
} from '@/utils/keymapPresets'

const overrides = ref(loadOverrides())
const presetId = ref(loadPreset())
// 预设键位 + 用户覆盖；所有对 keymap 的计算都以当前预设的动作表为准
const effectiveActions = computed(() => actionsForPreset(presetId.value))
const keymap = computed(() => buildKeymap(overrides.value, effectiveActions.value))
const conflicts = computed(() => findConflicts(keymap.value, effectiveActions.value))

function commit(next) {
  overrides.value = next
  saveOverrides(next)
}

/** 绑定某动作的组合键列表（有冲突时仍写入，由 UI 标红提示） */
function setBinding(actionId, combos) {
  const next = { ...keymap.value, [actionId]: combos.map(normalizeCombo).filter(Boolean) }
  commit(diffOverrides(next, effectiveActions.value))
}

function resetAction(actionId) {
  const next = { ...overrides.value }
  delete next[actionId]
  commit(next)
}

/** 清空自定义，回到当前预设 */
function resetAll() {
  commit({})
}

/** 切换预设：自定义覆盖项一并清空（调用方需要确认） */
function setPreset(id) {
  if (!isPreset(id)) return false
  presetId.value = id
  savePreset(id)
  commit({})
  return true
}

/** 导出当前预设 + 覆盖项（JSON 文本） */
function exportJSON() {
  return exportKeymap(presetId.value, overrides.value)
}

/** 导入 JSON 文本；成功则整体替换预设与覆盖项。返回 parseKeymapImport 的结果 */
function importJSON(text) {
  const r = parseKeymapImport(text)
  if (!r.ok) return r
  presetId.value = r.preset
  savePreset(r.preset)
  commit(r.overrides)
  return r
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

/** 全局动作（带修饰键）的处理器：输入框里也生效（如命令面板），无修饰键的全局动作仍不抢输入。 */
function createGlobalHandler(handlers) {
  return (e) => {
    if (e.defaultPrevented || e.isComposing) return
    const id = resolveAction(keymap.value, e, ['global'])
    const fn = id && handlers[id]
    if (!fn) return
    if (isEditableTarget(e.target) && !(e.ctrlKey || e.metaKey || e.altKey)) return
    if (fn(e) === false) return
    e.preventDefault()
  }
}

export function useKeymap() {
  return {
    actions: ACTIONS, overrides, keymap, conflicts, setBinding, resetAction, resetAll,
    presetId, presets: PRESETS, setPreset, exportJSON, importJSON, presetKeymap,
    defaultKeys: (id) => effectiveActions.value.find((a) => a.id === id)?.keys ?? [],
    conflictsFor: (id, c) => conflictsFor(keymap.value, id, c, effectiveActions.value),
    createKeyHandler, createGlobalHandler,
  }
}
