import test from 'node:test'
import assert from 'node:assert/strict'

import {
  toSlots, pickableAt, defaultCompare, toggleCompare, setCompareSide, createCompare, shownSlot,
  buildWorkbenchHandlers, candidateVideoSrc,
} from '../src/utils/shotWorkbench.js'
import {
  buildCandidateRequest, isLockable, lockBody, isLockedCandidate, indexLocks, candidateImageSrc,
} from '../src/utils/referenceLibrary.js'
import { ACTIONS, buildKeymap, resolveAction, SCOPE_WORKBENCH } from '../src/utils/keymap.js'

const done = (id, slot, extra = {}) => ({ id, slot, status: 'completed', video_url: `http://v/${id}.mp4`, ...extra })

test('toSlots fills four fixed slots', () => {
  const s = toSlots([done(10, 1), done(11, 3), { id: 12, slot: 9 }])
  assert.equal(s.length, 4)
  assert.equal(s[0].id, 10)
  assert.equal(s[1], null)
  assert.equal(s[2].id, 11)
  assert.equal(s[3], null)
})

test('pickableAt only returns completed candidates', () => {
  const s = toSlots([done(1, 1), { id: 2, slot: 2, status: 'processing' }])
  assert.equal(pickableAt(s, 1).id, 1)
  assert.equal(pickableAt(s, 2), null)
  assert.equal(pickableAt(s, 4), null)
})

test('defaultCompare prefers adopted as A and another playable as B', () => {
  const s = toSlots([done(1, 1), done(2, 2), done(3, 3)])
  assert.deepEqual(defaultCompare(s, 2), { a: 2, b: 1, showing: 'a' })
  assert.deepEqual(defaultCompare(s, null), { a: 1, b: 2, showing: 'a' })
  assert.deepEqual(defaultCompare(toSlots([done(1, 1)]), null), { a: 1, b: null, showing: 'a' })
  assert.deepEqual(defaultCompare(toSlots([]), null), { a: null, b: null, showing: 'a' })
})

test('toggleCompare flips only when both sides exist', () => {
  let st = { a: 1, b: 2, showing: 'a' }
  st = toggleCompare(st)
  assert.equal(st.showing, 'b')
  assert.equal(shownSlot(st), 2)
  assert.equal(toggleCompare(st).showing, 'a')
  assert.equal(toggleCompare({ a: 1, b: null, showing: 'b' }).showing, 'a')
})

test('setCompareSide clears the other side when equal', () => {
  const st = setCompareSide({ ...createCompare(), a: 1, b: 2 }, 'a', 2)
  assert.equal(st.a, 2)
  assert.equal(st.b, null)
})

test('workbench keys R / Alt+1..4 / Tab resolve to real handlers', () => {
  const calls = []
  const handlers = buildWorkbenchHandlers({
    regenerate: () => calls.push('regen'), pick: (n) => calls.push('pick' + n), toggleCompare: () => calls.push('toggle'),
    markIn: () => calls.push('in'), markOut: () => calls.push('out'),
  })
  const km = buildKeymap()
  const ev = (o) => ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o })
  const fire = (e) => { const id = resolveAction(km, ev(e), [SCOPE_WORKBENCH]); handlers[id]?.() }
  fire({ key: 'r', code: 'KeyR' })
  fire({ key: '1', code: 'Digit1', altKey: true })
  fire({ key: '4', code: 'Digit4', altKey: true })
  fire({ key: 'Tab', code: 'Tab' })
  fire({ key: 'i', code: 'KeyI' })
  fire({ key: 'o', code: 'KeyO' })
  assert.deepEqual(calls, ['regen', 'pick1', 'pick4', 'toggle', 'in', 'out'])
  for (const a of ACTIONS.filter((x) => x.scope === SCOPE_WORKBENCH)) assert.ok(handlers[a.id], a.id)
  // 没接入入出点的页面也不会因为按了 I / O 报错
  const bare = buildWorkbenchHandlers({ regenerate() {}, pick() {}, toggleCompare() {} })
  assert.doesNotThrow(() => { bare['shot.markIn'](); bare['shot.markOut']() })
})

test('candidateVideoSrc prefers local path', () => {
  assert.equal(candidateVideoSrc({ local_path: 'videos/a.mp4', video_url: 'http://x' }), '/static/videos/a.mp4')
  assert.equal(candidateVideoSrc({ video_url: 'http://x' }), 'http://x')
})

test('reference library: candidate request, lockability and lock matching', () => {
  const r = buildCandidateRequest({ kind: 'character', entity: { name: '小明', appearance: '黑发' }, dramaId: '3', model: 'img', style: 's' })
  assert.equal(r.drama_id, 3)
  assert.match(r.prompt, /小明，黑发/)
  assert.equal(r.character_id, undefined)
  assert.equal(r.scene_id, undefined)
  const sc = buildCandidateRequest({ kind: 'scene', entity: { location: '教室', time: '黄昏' }, dramaId: 3 })
  assert.match(sc.prompt, /教室，黄昏/)
  assert.equal(isLockable({ status: 'completed', image_url: 'u' }), true)
  assert.equal(isLockable({ status: 'processing', image_url: 'u' }), false)
  assert.deepEqual(lockBody({ id: 7, image_url: 'u', local_path: 'p' }), { image_url: 'u', local_path: 'p', source_image_id: 7 })
  assert.equal(isLockedCandidate({ id: 7 }, { source_image_id: 7 }), true)
  assert.equal(isLockedCandidate({ id: 8 }, { source_image_id: 7 }), false)
  assert.equal(isLockedCandidate({ image_url: 'u' }, { image_url: 'u' }), true)
  assert.equal(isLockedCandidate(null, {}), false)
  assert.deepEqual(Object.keys(indexLocks('scene', [{ entity_id: 2 }])), ['scene:2'])
  assert.equal(candidateImageSrc({ local_path: 'a/b.png' }), '/static/a/b.png')
})
