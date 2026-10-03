import test from 'node:test'
import assert from 'node:assert/strict'
import {
  slotState, nextSlotState, buildFrameSlots, pickSlotImages, historyItems,
} from '../src/components/shot/frameSlots.js'

test('slotState: none -> generating -> has -> stale priority', () => {
  assert.equal(slotState({}), 'none')
  assert.equal(slotState({ hasImage: true }), 'has')
  assert.equal(slotState({ hasImage: true, stale: true }), 'stale')
  assert.equal(slotState({ hasImage: false, stale: true }), 'none')
  assert.equal(slotState({ hasImage: true, stale: true, generating: true }), 'generating')
  assert.equal(slotState({ generating: true }), 'generating')
})

test('nextSlotState drives the state machine', () => {
  assert.equal(nextSlotState('none', 'start'), 'generating')
  assert.equal(nextSlotState('has', 'start'), 'generating')
  assert.equal(nextSlotState('stale', 'start'), 'generating')
  assert.equal(nextSlotState('generating', 'start'), 'generating')
  assert.equal(nextSlotState('generating', 'done'), 'has')
  assert.equal(nextSlotState('generating', 'fail', { hadImage: true }), 'has')
  assert.equal(nextSlotState('generating', 'fail', { hadImage: false }), 'none')
  assert.equal(nextSlotState('has', 'invalidate'), 'stale')
  assert.equal(nextSlotState('none', 'invalidate'), 'none')
  assert.equal(nextSlotState('generating', 'invalidate'), 'generating')
  assert.equal(nextSlotState('stale', 'adopt'), 'has')
  assert.equal(nextSlotState('none', 'adopt'), 'has')
  assert.equal(nextSlotState('has', 'clear'), 'none')
  assert.equal(nextSlotState('has', 'nonsense'), 'has')
})

const base = {
  useFirstLast: true,
  first: { hasImage: true },
  last: { hasImage: false },
  prev: { exists: true, lastHasImage: true },
  next: { exists: true },
  hasVideo: true,
}

test('single-image mode has only a first slot, no previous-tail link', () => {
  const s = buildFrameSlots({ ...base, useFirstLast: false })
  assert.equal(s.last, null)
  assert.equal(s.first.canUsePrevTail, false)
  assert.equal(s.first.prevTailReason, 'singleMode')
})

test('first slot: generate/upload/prompt/upscale availability by state', () => {
  const none = buildFrameSlots({ ...base, first: { hasImage: false } }).first
  assert.equal(none.state, 'none')
  assert.equal(none.canGenerate, true)
  assert.equal(none.canUpscale, false)
  const has = buildFrameSlots(base).first
  assert.equal(has.state, 'has')
  assert.equal(has.canUpscale, true)
  assert.equal(has.canUpload, true)
  assert.equal(has.canEditPrompt, true)
  const gen = buildFrameSlots({ ...base, first: { hasImage: true, generating: true } }).first
  assert.equal(gen.state, 'generating')
  assert.equal(gen.canGenerate, false)
  assert.equal(gen.canUpload, false)
  assert.equal(gen.canUpscale, false)
  const stale = buildFrameSlots({ ...base, first: { hasImage: true, stale: true } }).first
  assert.equal(stale.state, 'stale')
  assert.equal(stale.canGenerate, true)
  assert.equal(stale.canUpscale, true)
})

test('last slot generation needs a first frame and a queue that supports it', () => {
  const noCap = buildFrameSlots(base).last
  assert.equal(noCap.canGenerate, false)
  assert.equal(noCap.generateReason, 'queueUnsupported')
  assert.equal(noCap.canUpload, true)
  assert.equal(noCap.canUpscale, false)
  const cap = { lastFrameGenerate: true }
  const ok = buildFrameSlots({ ...base, capabilities: cap }).last
  assert.equal(ok.canGenerate, true)
  const needFirst = buildFrameSlots({ ...base, first: { hasImage: false }, capabilities: cap }).last
  assert.equal(needFirst.canGenerate, false)
  assert.equal(needFirst.generateReason, 'needFirst')
})

test('use previous shot tail frame: needs prev shot with a tail image', () => {
  assert.equal(buildFrameSlots(base).first.canUsePrevTail, true)
  const noPrev = buildFrameSlots({ ...base, prev: { exists: false } }).first
  assert.equal(noPrev.canUsePrevTail, false)
  assert.equal(noPrev.prevTailReason, 'noPrev')
  const noTail = buildFrameSlots({ ...base, prev: { exists: true, lastHasImage: false } }).first
  assert.equal(noTail.canUsePrevTail, false)
  assert.equal(noTail.prevTailReason, 'prevNoTail')
  const busy = buildFrameSlots({ ...base, first: { hasImage: true, generating: true } }).first
  assert.equal(busy.canUsePrevTail, false)
})

test('tail-frame link to next shot: needs next shot and a video', () => {
  assert.deepEqual(buildFrameSlots(base).linkTail, { enabled: true, reason: null })
  assert.deepEqual(buildFrameSlots({ ...base, next: { exists: false } }).linkTail, { enabled: false, reason: 'noNext' })
  assert.deepEqual(buildFrameSlots({ ...base, hasVideo: false }).linkTail, { enabled: false, reason: 'noVideo' })
  assert.equal(buildFrameSlots({ ...base, linking: true }).linkTail.enabled, false)
})

test('pickSlotImages follows bound ids, then frame_type, then none', () => {
  const imgs = [
    { id: 1, frame_type: 'storyboard_first' },
    { id: 2, frame_type: 'storyboard_last' },
    { id: 3, frame_type: 'storyboard_first' },
  ]
  assert.equal(pickSlotImages(imgs, { first_frame_image_id: 3 }).first.id, 3)
  assert.equal(pickSlotImages(imgs, {}).first.id, 1)
  assert.equal(pickSlotImages(imgs, {}).last.id, 2)
  assert.equal(pickSlotImages([], {}).first, null)
})

test('historyItems excludes images bound to either slot', () => {
  const imgs = [{ id: 1 }, { id: 2 }, { id: 3 }]
  assert.deepEqual(historyItems(imgs, { first: { id: 1 }, last: { id: 3 } }).map((i) => i.id), [2])
  assert.deepEqual(historyItems(imgs, { first: null, last: null }).map((i) => i.id), [1, 2, 3])
})
