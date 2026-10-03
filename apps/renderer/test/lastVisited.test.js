import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useShellStore } from '../src/stores/shell.js'
import { cardNextStop } from '../src/utils/homeModel.js'

// 首页卡片读取外壳 store 写下的“上次停留”记录；两边的约定（localStorage 键、集 id 为数字、视图名）必须一致。

function memoryStorage() {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

const project = {
  id: 12,
  episodes: [{ id: 8, episode_number: 2 }, { id: 7, episode_number: 1 }],
}

beforeEach(() => {
  setActivePinia(createPinia())
  globalThis.localStorage = memoryStorage()
})

test('a view remembered by the shell opens again from the card', () => {
  const shell = useShellStore()
  shell.rememberView(12, 8, 'canvas')
  const stop = cardNextStop(project, shell.lastView(12))
  assert.equal(stop.kind, 'last')
  assert.deepEqual(stop.location, { name: 'episode-canvas', params: { dramaId: 12, episodeId: 8 } })
})

test('route params from the router (strings) are remembered as numbers and still match', () => {
  const shell = useShellStore()
  shell.rememberView('12', '7', 'timeline')
  assert.deepEqual(shell.lastView(12), { episodeId: 7, view: 'timeline' })
  assert.equal(cardNextStop(project, shell.lastView(12)).location.params.episodeId, 7)
})

test('memory of another project does not leak into this card', () => {
  const shell = useShellStore()
  shell.rememberView(99, 8, 'canvas')
  const stop = cardNextStop(project, shell.lastView(12))
  assert.equal(stop.kind, 'first')
  assert.equal(stop.location.params.episodeId, 7)
})

test('the episode was deleted after the view was remembered: fall back to episode 1 script', () => {
  const shell = useShellStore()
  shell.rememberView(12, 55, 'storyboard')
  const stop = cardNextStop(project, shell.lastView(12))
  assert.equal(stop.kind, 'first')
  assert.deepEqual(stop.location, { name: 'episode-script', params: { dramaId: 12, episodeId: 7 } })
})

test('corrupt or disabled storage never throws and falls back', () => {
  globalThis.localStorage = memoryStorage()
  globalThis.localStorage.setItem('talekiln.shell.last.12', '{broken')
  const shell = useShellStore()
  assert.equal(shell.lastView(12), null)
  globalThis.localStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(shell.lastView(12), null)
  assert.doesNotThrow(() => shell.rememberView(12, 7, 'script'))
  assert.equal(cardNextStop(project, shell.lastView(12)).kind, 'first')
})

test('a project with no episodes at all lands on project-home', () => {
  const shell = useShellStore()
  shell.rememberView(12, 7, 'script')
  const stop = cardNextStop({ id: 12, episodes: [] }, shell.lastView(12))
  assert.equal(stop.kind, 'empty')
  assert.deepEqual(stop.location, { name: 'project-home', params: { dramaId: 12 } })
})
