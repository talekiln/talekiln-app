import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 四视图改造（Task 12）：旧页面已删除。src/ 里除 utils/legacyRoutes.js（旧地址 -> 新地址的重定向表）之外，
// 任何文件（含注释）都不得出现 '/film/' 或 '/drama/' 这类旧项目页地址；导航一律用 /p/... 的具名路由。
const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '../src')
const ALLOWED = new Set(['utils/legacyRoutes.js'])
const FORBIDDEN = ['/film/', '/drama/']

function walk(dir) {
  const out = []
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(vue|js|mjs|json|css)$/.test(f)) out.push(p)
  }
  return out
}

test('no source file under src/ (except utils/legacyRoutes.js) contains a /film/ or /drama/ route string', () => {
  const files = walk(src)
  assert.ok(files.length > 100, 'scanned the whole source tree')
  const hits = []
  for (const f of files) {
    const rel = path.relative(src, f).replace(/\\/g, '/')
    if (ALLOWED.has(rel)) continue
    const text = readFileSync(f, 'utf8')
    for (const needle of FORBIDDEN) if (text.includes(needle)) hits.push(`${rel}: ${needle}`)
  }
  assert.deepEqual(hits, [])
})

test('the redirect table still knows the old addresses (so old bookmarks keep working)', async () => {
  const { isLegacyPath } = await import('../src/utils/legacyRoutes.js')
  for (const p of ['/film/1', '/film/1/canvas', '/film/new', '/drama/1', '/episodes/2/script', '/project/3/library', '/free-create']) {
    assert.equal(isLegacyPath(p), true, p)
  }
})

test('the old page components are gone and the router does not import them', () => {
  const router = readFileSync(path.join(src, 'router/index.js'), 'utf8')
  for (const name of ['FilmCreate', 'DramaDetail', 'DramaCanvas', 'FreeCreate', 'ReferenceLibrary', 'ExportPage']) {
    assert.equal(router.includes(name), false, name)
    let exists = true
    try { statSync(path.join(src, 'views', `${name}.vue`)) } catch (_) { exists = false }
    assert.equal(exists, false, `views/${name}.vue should be deleted`)
  }
})
