import test from 'node:test'
import assert from 'node:assert/strict'
import { createPipelineRunner } from '../src/composables/usePipeline.js'

// ---- 假依赖 ----
const stateWith = (over = {}) => ({
  hasScript: true,
  characters: [{ id: 1, hasImage: false, locked: false }, { id: 2, hasImage: true, locked: false }],
  scenes: [{ id: 5, hasImage: false, locked: false }],
  props: [{ id: 7, hasImage: true, locked: false }],
  shots: [
    { id: 'a', storyboardId: 11, image: 'none', video: 'none', narration: 'none', hasText: true },
    { id: 'b', storyboardId: 12, image: 'fresh', video: 'none', narration: 'none', hasText: false },
  ],
  ...over,
})

function makeDeps(over = {}) {
  const calls = []
  const deps = {
    calls,
    collectState: async () => stateWith(),
    estimate: async (ids, kind) => { calls.push(['estimate', kind, ids]); return { billable: ids.length, allowed: true, provider_ready: true, estimate: { total: ids.length * 0.5, max: ids.length, currency: 'CNY' } } },
    submit: async (ids, kind) => { calls.push(['submit', kind, ids]); return { tasks: [] } },
    waitShots: async (ids, kind) => { calls.push(['wait', kind, ids]); return { failed: [] } },
    extract: async (id) => { calls.push(['extract', id]) },
    assetImage: async (type, id) => { calls.push(['asset', type, id]) },
    estimateVoice: async (ids) => ({ estimate: ids.length * 0.1, max: ids.length * 0.1, currency: 'CNY' }),
    voice: async (ids) => { calls.push(['voice', ids]) },
    concurrency: async () => 2,
    sleep: async () => {},
    ...over,
  }
  return deps
}

const ids = (calls, kind) => calls.filter((c) => c[0] === kind)

test('plan(): steps from the current state, plus a combined estimate for the shot steps', async () => {
  const deps = makeDeps()
  const r = createPipelineRunner(deps)
  const out = await r.plan()
  assert.equal(r.getSnapshot().state, 'idle')
  assert.deepEqual(out.plan.runnable.map((s) => s.id), ['characterImages', 'sceneImages', 'firstFrames', 'videos'])
  const est = ids(deps.calls, 'estimate')
  assert.equal(est.length, 1)
  assert.equal(est[0][1], 'both')
  assert.deepEqual(est[0][2], [11, 12])
  assert.equal(out.estimate.total, 1)
  assert.equal(out.estimate.currency, 'CNY')
  assert.equal(out.estimate.allowed, true)
})

test('plan(): shots that are not generated yet -> no estimate, flagged as pending', async () => {
  const deps = makeDeps({ collectState: async () => stateWith({ shots: [] }) })
  const out = await createPipelineRunner(deps).plan()
  assert.equal(out.estimate.pending, true)
  assert.equal(ids(deps.calls, 'estimate').length, 0)
})

test('plan(): voice estimate is added when the voice step is on', async () => {
  const deps = makeDeps()
  const out = await createPipelineRunner(deps, { includeVoice: true }).plan()
  assert.equal(out.estimate.voice.estimate, 0.1)
  assert.equal(Math.round(out.estimate.total * 100) / 100, 1.1)
})

test('plan(): estimate says not allowed -> allowed=false is surfaced', async () => {
  const deps = makeDeps({ estimate: async () => ({ billable: 1, allowed: false, refusal: { message: 'over cap' }, estimate: { total: 9, max: 9, currency: 'CNY' } }) })
  const out = await createPipelineRunner(deps).plan()
  assert.equal(out.estimate.allowed, false)
  assert.equal(out.estimate.blockedText, 'over cap')
})

test('run(): billable steps need explicit confirmation, and nothing runs without it', async () => {
  const deps = makeDeps()
  const r = createPipelineRunner(deps)
  await assert.rejects(() => r.run(), (e) => e.code === 'CONFIRM_REQUIRED')
  assert.equal(r.getSnapshot().state, 'idle')
  assert.equal(deps.calls.filter((c) => c[0] !== 'estimate').length, 0)
})

test('run(): steps run in order, each only on what is missing, ending in done', async () => {
  const deps = makeDeps()
  const r = createPipelineRunner(deps)
  const seen = []
  r.subscribe((s) => seen.push(s.state))
  await r.run({ confirmed: true })
  const order = deps.calls.filter((c) => c[0] !== 'estimate').map((c) => c.slice(0, 2).join(':') + (c[2] !== undefined && !Array.isArray(c[2]) ? ':' + c[2] : ''))
  assert.deepEqual(order, ['asset:character:1', 'asset:scene:5', 'submit:image', 'wait:image', 'submit:video', 'wait:video'])
  assert.deepEqual(ids(deps.calls, 'submit')[0][2], [11])
  assert.deepEqual(ids(deps.calls, 'submit')[1][2], [11, 12])
  const snap = r.getSnapshot()
  assert.equal(snap.state, 'done')
  assert.ok(seen.includes('running'))
  assert.equal(snap.steps.find((s) => s.id === 'characterImages').status, 'done')
  assert.equal(snap.steps.find((s) => s.id === 'extractCharacters').status, 'skipped')
  assert.equal(snap.errors.length, 0)
})

