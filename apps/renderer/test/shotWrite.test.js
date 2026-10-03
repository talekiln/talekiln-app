import test from 'node:test'
import assert from 'node:assert/strict'
import { saveShotPatch, planMove, planAdd, deleteShots, flatShots } from '../src/components/shot/shotWrite.js'

const groups = [
  { id: 'g1', shots: [{ id: 'a' }, { id: 'b' }] },
  { id: 'g2', shots: [{ id: 'c' }] },
  { id: 'g3', shots: [] },
]

test('saveShotPatch routes graph fields to the intent and plain columns to the legacy row', async () => {
  const calls = []
  const deps = {
    intent: async (v, n, a) => { calls.push(['intent', v, n, a]); return { seq: 1 } },
    updateLegacy: async (id, d) => { calls.push(['legacy', id, d]) },
  }
  const r = await saveShotPatch(deps, { id: 'shot_1', legacyId: 7 }, { description: 'x', duration: 2.5, scene_id: 3, dialogue: 'hi' })
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0], ['intent', 'shot', 'setShotField', { shot_id: 'shot_1', patch: { description: 'x', duration_ms: 2500 } }])
  assert.deepEqual(calls[1], ['legacy', 7, { scene_id: 3, dialogue: 'hi' }])
})

test('saveShotPatch makes no direct write when only graph fields change', async () => {
  let legacy = 0
  const r = await saveShotPatch({ intent: async () => ({}), updateLegacy: async () => { legacy++ } }, { id: 's', legacyId: 1 }, { title: 'T' })
  assert.equal(r.ok, true)
  assert.equal(legacy, 0)
})

test('saveShotPatch stops when the intent fails and reports bad durations', async () => {
  let legacy = 0
  const deps = { intent: async () => null, updateLegacy: async () => { legacy++ } }
  assert.deepEqual(await saveShotPatch(deps, { id: 's', legacyId: 1 }, { description: 'x', scene_id: 2 }), { ok: false, error: 'intent' })
  assert.equal(legacy, 0)
  assert.equal((await saveShotPatch(deps, { id: 's', legacyId: 1 }, { duration: 0 })).ok, false)
  assert.equal((await saveShotPatch({ intent: async () => ({}), updateLegacy: async () => {} }, { id: 's', legacyId: null }, { scene_id: 2 })).error, 'noLegacyRow')
})

test('saveShotPatch reports a failing legacy write', async () => {
  const r = await saveShotPatch({ intent: async () => ({}), updateLegacy: async () => { throw new Error('boom') } }, { id: 's', legacyId: 1 }, { scene_id: 1 })
  assert.deepEqual(r, { ok: false, error: 'boom' })
})

test('planMove swaps inside a group and crosses group boundaries', () => {
  assert.deepEqual(planMove(groups, 'a', 1), { name: 'reorderShots', args: { group_id: 'g1', ids: ['b', 'a'] } })
  assert.deepEqual(planMove(groups, 'b', 1), { name: 'moveShotToGroup', args: { shot_id: 'b', group_id: 'g2', index: 0 } })
  assert.deepEqual(planMove(groups, 'c', -1), { name: 'moveShotToGroup', args: { shot_id: 'c', group_id: 'g1', index: 2 } })
  assert.equal(planMove(groups, 'a', -1), null)
  assert.equal(planMove(groups, 'nope', 1), null)
})

test('planMove can move into an empty trailing group', () => {
  assert.deepEqual(planMove(groups, 'c', 1), { name: 'moveShotToGroup', args: { shot_id: 'c', group_id: 'g3', index: 0 } })
})

test('planAdd inserts after the selected shot or at the end of the last group', () => {
  assert.deepEqual(planAdd(groups, 'a'), { group: 'g1', index: 1 })
  assert.deepEqual(planAdd(groups, null), { group: 'g3', index: 0 })
  assert.equal(planAdd([], null), null)
})

test('deleteShots deletes in order and stops on failure', async () => {
  const seen = []
  const r = await deleteShots({ intent: async (v, n, a) => { seen.push(a.shot_id); return a.shot_id === 'b' ? null : {} } }, ['a', 'b', 'c'])
  assert.deepEqual(seen, ['a', 'b'])
  assert.deepEqual(r, { ok: false, done: ['a'] })
})

test('flatShots keeps display order', () => {
  assert.deepEqual(flatShots(groups), ['a', 'b', 'c'])
})
