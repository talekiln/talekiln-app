import test from 'node:test'
import assert from 'node:assert/strict'
import {
  generationGate, classifyGenerationError, waitForTask, buildAssetImageRequest, taskIdOf,
} from '../src/utils/assetGeneration.js'

test('generationGate: only an explicit legacy_enabled === true allows asset image generation', () => {
  assert.deepEqual(generationGate(true), { allowed: true, reasonKey: null })
  assert.deepEqual(generationGate(false), { allowed: false, reasonKey: 'assets.gen.legacyOff' })
  // unknown (status not loaded / request failed) is treated as disabled, with its own explanation
  assert.deepEqual(generationGate(null), { allowed: false, reasonKey: 'assets.gen.unknown' })
  assert.deepEqual(generationGate(undefined), { allowed: false, reasonKey: 'assets.gen.unknown' })
})

test('classifyGenerationError: 402 SPEND_LIMIT is inline, never a popup', () => {
  const e = Object.assign(new Error('over limit'), { response: { status: 402 }, code: 'SPEND_LIMIT' })
  assert.deepEqual(classifyGenerationError(e), { type: 'spendLimit', messageKey: 'assets.gen.spendLimit', message: 'over limit' })
  const e2 = Object.assign(new Error('x'), { response: { status: 402, data: { error: { code: 'SPEND_LIMIT' } } } })
  assert.equal(classifyGenerationError(e2).type, 'spendLimit')
})

test('classifyGenerationError: other errors keep their message', () => {
  assert.deepEqual(classifyGenerationError(new Error('boom')), { type: 'other', messageKey: null, message: 'boom' })
  assert.deepEqual(classifyGenerationError(null), { type: 'other', messageKey: null, message: '' })
})

test('buildAssetImageRequest builds per-kind route and body', () => {
  assert.deepEqual(buildAssetImageRequest('characters', { id: 3 }, { style: 'anime' }), {
    method: 'post', url: '/characters/3/generate-image', body: { model: undefined, style: 'anime' },
  })
  assert.deepEqual(buildAssetImageRequest('scenes', { id: 4 }, { style: 'anime', model: 'm' }), {
    method: 'post', url: '/scenes/generate-image', body: { scene_id: 4, model: 'm', style: 'anime' },
  })
  assert.deepEqual(buildAssetImageRequest('props', { id: 5 }, {}), {
    method: 'post', url: '/props/5/generate', body: { model: undefined, style: undefined },
  })
})

test('taskIdOf reads task id from the different response shapes', () => {
  assert.equal(taskIdOf({ task_id: 't1' }), 't1')
  assert.equal(taskIdOf({ image_generation: { task_id: 't2' } }), 't2')
  assert.equal(taskIdOf({}), '')
  assert.equal(taskIdOf(null), '')
})

test('waitForTask resolves on completed / failed and times out', async () => {
  const sleeps = []
  const sleep = async (ms) => { sleeps.push(ms) }
  let n = 0
  const get = async () => ({ status: ++n < 3 ? 'processing' : 'completed', result: { ok: 1 } })
  const done = await waitForTask(get, { sleep, intervalMs: 5, maxAttempts: 10 })
  assert.equal(done.status, 'completed')
  assert.equal(n, 3)
  assert.deepEqual(sleeps, [5, 5])

  const failed = await waitForTask(async () => ({ status: 'failed', error: 'nope' }), { sleep, intervalMs: 1, maxAttempts: 3 })
  assert.deepEqual({ status: failed.status, error: failed.error }, { status: 'failed', error: 'nope' })

  const timeout = await waitForTask(async () => ({ status: 'processing' }), { sleep, intervalMs: 1, maxAttempts: 3 })
  assert.equal(timeout.status, 'timeout')

  // transient errors in polling are tolerated; the last one is reported on timeout
  let k = 0
  const flaky = await waitForTask(async () => { if (++k < 2) throw new Error('net'); return { status: 'completed' } }, { sleep, intervalMs: 1, maxAttempts: 5 })
  assert.equal(flaky.status, 'completed')
})

test('waitForTask stops when cancelled', async () => {
  let calls = 0
  const out = await waitForTask(async () => { calls++; return { status: 'processing' } }, {
    sleep: async () => {}, intervalMs: 1, maxAttempts: 50, isCancelled: () => calls >= 2,
  })
  assert.equal(out.status, 'cancelled')
  assert.equal(calls, 2)
})
