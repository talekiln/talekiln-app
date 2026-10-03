import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useAssetsStore, setAssetsApi } from '../src/stores/assets.js'
import { useShellStore } from '../src/stores/shell.js'

function db() {
  return {
    characters: [{ id: 1, name: '林夏（小夏）' }, { id: 2, name: '陈默' }],
    scenes: [{ id: 7, location: '旧书店', time: '黄昏' }],
    props: [{ id: 5, name: '旧书' }],
  }
}

function fakeApi(over = {}) {
  const data = db()
  const calls = []
  let nextId = 100
  const locks = []
  const api = {
    calls,
    data,
    loadAll: async (dramaId) => {
      calls.push(['loadAll', dramaId])
      return JSON.parse(JSON.stringify(data))
    },
    create: async (kind, dramaId, body, ctx) => {
      calls.push(['create', kind, dramaId, body, ctx])
      const item = { id: ++nextId, ...body }
      data[kind].push(item)
      return item
    },
    update: async (kind, id, patch) => {
      calls.push(['update', kind, id, patch])
      const it = data[kind].find((x) => x.id === id)
      Object.assign(it, patch)
      return it
    },
    remove: async (kind, id) => {
      calls.push(['remove', kind, id])
      data[kind] = data[kind].filter((x) => x.id !== id)
    },
    listLocks: async (kind, ids) => {
      calls.push(['listLocks', kind, ids])
      return locks.filter((l) => l.type === kind && ids.includes(l.entity_id))
    },
    lock: async (kind, id, body) => {
      calls.push(['lock', kind, id, body])
      const l = { type: kind, entity_id: id, ...body }
      locks.push(l)
      return l
    },
    unlock: async (kind, id) => {
      calls.push(['unlock', kind, id])
      const i = locks.findIndex((l) => l.type === kind && l.entity_id === id)
      if (i >= 0) locks.splice(i, 1)
    },
    legacyEnabled: async () => true,
    generateImage: async () => ({ task_id: 't1' }),
    getTask: async () => ({ status: 'completed' }),
    ...over,
  }
  return api
}

