import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// useCharacters 里每一个 dramaAPI.xxx 调用都必须在 api/drama.js 里真实存在
// （回归：曾经调用不存在的 dramaAPI.getCharacters，「项目全部角色」列表永远加载失败）。
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const composable = read('../src/composables/filmCreate/useCharacters.js')
const api = read('../src/api/drama.js')

test('every dramaAPI method used by useCharacters exists in api/drama.js', () => {
  const used = [...new Set([...composable.matchAll(/dramaAPI\.(\w+)/g)].map((m) => m[1]))]
  assert.ok(used.length > 0)
  const defined = new Set([...api.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]))
  for (const name of used) assert.ok(defined.has(name), `dramaAPI.${name} is not defined in api/drama.js`)
})

test('the all-project-characters list reads GET /dramas/:id/characters', () => {
  assert.match(composable, /request\.get\(`\/dramas\/\$\{encodeURIComponent\(dramaId\.value\)\}\/characters`\)/)
})
