import test from 'node:test'
import assert from 'node:assert/strict'
import { episodeOfRoute } from '../src/utils/episodeContext.js'

test('episodeOfRoute reads :episodeId from the shell routes', () => {
  for (const name of ['episode-script', 'episode-storyboard', 'episode-timeline', 'episode-canvas', 'episode-export', 'shot-workbench']) {
    assert.equal(episodeOfRoute({ name, params: { dramaId: '12', episodeId: '7' }, query: {} }), 7, name)
  }
})

test('episodeOfRoute rejects a non-numeric episodeId and ignores non-episode routes', () => {
  assert.equal(episodeOfRoute({ name: 'episode-script', params: { dramaId: '1', episodeId: 'x' }, query: {} }), null)
  assert.equal(episodeOfRoute({ name: 'assets', params: { dramaId: '1' }, query: {} }, 5), null)
})
