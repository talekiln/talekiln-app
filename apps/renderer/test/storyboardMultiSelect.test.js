import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emptySelection, clickSelect, selectAll, pruneSelection, isSelected, batchAvailability, generateTargets,
} from '../src/components/shot/multiSelectModel.js'

const order = ['a', 'b', 'c', 'd', 'e']

test('plain click selects exactly one and sets the anchor', () => {
  let s = clickSelect(emptySelection(), order, 'b', {})
  assert.deepEqual(s.ids, ['b'])
  assert.equal(s.anchor, 'b')
  s = clickSelect(s, order, 'd', {})
  assert.deepEqual(s.ids, ['d'])
})

test('plain click on the only selected item clears nothing (stays selected)', () => {
  const s = clickSelect(clickSelect(emptySelection(), order, 'b', {}), order, 'b', {})
  assert.deepEqual(s.ids, ['b'])
})

test('ctrl/meta click toggles and moves the anchor', () => {
  let s = clickSelect(emptySelection(), order, 'a', {})
  s = clickSelect(s, order, 'c', { ctrl: true })
  assert.deepEqual(s.ids, ['a', 'c'])
  assert.equal(s.anchor, 'c')
  s = clickSelect(s, order, 'a', { meta: true })
  assert.deepEqual(s.ids, ['c'])
})

test('shift click selects the range from the anchor in display order, either direction', () => {
  let s = clickSelect(emptySelection(), order, 'b', {})
  s = clickSelect(s, order, 'd', { shift: true })
  assert.deepEqual(s.ids, ['b', 'c', 'd'])
  assert.equal(s.anchor, 'b')
  s = clickSelect(s, order, 'a', { shift: true })
  assert.deepEqual(s.ids, ['a', 'b'])
})

test('shift without an anchor behaves like a plain click', () => {
  const s = clickSelect(emptySelection(), order, 'c', { shift: true })
  assert.deepEqual(s.ids, ['c'])
  assert.equal(s.anchor, 'c')
})

test('ctrl+shift adds the range to the existing selection', () => {
  let s = clickSelect(emptySelection(), order, 'a', {})
  s = clickSelect(s, order, 'c', { ctrl: true })
  s = clickSelect(s, order, 'e', { ctrl: true, shift: true })
  assert.deepEqual(s.ids, ['a', 'c', 'd', 'e'])
})

test('selection ids are always kept in display order', () => {
  let s = clickSelect(emptySelection(), order, 'd', {})
  s = clickSelect(s, order, 'a', { ctrl: true })
  assert.deepEqual(s.ids, ['a', 'd'])
})

test('selectAll, isSelected and pruneSelection', () => {
  const all = selectAll(order)
  assert.deepEqual(all.ids, order)
  assert.equal(isSelected(all, 'c'), true)
  assert.equal(isSelected(emptySelection(), 'c'), false)
  const pruned = pruneSelection({ ids: ['a', 'x', 'c'], anchor: 'x' }, ['a', 'b', 'c'])
  assert.deepEqual(pruned.ids, ['a', 'c'])
  assert.equal(pruned.anchor, null)
})

const shots = {
  a: { id: 'a', image: 'none', video: 'none' },
  b: { id: 'b', image: 'fresh', video: 'none' },
  c: { id: 'c', image: 'fresh', video: 'fresh' },
}

test('batchAvailability: nothing selected disables everything', () => {
  const av = batchAvailability({ ids: [], anchor: null }, shots, {})
  assert.equal(av.count, 0)
  assert.deepEqual([av.generate.enabled, av.regenerate.enabled, av.delete.enabled], [false, false, false])
  assert.equal(av.generate.reason, 'empty')
})

test('batchAvailability: generate and delete for a normal selection', () => {
  const av = batchAvailability({ ids: ['a', 'b'], anchor: 'a' }, shots, {})
  assert.equal(av.count, 2)
  assert.equal(av.generate.enabled, true)
  assert.equal(av.delete.enabled, true)
  assert.equal(av.regenerate.enabled, true)
})

test('batchAvailability: regenerate needs at least one shot that already has output', () => {
  const av = batchAvailability({ ids: ['a'], anchor: 'a' }, shots, {})
  assert.equal(av.regenerate.enabled, false)
  assert.equal(av.regenerate.reason, 'nothingToRedo')
})

test('batchAvailability: busy shots are excluded; all busy disables generate and delete', () => {
  const busy = { a: true, b: true }
  const av = batchAvailability({ ids: ['a', 'b'], anchor: 'a' }, shots, busy)
  assert.equal(av.generate.enabled, false)
  assert.equal(av.generate.reason, 'allBusy')
  assert.equal(av.delete.enabled, false)
  const part = batchAvailability({ ids: ['a', 'c'], anchor: 'a' }, shots, { a: true })
  assert.equal(part.generate.enabled, true)
  assert.deepEqual(generateTargets({ ids: ['a', 'c'], anchor: 'a' }, { a: true }), ['c'])
})

test('batchAvailability: a global flag (e.g. regenerate in progress) disables writes', () => {
  const av = batchAvailability({ ids: ['a'], anchor: 'a' }, shots, {}, { locked: true })
  assert.equal(av.generate.enabled, false)
  assert.equal(av.delete.enabled, false)
  assert.equal(av.delete.reason, 'locked')
})
