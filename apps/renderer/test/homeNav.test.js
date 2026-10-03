import test from 'node:test'
import assert from 'node:assert/strict'
import { locationAfterDialog, sampleLocation } from '../src/components/home/homeNav.js'

const never = () => { throw new Error('should not fetch') }

test('created project goes straight to the script of its episode', async () => {
  const loc = await locationAfterDialog({ dramaId: 4, episodeId: 9 }, { getDrama: never })
  assert.deepEqual(loc, { name: 'episode-script', params: { dramaId: 4, episodeId: 9 } })
})

test('imported package lands on the last visited view when the episode exists', async () => {
  const drama = { id: 7, episodes: [{ id: 70, episode_number: 1 }, { id: 71, episode_number: 2 }] }
  const loc = await locationAfterDialog({ dramaId: 7 }, { getDrama: async () => drama, lastView: () => ({ episodeId: 71, view: 'timeline' }) })
  assert.deepEqual(loc, { name: 'episode-timeline', params: { dramaId: 7, episodeId: 71 } })
})

test('imported package with a stale last view falls back to episode 1 script', async () => {
  const drama = { id: 7, episodes: [{ id: 70, episode_number: 1 }] }
  const loc = await locationAfterDialog({ drama_id: 7 }, { getDrama: async () => drama, lastView: () => ({ episodeId: 99, view: 'canvas' }) })
  assert.deepEqual(loc, { name: 'episode-script', params: { dramaId: 7, episodeId: 70 } })
})

test('imported package without episodes, or a failed fetch, lands on project-home', async () => {
  const a = await locationAfterDialog({ dramaId: 8 }, { getDrama: async () => ({ id: 8, episodes: [] }) })
  assert.deepEqual(a, { name: 'project-home', params: { dramaId: 8 } })
  const b = await locationAfterDialog({ dramaId: 8 }, { getDrama: async () => { throw new Error('x') } })
  assert.deepEqual(b, { name: 'project-home', params: { dramaId: 8 } })
})

test('cancelled dialog or malformed result does not navigate', async () => {
  assert.equal(await locationAfterDialog(undefined, { getDrama: never }), null)
  assert.equal(await locationAfterDialog({}, { getDrama: never }), null)
})

test('sample project opens on the storyboard view', () => {
  assert.deepEqual(sampleLocation({ drama_id: 1, episode_id: 2 }), { name: 'episode-storyboard', params: { dramaId: 1, episodeId: 2 } })
  assert.deepEqual(sampleLocation({ drama_id: 1 }), { name: 'project-home', params: { dramaId: 1 } })
  assert.equal(sampleLocation(null), null)
})
