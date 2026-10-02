import test from 'node:test'
import assert from 'node:assert/strict'
import { makeQueuedId, parseQueuedId, toLegacyTask } from '../src/utils/queuedTask.js'

test('queued id round-trips; non-queued ids are ignored', () => {
  const id = makeQueuedId({ taskId: 'abc-1', episodeId: 3, storyboardId: 9, kind: 'video' })
  assert.deepEqual(parseQueuedId(id), { taskId: 'abc-1', episodeId: '3', storyboardId: '9', kind: 'video' })
  assert.equal(parseQueuedId(makeQueuedId({ episodeId: 3, storyboardId: 9, kind: 'image' })).taskId, null)
  assert.equal(parseQueuedId('123'), null)
  assert.equal(parseQueuedId('q:a:1:2:audio'), null)
})

test('toLegacyTask: failure, cancel, in-flight and write-back wait', () => {
  assert.deepEqual(toLegacyTask({ state: 'failed', error_message: 'boom' }, null), { status: 'failed', error: 'boom' })
  assert.equal(toLegacyTask({ state: 'cancelled' }, null).error, '已取消')
  assert.equal(toLegacyTask({ state: 'polling' }, null).status, 'processing')
  assert.equal(toLegacyTask({ state: 'succeeded' }, { state: 'running' }).status, 'processing')
  assert.equal(toLegacyTask({ state: 'succeeded' }, { state: 'fresh' }).status, 'completed')
})

test('toLegacyTask without a real task (cache hit / already fresh)', () => {
  assert.equal(toLegacyTask(null, { state: 'fresh' }).status, 'completed')
  assert.equal(toLegacyTask(null, { state: 'failed', error_code: 'X' }).error, 'X')
  assert.equal(toLegacyTask(null, { state: 'stale' }).status, 'processing')
})
