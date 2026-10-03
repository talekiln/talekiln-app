import test from 'node:test'
import assert from 'node:assert/strict'
import { createEpisodesApi } from '../src/api/episodesCore.js'

// 内存里的假后端：与 dramaService.saveEpisodes 同语义——按集号 upsert，提交里没有的集号被软删除。
function fakeBackend(initial) {
  let nextId = 100
  const rows = initial.map((e) => ({ storyboards: [], ...e }))
  const calls = []
  return {
    calls,
    rows,
    getDrama: async () => ({ id: 1, episodes: rows.filter((r) => !r.deleted).map((r) => ({ ...r })) }),
    saveEpisodes: async (dramaId, payload) => {
      calls.push(payload.map((p) => ({ ...p })))
      const numbers = new Set(payload.map((p) => p.episode_number))
      for (const r of rows) if (!numbers.has(r.episode_number)) r.deleted = true
      for (const p of payload) {
        const hit = rows.find((r) => r.episode_number === p.episode_number)
        if (hit) Object.assign(hit, p, { deleted: false })
        else rows.push({ id: nextId++, storyboards: [], ...p })
      }
    },
  }
}
const seed = () => [
  { id: 1, episode_number: 1, title: 'one', script_content: 'a' },
  { id: 2, episode_number: 2, title: 'two', script_content: 'b' },
  { id: 3, episode_number: 3, title: 'three', script_content: 'c' },
]
const live = (be) => be.rows.filter((r) => !r.deleted)

test('add appends one episode after the highest number and keeps the others', async () => {
  const be = fakeBackend(seed())
  const api = createEpisodesApi(be)
  const r = await api.add(1, { title: 'new' })
  assert.equal(live(be).length, 4)
  assert.equal(r.episode.episode_number, 4)
  assert.equal(r.episode.title, 'new')
  assert.deepEqual(r.episodes.map((e) => e.episode_number), [1, 2, 3, 4])
  assert.equal(be.calls[0].length, 4)
})

test('append returns the created episodes in order and never drops existing ones', async () => {
  const be = fakeBackend(seed())
  const r = await createEpisodesApi(be).append(1, [{ title: 'x', script_content: '1' }, { title: 'y', script_content: '2' }])
  assert.deepEqual(r.added.map((e) => [e.episode_number, e.title]), [[4, 'x'], [5, 'y']])
  assert.equal(live(be).length, 5)
})

test('rename changes one title and keeps every other episode alive', async () => {
  const be = fakeBackend(seed())
  const r = await createEpisodesApi(be).rename(1, 2, 'renamed')
  assert.deepEqual(live(be).map((e) => e.title), ['one', 'renamed', 'three'])
  assert.equal(r.episode.id, 2)
})

test('remove deletes only that episode and does not renumber the rest', async () => {
  const be = fakeBackend(seed())
  const r = await createEpisodesApi(be).remove(1, 2)
  assert.deepEqual(live(be).map((e) => e.id), [1, 3])
  assert.deepEqual(r.episodes.map((e) => e.episode_number), [1, 3])
})

test('remove refuses to delete the last episode', async () => {
  const be = fakeBackend([seed()[0]])
  await assert.rejects(() => createEpisodesApi(be).remove(1, 1), (e) => e.code === 'LAST_EPISODE')
  assert.equal(live(be).length, 1)
})

test('unknown episode ids raise EPISODE_NOT_FOUND without writing', async () => {
  const be = fakeBackend(seed())
  const api = createEpisodesApi(be)
  for (const fn of [() => api.rename(1, 99, 'x'), () => api.remove(1, 99), () => api.setContent(1, 99, { script_content: 'x' })]) {
    await assert.rejects(fn, (e) => e.code === 'EPISODE_NOT_FOUND')
  }
  assert.equal(be.calls.length, 0)
})

test('setContent replaces script text and optional title for one episode', async () => {
  const be = fakeBackend(seed())
  await createEpisodesApi(be).setContent(1, 3, { script_content: 'new body', title: 'T' })
  assert.equal(live(be)[2].script_content, 'new body')
  assert.equal(live(be)[2].title, 'T')
  assert.equal(live(be)[0].script_content, 'a')
})

test('reorder moves content between number slots; ids stay on their numbers', async () => {
  const be = fakeBackend(seed())
  const r = await createEpisodesApi(be).reorder(1, [2, 3, 1])
  assert.deepEqual(live(be).map((e) => [e.id, e.episode_number, e.title]), [[1, 1, 'two'], [2, 2, 'three'], [3, 3, 'one']])
  assert.deepEqual(r.changed.map((e) => e.id).sort(), [1, 2, 3])
  assert.equal(r.changed.find((e) => e.id === 1).script_content, 'b')
})

test('reorder only reports episodes whose content actually moved', async () => {
  const be = fakeBackend(seed())
  const r = await createEpisodesApi(be).reorder(1, [1, 3, 2])
  assert.deepEqual(r.changed.map((e) => e.id).sort(), [2, 3])
})

test('reorder is blocked when a moved episode already has shots, and nothing is written', async () => {
  const rows = seed()
  rows[1].storyboards = [{ id: 9 }]
  const be = fakeBackend(rows)
  await assert.rejects(() => createEpisodesApi(be).reorder(1, [2, 1, 3]), (e) => e.code === 'EPISODE_HAS_SHOTS')
  assert.equal(be.calls.length, 0)
  // 没被移动的有镜头集不拦
  await createEpisodesApi(be).reorder(1, [1, 3, 2]).catch((e) => assert.equal(e.code, 'EPISODE_HAS_SHOTS'))
})

test('reorder rejects an order that is not a permutation', async () => {
  const be = fakeBackend(seed())
  await assert.rejects(() => createEpisodesApi(be).reorder(1, [1, 2]), (e) => e.code === 'BAD_ORDER')
  assert.equal(be.calls.length, 0)
})

test('each operation reads the drama fresh, so concurrent edits are not overwritten by stale lists', async () => {
  const be = fakeBackend(seed())
  const api = createEpisodesApi(be)
  be.rows.push({ id: 7, episode_number: 4, title: 'added elsewhere', script_content: 'z', storyboards: [] })
  await api.rename(1, 1, 'r')
  assert.equal(live(be).length, 4)
  assert.equal(be.calls[0].length, 4)
})

test('a failed save surfaces the error', async () => {
  const be = fakeBackend(seed())
  const boom = createEpisodesApi({ ...be, saveEpisodes: async () => { throw new Error('boom') } })
  await assert.rejects(() => boom.rename(1, 1, 'x'), /boom/)
})

test('reorder also asks the kernel graph for shots of the moved episodes', async () => {
  const be = fakeBackend(seed())
  const asked = []
  const api = createEpisodesApi({ ...be, countShots: async (id) => { asked.push(id); return id === 3 ? 2 : 0 } })
  await assert.rejects(() => api.reorder(1, [3, 2, 1]), (e) => e.code === 'EPISODE_HAS_SHOTS')
  assert.ok(asked.includes(1))
  assert.equal(be.calls.length, 0)
  // 没动到有镜头的集
  const ok = await api.reorder(1, [2, 1, 3])
  assert.deepEqual(ok.changed.map((e) => e.id).sort(), [1, 2])
})