test('run(): state is re-read before each step, so steps pending on earlier ones get real counts', async () => {
  let extracted = false
  const deps = makeDeps({
    collectState: async () => (extracted
      ? stateWith({ characters: [{ id: 9, hasImage: false, locked: false }] })
      : stateWith({ characters: [], scenes: [], shots: [] })),
    extract: async (id) => { deps.calls.push(['extract', id]); if (id === 'storyboards') extracted = true },
  })
  const r = createPipelineRunner(deps)
  await r.run({ confirmed: true })
  assert.ok(ids(deps.calls, 'extract').some((c) => c[1] === 'storyboards'))
  assert.deepEqual(ids(deps.calls, 'asset').filter((c) => c[1] === 'character').map((c) => c[2]), [9])
  assert.equal(r.getSnapshot().state, 'done')
})

test('run(): a failing storyboard step is fatal; a failing prop extraction is not', async () => {
  const bad = makeDeps({
    collectState: async () => stateWith({ shots: [] }),
    extract: async (id) => { bad.calls.push(['extract', id]); if (id === 'storyboards') throw new Error('llm down') },
  })
  const r = createPipelineRunner(bad)
  await r.run({ confirmed: true })
  let snap = r.getSnapshot()
  assert.equal(snap.state, 'failed')
  assert.equal(snap.error.stepId, 'storyboards')
  assert.match(snap.error.message, /llm down/)
  assert.equal(ids(bad.calls, 'submit').length, 0)

  const soft = makeDeps({
    collectState: async () => stateWith({ props: [] }),
    extract: async (id) => { soft.calls.push(['extract', id]); if (id === 'extractProps') throw new Error('no props') },
  })
  const r2 = createPipelineRunner(soft)
  await r2.run({ confirmed: true })
  snap = r2.getSnapshot()
  assert.equal(snap.state, 'done')
  assert.equal(snap.errors.length, 1)
  assert.equal(snap.errors[0].stepId, 'extractProps')
})

test('run(): an asset image is retried, and is only an error after the last attempt', async () => {
  let n = 0
  const flaky = makeDeps({
    assetImage: async (type, id) => { flaky.calls.push(['asset', type, id]); if (type === 'character' && ++n < 3) throw new Error('boom') },
  })
  const r = createPipelineRunner(flaky, { retries: 2 })
  await r.run({ confirmed: true })
  assert.equal(ids(flaky.calls, 'asset').filter((c) => c[1] === 'character').length, 3)
  assert.equal(r.getSnapshot().errors.length, 0)

  const dead = makeDeps({
    assetImage: async (type, id) => { dead.calls.push(['asset', type, id]); if (type === 'character') throw new Error('always') },
  })
  const r2 = createPipelineRunner(dead, { retries: 2 })
  await r2.run({ confirmed: true })
  const snap = r2.getSnapshot()
  assert.equal(snap.state, 'done')
  assert.equal(snap.errors.length, 1)
  assert.equal(snap.errors[0].item, 1)
  assert.equal(snap.steps.find((s) => s.id === 'characterImages').status, 'failed')
  // 后面的步骤照常跑
  assert.ok(ids(dead.calls, 'submit').length > 0)
})

test('run(): asset images respect the concurrency limit', async () => {
  let live = 0
  let peak = 0
  const deps = makeDeps({
    collectState: async () => stateWith({ characters: [1, 2, 3, 4, 5].map((id) => ({ id, hasImage: false, locked: false })), scenes: [], shots: [] }),
    assetImage: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live-- },
    concurrency: async () => 2,
  })
  await createPipelineRunner(deps).run({ confirmed: true })
  assert.equal(peak, 2)
})

test('run(): the generate preview is re-checked per step; a refused cap stops the pipeline', async () => {
  const deps = makeDeps({
    estimate: async (ids2, kind) => (kind === 'video'
      ? { billable: 1, allowed: false, refusal: { message: 'monthly cap' } }
      : { billable: 1, allowed: true, provider_ready: true, estimate: { total: 1, max: 1, currency: 'CNY' } }),
  })
  const r = createPipelineRunner(deps)
  await r.run({ confirmed: true })
  const snap = r.getSnapshot()
  assert.equal(snap.state, 'failed')
  assert.equal(snap.error.stepId, 'videos')
  assert.equal(snap.error.code, 'blocked')
  assert.equal(snap.error.message, 'monthly cap')
  assert.equal(ids(deps.calls, 'submit').filter((c) => c[1] === 'video').length, 0)
})

