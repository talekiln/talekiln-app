import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { GENERATE_MENU, EXPORT_MENU } from '../src/shell/menus.js'

// 外壳里“按 id 触发”的东西（菜单项、左栏按钮、顶栏、命令面板）必须都有人注册：
// action 在 shell/actions/<lane>.js，对话框在 shell/dialogs/<lane>.js。
// 这些 lane 文件会 import '@/...' 别名（node 下无法解析），所以按源码文本取出默认导出表里的键。
const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '../src')
const read = (rel) => readFileSync(path.join(src, rel), 'utf8')

async function laneKeys(dir) {
  const ids = new Set()
  for (const f of readdirSync(path.join(src, dir))) {
    if (!f.endsWith('.js') || f === 'index.js' || f === 'registry.js') continue
    let keys
    try {
      keys = Object.keys((await import(pathToFileURL(path.join(src, dir, f)).href)).default || {})
    } catch (e) {
      // 个别 lane 文件静态 import 了带 '@/' 别名的模块，node 下加载不了：退而读源码里默认导出表的键
      if (!/Cannot find package/.test(String(e && e.message))) throw e
      const text = read(`${dir}/${f}`)
      const at = text.indexOf('export default {')
      assert.ok(at >= 0, `${dir}/${f} has an object-literal default export`)
      keys = [...text.slice(at).matchAll(/^ {2}'?([a-z][A-Za-z]*\.[A-Za-z.]+)'?\s*:/gm)].map((m) => m[1])
    }
    for (const k of keys) ids.add(k)
  }
  return ids
}

const ACTIONS = await laneKeys('shell/actions')
const DIALOGS = await laneKeys('shell/dialogs')

function walk(dir) {
  const out = []
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(vue|js)$/.test(f)) out.push(p)
  }
  return out
}

test('every lane table is non-trivial (the key extraction works)', () => {
  assert.ok(ACTIONS.size >= 25, `actions: ${ACTIONS.size}`)
  assert.ok(DIALOGS.size >= 15, `dialogs: ${DIALOGS.size}`)
})

test('every Generate / Export menu item has a registered action', () => {
  const missing = [...GENERATE_MENU, ...EXPORT_MENU].map((i) => i.action).filter((id) => !ACTIONS.has(id))
  assert.deepEqual(missing, [])
})

test('every literal id passed to runAction() / openDialog() anywhere in src is registered', () => {
  const missingActions = []
  const missingDialogs = []
  for (const f of walk(src)) {
    const rel = path.relative(src, f).split(path.sep).join('/')
    if (rel.startsWith('shell/actions/registry') || rel === 'shell/dialogs/index.js') continue
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/\brunAction\(\s*'([\w.]+)'/g)) if (!ACTIONS.has(m[1])) missingActions.push(`${rel}: ${m[1]}`)
    for (const m of text.matchAll(/\bopenDialog\(\s*'([\w.]+)'/g)) if (!DIALOGS.has(m[1])) missingDialogs.push(`${rel}: ${m[1]}`)
  }
  assert.deepEqual(missingActions, [])
  assert.deepEqual(missingDialogs, [])
})

test('LeftRail: its action buttons and the project-settings dialog are all registered', () => {
  const rail = read('shell/LeftRail.vue')
  const ran = [...rail.matchAll(/run\('([\w.]+)'\)/g)].map((m) => m[1])
  assert.deepEqual(ran.sort(), ['assets.importFromGlobal', 'script.addEpisode', 'script.importEpisodes'])
  for (const id of ran) assert.ok(ACTIONS.has(id), id)
  assert.match(rail, /openDialog\('home\.projectSettings'/)
  assert.ok(DIALOGS.has('home.projectSettings'), 'home.projectSettings is provided (script lane)')
})

test('TopBar only triggers actions through the menu tables (no hard-coded ids that could drift)', () => {
  const bar = read('shell/TopBar.vue')
  assert.match(bar, /runAction\(it\.action, actionCtx\(\)\)/)
  assert.equal(/openDialog\(\s*'/.test(bar), false)
})

test('ids that reach runAction / openDialog through a table or helper are registered too', () => {
  const home = read('views/FilmList.vue')
  const starts = [...home.matchAll(/action: '([\w.]+)'/g)].map((m) => m[1])
  assert.ok(starts.length >= 4)
  for (const id of starts) assert.ok(ACTIONS.has(id), `FilmList start card ${id}`)

  const script = read('views/ScriptView.vue')
  const ids = script.match(/const ids = \{([^}]*)\}/)[1]
  for (const m of ids.matchAll(/'([\w.]+)'/g)) assert.ok(ACTIONS.has(m[1]), `ScriptView episode menu ${m[1]}`)

  const gen = read('components/generate/generateActions.js')
  for (const m of gen.matchAll(/dialogFor\('([\w.]+)'/g)) assert.ok(DIALOGS.has(m[1]), `generate dialog ${m[1]}`)
  const confirm = gen.match(/dialogFor\('generate\.confirm'/)
  assert.ok(confirm && DIALOGS.has('generate.confirm'))
})

test('every dialog loader points at a component file that exists', () => {
  const missing = []
  for (const f of readdirSync(path.join(src, 'shell/dialogs'))) {
    if (!f.endsWith('.js') || f === 'index.js') continue
    for (const line of read(`shell/dialogs/${f}`).split('\n')) {
      if (line.trim().startsWith('//')) continue
      const m = line.match(/import\('@\/([^']+\.vue)'\)/)
      if (m) { try { statSync(path.join(src, m[1])) } catch (_) { missing.push(`${f}: ${m[1]}`) } }
    }
  }
  assert.deepEqual(missing, [])
})

test('the assets panel that LeftRail opens is mounted by the shell (nothing else mounts it)', () => {
  const shell = read('shell/ProjectShell.vue')
  assert.match(shell, /<AssetPanel v-if="showAssetPanel" @pick="onPickAsset" \/>/)
  const mounts = walk(src).filter((f) => readFileSync(f, 'utf8').includes('<AssetPanel'))
  assert.deepEqual(mounts.map((f) => path.basename(f)), ['ProjectShell.vue'])
})
