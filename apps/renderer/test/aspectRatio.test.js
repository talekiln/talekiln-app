import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../src/i18n/index.js'
import { ASPECTS, aspectLabel } from '../src/utils/aspectRatio.js'

test('aspectLabel: known ratios are translated, unknown ones pass through', () => {
  setLocale('en')
  assert.equal(aspectLabel('16:9'), '16:9 landscape (default)')
  assert.equal(aspectLabel('5:4'), '5:4')
  assert.equal(aspectLabel(undefined), '')
  setLocale('zh-CN')
  assert.match(aspectLabel('9:16'), /^9:16 /)
  assert.notEqual(aspectLabel('9:16'), '9:16')
})

test('every listed aspect has a label in both languages', () => {
  for (const loc of ['zh-CN', 'en']) {
    setLocale(loc)
    for (const a of ASPECTS) assert.ok(aspectLabel(a).startsWith(a) && aspectLabel(a).length > a.length, `${loc} ${a}`)
  }
})
