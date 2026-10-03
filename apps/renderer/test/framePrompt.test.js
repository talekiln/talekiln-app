import test from 'node:test'
import assert from 'node:assert/strict'
import { promptFromTask, promptFromList, pollTaskResult, frameTypeOf, imageFrameTypeOf, boundColumnOf } from '../src/components/shot/framePrompt.js'

test('promptFromTask and promptFromList trim and tolerate missing data', () => {
  assert.equal(promptFromTask({ result: { response: { single_frame: { prompt: '  a  ' } } } }), 'a')
  assert.equal(promptFromTask({}), '')
  assert.equal(promptFromTask(null), '')
  const res = { frame_prompts: [{ frame_type: 'first', prompt: ' f ' }, { frame_type: 'last', prompt: 'l' }] }
  assert.equal(promptFromList(res, 'last'), 'l')
  assert.equal(promptFromList(res, 'first'), 'f')
  assert.equal(promptFromList({}, 'first'), '')
})

test('pollTaskResult waits until completed', async () => {
  const seq = ['pending', 'running', 'completed']
  let i = 0
  const sleeps = []
  const r = await pollTaskResult({ get: async () => ({ status: seq[i++] }), sleep: async (ms) => { sleeps.push(ms) } }, 't1', { intervalMs: 5 })
  assert.equal(r.ok, true)
  assert.deepEqual(sleeps, [5, 5])
})

test('pollTaskResult reports failure, request errors and timeout', async () => {
  const sleep = async () => {}
  assert.deepEqual(
    (await pollTaskResult({ get: async () => ({ status: 'failed', error: 'bad key' }), sleep }, 't')).error, 'bad key',
  )
  assert.equal((await pollTaskResult({ get: async () => { throw new Error('net') }, sleep }, 't')).error, 'net')
  const to = await pollTaskResult({ get: async () => ({ status: 'running' }), sleep }, 't', { maxTries: 3 })
  assert.deepEqual(to, { ok: false, error: 'timeout' })
})

test('slot helpers', () => {
  assert.equal(frameTypeOf('last'), 'last')
  assert.equal(frameTypeOf('first'), 'first')
  assert.equal(imageFrameTypeOf('last'), 'storyboard_last')
  assert.equal(boundColumnOf('first'), 'first_frame_image_id')
})
