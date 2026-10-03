import test from 'node:test'
import assert from 'node:assert/strict'
import { isLegacyPath, resolveLegacyRoute } from '../src/utils/legacyRoutes.js'

// 剧集 7 属于项目 12；项目 12 的第 1 集是 3；项目 13 没有剧集
const deps = {
  episodeToDrama: async (id) => ({ 7: 12, 3: 12, 21: 30 })[id] ?? null,
  firstEpisode: async (dramaId) => ({ 12: 3, 30: 21 })[dramaId] ?? null,
}
const go = (path, query = {}, d = deps) => resolveLegacyRoute({ path, query }, d)

test('/drama/:id -> project root (shell picks last view); no episodes -> assets', async () => {
  assert.equal(await go('/drama/12'), '/p/12')
  assert.equal(await go('/drama/13'), '/p/13/assets')
})

test('/film/:id and ?episode=N -> storyboard of that episode', async () => {
  assert.equal(await go('/film/12', { episode: '3' }), '/p/12/e/3/storyboard')
  assert.equal(await go('/film/12', { episode: '9' }), '/p/12/e/9/storyboard')
  assert.equal(await go('/film/12'), '/p/12/e/3/storyboard')
  assert.equal(await go('/film/13'), '/p/13/assets')
})

test('/film/:id/canvas -> first episode canvas', async () => {
  assert.equal(await go('/film/12/canvas'), '/p/12/e/3/canvas')
  assert.equal(await go('/film/12/canvas', { episode: '7' }), '/p/12/e/7/canvas')
  assert.equal(await go('/film/13/canvas'), '/p/13/assets')
})

test('/film/new -> /new-project', async () => {
  assert.equal(await go('/film/new'), '/new-project')
})

test('/episodes/:id/{script,canvas,timeline,storyboard,export} -> /p/:drama/e/:id/...', async () => {
  for (const v of ['script', 'canvas', 'timeline', 'storyboard', 'export']) {
    assert.equal(await go(`/episodes/7/${v}`), `/p/12/e/7/${v}`)
  }
})

test('/episodes/:id/* uses ?drama= hint without a lookup', async () => {
  let calls = 0
  const counting = { ...deps, episodeToDrama: async () => { calls++; return 99 } }
  assert.equal(await go('/episodes/7/script', { drama: '12' }, counting), '/p/12/e/7/script')
  assert.equal(calls, 0)
})

test('/episodes/:id/* with unknown owner (or lookup error) -> /', async () => {
  assert.equal(await go('/episodes/99/script'), '/')
  const boom = { ...deps, episodeToDrama: async () => { throw new Error('offline') } }
  assert.equal(await go('/episodes/7/timeline', {}, boom), '/')
})

test('/project/:d/storyboard?episode= -> /p/:d/e/:ep/storyboard (default: first episode)', async () => {
  assert.equal(await go('/project/12/storyboard', { episode: '7' }), '/p/12/e/7/storyboard')
  assert.equal(await go('/project/12/storyboard'), '/p/12/e/3/storyboard')
  assert.equal(await go('/project/13/storyboard'), '/p/13/assets')
})

test('/project/:d/library and /batch', async () => {
  assert.equal(await go('/project/12/library'), '/p/12/assets')
  assert.equal(await go('/project/12/batch'), '/p/12/batch')
})

test('/project/:d/shot/:shotId -> episode from ?episode=, shotEpisode(), then first episode', async () => {
  assert.equal(await go('/project/12/shot/55', { episode: '7' }), '/p/12/e/7/shot/55')
  const withLookup = { ...deps, shotEpisode: async (id) => (id === '55' ? 7 : null) }
  assert.equal(await go('/project/12/shot/55', {}, withLookup), '/p/12/e/7/shot/55')
  assert.equal(await go('/project/12/shot/56', {}, withLookup), '/p/12/e/3/shot/56')
  assert.equal(await go('/project/13/shot/1'), '/p/13/assets')
})

test('array query values and non-numeric ids do not break', async () => {
  assert.equal(await go('/film/12', { episode: ['7', '8'] }), '/p/12/e/7/storyboard')
  assert.equal(await go('/film/12', { episode: 'abc' }), '/p/12/e/3/storyboard')
  assert.equal(await go('/film/abc'), '/')
  assert.equal(await go('/episodes/abc/script'), '/')
})

test('missing deps degrade to a safe page, never throw', async () => {
  assert.equal(await go('/film/12', {}, {}), '/p/12/assets')
  assert.equal(await go('/episodes/7/script', {}, {}), '/')
})

test('non-legacy paths return null; trailing slash and hash are tolerated', async () => {
  assert.equal(await go('/p/12/e/3/script'), null)
  assert.equal(await go('/'), null)
  assert.equal(await go('/spend'), null)
  assert.equal(await go('/film/12/'), '/p/12/e/3/storyboard')
  assert.equal(isLegacyPath('/film/12'), true)
  assert.equal(isLegacyPath('/film/abc'), true)
  assert.equal(isLegacyPath('/p/12'), false)
  assert.equal(isLegacyPath('/project/1/library?x=1'), true)
  assert.equal(isLegacyPath('/media-library'), false)
})
