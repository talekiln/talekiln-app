import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useShellStore, setShellApi } from '../src/stores/shell.js'

const DRAMA = {
  id: 12, title: 'P', style: 'realistic', quality: 'draft', metadata: { aspect_ratio: '9:16' },
  episodes: [{ id: 8, episode_number: 2, title: 'B' }, { id: 7, episode_number: 1, title: 'A' }],
  characters: [{ id: 1 }, { id: 2 }], scenes: [{ id: 1 }], props: [],
}

function fakeApi(over = {}) {
  const calls = []
  return {
    calls,
    getDrama: async (id) => { calls.push(['getDrama', id]); return { ...DRAMA, id } },
    putQuality: async (id, q) => { calls.push(['putQuality', id, q]); return { quality: q } },
    renderCoreOk: async (ep) => { calls.push(['renderCoreOk', ep]); return false },
    runningTaskCount: async () => 3,
    ...over,
  }
}

function memoryStorage() {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

beforeEach(() => {
  setActivePinia(createPinia())
  globalThis.localStorage = memoryStorage()
})

test('loadProject fills drama, sorted episodes, asset counts, quality and render core status', async () => {
  const api = fakeApi()
  setShellApi(api)
  const s = useShellStore()
  await s.loadProject(12)
  assert.equal(s.dramaId, 12)
  assert.deepEqual(s.episodes.map((e) => e.id), [7, 8])
  assert.deepEqual(s.assetCounts, { characters: 2, scenes: 1, props: 0 })
  assert.equal(s.quality, 'draft')
  assert.equal(s.renderCoreOk, false)
  assert.deepEqual(api.calls.find((c) => c[0] === 'renderCoreOk'), ['renderCoreOk', 7])
})

test('loadProject ignores a stale response when the project changed meanwhile', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const api = fakeApi({
    getDrama: async (id) => { if (id === 1) await gate; return { ...DRAMA, id, title: `P${id}` } },
  })
  setShellApi(api)
  const s = useShellStore()
  const first = s.loadProject(1)
  await s.loadProject(2)
  release()
  await first
  assert.equal(s.dramaId, 2)
  assert.equal(s.drama.title, 'P2')
})

test('loadProject failure leaves an empty-but-valid state and does not throw', async () => {
  setShellApi(fakeApi({ getDrama: async () => { throw new Error('offline') } }))
  const s = useShellStore()
  await s.loadProject(5)
  assert.equal(s.dramaId, 5)
  assert.equal(s.drama, null)
  assert.deepEqual(s.episodes, [])
  assert.equal(s.loadError, 'offline')
})

test('setQuality calls PUT and updates the store', async () => {
  const api = fakeApi()
  setShellApi(api)
  const s = useShellStore()
  await s.loadProject(12)
  await s.setQuality('final')
  assert.equal(s.quality, 'final')
  assert.deepEqual(api.calls.at(-1), ['putQuality', 12, 'final'])
})

test('setQuality keeps the choice locally and does not throw when the endpoint is missing (404)', async () => {
  const notFound = Object.assign(new Error('Not Found'), { response: { status: 404 } })
  setShellApi(fakeApi({ putQuality: async () => { throw notFound } }))
  const s = useShellStore()
  await s.loadProject(12)
  assert.equal(await s.setQuality('final'), true)
  assert.equal(s.quality, 'final')
  assert.equal(globalThis.localStorage.getItem('talekiln.quality.12'), 'final')
})

test('setQuality reverts on other errors and rejects invalid values', async () => {
  setShellApi(fakeApi({ putQuality: async () => { throw Object.assign(new Error('boom'), { response: { status: 500 } }) } }))
  const s = useShellStore()
  await s.loadProject(12)
  assert.equal(await s.setQuality('final'), false)
  assert.equal(s.quality, 'draft')
  assert.equal(await s.setQuality('ultra'), false)
  assert.equal(s.quality, 'draft')
})

test('rememberView / lastView round-trip and survive a throwing localStorage', () => {
  setShellApi(fakeApi())
  const s = useShellStore()
  s.rememberView(12, 8, 'canvas')
  assert.deepEqual(s.lastView(12), { episodeId: 8, view: 'canvas' })
  assert.equal(s.lastView(99), null)
  globalThis.localStorage = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
  }
  assert.doesNotThrow(() => s.rememberView(12, 8, 'script'))
  assert.equal(s.lastView(12), null)
})

test('lastView ignores corrupt or unknown values', () => {
  const s = useShellStore()
  globalThis.localStorage.setItem('talekiln.shell.last.12', '{nope')
  assert.equal(s.lastView(12), null)
  globalThis.localStorage.setItem('talekiln.shell.last.12', JSON.stringify({ episodeId: 8, view: 'evil' }))
  assert.equal(s.lastView(12), null)
})

test('landingPath: remembered view if the episode still exists, else first episode script, else assets', async () => {
  setShellApi(fakeApi())
  const s = useShellStore()
  await s.loadProject(12)
  assert.equal(s.landingPath(12), '/p/12/e/7/script')
  s.rememberView(12, 8, 'timeline')
  assert.equal(s.landingPath(12), '/p/12/e/8/timeline')
  s.rememberView(12, 999, 'timeline')
  assert.equal(s.landingPath(12), '/p/12/e/7/script')
  setShellApi(fakeApi({ getDrama: async (id) => ({ ...DRAMA, id, episodes: [] }) }))
  await s.loadProject(13)
  assert.equal(s.landingPath(13), '/p/13/assets')
})

test('refreshTasks and stale-only / assets-panel flags', async () => {
  setShellApi(fakeApi())
  const s = useShellStore()
  await s.refreshTasks()
  assert.equal(s.tasksRunning, 3)
  s.setStaleOnly(true)
  assert.equal(s.staleOnly, true)
  s.openAssetsPanel()
  assert.equal(s.assetsPanelOpen, true)
  s.closeAssetsPanel()
  assert.equal(s.assetsPanelOpen, false)
})

test('refreshDraftCount: reads the count, 0 without an episode, an api without it, or on error', async () => {
  setShellApi(fakeApi({ draftCount: async (id) => (id === 7 ? 4 : 0) }))
  const s = useShellStore()
  await s.refreshDraftCount(7)
  assert.equal(s.draftCount, 4)
  await s.refreshDraftCount(null)
  assert.equal(s.draftCount, 0)
  setShellApi(fakeApi())
  await s.refreshDraftCount(7)
  assert.equal(s.draftCount, 0)
  setShellApi(fakeApi({ draftCount: async () => { throw new Error('404') } }))
  await s.refreshDraftCount(7)
  assert.equal(s.draftCount, 0)
})
