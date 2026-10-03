import test from 'node:test'
import assert from 'node:assert/strict'
import { createGenerateActions } from '../src/components/generate/generateActions.js'

function harness(overrides = {}) {
  const calls = { dialogs: [], notes: [], directors: [], pushes: [] }
  const actions = createGenerateActions({
    notify: (type, key, params) => calls.notes.push({ type, key, params }),
    openDirector: (ep) => calls.directors.push(ep),
    ...overrides,
  })
  const ctx = (extra = {}) => ({
    dramaId: 3,
    episodeId: 9,
    openDialog: (id, props) => { calls.dialogs.push({ id, props }); return Promise.resolve(undefined) },
    router: { push: (to) => calls.pushes.push(to) },
    store: { style: 'anime', aspectRatio: '16:9' },
    ...extra,
  })
  return { actions, calls, ctx }
}

test('exposes exactly the eight generate.* menu ids', () => {
  const { actions } = harness()
  assert.deepEqual(Object.keys(actions).sort(), [
    'generate.allFirstFrames', 'generate.allVideos', 'generate.allVoice', 'generate.batchEpisodes',
    'generate.director', 'generate.missing', 'generate.pipeline', 'generate.rerunDraft',
  ])
})

test('pipeline opens the one-click dialog with the project style', async () => {
  const { actions, calls, ctx } = harness()
  await actions['generate.pipeline'](ctx())
  assert.deepEqual(calls.dialogs, [{ id: 'generate.pipeline', props: { dramaId: 3, episodeId: 9, artStyle: 'anime' } }])
})

test('missing / first frames / videos open the confirm dialog carrying the action id', async () => {
  const { actions, calls, ctx } = harness()
  for (const id of ['generate.missing', 'generate.allFirstFrames', 'generate.allVideos']) await actions[id](ctx())
  assert.deepEqual(calls.dialogs.map((d) => [d.id, d.props.action]), [
    ['generate.confirm', 'generate.missing'],
    ['generate.confirm', 'generate.allFirstFrames'],
    ['generate.confirm', 'generate.allVideos'],
  ])
  assert.equal(calls.dialogs[0].props.episodeId, 9)
})

test('voice and rerunDraft open their dialogs', async () => {
  const { actions, calls, ctx } = harness()
  await actions['generate.allVoice'](ctx())
  await actions['generate.rerunDraft'](ctx())
  assert.deepEqual(calls.dialogs.map((d) => d.id), ['generate.voice', 'generate.rerunDraft'])
  assert.equal(calls.dialogs[1].props.episodeId, 9)
})

test('director opens the drawer for the current episode', async () => {
  const { actions, calls, ctx } = harness()
  await actions['generate.director'](ctx())
  assert.deepEqual(calls.directors, [9])
  assert.equal(calls.dialogs.length, 0)
})

test('batchEpisodes navigates to the project batch route and works without an episode', async () => {
  const { actions, calls, ctx } = harness()
  await actions['generate.batchEpisodes'](ctx({ episodeId: null }))
  assert.deepEqual(calls.pushes, [{ name: 'batch', params: { dramaId: 3 } }])
})

test('episode-scoped actions without an episode warn instead of opening anything', async () => {
  const { actions, calls, ctx } = harness()
  for (const id of ['generate.pipeline', 'generate.missing', 'generate.allVoice', 'generate.director', 'generate.rerunDraft']) {
    await actions[id](ctx({ episodeId: null }))
  }
  assert.equal(calls.dialogs.length, 0)
  assert.equal(calls.directors.length, 0)
  assert.equal(calls.notes.length, 5)
  assert.equal(calls.notes[0].type, 'warning')
  assert.equal(calls.notes[0].key, 'generate.noEpisode')
})

test('batchEpisodes without a project warns', async () => {
  const { actions, calls, ctx } = harness()
  await actions['generate.batchEpisodes'](ctx({ dramaId: null }))
  assert.equal(calls.pushes.length, 0)
  assert.equal(calls.notes[0].key, 'generate.noProject')
})
