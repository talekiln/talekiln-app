import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIONS, normalizeCombo, eventToCombo, buildKeymap, findConflicts, conflictsFor, resolveAction,
  diffOverrides, loadOverrides, saveOverrides, STORAGE_KEY, SCOPE_TIMELINE, SCOPE_WORKBENCH,
} from '../src/utils/keymap.js'
import { createHistory } from '../src/utils/editHistory.js'
import {
  createDraftWriter, assessRecovery, mergeDraft, makeDraft, draftKey, parseDraft,
} from '../src/utils/draft.js'

const memStorage = () => {
  const m = new Map()
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
const ev = (o) => ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o })

// ---------- keymap ----------

test('normalizeCombo canonicalises order, case and aliases', () => {
  assert.equal(normalizeCombo('shift+ctrl+z'), 'Ctrl+Shift+Z')
  assert.equal(normalizeCombo('cmd+Z'), 'Ctrl+Z')
  assert.equal(normalizeCombo('del'), 'Delete')
  assert.equal(normalizeCombo(' '), '')
  assert.equal(normalizeCombo('Ctrl++'), 'Ctrl++')
  assert.equal(normalizeCombo('Ctrl+'), '')
  assert.equal(normalizeCombo('ctrl'), '')
})

test('eventToCombo uses physical code for letters/digits and ignores bare modifiers', () => {
  assert.equal(eventToCombo(ev({ key: '¡', code: 'Digit1', altKey: true })), 'Alt+1')
  assert.equal(eventToCombo(ev({ key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Z')
  assert.equal(eventToCombo(ev({ key: ' ', code: 'Space' })), 'Space')
  assert.equal(eventToCombo(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })), '')
  assert.equal(eventToCombo(ev({ key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true })), 'Shift+ArrowLeft')
  assert.equal(eventToCombo(ev({ key: 'z', code: 'KeyZ', metaKey: true })), 'Ctrl+Z')
})

test('default keymap resolves the JianYing-style defaults', () => {
  const km = buildKeymap()
  const r = (e) => resolveAction(km, e, [SCOPE_TIMELINE, SCOPE_WORKBENCH])
  assert.equal(r(ev({ key: ' ', code: 'Space' })), 'play.toggle')
  assert.equal(r(ev({ key: 's', code: 'KeyS' })), 'clip.split')
  assert.equal(r(ev({ key: 'Delete', code: 'Delete' })), 'clip.delete')
  assert.equal(r(ev({ key: 'z', code: 'KeyZ', ctrlKey: true })), 'edit.undo')
  assert.equal(r(ev({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true })), 'edit.redo')
  assert.equal(r(ev({ key: 'ArrowRight', code: 'ArrowRight' })), 'playhead.nextFrame')
  assert.equal(r(ev({ key: 'Home', code: 'Home' })), 'playhead.home')
  assert.equal(r(ev({ key: 'm', code: 'KeyM' })), 'track.mute')
  assert.equal(r(ev({ key: '=', code: 'Equal' })), 'zoom.in')
  assert.equal(r(ev({ key: '-', code: 'Minus' })), 'zoom.out')
  assert.equal(r(ev({ key: 'r', code: 'KeyR' })), 'shot.regenerate')
  assert.equal(r(ev({ key: '3', code: 'Digit3', altKey: true })), 'shot.pick3')
  assert.equal(r(ev({ key: 'Tab', code: 'Tab' })), 'shot.compareToggle')
  assert.equal(r(ev({ key: 'q', code: 'KeyQ' })), null)
})

test('scope limits resolution', () => {
  const km = buildKeymap()
  assert.equal(resolveAction(km, 'R', [SCOPE_TIMELINE]), null)
  assert.equal(resolveAction(km, 'R', [SCOPE_WORKBENCH]), 'shot.regenerate')
})

test('default keymap has no conflicts and every action id is unique', () => {
  assert.deepEqual(findConflicts(buildKeymap()), [])
  assert.equal(new Set(ACTIONS.map((a) => a.id)).size, ACTIONS.length)
})

test('conflict detection: same scope conflicts, cross-scope does not', () => {
  const km = buildKeymap({ 'clip.split': ['M'] })
  const c = findConflicts(km)
  assert.equal(c.length, 1)
  assert.deepEqual(c[0].actions.sort(), ['clip.split', 'track.mute'])
  // R is workbench-only; binding R to a timeline action is not a conflict
  assert.deepEqual(conflictsFor(buildKeymap(), 'clip.split', 'r'), [])
  assert.deepEqual(conflictsFor(buildKeymap(), 'clip.split', 'm'), ['track.mute'])
  assert.deepEqual(conflictsFor(buildKeymap(), 'clip.split', 'S'), [])
})

test('overrides: diffOverrides keeps only changes; persistence round-trips and survives garbage', () => {
  const km = buildKeymap({ 'clip.split': ['B'] })
  const ov = diffOverrides(km)
  assert.deepEqual(ov, { 'clip.split': ['B'] })
  const st = memStorage()
  assert.equal(saveOverrides(ov, st), true)
  assert.deepEqual(loadOverrides(st), ov)
  assert.equal(buildKeymap(loadOverrides(st))['clip.split'][0], 'B')
  saveOverrides({}, st)
  assert.equal(st.m.has(STORAGE_KEY), false)
  st.setItem(STORAGE_KEY, '{not json')
  assert.deepEqual(loadOverrides(st), {})
  st.setItem(STORAGE_KEY, JSON.stringify({ 'bogus.id': ['A'], 'clip.split': 'x', 'track.mute': ['K'] }))
  assert.deepEqual(loadOverrides(st), { 'track.mute': ['K'] })
  assert.equal(saveOverrides({ a: ['B'] }, { setItem() { throw new Error('quota') }, removeItem() {} }), false)
})

// ---------- undo / redo ----------

test('history undo/redo and redo invalidation', () => {
  const h = createHistory()
  assert.equal(h.undo('x'), null)
  h.record('s0', 'a')
  h.record('s1', 'b')
  assert.equal(h.undoLabel, 'b')
  assert.equal(h.undo('s2'), 's1')
  assert.equal(h.canRedo, true)
  assert.equal(h.redo('s1'), 's2')
  assert.equal(h.undo('s2'), 's1')
  h.record('s1', 'c') // new edit clears redo
  assert.equal(h.canRedo, false)
  assert.equal(h.undo('s3'), 's1')
  assert.equal(h.undo('s1'), 's0')
  assert.equal(h.canUndo, false)
})

test('history limit and coalescing', () => {
  const h = createHistory({ limit: 3 })
  for (let i = 0; i < 6; i++) h.record(`s${i}`)
  assert.equal(h.size, 3)
  assert.equal(h.undo('x'), 's5')

  let t = 0
  const c = createHistory({ coalesceMs: 100, now: () => t })
  c.record('a', 'nudge', 'k')
  t = 50
  c.record('b', 'nudge', 'k') // merged
  t = 500
  c.record('c', 'nudge', 'k') // too late, new step
  assert.equal(c.size, 2)
  assert.equal(c.undo('z'), 'c')
  assert.equal(c.undo('c'), 'a')
})

// ---------- drafts ----------

const server = (extra = {}) => ({ id: 't1', episode_id: 7, version: 3, tracks: [{ id: 'v', kind: 'video', clips: [] }], ...extra })
const edited = () => [{ id: 'v', kind: 'video', clips: [{ id: 'c1', start_ms: 0, duration_ms: 1000 }] }]

test('assessRecovery decisions', () => {
  const srv = server()
  const d = makeDraft({ ...srv, tracks: edited() }, 1000)
  assert.equal(d.baseVersion, 3)
  assert.deepEqual(assessRecovery(null, srv), { action: 'none', discard: false, conflict: false })
  assert.deepEqual(assessRecovery(d, srv), { action: 'prompt', discard: false, conflict: false })
  assert.deepEqual(assessRecovery({ ...d, baseVersion: 2 }, srv), { action: 'prompt', discard: false, conflict: true })
  assert.deepEqual(assessRecovery({ ...d, tracks: srv.tracks }, srv), { action: 'none', discard: true, conflict: false })
  assert.deepEqual(assessRecovery({ ...d, timelineId: 'other' }, srv), { action: 'none', discard: true, conflict: false })
})

test('mergeDraft takes draft tracks onto server version without aliasing', () => {
  const srv = server({ version: 5 })
  const d = makeDraft({ ...srv, tracks: edited() })
  const m = mergeDraft(srv, d)
  assert.equal(m.version, 5)
  assert.deepEqual(m.tracks, d.tracks)
  m.tracks[0].clips[0].start_ms = 99
  assert.equal(d.tracks[0].clips[0].start_ms, 0)
})

test('parseDraft rejects malformed data', () => {
  assert.equal(parseDraft('nope'), null)
  assert.equal(parseDraft('{"tracks":1}'), null)
  assert.equal(parseDraft(JSON.stringify({ timelineId: 't', tracks: [] })).timelineId, 't')
})

function fakeTimers() {
  let next = 1
  const q = new Map()
  return { q, setTimer: (fn) => { q.set(next, fn); return next++ }, clearTimer: (id) => q.delete(id), fire() { const fns = [...q.values()]; q.clear(); fns.forEach((f) => f()) } }
}

test('draft writer batches edits into a single write of the latest state', () => {
  const st = memStorage()
  const ft = fakeTimers()
  const w = createDraftWriter({ storage: st, setTimer: ft.setTimer, clearTimer: ft.clearTimer })
  const key = draftKey(7)
  let writes = 0
  const orig = st.setItem
  st.setItem = (k, v) => { writes++; orig(k, v) }
  let state = 1
  w.schedule(key, () => ({ timelineId: 't1', tracks: [], v: state }))
  state = 2
  w.schedule(key, () => ({ timelineId: 't1', tracks: [], v: state }))
  state = 3
  assert.equal(ft.q.size, 1) // one timer for the whole batch
  assert.equal(writes, 0)
  ft.fire()
  assert.equal(writes, 1)
  assert.equal(w.read(key).v, 3)
  assert.equal(w.hasPending, false)
})

test('draft writer flush writes immediately; clear cancels pending and removes; storage errors are swallowed', () => {
  const st = memStorage()
  const ft = fakeTimers()
  const w = createDraftWriter({ storage: st, setTimer: ft.setTimer, clearTimer: ft.clearTimer })
  const key = draftKey(1)
  w.schedule(key, () => ({ timelineId: 'a', tracks: [] }))
  assert.equal(w.flush(), true)
  assert.ok(w.read(key))
  assert.equal(ft.q.size, 0)
  w.schedule(key, () => ({ timelineId: 'a', tracks: [], x: 1 }))
  w.clear(key)
  assert.equal(ft.q.size, 0)
  assert.equal(w.read(key), null)

  const bad = createDraftWriter({ storage: { setItem() { throw new Error('quota') }, getItem() { return null }, removeItem() {} }, setTimer: ft.setTimer, clearTimer: ft.clearTimer })
  bad.schedule(key, () => ({ timelineId: 'a', tracks: [] }))
  assert.equal(bad.flush(), false)
})
