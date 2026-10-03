import test from 'node:test'
import assert from 'node:assert/strict'
import { runDeleteFlow, classifyFailure, fetchFullBackup, createProjectWithEpisodes } from '../src/components/home/projectFlows.js'

const drama = { id: 7, title: 'Rain' }

function deps(over = {}) {
  const calls = []
  const d = {
    calls,
    confirmDelete: async () => { calls.push('confirmDelete'); return true },
    confirmWithoutSnapshot: async (why) => { calls.push(['confirmWithoutSnapshot', why]); return true },
    snapshot: async (id) => { calls.push(['snapshot', id]); return { ok: true, id: 's1' } },
    remove: async (id) => { calls.push(['remove', id]) },
    remember: (rec) => { calls.push(['remember', rec]) },
    now: () => 123,
    ...over,
  }
  return d
}

test('delete: snapshot is taken before the delete call and remembered', async () => {
  const d = deps()
  const r = await runDeleteFlow(drama, d)
  assert.equal(r.status, 'deleted')
  assert.deepEqual(r.snapshot, { ok: true, id: 's1' })
  const names = d.calls.map((c) => (Array.isArray(c) ? c[0] : c))
  assert.deepEqual(names, ['confirmDelete', 'snapshot', 'remove', 'remember'])
  assert.deepEqual(d.calls[3][1], { dramaId: 7, title: 'Rain', snapshotId: 's1', at: 123 })
})

test('delete: cancelling the first confirm touches nothing', async () => {
  const d = deps({ confirmDelete: async () => false })
  const r = await runDeleteFlow(drama, d)
  assert.equal(r.status, 'cancelled')
  assert.equal(d.calls.length, 0)
})

test('delete: snapshot unavailable asks again; declining keeps the project', async () => {
  const d = deps({ snapshot: async () => ({ ok: false, reason: 'unavailable' }), confirmWithoutSnapshot: async (why) => { d.calls.push(['again', why]); return false } })
  const r = await runDeleteFlow(drama, d)
  assert.equal(r.status, 'cancelled')
  assert.deepEqual(d.calls.at(-1), ['again', 'unavailable'])
  assert.equal(d.calls.some((c) => Array.isArray(c) && c[0] === 'remove'), false)
})

test('delete: snapshot failed but user insists -> deleted without a log entry', async () => {
  const d = deps({ snapshot: async () => ({ ok: false, reason: 'failed' }) })
  const r = await runDeleteFlow(drama, d)
  assert.equal(r.status, 'deleted')
  assert.equal(r.snapshot, null)
  assert.equal(d.calls.some((c) => Array.isArray(c) && c[0] === 'remember'), false)
})

test('delete: a throwing snapshot counts as failed, a throwing remove reports failure', async () => {
  const d = deps({ snapshot: async () => { throw new Error('boom') } })
  assert.equal((await runDeleteFlow(drama, d)).status, 'deleted')
  const e = deps({ remove: async () => { throw new Error('nope') } })
  const r = await runDeleteFlow(drama, e)
  assert.equal(r.status, 'failed')
  assert.equal(r.error.message, 'nope')
  assert.equal(e.calls.some((c) => Array.isArray(c) && c[0] === 'remember'), false)
})

test('classifyFailure separates missing endpoints from real failures', () => {
  assert.equal(classifyFailure({ response: { status: 404 } }), 'unavailable')
  assert.equal(classifyFailure({ status: 405 }), 'unavailable')
  assert.equal(classifyFailure({ response: { status: 501 } }), 'unavailable')
  assert.equal(classifyFailure({ response: { status: 500 } }), 'failed')
  assert.equal(classifyFailure(new Error('x')), 'failed')
  assert.equal(classifyFailure(null), 'failed')
})

test('fetchFullBackup posts, returns the blob, and maps errors', async () => {
  const seen = []
  const ok = await fetchFullBackup(7, async (url, init) => {
    seen.push([url, init.method])
    return { ok: true, status: 200, blob: async () => 'BLOB' }
  })
  assert.equal(ok, 'BLOB')
  assert.deepEqual(seen[0], ['/api/v1/dramas/7/backup/full', 'POST'])
  await assert.rejects(
    fetchFullBackup(7, async () => ({ ok: false, status: 404, json: async () => ({}) })),
    (e) => e.reason === 'unavailable',
  )
  await assert.rejects(
    fetchFullBackup(7, async () => ({ ok: false, status: 500, json: async () => ({ error: { code: 'BACKUP_CORRUPT', message: 'bad' } }) })),
    (e) => e.reason === 'failed' && e.code === 'BACKUP_CORRUPT',
  )
  await assert.rejects(fetchFullBackup(7, async () => { throw new Error('offline') }), (e) => e.reason === 'failed')
})

test('createProjectWithEpisodes creates, saves episodes, and resolves the first episode by number', async () => {
  const calls = []
  const api = {
    create: async (body) => { calls.push(['create', body]); return { id: 21 } },
    saveEpisodes: async (id, eps) => { calls.push(['save', id, eps.map((e) => e.episode_number)]) },
    get: async (id) => { calls.push(['get', id]); return { id, episodes: [{ id: 91, episode_number: 2 }, { id: 90, episode_number: 1 }] } },
    remove: async (id) => { calls.push(['remove', id]) },
  }
  const r = await createProjectWithEpisodes(api, { title: ' T ', description: ' d ', aspect_ratio: '9:16' }, [
    { episode_number: 1, title: 'a', script_content: 'x', chapter_titles: ['a'] },
    { episode_number: 2, title: 'b', script_content: 'y' },
  ])
  assert.deepEqual(r, { dramaId: 21, episodeId: 90 })
  assert.deepEqual(calls[0], ['create', { title: 'T', description: 'd', metadata: { aspect_ratio: '9:16' } }])
  assert.deepEqual(calls[1], ['save', 21, [1, 2]])
})

test('createProjectWithEpisodes removes the half-made project when saving episodes fails', async () => {
  const calls = []
  const api = {
    create: async () => ({ id: 5 }),
    saveEpisodes: async () => { throw new Error('save failed') },
    get: async () => ({}),
    remove: async (id) => { calls.push(['remove', id]) },
  }
  await assert.rejects(createProjectWithEpisodes(api, { title: 'T' }, [{ episode_number: 1, title: 'a', script_content: '' }]), /save failed/)
  assert.deepEqual(calls, [['remove', 5]])
})
