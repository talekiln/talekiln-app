import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { routeTitle } from '../src/utils/routeTitle.js'
import { createTranslator } from '../src/i18n/index.js'
import catalog from '../src/i18n/catalog.js'

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src')

test('routeTitle follows the locale and falls back to meta.title', () => {
  let loc = 'zh-CN'
  const t = createTranslator(catalog, () => loc)
  const route = { name: 'episode-storyboard', meta: { title: '分镜表' } }
  assert.equal(routeTitle(route, t), '分镜表 - 故事窑')
  loc = 'en'
  assert.equal(routeTitle(route, t), 'Storyboard - Talekiln')
  assert.equal(routeTitle({ name: 'unlisted', meta: { title: '自定义' } }, t), '自定义 - Talekiln')
  assert.equal(routeTitle({ name: 'x', meta: {} }, t), '')
})

test('every named route with a meta.title has a zh-CN and en title', () => {
  const text = readFileSync(path.join(src, 'router/index.js'), 'utf8')
  const names = [...text.matchAll(/name: '([\w-]+)',[\s\S]*?meta: \{ title: '/g)].map((m) => m[1])
  assert.ok(names.length >= 20, `found ${names.length} routes`)
  for (const n of names) {
    assert.ok(catalog['zh-CN'][`routes.title.${n}`], `zh-CN missing for ${n}`)
    assert.ok(catalog.en[`routes.title.${n}`], `en missing for ${n}`)
  }
})
