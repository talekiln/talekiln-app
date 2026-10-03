import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { findCjkLiterals } from './helpers/i18nLiterals.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(here, '../src')
const listDir = path.join(here, 'i18n-migrated')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/**
 * 登记项相对 src/。支持通配：`components/script/*`（单层）、`shell/**`（递归）、`shell/actions/*.js`。
 * 没有通配的登记项必须存在。
 */
export function expand(entry) {
  if (!entry.includes('*')) return [path.join(srcDir, entry)]
  const segs = entry.split('/')
  const fixed = []
  while (segs.length && !segs[0].includes('*')) fixed.push(segs.shift())
  const base = path.join(srcDir, ...fixed)
  if (!existsSync(base)) return []
  const body = segs
    .join('/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  const rx = new RegExp(`^${body}$`)
  return walk(base).filter((f) => rx.test(path.relative(base, f).split(path.sep).join('/')))
}

test('checker flags CJK in template text, bound attributes and script strings', () => {
  const vue = [
    '<template>',
    '  <div title="提示">{{ t("a.b") }} {{ ok ? "是" : t("a.c") }}</div>',
    '  <p>纯文本</p>',
    '  <span :label="t(\'x.y\')">{{ t(\'x.z\', { n: 1 }) }}</span>',
    '  <b>忽略 <!-- i18n-ignore --></b>',
    '  <i>注释 <!-- 注释里的中文不算 --></i>',
    '</template>',
    '<script setup>',
    "const a = '中文'",
    "const b = t('ok.key') // 注释里的中文不算",
    "const c = '允许' // i18n-ignore",
    'const re = /[\\u4e00-\\u9fff]/',
    'const d = `模板 ${a}`',
    "const e = t('nested.key', { n: f('括号)里') })",
    '</script>',
  ].join('\r\n')
  const got = findCjkLiterals('x.vue', vue).map((p) => `${p.line}:${p.snippet}`)
  assert.deepEqual(got, ['2:提示', '3:纯文本', '6:注释', '9:中文', '13:模板 ${a}'])
})

test('checker passes a clean module', () => {
  const js = "export default { a: t('x.y'), b: 'plain', c: \"it's\" }\n// 中文注释\n/* 块注释 中文 */\n"
  assert.deepEqual(findCjkLiterals('x.js', js), [])
})

test('expand supports * and **', () => {
  const files = expand('i18n/messages/*.js').map((p) => path.basename(p))
  assert.ok(files.includes('common.js'))
  assert.ok(expand('i18n/**').length >= files.length)
})

for (const f of readdirSync(listDir).filter((n) => n.endsWith('.json'))) {
  test(`migrated files in ${f} contain no CJK literals`, () => {
    const entries = JSON.parse(readFileSync(path.join(listDir, f), 'utf8'))
    assert.ok(Array.isArray(entries), `${f} must be a JSON array of paths relative to src/`)
    const problems = []
    for (const entry of entries) {
      const files = expand(entry).filter((p) => /\.(vue|js)$/.test(p))
      if (!entry.includes('*') && !existsSync(files[0] || '')) {
        problems.push({ file: entry, line: 0, snippet: 'registered file does not exist' })
        continue
      }
      for (const p of files) {
        const rel = path.relative(srcDir, p).split(path.sep).join('/')
        problems.push(...findCjkLiterals(rel, readFileSync(p, 'utf8')))
      }
    }
    assert.deepEqual(
      problems.map((p) => `${p.file}:${p.line}  ${p.snippet}`),
      [],
      'Chinese literals found in migrated files; move them to t() (or add // i18n-ignore)'
    )
  })
}
