import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIONS, buildKeymap, findConflicts, conflictsFor, resolveAction, diffOverrides, normalizeCombo,
  SCOPE_GLOBAL, SCOPE_TIMELINE, SCOPE_WORKBENCH,
} from '../src/utils/keymap.js'
import {
  PRESETS, DEFAULT_PRESET, actionsForPreset, presetKeymap, isPreset, loadPreset, savePreset, PRESET_STORAGE_KEY,
  exportKeymap, parseKeymapImport, EXPORT_FORMAT,
} from '../src/utils/keymapPresets.js'

const memStorage = () => {
  const m = new Map()
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

// ---------- 全局作用域与冲突 ----------

test('palette.open is a global action bound to Ctrl+K by default and the default keymap stays conflict-free', () => {
  const a = ACTIONS.find((x) => x.id === 'palette.open')
  assert.equal(a.scope, SCOPE_GLOBAL)
  assert.deepEqual(a.keys, ['Ctrl+K'])
  assert.deepEqual(findConflicts(buildKeymap()), [])
  assert.equal(resolveAction(buildKeymap(), 'Ctrl+K', [SCOPE_GLOBAL]), 'palette.open')
  assert.equal(resolveAction(buildKeymap(), 'Ctrl+K', [SCOPE_TIMELINE]), null)
})

test('global actions conflict with the same combo in any scope (they fire everywhere)', () => {
  const km = buildKeymap({ 'clip.split': ['Ctrl+K'] })
  const c = findConflicts(km)
  assert.equal(c.length, 1)
  assert.equal(c[0].combo, 'Ctrl+K')
  assert.deepEqual(c[0].actions.sort(), ['clip.split', 'palette.open'])
  const km2 = buildKeymap({ 'shot.regenerate': ['Ctrl+K'] })
  assert.deepEqual(findConflicts(km2)[0].actions.sort(), ['palette.open', 'shot.regenerate'])
  assert.deepEqual(conflictsFor(buildKeymap(), 'clip.split', 'ctrl+k'), ['palette.open'])
  assert.deepEqual(conflictsFor(buildKeymap(), 'palette.open', 'S'), ['clip.split'])
  // 不同作用域之间（都不是全局）仍不冲突
  assert.deepEqual(conflictsFor(buildKeymap(), 'shot.regenerate', 'S'), [])
})

test('a global combo shared by timeline and workbench actions reports one conflict per scope', () => {
  const km = buildKeymap({ 'clip.split': ['Ctrl+K'], 'shot.regenerate': ['Ctrl+K'] })
  const c = findConflicts(km)
  assert.equal(c.length, 2)
  assert.deepEqual(c.map((x) => x.scope).sort(), [SCOPE_TIMELINE, SCOPE_WORKBENCH])
  assert.ok(c.every((x) => x.actions.includes('palette.open')))
})

// ---------- 预设 ----------

test('presets: jianying is the untouched default, premiere differs; ids are known', () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ['jianying', 'premiere'])
  assert.equal(DEFAULT_PRESET, 'jianying')
  assert.equal(isPreset('premiere'), true)
  assert.equal(isPreset('final-cut'), false)
  assert.equal(actionsForPreset('jianying'), ACTIONS)
  assert.equal(actionsForPreset('nope'), ACTIONS, 'unknown preset falls back to default')
  assert.deepEqual(presetKeymap('jianying'), buildKeymap())
})

test('premiere preset: Ctrl+K splits, palette moves to Ctrl+Shift+P, Shift+M mutes; no conflicts; all actions present', () => {
  const km = presetKeymap('premiere')
  assert.deepEqual(km['clip.split'], ['Ctrl+K'])
  assert.deepEqual(km['palette.open'], ['Ctrl+Shift+P'])
  assert.deepEqual(km['track.mute'], ['Shift+M'])
  assert.deepEqual(km['edit.redo'], ['Ctrl+Shift+Z'])
  assert.deepEqual(km['shot.regenerate'], ['R'], 'actions the preset does not list keep the default keys')
  assert.deepEqual(Object.keys(km).sort(), ACTIONS.map((a) => a.id).sort())
  assert.deepEqual(findConflicts(km, actionsForPreset('premiere')), [])
  const actions = actionsForPreset('premiere')
  assert.equal(resolveAction(km, 'Ctrl+K', [SCOPE_TIMELINE], actions), 'clip.split')
  assert.equal(resolveAction(km, 'Ctrl+Shift+P', [SCOPE_GLOBAL], actions), 'palette.open')
  assert.equal(resolveAction(km, 'Ctrl+K', [SCOPE_GLOBAL], actions), null)
  // 同一个键在剪映预设里切分是 S
  assert.equal(resolveAction(presetKeymap('jianying'), 'S', [SCOPE_TIMELINE]), 'clip.split')
})

test('premiere preset keys are all canonical combos', () => {
  for (const [id, combos] of Object.entries(presetKeymap('premiere'))) {
    for (const c of combos) assert.equal(normalizeCombo(c), c, `${id}: ${c}`)
  }
})

