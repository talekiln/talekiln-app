/**
 * 快捷键系统：纯逻辑（无 DOM / Vue 依赖），默认键位参考剪映。
 * 组合键规范写法："Ctrl+Shift+Z"：修饰键顺序固定为 Ctrl, Alt, Shift；Meta(⌘) 视同 Ctrl。
 */

export const SCOPE_TIMELINE = 'timeline'
export const SCOPE_WORKBENCH = 'workbench'
export const STORAGE_KEY = 'talekiln.keymap.v1'

/**
 * 已注册动作。keys 为默认组合键（可多个）。
 * Ctrl+滚轮缩放属于鼠标手势，不在此映射（由编辑器直接处理）。
 */
export const ACTIONS = [
  { id: 'play.toggle', scope: SCOPE_TIMELINE, label: '播放 / 暂停', keys: ['Space'] },
  { id: 'clip.split', scope: SCOPE_TIMELINE, label: '切分片段', keys: ['S'] },
  { id: 'clip.delete', scope: SCOPE_TIMELINE, label: '删除片段', keys: ['Delete', 'Backspace'] },
  { id: 'edit.undo', scope: SCOPE_TIMELINE, label: '撤销', keys: ['Ctrl+Z'] },
  { id: 'edit.redo', scope: SCOPE_TIMELINE, label: '重做', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'] },
  { id: 'playhead.prevFrame', scope: SCOPE_TIMELINE, label: '播放头后退一帧', keys: ['ArrowLeft'] },
  { id: 'playhead.nextFrame', scope: SCOPE_TIMELINE, label: '播放头前进一帧', keys: ['ArrowRight'] },
  { id: 'playhead.prevSecond', scope: SCOPE_TIMELINE, label: '播放头后退 1 秒', keys: ['Shift+ArrowLeft'] },
  { id: 'playhead.nextSecond', scope: SCOPE_TIMELINE, label: '播放头前进 1 秒', keys: ['Shift+ArrowRight'] },
  { id: 'playhead.home', scope: SCOPE_TIMELINE, label: '跳到开头', keys: ['Home'] },
  { id: 'playhead.end', scope: SCOPE_TIMELINE, label: '跳到结尾', keys: ['End'] },
  { id: 'zoom.in', scope: SCOPE_TIMELINE, label: '放大时间线', keys: ['=', 'Ctrl+='] },
  { id: 'zoom.out', scope: SCOPE_TIMELINE, label: '缩小时间线', keys: ['-', 'Ctrl+-'] },
  { id: 'track.mute', scope: SCOPE_TIMELINE, label: '静音 / 取消静音当前轨道', keys: ['M'] },
  // 分镜工作台（AI）：处理函数暂为占位，动作先注册
  { id: 'shot.regenerate', scope: SCOPE_WORKBENCH, label: '重新生成镜头', keys: ['R'] },
  { id: 'shot.pick1', scope: SCOPE_WORKBENCH, label: '选用候选 V1', keys: ['Alt+1'] },
  { id: 'shot.pick2', scope: SCOPE_WORKBENCH, label: '选用候选 V2', keys: ['Alt+2'] },
  { id: 'shot.pick3', scope: SCOPE_WORKBENCH, label: '选用候选 V3', keys: ['Alt+3'] },
  { id: 'shot.pick4', scope: SCOPE_WORKBENCH, label: '选用候选 V4', keys: ['Alt+4'] },
  { id: 'shot.compareToggle', scope: SCOPE_WORKBENCH, label: '切换 A/B 对比', keys: ['Tab'] },
]

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift']

const KEY_ALIASES = {
  ' ': 'Space', spacebar: 'Space', space: 'Space', del: 'Delete', delete: 'Delete', esc: 'Escape', escape: 'Escape',
  backspace: 'Backspace', tab: 'Tab', home: 'Home', end: 'End', enter: 'Enter', return: 'Enter',
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
  arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
  plus: '+', minus: '-', pageup: 'PageUp', pagedown: 'PageDown',
}

function normKey(k) {
  if (k == null || k === '') return ''
  const alias = KEY_ALIASES[String(k).toLowerCase()]
  if (alias) return alias
  return k.length === 1 ? k.toUpperCase() : k
}

/** 把任意写法规范化："ctrl+shift+z" -> "Ctrl+Shift+Z"。无主键返回 ''。 */
export function normalizeCombo(combo) {
  if (!combo) return ''
  const raw = String(combo).trim()
  // 末尾的 '+' 本身是主键（如 "Ctrl++"）
  const plusKey = raw === '+' || raw.endsWith('++')
  const body = plusKey ? raw.slice(0, -1) : raw
  const parts = body.split('+').map((s) => s.trim()).filter(Boolean)
  const mods = new Set()
  let key = plusKey ? '+' : ''
  for (const p of parts) {
    const l = p.toLowerCase()
    if (l === 'ctrl' || l === 'control' || l === 'cmd' || l === 'meta' || l === 'command') mods.add('Ctrl')
    else if (l === 'alt' || l === 'option') mods.add('Alt')
    else if (l === 'shift') mods.add('Shift')
    else key = normKey(p)
  }
  if (!key) return ''
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+')
}

/** 键盘事件（或同形对象）-> 规范组合键；纯修饰键按下返回 ''。 */
export function eventToCombo(e) {
  let key
  const code = e.code || ''
  // Alt+数字 / Alt+字母在 macOS 会产生符号，故优先用物理键 code
  if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Numpad\d$/.test(code)) key = code.slice(6)
  else key = normKey(e.key)
  if (!key || ['Control', 'Shift', 'Alt', 'Meta', 'Dead', 'Unidentified'].includes(key)) return ''
  const mods = []
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  // 对 '+' 符号键，Shift 已体现在字符里，不再计入
  if (e.shiftKey && key !== '+') mods.push('Shift')
  return [...mods, key].join('+')
}

