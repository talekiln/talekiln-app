import test from 'node:test'
import assert from 'node:assert/strict'

import { createRegistry, fuzzyScore, scoreCommand, RECENT_STORAGE_KEY } from '../src/utils/commandRegistry.js'
import { createBuiltinCommands, createContentProvider } from '../src/utils/builtinCommands.js'

const memStorage = () => {
  const m = new Map()
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
const cmd = (id, title, extra = {}) => ({ id, title, run: () => id, ...extra })
const ids = (rows) => rows.map((r) => r.cmd.id)

// ---------- 模糊匹配 ----------

test('fuzzyScore: substring beats prefix-less subsequence; no match is null; case-insensitive', () => {
  assert.equal(fuzzyScore('', 'anything'), 0)
  assert.equal(fuzzyScore('zzz', 'timeline'), null)
  const sub = fuzzyScore('time', 'Timeline view')
  const seq = fuzzyScore('tmln', 'Timeline view')
  assert.ok(sub > seq && seq !== null)
  assert.ok(fuzzyScore('TIME', 'timeline') === fuzzyScore('time', 'TIMELINE'))
})

test('fuzzyScore: prefix > word start > middle; earlier and shorter is better', () => {
  const prefix = fuzzyScore('画布', '画布视图')
  const middle = fuzzyScore('画布', '切换到画布视图')
  assert.ok(prefix > middle)
  assert.ok(fuzzyScore('view', 'go view') > fuzzyScore('view', 'goview'))
  assert.ok(fuzzyScore('undo', 'undo') > fuzzyScore('undo', 'undo the last long operation'))
})

test('fuzzyScore: multi-term needs every term; contiguous subsequence beats scattered', () => {
  assert.notEqual(fuzzyScore('切换 画布', '切换到画布视图'), null)
  assert.equal(fuzzyScore('切换 导出', '切换到画布视图'), null)
  assert.ok(fuzzyScore('abc', 'xxabcxx') > fuzzyScore('abc', 'a-x-b-x-c'))
})

test('scoreCommand: title outranks keywords outranks group; any hit counts', () => {
  const byTitle = scoreCommand('export', { title: 'export video' })
  const byKeyword = scoreCommand('export', { title: '导出视频', keywords: ['export'] })
  const byGroup = scoreCommand('project', { title: '导出视频', group: 'project' })
  assert.ok(byTitle > byKeyword && byKeyword > byGroup)
  assert.equal(scoreCommand('nothing', { title: '导出视频', keywords: ['export'], group: '项目' }), null)
  assert.equal(scoreCommand('', { title: 'x' }), 0)
})

// ---------- 注册 ----------

test('register validates, returns an unregister function, same id replaces', () => {
  const r = createRegistry({ storage: memStorage() })
  assert.throws(() => r.register({ title: 'x', run() {} }), /id/)
  assert.throws(() => r.register({ id: 'a', run() {} }), /title/)
  assert.throws(() => r.register({ id: 'a', title: 'x' }), /run/)
  const off = r.register(cmd('a', 'Alpha'))
  assert.equal(r.has('a'), true)
  const replacement = cmd('a', 'Alpha 2')
  r.register(replacement)
  assert.equal(r.get('a').title, 'Alpha 2')
  off() // 旧命令的卸载函数不能删掉替换者
  assert.equal(r.has('a'), true)
  r.register(cmd('b', 'Beta'))()
  assert.equal(r.has('b'), false)
})

test('when hides a command, enabled greys it out; both react to ctx', () => {
  const r = createRegistry({ storage: memStorage() })
  r.register(cmd('needs.ep', '需要剧集', { when: (c) => !!c.episodeId }))
  r.register(cmd('undo', '撤销', { enabled: (c) => c.canUndo }))
  assert.deepEqual(ids(r.search('', {})), ['undo'])
  assert.deepEqual(ids(r.search('', { episodeId: 3 })), ['needs.ep', 'undo'])
  assert.equal(r.search('', {})[0].enabled, false)
  assert.equal(r.search('', { canUndo: true })[0].enabled, true)
  // when 抛错视为不可见，不炸整个列表
  r.register(cmd('bad', '坏的', { when: () => { throw new Error('x') } }))
  assert.ok(!ids(r.search('', {})).includes('bad'))
})

test('providers add dynamic commands per query; a throwing provider is ignored; unregister works', () => {
  const r = createRegistry({ storage: memStorage() })
  r.register(cmd('static', '静态命令'))
  const off = r.registerProvider((q) => (q ? [cmd(`dyn:${q}`, `动态 ${q}`)] : []))
  r.registerProvider(() => { throw new Error('boom') })
  assert.deepEqual(ids(r.search('', {})), ['static'])
  assert.ok(ids(r.search('动态', {})).includes('dyn:动态'))
  off()
  assert.ok(!ids(r.search('动态', {})).includes('dyn:动态'))
  assert.throws(() => r.registerProvider(null), /function/)
})

// ---------- 搜索排序 ----------

test('search ranks by score; non-matching are dropped; ties keep registration order', () => {
  const r = createRegistry({ storage: memStorage() })
  r.register(cmd('a', '切换到画布视图'))
  r.register(cmd('b', '画布'))
  r.register(cmd('c', '导出视频'))
  r.register(cmd('d', '画布设置'))
  const rows = r.search('画布', {})
  assert.deepEqual(ids(rows), ['b', 'd', 'a'])
  assert.deepEqual(ids(r.search('不存在的东西', {})), [])
  r.register(cmd('e1', '同名'))
  r.register(cmd('e2', '同名'))
  assert.deepEqual(ids(r.search('同名', {})), ['e1', 'e2'])
})

test('search matches keywords (English alias for a Chinese title) and limits results', () => {
  const r = createRegistry({ storage: memStorage() })
  r.register(cmd('canvas', '切换到画布视图', { keywords: ['canvas', '节点'] }))
  assert.deepEqual(ids(r.search('canvas', {})), ['canvas'])
  for (let i = 0; i < 10; i++) r.register(cmd(`n${i}`, `命令 ${i}`))
  assert.equal(r.search('命令', {}, { limit: 4 }).length, 4)
})

// ---------- 最近使用 ----------

test('execute records recent use; empty query lists recent first, then registration order', async () => {
  const st = memStorage()
  const r = createRegistry({ storage: st })
  for (const [id, t] of [['a', '甲'], ['b', '乙'], ['c', '丙'], ['d', '丁']]) r.register(cmd(id, t))
  assert.deepEqual(ids(r.search('', {})), ['a', 'b', 'c', 'd'])
  await r.execute('c')
  await r.execute('b')
  assert.deepEqual(ids(r.search('', {})), ['b', 'c', 'a', 'd'])
  assert.deepEqual(r.search('', {}).map((x) => x.recent), [true, true, false, false])
  await r.execute('c')
  assert.deepEqual(r.recentIds(), ['c', 'b'])
  assert.deepEqual(JSON.parse(st.m.get(RECENT_STORAGE_KEY)), ['c', 'b'])
  // 新注册表从存储恢复
  const r2 = createRegistry({ storage: st })
  for (const [id, t] of [['a', '甲'], ['b', '乙'], ['c', '丙'], ['d', '丁']]) r2.register(cmd(id, t))
  assert.deepEqual(ids(r2.search('', {})).slice(0, 2), ['c', 'b'])
  assert.deepEqual(r2.recentCommands({}).map((c) => c.id), ['c', 'b'])
})

test('with a query, recent use only breaks ties', async () => {
  const r = createRegistry({ storage: memStorage() })
  r.register(cmd('x1', '同名'))
  r.register(cmd('x2', '同名'))
  r.register(cmd('exact', '同'))
  await r.execute('x2')
  assert.deepEqual(ids(r.search('同名', {})), ['x2', 'x1'])
  assert.equal(ids(r.search('同', {}))[0], 'exact', '更好的匹配仍排在最近使用之前')
})

test('recent list is capped, ignores garbage storage, and survives a broken storage', async () => {
  const st = memStorage()
  st.setItem(RECENT_STORAGE_KEY, '{not json')
  const r = createRegistry({ storage: st })
  assert.deepEqual(r.recentIds(), [])
  for (let i = 0; i < 12; i++) { r.register(cmd(`c${i}`, `命令${i}`)); await r.execute(`c${i}`) }
  assert.equal(r.recentIds().length, 8)
  assert.equal(r.recentIds()[0], 'c11')
  const broken = { getItem() { throw new Error('x') }, setItem() { throw new Error('x') } }
  const r2 = createRegistry({ storage: broken })
  r2.register(cmd('a', 'A'))
  assert.equal(await r2.execute('a'), 'a')
  assert.deepEqual(r2.recentIds(), ['a'])
  r.clearRecent()
  assert.deepEqual(r.recentIds(), [])
})

// ---------- 执行 ----------

test('execute passes ctx, returns the result (sync or async), supports command objects from providers', async () => {
  const r = createRegistry({ storage: memStorage() })
  let seen = null
  r.register({ id: 'a', title: 'A', run: async (c) => { seen = c; return 42 } })
  assert.equal(await r.execute('a', { episodeId: 7 }), 42)
  assert.deepEqual(seen, { episodeId: 7 })
  const dyn = cmd('dyn:1', '动态', { run: () => 'ok' })
  assert.equal(await r.execute(dyn, {}), 'ok')
  assert.deepEqual(r.recentIds(), ['dyn:1', 'a'])
})

test('execute refuses unknown, hidden and disabled commands and does not record them; run errors propagate', async () => {
  const r = createRegistry({ storage: memStorage() })
  r.register(cmd('hidden', 'H', { when: () => false }))
  r.register(cmd('off', 'O', { enabled: () => false }))
  r.register({ id: 'boom', title: 'B', run: () => { throw new Error('失败了') } })
  await assert.rejects(() => r.execute('nope'), /unknown command/)
  await assert.rejects(() => r.execute('hidden'), /not available/)
  await assert.rejects(() => r.execute('off'), /disabled/)
  await assert.rejects(() => r.execute('boom'), /失败了/)
  assert.deepEqual(r.recentIds(), [])
})

// ---------- 内置命令 ----------

function builtinHarness() {
  const calls = []
  const deps = {
    go: (l) => calls.push(['go', l]),
    undo: () => calls.push(['undo']),
    redo: () => calls.push(['redo']),
    openHistory: () => calls.push(['history']),
    select: (s) => calls.push(['select', s]),
    getViews: () => views,
  }
  const views = {
    shots: { groups: [{ id: 'g1', title: '序章', shots: [
      { id: 's1', params: { title: '雨夜街口' }, dialogue: '老周：你来晚了。' },
      { id: 's2', params: { title: '', description: '车内特写' }, dialogue: '' },
    ] }] },
    script: { groups: [{ id: 'g1', lines: [
      { id: 'l1', speaker: '老周', text: '你来晚了。' },
      { id: 'l2', speaker: '', text: '雨越下越大。' },
    ] }] },
  }
  const r = createRegistry({ storage: memStorage() })
  r.registerAll(createBuiltinCommands(deps))
  r.registerProvider(createContentProvider(deps))
  return { r, calls, views }
}

test('builtin commands: page-level ones are always there, episode-level ones need an episode', () => {
  const { r } = builtinHarness()
  const none = ids(r.search('', {}))
  for (const id of ['nav.list', 'project.new', 'nav.ai-config', 'nav.keyboard']) assert.ok(none.includes(id), id)
  for (const id of ['view.script', 'view.storyboard', 'view.timeline', 'view.canvas', 'edit.undo', 'edit.redo', 'history.open', 'project.export']) assert.ok(!none.includes(id), id)
  const withEp = ids(r.search('', { episodeId: 5 }))
  for (const id of ['view.script', 'view.storyboard', 'view.timeline', 'view.canvas', 'edit.undo', 'edit.redo', 'history.open', 'project.export']) assert.ok(withEp.includes(id), id)
})

test('builtin commands: Chinese and English queries find the intended command first', () => {
  const { r } = builtinHarness()
  const ctx = { episodeId: 5, canUndo: true }
  assert.equal(ids(r.search('画布', ctx))[0], 'view.canvas')
  assert.equal(ids(r.search('timeline', ctx))[0], 'view.timeline')
  assert.equal(ids(r.search('撤销', ctx))[0], 'edit.undo')
  assert.equal(ids(r.search('导出', ctx))[0], 'project.export')
  assert.equal(ids(r.search('新建项目', ctx))[0], 'project.new')
  assert.equal(ids(r.search('设置', ctx))[0], 'nav.ai-config')
  assert.equal(ids(r.search('快捷键', ctx))[0], 'nav.keyboard')
  assert.equal(ids(r.search('history', ctx))[0], 'history.open')
})

test('builtin commands execute: view switch keeps episode and drama; undo/redo respect enabled; export path', async () => {
  const { r, calls } = builtinHarness()
  const ctx = { episodeId: 5, dramaId: 9, canUndo: true, canRedo: false, busy: false }
  await r.execute('view.canvas', ctx)
  await r.execute('view.storyboard', ctx)
  await r.execute('project.export', ctx)
  await r.execute('edit.undo', ctx)
  await r.execute('history.open', ctx)
  await assert.rejects(() => r.execute('edit.redo', ctx), /disabled/)
  await assert.rejects(() => r.execute('edit.undo', { ...ctx, busy: true }), /disabled/)
  assert.deepEqual(calls[0], ['go', { path: '/episodes/5/canvas', query: { drama: '9' } }])
  assert.deepEqual(calls[1], ['go', { path: '/project/9/storyboard', query: { drama: '9', episode: '5' } }])
  assert.deepEqual(calls[2], ['go', { path: '/episodes/5/export', query: { drama: '9' } }])
  assert.deepEqual(calls[3], ['undo'])
  assert.deepEqual(calls[4], ['history'])
  await r.execute('project.new', {})
  assert.deepEqual(calls[5], ['go', '/new-project'])
})

test('content provider: searches shots and script lines; empty query or no episode gives nothing', async () => {
  const { r, calls } = builtinHarness()
  const ctx = { episodeId: 5, dramaId: 9 }
  assert.deepEqual(ids(r.search('雨夜', ctx)).filter((i) => i.startsWith('shot:')), ['shot:s1'])
  assert.ok(ids(r.search('来晚了', ctx)).includes('line:l1'))
  assert.ok(ids(r.search('来晚了', ctx)).includes('shot:s1'), '镜头的对白也能搜到该镜头')
  assert.equal(ids(r.search('车内', ctx))[0], 'shot:s2')
  assert.deepEqual(ids(r.search('雨夜', {})).filter((i) => /^(shot|line):/.test(i)), [])
  assert.deepEqual(ids(r.search('', ctx)).filter((i) => /^(shot|line):/.test(i)), [])
  const hit = r.search('车内', ctx)[0]
  await r.execute(hit.cmd, ctx)
  assert.deepEqual(calls[0], ['select', { kind: 'shot', id: 's2' }])
  assert.deepEqual(calls[1], ['go', { path: '/project/9/storyboard', query: { drama: '9', episode: '5' } }])
  const line = r.search('雨越下越大', ctx).find((x) => x.cmd.id === 'line:l2')
  await r.execute(line.cmd, ctx)
  assert.deepEqual(calls[2], ['select', { kind: 'line', id: 'l2' }])
  assert.deepEqual(calls[3], ['go', { path: '/episodes/5/script', query: { drama: '9' } }])
})

test('content provider: does not repeat the speaker when the line text already starts with it', () => {
  const deps = { getViews: () => ({ script: { groups: [{ id: 'g', lines: [{ id: 'a', speaker: '老周', text: '老周：来了。' }, { id: 'b', speaker: '阿宁', text: '早。' }] }] } }), go() {}, select() {} }
  const out = createContentProvider(deps)('来了 早', { episodeId: 1 })
  const all = createContentProvider(deps)('老周', { episodeId: 1 })
  assert.equal(all[0].title, '老周：来了。')
  assert.equal(createContentProvider(deps)('阿宁', { episodeId: 1 })[0].title, '阿宁：早。')
  assert.ok(Array.isArray(out))
})

test('content provider: caps the number of results and tolerates missing views', () => {
  const deps = { getViews: () => null, go() {}, select() {} }
  assert.deepEqual(createContentProvider(deps)('x', { episodeId: 1 }), [])
  const many = { script: { groups: [{ id: 'g', lines: Array.from({ length: 100 }, (_, i) => ({ id: `l${i}`, text: `雨 ${i}` })) }] } }
  const out = createContentProvider({ ...deps, getViews: () => many }, { limit: 5 })('雨', { episodeId: 1 })
  assert.equal(out.length, 5)
})
