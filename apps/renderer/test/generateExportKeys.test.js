// 守卫：generate / export 两条泳道的源码里引用的 i18n key 必须真实存在（静态 key 精确匹配，动态 key 的前缀至少匹配一个）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '../src')

const FILES = [
  'components/export', 'components/generate', 'composables/usePipeline.js', 'utils/exportJob.js', 'utils/exportSrt.js',
  'utils/exportStoryboardSheet.js', 'utils/pipelinePlan.js', 'utils/batchView.js', 'views/BatchPage.vue',
  'shell/actions/generate.js', 'shell/actions/export.js', 'shell/dialogs/generate.js', 'shell/dialogs/export.js',
]

function walk(p) {
  const full = path.join(src, p)
  if (!existsSync(full)) return []
  if (!statSync(full).isDirectory()) return [full]
  return readdirSync(full).flatMap((n) => walk(path.join(p, n)))
}

async function catalogKeys() {
  const keys = new Set()
  for (const ns of ['generate', 'export']) {
    const mod = (await import(pathToFileURL(path.join(src, `i18n/messages/${ns}.js`)).href)).default
    for (const k of Object.keys(mod['zh-CN'])) keys.add(k)
  }
  return keys
}

test('every generate.* / export.* key used by the generate/export lanes exists', async () => {
  const keys = await catalogKeys()
  const all = [...keys]
  const missing = []
  for (const file of FILES.flatMap(walk).filter((f) => /\.(js|vue)$/.test(f) && !f.endsWith('.test.js'))) {
    const text = readFileSync(file, 'utf8')
    const rel = path.relative(src, file).split(path.sep).join('/')
    for (const m of text.matchAll(/['"`]((?:generate|export)\.[A-Za-z0-9_.]*)(\$\{)?/g)) {
      const key = m[1]
      if (m[2]) {
        // 动态：前缀至少匹配一条
        if (!all.some((k) => k.startsWith(key))) missing.push(`${rel}: dynamic ${key}\${...}`)
        continue
      }
      // 静态：必须是完整 key（没有对应 key 的，只能是动作 / 对话框 id）
      if (keys.has(key)) continue
      if (/^(generate|export)\.[a-zA-Z]*$/.test(key)) continue // 裸前缀、动作 / 对话框 id（单段）
      missing.push(`${rel}: ${key}`)
    }
  }
  assert.deepEqual(missing, [])
})