test('overrides are relative to the active preset: diffOverrides drops entries equal to the preset', () => {
  const actions = actionsForPreset('premiere')
  const km = buildKeymap({ 'clip.split': ['B'], 'track.mute': ['Shift+M'] }, actions)
  assert.deepEqual(diffOverrides(km, actions), { 'clip.split': ['B'] })
  // 同一份覆盖放在剪映预设下，track.mute 才算自定义
  assert.deepEqual(diffOverrides(buildKeymap({ 'track.mute': ['Shift+M'] })), { 'track.mute': ['Shift+M'] })
})

test('custom binding on top of a preset: conflict detection and reset to the preset value', () => {
  const actions = actionsForPreset('premiere')
  const km = buildKeymap({ 'track.mute': ['Ctrl+K'] }, actions)
  const c = findConflicts(km, actions)
  assert.deepEqual(c[0].actions.sort(), ['clip.split', 'track.mute'])
  // 重置 = 去掉该动作的覆盖项，回到预设键位
  const reset = buildKeymap({}, actions)
  assert.deepEqual(reset['track.mute'], ['Shift+M'])
  assert.deepEqual(findConflicts(reset, actions), [])
})

test('preset persistence: default is not stored, garbage and broken storage fall back to default', () => {
  const st = memStorage()
  assert.equal(loadPreset(st), 'jianying')
  assert.equal(savePreset('premiere', st), true)
  assert.equal(st.m.get(PRESET_STORAGE_KEY), 'premiere')
  assert.equal(loadPreset(st), 'premiere')
  savePreset('jianying', st)
  assert.equal(st.m.has(PRESET_STORAGE_KEY), false)
  st.setItem(PRESET_STORAGE_KEY, 'bogus')
  assert.equal(loadPreset(st), 'jianying')
  const broken = { getItem() { throw new Error('x') }, setItem() { throw new Error('x') }, removeItem() { throw new Error('x') } }
  assert.equal(loadPreset(broken), 'jianying')
  assert.equal(savePreset('premiere', broken), false)
})

// ---------- 导入导出 ----------

test('export -> import round-trips preset and overrides', () => {
  const text = exportKeymap('premiere', { 'clip.split': ['B'], 'zoom.in': ['Ctrl+=', '='] })
  const obj = JSON.parse(text)
  assert.equal(obj.format, EXPORT_FORMAT)
  assert.equal(obj.version, 1)
  assert.equal(obj.preset, 'premiere')
  const r = parseKeymapImport(text)
  assert.equal(r.ok, true)
  assert.equal(r.preset, 'premiere')
  assert.deepEqual(r.overrides, { 'clip.split': ['B'], 'zoom.in': ['Ctrl+=', '='] })
  assert.deepEqual(r.warnings, [])
})

test('import normalises combos, drops duplicates, unknown actions and invalid combos with warnings', () => {
  const r = parseKeymapImport(JSON.stringify({
    format: EXPORT_FORMAT, version: 1, preset: 'jianying',
    overrides: { 'clip.split': ['shift+ctrl+b', 'Shift+Ctrl+B', ''], 'no.such.action': ['X'], 'edit.undo': 'Ctrl+Z', 'zoom.in': [5, 'ctrl'] },
  }))
  assert.equal(r.ok, true)
  assert.deepEqual(r.overrides['clip.split'], ['Ctrl+Shift+B'])
  assert.equal(r.overrides['edit.undo'], undefined)
  assert.deepEqual(r.overrides['zoom.in'], [])
  assert.ok(r.warnings.some((w) => w.includes('no.such.action')))
  assert.ok(r.warnings.some((w) => w.includes('edit.undo')))
  assert.ok(r.warnings.some((w) => w.includes('zoom.in')))
})

test('import drops overrides identical to the preset and reports conflicts without rejecting', () => {
  const same = parseKeymapImport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, preset: 'premiere', overrides: { 'clip.split': ['ctrl+k'] } }))
  assert.deepEqual(same.overrides, {})
  const clash = parseKeymapImport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, preset: 'jianying', overrides: { 'clip.split': ['M'] } }))
  assert.equal(clash.ok, true)
  assert.ok(clash.warnings.some((w) => w.includes('冲突')))
})

test('import rejects non-JSON, wrong format, wrong version; unknown preset falls back with a warning', () => {
  assert.equal(parseKeymapImport('not json').ok, false)
  assert.equal(parseKeymapImport('[]').ok, false)
  assert.equal(parseKeymapImport('null').ok, false)
  assert.equal(parseKeymapImport(JSON.stringify({ format: 'other', version: 1 })).ok, false)
  assert.equal(parseKeymapImport(JSON.stringify({ format: EXPORT_FORMAT, version: 2 })).ok, false)
  const r = parseKeymapImport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, preset: 'final-cut', overrides: {} }))
  assert.equal(r.ok, true)
  assert.equal(r.preset, 'jianying')
  assert.ok(r.warnings.some((w) => w.includes('final-cut')))
  // overrides 缺失 / 类型不对不炸
  assert.deepEqual(parseKeymapImport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, overrides: [1] })).overrides, {})
})
