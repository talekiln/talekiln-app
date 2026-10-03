import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GRAPH_FIELDS, splitPatch, mergeShot, formFromShot, diffForm, supportsMultiRef, shotMode,
  chipKey, summaryOf, buildRegeneratePlan, undoNoticeKind,
} from '../src/components/shot/shotInspectorModel.js'

const view = {
  id: 'shot_1', legacy_id: 11,
  params: { title: 'T', description: 'D', location: 'Street', time: 'dusk', shot_type: 'close', angle: '', movement: 'push', image_prompt: 'ip', video_prompt: 'vp', characters: [1, 2], duration_ms: 4500 },
  dialogue: 'Ann: hi', planned_ms: 4500, real_ms: null, used_ms: 4500,
  image: 'fresh', video: 'stale', narration: 'none',
}
const legacy = { id: 11, scene_id: 3, narration: 'It rained.', action: 'walks', lighting_style: 'neon', depth_of_field: 'deep', layout_description: 'left/right', creation_mode: 'universal', universal_segment_text: '@x', first_frame_image_id: 7 }

test('splitPatch sends kernel params through the graph and everything else to the legacy update', () => {
  const { graph, legacy: rest } = splitPatch({ title: 'N', duration: 6, dialogue: 'Bob: yo', lighting_style: 'soft', scene_id: 4, movement: 'pan' })
  assert.deepEqual(graph, { title: 'N', duration_ms: 6000, movement: 'pan' })
  assert.deepEqual(rest, { dialogue: 'Bob: yo', lighting_style: 'soft', scene_id: 4 })
})

test('splitPatch keeps asset binding (characters) on the legacy route and drops undefined', () => {
  const { graph, legacy: rest } = splitPatch({ character_ids: [1, 2], description: undefined, video_prompt: '' })
  assert.deepEqual(graph, { video_prompt: '' })
  assert.deepEqual(rest, { character_ids: [1, 2] })
})

test('splitPatch rejects non-positive duration', () => {
  assert.throws(() => splitPatch({ duration: 0 }), /duration/)
  assert.throws(() => splitPatch({ duration: 'x' }), /duration/)
  assert.equal(splitPatch({ duration: 2.5 }).graph.duration_ms, 2500)
})

test('GRAPH_FIELDS lists the kernel shot params', () => {
  for (const k of ['title', 'description', 'location', 'time', 'shot_type', 'angle', 'movement', 'image_prompt', 'video_prompt', 'atmosphere', 'duration_ms']) assert.ok(GRAPH_FIELDS.includes(k), k)
  assert.ok(!GRAPH_FIELDS.includes('characters'))
})

test('mergeShot joins the kernel view with the legacy row', () => {
  const m = mergeShot(view, legacy)
  assert.equal(m.id, 'shot_1')
  assert.equal(m.legacyId, 11)
  assert.equal(m.title, 'T')
  assert.equal(m.duration, 4.5)
  assert.equal(m.dialogue, 'Ann: hi')
  assert.equal(m.narration, 'It rained.')
  assert.equal(m.lighting_style, 'neon')
  assert.equal(m.imageState, 'fresh')
  assert.equal(m.videoState, 'stale')
  assert.equal(mergeShot(view, null).narration, '')
})

test('formFromShot / diffForm produce a minimal patch', () => {
  const m = mergeShot(view, legacy)
  const f = formFromShot(m)
  assert.deepEqual(diffForm(f, m), {})
  assert.deepEqual(diffForm({ ...f, description: 'D2', duration: 6 }, m), { description: 'D2', duration: 6 })
  assert.deepEqual(diffForm({ ...f, lighting_style: '' }, m), { lighting_style: '' })
})

test('supportsMultiRef follows the active video config protocol', () => {
  assert.equal(supportsMultiRef(null), false)
  assert.equal(supportsMultiRef({ api_protocol: 'kling_omni' }), true)
  assert.equal(supportsMultiRef({ api_protocol: 'volcengine_omni' }), true)
  assert.equal(supportsMultiRef({ api_protocol: 'volcengine' }), false)
  assert.equal(supportsMultiRef({ provider: 'agnes' }), true)
  assert.equal(supportsMultiRef({ default_model: 'agnes-video-1' }), true)
  assert.equal(supportsMultiRef({ api_protocol: 'openai' }), false)
})

test('shotMode: universal only when the capability is on', () => {
  assert.equal(shotMode({ creation_mode: 'universal' }, true), 'universal')
  assert.equal(shotMode({ creation_mode: 'universal' }, false), 'classic')
  assert.equal(shotMode({}, true), 'classic')
})