/** 显示用 */
export function formatCombo(combo) {
  return combo.replace('Space', '空格').replace('ArrowLeft', '←').replace('ArrowRight', '→')
    .replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('Delete', 'Del')
}

/** 合并默认键位与用户覆盖（overrides: { actionId: string[] }）。返回 { actionId: string[] } */
export function buildKeymap(overrides = {}, actions = ACTIONS) {
  const map = {}
  for (const a of actions) {
    const o = overrides && Array.isArray(overrides[a.id]) ? overrides[a.id] : null
    map[a.id] = [...new Set((o ?? a.keys).map(normalizeCombo).filter(Boolean))]
  }
  return map
}

/**
 * 冲突检测：同一作用域内同一组合键被多个动作使用。
 * 返回 [{ combo, scope, actions: [id,...] }]
 */
export function findConflicts(keymap, actions = ACTIONS) {
  const seen = new Map()
  for (const a of actions) {
    for (const c of keymap[a.id] || []) {
      const k = `${a.scope}\u0000${c}`
      if (!seen.has(k)) seen.set(k, { combo: c, scope: a.scope, actions: [] })
      seen.get(k).actions.push(a.id)
    }
  }
  return [...seen.values()].filter((x) => x.actions.length > 1)
}

/** 若给 actionId 绑定 combo，会与哪些动作冲突（同作用域、不含自身） */
export function conflictsFor(keymap, actionId, combo, actions = ACTIONS) {
  const c = normalizeCombo(combo)
  const self = actions.find((a) => a.id === actionId)
  if (!self || !c) return []
  return actions.filter((a) => a.id !== actionId && a.scope === self.scope && (keymap[a.id] || []).includes(c)).map((a) => a.id)
}

/** 由键盘事件（或组合键字符串）解析动作 id（限定作用域），无匹配返回 null */
export function resolveAction(keymap, e, scopes = [SCOPE_TIMELINE], actions = ACTIONS) {
  const combo = typeof e === 'string' ? normalizeCombo(e) : eventToCombo(e)
  if (!combo) return null
  for (const a of actions) {
    if (scopes.includes(a.scope) && (keymap[a.id] || []).includes(combo)) return a.id
  }
  return null
}

/** 只保留与默认值不同的覆盖项，避免默认键位升级后被旧存储固化 */
export function diffOverrides(keymap, actions = ACTIONS) {
  const out = {}
  for (const a of actions) {
    const def = a.keys.map(normalizeCombo)
    const cur = keymap[a.id] || []
    if (def.length !== cur.length || def.some((k, i) => k !== cur[i])) out[a.id] = cur
  }
  return out
}

export function loadOverrides(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return {}
    const known = new Set(ACTIONS.map((a) => a.id))
    const out = {}
    for (const [id, v] of Object.entries(obj)) {
      if (known.has(id) && Array.isArray(v) && v.every((x) => typeof x === 'string')) out[id] = v
    }
    return out
  } catch (_) {
    return {}
  }
}

export function saveOverrides(overrides, storage = globalThis.localStorage) {
  try {
    if (!overrides || !Object.keys(overrides).length) storage?.removeItem(STORAGE_KEY)
    else storage?.setItem(STORAGE_KEY, JSON.stringify(overrides))
    return true
  } catch (_) {
    return false
  }
}

/** 可编辑控件内应放行的事件目标 */
export function isEditableTarget(t) {
  const tag = (t?.tagName || '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!t?.isContentEditable
}
