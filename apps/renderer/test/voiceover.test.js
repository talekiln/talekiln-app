import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateText, needsConfirm, resultText, skipText, voiceOptions } from '../src/utils/voiceover.js'

test('estimateText 带字数、费用、示例价标记', () => {
  const t = estimateText({ shots: 3, chars: 86, estimate: 0.017, max: 0.02, currency: 'CNY', sample_prices: true })
  assert.match(t, /3 个镜头 \/ 86 字/)
  assert.match(t, /预计 0.017 元/)
  assert.match(t, /示例价/)
  assert.match(estimateText({ shots: 1, chars: 5, estimate: 0, max: 0, currency: 'CNY', price_known: false }), /没有价格条目/)
  assert.equal(estimateText(null), '')
})

test('needsConfirm 只在有事可做时为真', () => {
  assert.equal(needsConfirm({ confirm_required: true, shots: 2 }), true)
  assert.equal(needsConfirm({ confirm_required: false, shots: 0 }), false)
  assert.equal(needsConfirm(null), false)
})

test('resultText 汇总完成、失败、跳过', () => {
  assert.equal(resultText({ done: [{}, {}], failed: [], skipped: [] }), '已生成 2 个镜头的旁白')
  assert.equal(resultText({ done: [{}], failed: [{ message: '拒绝' }], skipped: [{}] }), '已生成 1 个镜头的旁白，1 个失败：拒绝，跳过 1 个')
  assert.equal(skipText('fresh'), '已有最新旁白')
})

test('voiceOptions 映射为下拉选项', () => {
  assert.deepEqual(voiceOptions([{ id: 'a', label: 'A' }]), [{ value: 'a', label: 'A' }])
  assert.deepEqual(voiceOptions(null), [])
})