test('chipKey maps queue state to an i18n key under storyboard.state', () => {
  assert.equal(chipKey('none'), 'storyboard.state.none')
  assert.equal(chipKey('fresh'), 'storyboard.state.fresh')
  assert.equal(chipKey('stale'), 'storyboard.state.stale')
  assert.equal(chipKey('running'), 'storyboard.state.running')
  assert.equal(chipKey('weird'), 'storyboard.state.none')
})

test('summaryOf counts shots and rounds total seconds', () => {
  assert.deepEqual(summaryOf([{ planned_ms: 4500 }, { planned_ms: 3000 }]), { shots: 2, seconds: 8 })
  assert.deepEqual(summaryOf([]), { shots: 0, seconds: 0 })
})

test('buildRegeneratePlan: reads can_undo; falls back to a clear-history confirm', () => {
  assert.deepEqual(buildRegeneratePlan({ shotCount: 0 }), { confirm: false, mode: 'first' })
  assert.deepEqual(buildRegeneratePlan({ shotCount: 5, undoable: true }), { confirm: true, mode: 'undoable' })
  assert.deepEqual(buildRegeneratePlan({ shotCount: 5, undoable: false }), { confirm: true, mode: 'clearsHistory' })
})

test('undoNoticeKind uses can_undo from the response', () => {
  assert.equal(undoNoticeKind({ can_undo: true }), 'undo')
  assert.equal(undoNoticeKind({ data: { can_undo: true } }), 'undo')
  assert.equal(undoNoticeKind({ can_undo: false }), 'cleared')
  assert.equal(undoNoticeKind({}), 'plain')
  assert.equal(undoNoticeKind(null), 'plain')
})

test('shotChips lets queue states win over graph states', async () => {
  const { shotChips, isShotBusy } = await import('../src/components/shot/shotInspectorModel.js')
  assert.deepEqual(shotChips({ imageState: 'fresh', videoState: 'stale' }, null), { image: 'fresh', video: 'stale' })
  assert.deepEqual(shotChips({ imageState: 'fresh', videoState: 'none' }, { image: { state: 'running' }, video: { state: 'fresh' } }), { image: 'running', video: 'none' })
  assert.deepEqual(shotChips({}, { video: { state: 'failed' } }), { image: 'none', video: 'failed' })
  assert.equal(isShotBusy({ state: 'queued' }), true)
  assert.equal(isShotBusy({ state: 'fresh' }), false)
  assert.equal(isShotBusy(null), false)
})

test('pickVideoConfig prefers the default active config', async () => {
  const { pickVideoConfig } = await import('../src/components/shot/shotInspectorModel.js')
  assert.equal(pickVideoConfig([{ id: 1, is_active: 1 }, { id: 2, is_active: 1, is_default: 1 }]).id, 2)
  assert.equal(pickVideoConfig([{ id: 1, is_active: 0, is_default: 1 }, { id: 3, is_active: true }]).id, 3)
  assert.equal(pickVideoConfig({ items: [{ id: 4 }] }).id, 4)
  assert.equal(pickVideoConfig([]), null)
  assert.equal(pickVideoConfig(null), null)
})

test('orderedRefs follows the row id order, moveId swaps neighbours', async () => {
  const { orderedRefs, moveId, rowIds } = await import('../src/components/shot/shotInspectorModel.js')
  const byKind = { characters: [{ id: 1 }, { id: 2 }, { id: 3 }], scenes: [{ id: 9 }], props: [{ id: 5 }] }
  const refs = orderedRefs({ characters: '[3,1,99]', scene_id: 9, prop_ids: [5] }, byKind)
  assert.deepEqual(refs.characters.map((a) => a.id), [3, 1])
  assert.deepEqual(refs.scenes.map((a) => a.id), [9])
  assert.deepEqual(refs.props.map((a) => a.id), [5])
  assert.deepEqual(orderedRefs(null, byKind), { scenes: [], characters: [], props: [] })
  assert.deepEqual(rowIds([{ id: 4 }, '5', 4, 'x']), [4, 5])
  assert.deepEqual(moveId([1, 2, 3], 2, -1), [2, 1, 3])
  assert.deepEqual(moveId([1, 2, 3], 3, 1), [1, 2, 3])
  assert.deepEqual(moveId([1, 2, 3], 7, 1), [1, 2, 3])
})
