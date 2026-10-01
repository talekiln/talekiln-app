/**
 * 键位预设与导入导出（纯逻辑，无 DOM / Vue 依赖）。
 * 预设 = 对默认键位（剪映风格，见 keymap.js 的 ACTIONS）的整体替换表；用户自定义是预设之上的覆盖项。
 * 实际键位 = buildKeymap(overrides, actionsForPreset(presetId))。
 */
import { ACTIONS, normalizeCombo, buildKeymap, diffOverrides, findConflicts } from './keymap.js'

export const PRESET_STORAGE_KEY = 'talekiln.keymap.preset.v1'
export const EXPORT_FORMAT = 'talekiln-keymap'
export const EXPORT_VERSION = 1

/**
 * Premiere Pro 习惯：Ctrl+K = 添加剪辑点（切分），Shift+M 代替 M（M 在 PR 里是标记），Delete 删除。
 * Ctrl+K 被 PR 用于切分，所以此预设里命令面板改为 Ctrl+Shift+P（全局动作与其它作用域同键算冲突）。
 * 未列出的动作沿用默认键位。注意：PR 的 J/K/L 变速播放、Q/W 波纹修剪在本应用没有对应动作，不收录。
 */
const PREMIERE = {
  'palette.open': ['Ctrl+Shift+P'],
  'play.toggle': ['Space'],
  'clip.split': ['Ctrl+K'],
  'clip.delete': ['Delete', 'Backspace'],
  'edit.undo': ['Ctrl+Z'],
  'edit.redo': ['Ctrl+Shift+Z'],
  'playhead.prevFrame': ['ArrowLeft'],
  'playhead.nextFrame': ['ArrowRight'],
  'playhead.prevSecond': ['Shift+ArrowLeft'],
  'playhead.nextSecond': ['Shift+ArrowRight'],
  'playhead.home': ['Home'],
  'playhead.end': ['End'],
  'zoom.in': ['='],
  'zoom.out': ['-'],
  'track.mute': ['Shift+M'],
}

export const PRESETS = [
  { id: 'jianying', label: '剪映风格（默认）', keys: {} },
  { id: 'premiere', label: 'Premiere 风格', keys: PREMIERE },
]
export const DEFAULT_PRESET = 'jianying'

export const presetIds = () => PRESETS.map((p) => p.id)
export const isPreset = (id) => PRESETS.some((p) => p.id === id)

/** 某预设下的动作表（ACTIONS 的副本，keys 换成预设键位）。未知预设回落默认。 */
export function actionsForPreset(presetId) {
  const p = PRESETS.find((x) => x.id === presetId)
  if (!p || !Object.keys(p.keys).length) return ACTIONS
  return ACTIONS.map((a) => (p.keys[a.id] ? { ...a, keys: p.keys[a.id] } : a))
}

/** 预设自身的键位（无覆盖项）。 */
export const presetKeymap = (presetId) => buildKeymap({}, actionsForPreset(presetId))

export function loadPreset(storage = globalThis.localStorage) {
  try {
    const v = storage?.getItem(PRESET_STORAGE_KEY)
    return isPreset(v) ? v : DEFAULT_PRESET
  } catch (_) {
    return DEFAULT_PRESET
  }
}

export function savePreset(id, storage = globalThis.localStorage) {
  try {
    if (!isPreset(id) || id === DEFAULT_PRESET) storage?.removeItem(PRESET_STORAGE_KEY)
    else storage?.setItem(PRESET_STORAGE_KEY, id)
    return true
  } catch (_) {
    return false
  }
}

/** 导出为 JSON 文本：{ format, version, preset, overrides }。overrides 只含与预设不同的动作。 */
export function exportKeymap(presetId, overrides) {
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, preset: isPreset(presetId) ? presetId : DEFAULT_PRESET, overrides: overrides || {} }, null, 2)
}

/**
 * 解析导入文本。返回 { ok:true, preset, overrides, warnings } 或 { ok:false, error }。
 * 未知动作、非法组合键被丢弃并记入 warnings；导入后与预设相同的项被剔除；冲突不拒绝（界面标红），但写进 warnings。
 */
export function parseKeymapImport(text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch (_) {
    return { ok: false, error: '不是有效的 JSON' }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: '内容不是键位配置' }
  if (obj.format !== EXPORT_FORMAT) return { ok: false, error: '不是 Talekiln 键位配置（format 不符）' }
  if (obj.version !== EXPORT_VERSION) return { ok: false, error: `不支持的版本：${obj.version}` }
  const preset = isPreset(obj.preset) ? obj.preset : DEFAULT_PRESET
  const warnings = []
  if (obj.preset !== undefined && !isPreset(obj.preset)) warnings.push(`未知预设「${obj.preset}」，已改用默认预设`)
  const known = new Set(ACTIONS.map((a) => a.id))
  const raw = obj.overrides && typeof obj.overrides === 'object' && !Array.isArray(obj.overrides) ? obj.overrides : {}
  const cleaned = {}
  for (const [id, v] of Object.entries(raw)) {
    if (!known.has(id)) { warnings.push(`忽略未知动作：${id}`); continue }
    if (!Array.isArray(v)) { warnings.push(`忽略格式错误的动作：${id}`); continue }
    const combos = []
    for (const c of v) {
      const n = typeof c === 'string' ? normalizeCombo(c) : ''
      if (n) combos.push(n)
      else warnings.push(`${id}：忽略无效组合键 ${JSON.stringify(c)}`)
    }
    cleaned[id] = [...new Set(combos)]
  }
  const actions = actionsForPreset(preset)
  const overrides = diffOverrides(buildKeymap(cleaned, actions), actions)
  const conflicts = findConflicts(buildKeymap(overrides, actions), actions)
  if (conflicts.length) warnings.push(`导入的键位有 ${conflicts.length} 处冲突`)
  return { ok: true, preset, overrides, warnings }
}
