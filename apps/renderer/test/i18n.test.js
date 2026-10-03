import test from 'node:test'
import assert from 'node:assert/strict'
import { createTranslator } from '../src/i18n/index.js'

const catalog = {
  'zh-CN': { 'a.hello': '你好，{name}', 'a.onlyZh': '仅中文' },
  en: { 'a.hello': 'Hello, {name}' },
}

test('interpolates params', () => {
  const t = createTranslator(catalog, () => 'en')
  assert.equal(t('a.hello', { name: 'Lin' }), 'Hello, Lin')
})
test('falls back to zh-CN then key', () => {
  const t = createTranslator(catalog, () => 'en')
  assert.equal(t('a.onlyZh'), '仅中文')
  assert.equal(t('a.missing'), 'a.missing')
})
test('keeps unknown placeholders visible', () => {
  const t = createTranslator(catalog, () => 'zh-CN')
  assert.equal(t('a.hello'), '你好，{name}')
})
