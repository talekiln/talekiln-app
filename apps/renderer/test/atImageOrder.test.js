import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AT, buildRefSlots, toCanonical, toDisplay, referencedIndexes, removeSlot, moveSlot, remapCanonical,
} from '../src/components/shot/atImageOrder.js'

const refs = [
  { kind: 'scene', id: 5, name: 'Old Street', thumbUrl: '/s.png' },
  { kind: 'character', id: 1, name: 'Lin', thumbUrl: '/a.png' },
  { kind: 'character', id: 2, name: 'Chen', thumbUrl: '/b.png' },
  { kind: 'prop', id: 9, name: 'Letter', thumbUrl: '/c.png' },
]
const P = { scene: 'S', character: 'C', prop: 'P' }
const slots = buildRefSlots(refs)
const tok = (n) => `${AT}${n}`

test('AT is the canonical @image-N protocol prefix', () => {
  assert.equal(AT, '@图片')
})

test('buildRefSlots orders scene, characters, props and skips ones without an image', () => {
  assert.deepEqual(slots.map((s) => [s.index, s.kind, s.name]), [[1, 'scene', 'Old Street'], [2, 'character', 'Lin'], [3, 'character', 'Chen'], [4, 'prop', 'Letter']])
  const mixed = buildRefSlots([
    { kind: 'prop', id: 1, name: 'p', thumbUrl: '/p' },
    { kind: 'character', id: 2, name: 'c', thumbUrl: '' },
    { kind: 'scene', id: 3, name: 's', thumbUrl: '/s' },
  ])
  assert.deepEqual(mixed.map((s) => s.name), ['s', 'p'])
  assert.deepEqual(mixed.map((s) => s.index), [1, 2])
  assert.deepEqual(buildRefSlots(null), [])
})

test('buildRefSlots caps the list at 10 references', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ kind: 'prop', id: i + 1, name: `p${i}`, thumbUrl: `/p${i}` }))
  assert.equal(buildRefSlots(many).length, 10)
})

test('toDisplay / toCanonical are inverse for unique names', () => {
  const canon = `${tok(2)} meets ${tok(3)} at ${tok(1)}`
  const disp = toDisplay(canon, slots, P)
  assert.equal(disp, '@Lin meets @Chen at @Old Street')
  assert.equal(toCanonical(disp, slots, P), canon)
})

test('duplicate names get a kind prefix and still round-trip', () => {
  const dup = buildRefSlots([
    { kind: 'scene', id: 1, name: 'Rose', thumbUrl: '/1' },
    { kind: 'character', id: 2, name: 'Rose', thumbUrl: '/2' },
  ])
  const canon = `${tok(1)} and ${tok(2)}`
  const disp = toDisplay(canon, dup, P)
  assert.equal(disp, '@S·Rose and @C·Rose')
  assert.equal(toCanonical(disp, dup, P), canon)
})

test('unknown indexes stay canonical; longer names win over prefixes', () => {
  assert.equal(toDisplay(`${tok(9)} x`, slots, P), `${tok(9)} x`)
  const s = buildRefSlots([
    { kind: 'character', id: 1, name: 'Li', thumbUrl: '/1' },
    { kind: 'character', id: 2, name: 'Lin', thumbUrl: '/2' },
  ])
  assert.equal(toCanonical('@Lin waves, @Li nods', s, P), `${tok(2)} waves, ${tok(1)} nods`)
})

test('referencedIndexes lists distinct indexes in order of appearance', () => {
  assert.deepEqual(referencedIndexes(`${tok(3)} ${tok(1)} ${tok(3)}`), [3, 1])
  assert.deepEqual(referencedIndexes(''), [])
})

test('removeSlot: deleting the middle image shifts later references and drops its own', () => {
  const text = `${tok(1)} ${tok(2)} ${tok(3)} ${tok(4)}`
  assert.equal(removeSlot(text, 2), `${tok(1)}  ${tok(2)} ${tok(3)}`)
  assert.equal(removeSlot(`${tok(1)} only`, 2), `${tok(1)} only`)
  assert.equal(removeSlot(`${tok(1)} a`, 1), ' a')
})

test('moveSlot keeps each reference pointing at the same asset', () => {
  const text = `${tok(1)} ${tok(2)} ${tok(3)}`
  assert.equal(moveSlot(text, 1, 3), `${tok(3)} ${tok(1)} ${tok(2)}`)
  assert.equal(moveSlot(text, 3, 1), `${tok(2)} ${tok(3)} ${tok(1)}`)
  assert.equal(moveSlot(text, 2, 2), text)
})

test('remapCanonical follows asset identity when the bound set changes', () => {
  const before = buildRefSlots(refs)
  const after = buildRefSlots(refs.filter((r) => r.id !== 1 || r.kind !== 'character'))
  const text = `${tok(3)} ${tok(2)} ${tok(1)}`
  assert.equal(remapCanonical(text, before, after), `${tok(2)}  ${tok(1)}`)
  const reorder = buildRefSlots([refs[0], refs[2], refs[1], refs[3]])
  assert.equal(remapCanonical(`${tok(1)} ${tok(2)} ${tok(3)}`, before, reorder), `${tok(1)} ${tok(3)} ${tok(2)}`)
})