function memoryStorage() {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

beforeEach(() => {
  setActivePinia(createPinia())
  globalThis.localStorage = memoryStorage()
})

test('load fills the three lists, counts and locks for characters and scenes', async () => {
  const api = fakeApi()
  api.data.characters[0].image_url = 'x'
  setAssetsApi(api)
  const s = useAssetsStore()
  await s.load(12)
  assert.equal(s.dramaId, 12)
  assert.deepEqual(s.byKind.characters.map((c) => c.id), [1, 2])
  assert.deepEqual(s.counts, { characters: 2, scenes: 1, props: 1 })
  assert.equal(s.loading, false)
  assert.ok(api.calls.some((c) => c[0] === 'listLocks' && c[1] === 'character'))
  assert.ok(api.calls.some((c) => c[0] === 'listLocks' && c[1] === 'scene'))
  // props have no reference lock on the backend
  assert.ok(!api.calls.some((c) => c[0] === 'listLocks' && c[1] === 'prop'))
})

test('load failure keeps the error, empties nothing stale for the same project, and clears loading', async () => {
  setAssetsApi(fakeApi({ loadAll: async () => { throw new Error('offline') } }))
  const s = useAssetsStore()
  await s.load(12)
  assert.equal(s.loadError, 'offline')
  assert.equal(s.loading, false)
})

test('switching project clears the previous lists; a stale response is ignored', async () => {
  let release
  const slow = new Promise((r) => { release = r })
  const api = fakeApi({
    loadAll: async (id) => {
      if (id === 1) { await slow; return { characters: [{ id: 1, name: 'old' }], scenes: [], props: [] } }
      return { characters: [{ id: 2, name: 'new' }], scenes: [], props: [] }
    },
  })
  setAssetsApi(api)
  const s = useAssetsStore()
  const p1 = s.load(1)
  await s.load(2)
  release()
  await p1
  assert.equal(s.dramaId, 2)
  assert.deepEqual(s.byKind.characters.map((c) => c.name), ['new'])
})

test('create / update / remove call the api and update the lists', async () => {
  const api = fakeApi()
  setAssetsApi(api)
  const s = useAssetsStore()
  await s.load(12)
  const c = await s.create('characters', { name: '新角色' })
  assert.equal(c.name, '新角色')
  assert.equal(s.counts.characters, 3)
  assert.deepEqual(api.calls.find((x) => x[0] === 'create').slice(1, 3), ['characters', 12])
  await s.update('props', 5, { name: '旧书本' })
  assert.equal(s.find('props', 5).name, '旧书本')
  await s.remove('scenes', 7)
  assert.equal(s.counts.scenes, 0)
  assert.equal(s.find('scenes', 7), null)
})

test('create passes the episode context to the api', async () => {
  const api = fakeApi()
  setAssetsApi(api)
  const s = useAssetsStore()
  await s.load(12)
  await s.create('scenes', { location: '天台', time: '夜' }, { episodeId: 3 })
  assert.deepEqual(api.calls.find((x) => x[0] === 'create')[4], { episodeId: 3 })
})

test('create reloads when the api cannot return the created item', async () => {
  const api = fakeApi({
    create: async (kind, dramaId, body) => { api.data[kind].push({ id: 55, ...body }); return null },
  })
  setAssetsApi(api)
  const s = useAssetsStore()
  await s.load(12)
  const item = await s.create('characters', { name: 'Zed' })
  assert.equal(item.id, 55)
  assert.equal(s.counts.characters, 3)
})

test('update with extra_images array is serialised for the api', async () => {
  const api = fakeApi()
  setAssetsApi(api)
  const s = useAssetsStore()
  await s.load(12)
  await s.update('characters', 1, { extra_images: ['a.png'] })
  const call = api.calls.find((x) => x[0] === 'update')
  assert.equal(call[3].extra_images, '["a.png"]')
})

test('lock / unlock for characters and scenes; props are unsupported', async () => {
  const api = fakeApi()
  setAssetsApi(api)
  const s = useAssetsStore()
  await s.load(12)
  assert.equal(s.isLocked('characters', 1), false)
  const r = await s.lock('characters', 1, { id: 9, local_path: 'a.png', image_url: '' })
  assert.equal(r.ok, true)
  assert.equal(s.isLocked('characters', 1), true)
  assert.equal(s.lockOf('characters', 1).local_path, 'a.png')
  // lock body uses the shared lockBody shape
  assert.deepEqual(api.calls.find((x) => x[0] === 'lock')[3], { image_url: null, local_path: 'a.png', source_image_id: 9 })
  await s.unlock('characters', 1)
  assert.equal(s.isLocked('characters', 1), false)
  const p = await s.lock('props', 5, { id: 1, local_path: 'p.png' })
  assert.deepEqual(p, { ok: false, reason: 'unsupported' })
  assert.ok(!api.calls.some((x) => x[0] === 'lock' && x[1] === 'prop'))
})

test('resolveMention and refs use the loaded lists', async () => {
  setAssetsApi(fakeApi())
  const s = useAssetsStore()
  await s.load(12)
  assert.equal(s.resolveMention('@小夏').id, 1)
  assert.equal(s.resolveMention('#旧书店').id, 7)
  assert.equal(s.resolveMention('@nobody'), null)
  const r = s.refs({ character_ids: [2], scene_id: 7, prop_ids: [5] })
  assert.deepEqual([r.characters.length, r.scenes.length, r.props.length], [1, 1, 1])
})

test('generate is gated on legacy_enabled and never throws on 402', async () => {
  const api = fakeApi({ legacyEnabled: async () => false })
  setAssetsApi(api)
  const s = useAssetsStore()
  await s.load(12)
  await s.refreshGate(3)
  assert.equal(s.legacyEnabled, false)
  assert.equal(s.gate.allowed, false)
  const blocked = await s.generate('characters', 1)
  assert.deepEqual(blocked, { ok: false, reasonKey: 'assets.gen.legacyOff' })
  assert.ok(!api.calls.some((x) => x[0] === 'generateImage'))
})

test('generate: success reloads, spend limit is inline, other errors are recorded per asset', async () => {
  const api = fakeApi()
  setAssetsApi(api)
  const s = useAssetsStore()
  await s.load(12)
  await s.refreshGate(3)
  assert.equal(s.gate.allowed, true)
  const ok = await s.generate('characters', 1, { style: 'anime' }, { intervalMs: 1, sleep: async () => {} })
  assert.equal(ok.ok, true)
  assert.equal(s.isGenerating('characters', 1), false)
  assert.equal(s.genError('characters', 1), null)

  api.generateImage = async () => { throw Object.assign(new Error('limit'), { response: { status: 402 }, code: 'SPEND_LIMIT' }) }
  const lim = await s.generate('characters', 2)
  assert.equal(lim.ok, false)
  assert.equal(s.genError('characters', 2).type, 'spendLimit')

  api.generateImage = async () => ({ task_id: 't2' })
  api.getTask = async () => ({ status: 'failed', error: 'model down' })
  const bad = await s.generate('scenes', 7, {}, { intervalMs: 1, sleep: async () => {} })
  assert.equal(bad.ok, false)
  assert.equal(s.genError('scenes', 7).message, 'model down')
  // a new attempt clears the old error
  api.getTask = async () => ({ status: 'completed' })
  await s.generate('scenes', 7, {}, { intervalMs: 1, sleep: async () => {} })
  assert.equal(s.genError('scenes', 7), null)
})

test('mutations keep the shell asset counts in sync for the same project', async () => {
  setAssetsApi(fakeApi())
  const shell = useShellStore()
  shell.dramaId = 12
  shell.assetCounts = { characters: 0, scenes: 0, props: 0 }
  const s = useAssetsStore()
  await s.load(12)
  assert.deepEqual(shell.assetCounts, { characters: 2, scenes: 1, props: 1 })
  await s.create('props', { name: 'cup' })
  assert.equal(shell.assetCounts.props, 2)
  // another project does not touch the shell counts
  shell.dramaId = 99
  await s.remove('props', 5)
  assert.equal(shell.assetCounts.props, 2)
})
