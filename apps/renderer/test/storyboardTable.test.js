import test from 'node:test'
import assert from 'node:assert/strict'
import {
  rowFromApi, moveRow, removeRow, renumber, totalDuration, rowWarnings, patchFromRow,
  createAutosaver, buildProjectRequest, statusLabel, saveStateText,
} from '../src/utils/storyboardTable.js'

const rows = [1, 2, 3].map((n) => ({ id: n * 10, no: n, description: 'd', dialogue: '', duration: 3, thumb: '', status: 'pending' }))

test('rowFromApi prefers local_path for thumbnail', () => {
  const r = rowFromApi({ id: 1, storyboard_number: 2, description: 'x', dialogue: null, duration: '3.5', local_path: 'a/b.png', image_url: 'http://x' })
  assert.equal(r.thumb, '/static/a/b.png')
  assert.equal(r.duration, 3.5)
  assert.equal(r.dialogue, '')
  assert.equal(rowFromApi({ id: 1, image_url: 'http://x' }).thumb, 'http://x')
})

test('moveRow reorders and renumbers; out-of-range is a no-op', () => {
  const m = moveRow(rows, 0, 2)
  assert.deepEqual(m.map((r) => r.id), [20, 30, 10])
  assert.deepEqual(m.map((r) => r.no), [1, 2, 3])
  assert.equal(moveRow(rows, 0, 5), rows)
  assert.equal(moveRow(rows, 1, 1), rows)
})

test('removeRow renumbers; totalDuration sums', () => {
  assert.deepEqual(removeRow(rows, 20).map((r) => r.no), [1, 2])
  assert.equal(totalDuration(rows), 9)
  assert.deepEqual(renumber([{ id: 1, no: 9 }]).map((r) => r.no), [1])
})

test('rowWarnings flags duration, long dialogue and empty description', () => {
  assert.deepEqual(rowWarnings({ description: 'a', dialogue: '', duration: 3 }), [])
  assert.equal(rowWarnings({ description: 'a', dialogue: '', duration: 1 }).length, 1)
  assert.match(rowWarnings({ description: 'a', dialogue: '一二三四五六七八九十一二三四五六', duration: 3 })[0], /台词/)
  assert.match(rowWarnings({ description: ' ', dialogue: '', duration: 3 })[0], /画面描述/)
})

test('patchFromRow rounds duration', () => {
  assert.equal(patchFromRow({ description: 'a', dialogue: 'b', duration: '3.14159' }).duration, 3.1)
})

function fakeTimers() {
  let cb = null
  return {
    setTimeout: (f) => { cb = f; return 1 },
    clearTimeout: () => { cb = null },
    fire: () => { const f = cb; cb = null; return f && f() },
    get armed() { return !!cb },
  }
}

test('autosaver debounces, dedupes by key and reports states', async () => {
  const t = fakeTimers()
  const states = []
  const calls = []
  const a = createAutosaver({ timers: t, onState: (s) => states.push(s) })
  a.schedule('u:1', async () => calls.push('old'))
  a.schedule('u:1', async () => calls.push('new'))
  assert.equal(a.state, 'dirty')
  assert.equal(a.pending, 1)
  await t.fire()
  assert.deepEqual(calls, ['new'])
  assert.equal(a.state, 'saved')
  assert.deepEqual(states, ['dirty', 'saving', 'saved'])
})

test('autosaver keeps failed tasks and retries on flush', async () => {
  const t = fakeTimers()
  let fail = true
  const a = createAutosaver({ timers: t })
  a.schedule('order', async () => { if (fail) throw new Error('boom') })
  await t.fire()
  assert.equal(a.state, 'error')
  assert.equal(a.pending, 1)
  fail = false
  assert.equal(await a.flush(), true)
  assert.equal(a.state, 'saved')
  assert.equal(a.pending, 0)
})

test('autosaver cancel clears pending work', () => {
  const t = fakeTimers()
  const a = createAutosaver({ timers: t })
  a.schedule('u:1', async () => {})
  a.cancel('u:1')
  assert.equal(a.state, 'saved')
  assert.equal(t.armed, false)
})

test('autosaver: task rescheduled during a run is kept', async () => {
  const t = fakeTimers()
  const calls = []
  const a = createAutosaver({ timers: t })
  const first = async () => { calls.push('first'); a.schedule('u:1', second) }
  const second = async () => { calls.push('second') }
  a.schedule('u:1', first)
  await t.fire()
  assert.equal(a.state, 'dirty')
  await t.fire()
  assert.deepEqual(calls, ['first', 'second'])
  assert.equal(a.state, 'saved')
})

test('buildProjectRequest validates and builds body', () => {
  const ok = buildProjectRequest({ story: ' 故事 ', templateId: 'guofeng-drama', aspectRatio: '9:16', durationSec: 45, title: '', style: 'cinematic' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.body, { story: '故事', templateId: 'guofeng-drama', aspectRatio: '9:16', durationSec: 45, style: 'cinematic' })
  const bad = buildProjectRequest({ story: '', templateId: '', aspectRatio: '4:3', durationSec: 10 })
  assert.equal(bad.errors.length, 4)
})

test('labels', () => {
  assert.equal(statusLabel('completed'), '已完成')
  assert.equal(statusLabel('weird'), '待生成')
  assert.equal(saveStateText('dirty'), '有未保存的修改')
})