test('run(): a missing provider key stops before submitting', async () => {
  const deps = makeDeps({ estimate: async () => ({ billable: 1, allowed: true, provider_ready: false }) })
  const r = createPipelineRunner(deps)
  await r.run({ confirmed: true })
  assert.equal(r.getSnapshot().error.code, 'no_provider')
  assert.equal(ids(deps.calls, 'submit').length, 0)
})

test('run(): shots that fail in the queue become errors but do not stop the pipeline', async () => {
  const deps = makeDeps({ waitShots: async (sb, kind) => { deps.calls.push(['wait', kind, sb]); return { failed: kind === 'image' ? [11] : [] } } })
  const r = createPipelineRunner(deps)
  await r.run({ confirmed: true })
  const snap = r.getSnapshot()
  assert.equal(snap.state, 'done')
  assert.deepEqual(snap.errors.map((e) => [e.stepId, e.item]), [['firstFrames', 11]])
})

test('pause()/resume(): takes effect at the next step boundary and continues where it stopped', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const deps = makeDeps({
    assetImage: async (type, id) => { deps.calls.push(['asset', type, id]); if (type === 'character') await gate },
  })
  const r = createPipelineRunner(deps)
  const done = r.run({ confirmed: true })
  await new Promise((r2) => setTimeout(r2, 5))
  r.pause()
  release()
  await new Promise((r2) => setTimeout(r2, 10))
  assert.equal(r.getSnapshot().state, 'paused')
  assert.equal(ids(deps.calls, 'asset').filter((c) => c[1] === 'scene').length, 0)
  r.resume()
  await done
  assert.equal(r.getSnapshot().state, 'done')
  assert.equal(ids(deps.calls, 'asset').filter((c) => c[1] === 'scene').length, 1)
})

test('pauseBetweenPhases: stops after the last step of a phase until resumed', async () => {
  const deps = makeDeps()
  const r = createPipelineRunner(deps, { pauseBetweenPhases: true })
  const done = r.run({ confirmed: true })
  await new Promise((r2) => setTimeout(r2, 10))
  let snap = r.getSnapshot()
  assert.equal(snap.state, 'paused')
  assert.equal(snap.pausedAfter, 'sceneImages')
  assert.equal(ids(deps.calls, 'submit').length, 0)
  r.resume()
  await new Promise((r2) => setTimeout(r2, 10))
  snap = r.getSnapshot()
  assert.equal(snap.state, 'paused')
  assert.equal(snap.pausedAfter, 'firstFrames')
  r.resume()
  await done
  assert.equal(r.getSnapshot().state, 'done')
})

test('cancel(): stops before the next step, also while paused', async () => {
  const deps = makeDeps()
  const r = createPipelineRunner(deps, { pauseBetweenPhases: true })
  const done = r.run({ confirmed: true })
  await new Promise((r2) => setTimeout(r2, 10))
  assert.equal(r.getSnapshot().state, 'paused')
  r.cancel()
  await done
  assert.equal(r.getSnapshot().state, 'cancelled')
  assert.equal(ids(deps.calls, 'submit').length, 0)
})

test('run(): no script and no shots is reported as blocked, not run', async () => {
  const deps = makeDeps({ collectState: async () => stateWith({ hasScript: false, shots: [], characters: [], scenes: [] }) })
  const r = createPipelineRunner(deps)
  await r.run({ confirmed: true })
  assert.equal(r.getSnapshot().state, 'failed')
  assert.equal(r.getSnapshot().error.code, 'no_script')
})

test('run(): everything already done -> finishes immediately with nothing submitted', async () => {
  const deps = makeDeps({
    collectState: async () => stateWith({
      characters: [{ id: 1, hasImage: true }], scenes: [{ id: 5, hasImage: true }], props: [{ id: 7, hasImage: true }],
      shots: [{ id: 'a', storyboardId: 11, image: 'fresh', video: 'fresh', narration: 'fresh', hasText: true }],
    }),
  })
  const r = createPipelineRunner(deps)
  await r.run()
  assert.equal(r.getSnapshot().state, 'done')
  assert.equal(deps.calls.filter((c) => c[0] !== 'estimate').length, 0)
})

test('run(): voice step passes only shots that have text and no fresh narration', async () => {
  const deps = makeDeps()
  const r = createPipelineRunner(deps, { includeVoice: true })
  await r.run({ confirmed: true })
  assert.deepEqual(ids(deps.calls, 'voice')[0][1], [11])
})
