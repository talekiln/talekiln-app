import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPlan, STEP_ORDER, PHASE_OF } from '../src/utils/pipelinePlan.js'

const shot = (id, over = {}) => ({ id: `s${id}`, storyboardId: id, image: 'none', video: 'none', narration: 'none', hasText: true, ...over })
const asset = (id, over = {}) => ({ id, hasImage: false, locked: false, ...over })

const EMPTY = { hasScript: true, characters: [], scenes: [], props: [], shots: [] }
const FULL = {
  hasScript: true,
  characters: [asset(1), asset(2)],
  scenes: [asset(3)],
  props: [asset(4)],
  shots: [shot(1), shot(2), shot(3)],
}

const byId = (plan) => Object.fromEntries(plan.steps.map((s) => [s.id, s]))

test('step order and phases are fixed', () => {
  assert.deepEqual(STEP_ORDER, [
    'extractCharacters', 'extractScenes', 'extractProps', 'storyboards',
    'characterImages', 'sceneImages', 'propImages', 'firstFrames', 'videos', 'voice',
  ])
  assert.equal(PHASE_OF.storyboards, 'text')
  assert.equal(PHASE_OF.propImages, 'assets')
  assert.equal(PHASE_OF.firstFrames, 'frames')
  assert.equal(PHASE_OF.videos, 'video')
  assert.equal(PHASE_OF.voice, 'voice')
})

test('existing storyboards skip storyboard generation', () => {
  const plan = buildPlan(FULL)
  const s = byId(plan)
  assert.equal(s.storyboards.skip, true)
  assert.equal(s.storyboards.reason, 'exists')
  assert.equal(s.extractCharacters.skip, true)
  assert.equal(s.extractScenes.skip, true)
  assert.equal(s.extractProps.skip, true)
})

test('no storyboards -> generate them, and shot steps are pending with unknown counts', () => {
  const plan = buildPlan({ ...EMPTY, characters: [asset(1)] })
  const s = byId(plan)
  assert.equal(s.storyboards.skip, false)
  assert.equal(s.extractCharacters.skip, true)
  assert.equal(s.extractScenes.skip, false)
  assert.equal(s.firstFrames.skip, false)
  assert.equal(s.firstFrames.count, null)
  assert.equal(s.videos.count, null)
  assert.equal(plan.blocked, null)
})

test('nothing to work from: no script and no shots is blocked', () => {
  const plan = buildPlan({ ...EMPTY, hasScript: false })
  assert.equal(plan.blocked, 'no_script')
  assert.equal(plan.runnable.length, 0)
})

test('no script but shots exist is not blocked', () => {
  const plan = buildPlan({ ...FULL, hasScript: false })
  assert.equal(plan.blocked, null)
  assert.ok(plan.runnable.length > 0)
})

test('locked or already-imaged references are skipped, with ids for the rest', () => {
  const plan = buildPlan({
    ...FULL,
    characters: [asset(1, { locked: true }), asset(2, { hasImage: true }), asset(5)],
    scenes: [asset(3, { locked: true })],
    props: [asset(4, { hasImage: true })],
  })
  const s = byId(plan)
  assert.equal(s.characterImages.skip, false)
  assert.deepEqual(s.characterImages.ids, [5])
  assert.equal(s.characterImages.count, 1)
  assert.equal(s.characterImages.lockedCount, 1)
  assert.equal(s.sceneImages.skip, true)
  assert.equal(s.sceneImages.reason, 'locked')
  assert.equal(s.propImages.skip, true)
  assert.equal(s.propImages.reason, 'exists')
})

test('shot steps count only shots that are not fresh', () => {
  const plan = buildPlan({
    ...FULL,
    shots: [shot(1, { image: 'fresh', video: 'fresh' }), shot(2, { image: 'fresh' }), shot(3, { image: 'stale', video: 'stale' })],
  })
  const s = byId(plan)
  assert.deepEqual(s.firstFrames.ids, [3])
  assert.deepEqual(s.videos.ids, [2, 3])
  assert.equal(s.firstFrames.count, 1)
  assert.equal(s.videos.count, 2)
})

test('everything fresh -> nothing runnable', () => {
  const shots = [shot(1, { image: 'fresh', video: 'fresh', narration: 'fresh' })]
  const plan = buildPlan({ hasScript: true, characters: [asset(1, { hasImage: true })], scenes: [asset(2, { hasImage: true })], props: [asset(3, { hasImage: true })], shots }, { includeVoice: true })
  assert.equal(plan.runnable.length, 0)
  assert.equal(plan.done, true)
})

test('voice step is opt-in and skips shots without text or with fresh narration', () => {
  const shots = [shot(1), shot(2, { narration: 'fresh' }), shot(3, { hasText: false })]
  const off = byId(buildPlan({ ...FULL, shots }))
  assert.equal(off.voice.skip, true)
  assert.equal(off.voice.reason, 'off')
  const on = byId(buildPlan({ ...FULL, shots }, { includeVoice: true }))
  assert.equal(on.voice.skip, false)
  assert.deepEqual(on.voice.ids, [1])
})

test('options can drop asset images and extraction', () => {
  const s = byId(buildPlan(EMPTY, { includeAssetImages: false, includeExtract: false }))
  assert.equal(s.extractCharacters.skip, true)
  assert.equal(s.extractCharacters.reason, 'off')
  assert.equal(s.characterImages.skip, true)
  assert.equal(s.characterImages.reason, 'off')
  assert.equal(s.storyboards.skip, false)
})

test('no pause points by default', () => {
  const plan = buildPlan(FULL, { includeVoice: true })
  assert.deepEqual(plan.steps.filter((x) => x.pauseAfter), [])
})

test('pause points sit on the last runnable step of each phase that is followed by more work', () => {
  const plan = buildPlan(EMPTY, { includeVoice: true, pauseBetweenPhases: true })
  const paused = plan.runnable.filter((x) => x.pauseAfter).map((x) => x.id)
  assert.deepEqual(paused, ['storyboards', 'propImages', 'firstFrames', 'videos'])
  assert.equal(plan.runnable.at(-1).pauseAfter, false)
})

test('pause points skip phases that have nothing to do and never trail the plan', () => {
  const plan = buildPlan({
    ...FULL,
    characters: [asset(1, { hasImage: true })], scenes: [asset(3, { hasImage: true })], props: [asset(4, { hasImage: true })],
  }, { pauseBetweenPhases: true })
  // storyboards exist, assets have images -> frames then videos only
  assert.deepEqual(plan.runnable.map((x) => x.id), ['firstFrames', 'videos'])
  assert.deepEqual(plan.runnable.filter((x) => x.pauseAfter).map((x) => x.id), ['firstFrames'])
})

test('billable flag: only generation steps cost money', () => {
  const s = byId(buildPlan(EMPTY, { includeVoice: true }))
  assert.equal(s.extractCharacters.billable, false)
  assert.equal(s.storyboards.billable, false)
  for (const id of ['characterImages', 'sceneImages', 'propImages', 'firstFrames', 'videos', 'voice']) assert.equal(s[id].billable, true, id)
})
