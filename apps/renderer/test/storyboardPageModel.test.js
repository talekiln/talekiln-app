import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPageGroups, legacyIdsOf, moveFlags, pageSummary, visibleIds } from '../src/components/shot/storyboardPageModel.js'

const groups = [
  { id: 'g1', title: 'Scene A', shots: [
    { id: 's1', legacy_id: 11, params: { title: 'T1', description: 'd1', duration_ms: 2000 }, planned_ms: 2000, dialogue: 'hi', image: 'fresh', video: 'none' },
    { id: 's2', legacy_id: 12, params: { description: 'd2' }, planned_ms: 3500, image: 'stale', video: 'stale' },
  ] },
  { id: 'g2', title: '', shots: [{ id: 's3', legacy_id: null, params: {}, planned_ms: 1000 }] },
]
const numbers = { s1: 1, s2: 2, s3: 3 }

test('buildPageGroups joins legacy rows and numbers', () => {
  const rows = { 11: { id: 11, local_path: 'a/b.png', status: 'completed' } }
  const g = buildPageGroups(groups, { numbers, rows })
  assert.equal(g.length, 2)
  assert.equal(g[0].items[0].thumb, '/static/a/b.png')
  assert.equal(g[0].items[0].status, 'completed')
  assert.equal(g[0].items[1].thumb, '')
  assert.equal(g[0].items[0].no, 1)
  assert.equal(g[0].seconds, 5.5)
  assert.equal(g[1].items[0].legacyId, null)
})

test('drafts override description / dialogue / duration', () => {
  const g = buildPageGroups(groups, { numbers, drafts: { s1: { description: 'edited', duration: 4 } } })
  assert.equal(g[0].items[0].description, 'edited')
  assert.equal(g[0].items[0].duration, 4)
  assert.equal(g[0].items[0].dialogue, 'hi')
})

test('staleOnly keeps only stale shots and drops empty groups', () => {
  const g = buildPageGroups(groups, { numbers, staleIds: new Set(['s2']), staleOnly: true })
  assert.deepEqual(visibleIds(g), ['s2'])
  assert.equal(g.length, 1)
  assert.equal(g[0].items[0].stale, true)
})

test('pageSummary / moveFlags / legacyIdsOf', () => {
  const g = buildPageGroups(groups, { numbers })
  assert.deepEqual(pageSummary(g), { shots: 3, seconds: 6.5 })
  assert.deepEqual(moveFlags(['a', 'b', 'c'], 'a'), { canUp: false, canDown: true })
  assert.deepEqual(moveFlags(['a', 'b', 'c'], 'c'), { canUp: true, canDown: false })
  assert.deepEqual(moveFlags(['a'], 'zz'), { canUp: false, canDown: false })
  assert.deepEqual(legacyIdsOf(['s1', 's3', 'nope'], g.flatMap((x) => x.items)), [11])
})
