import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/i18n/messages')
for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const ns = file.replace(/\.js$/, '')
  test(`messages/${file}: zh-CN and en have identical keys under namespace`, async () => {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)).default
    const zh = Object.keys(mod['zh-CN']).sort()
    const en = Object.keys(mod.en).sort()
    assert.deepEqual(en, zh, 'every key needs both languages')
    for (const k of zh) assert.ok(k.startsWith(`${ns}.`), `key ${k} must start with ${ns}.`)
    for (const [k, v] of Object.entries(mod.en)) assert.ok(String(v).trim() !== '', `${k} English text is empty`)
  })
}

test('catalog.js merges every messages file', async () => {
  const catalog = (await import('../src/i18n/catalog.js')).default
  let total = 0
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)).default
    for (const k of Object.keys(mod['zh-CN'])) {
      assert.equal(catalog['zh-CN'][k], mod['zh-CN'][k], `catalog missing zh-CN ${k}`)
      assert.equal(catalog.en[k], mod.en[k], `catalog missing en ${k}`)
      total++
    }
  }
  assert.ok(total > 0)
})
