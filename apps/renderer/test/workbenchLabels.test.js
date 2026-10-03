import test from 'node:test'
import assert from 'node:assert/strict'
import {
  rectLabelText, costLineText, strategyLabel, refusalLabel, regionStatusLabel, regionLineText,
  versionSourceLabel, versionMetaLabel, adoptLabel,
} from '../src/components/shot/workbenchLabels.js'

const t = (k, p) => (p ? `${k}${JSON.stringify(p)}` : k)

test('rectLabelText maps the rect to a position key', () => {
  assert.equal(rectLabelText(null, t), 'storyboard.wb.rect.full')
  assert.equal(rectLabelText({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, t), 'storyboard.wb.rect.center')
  assert.equal(rectLabelText({ x: 0, y: 0.4, w: 0.2, h: 0.2 }, t), 'storyboard.wb.rect.left')
  assert.equal(rectLabelText({ x: 0.4, y: 0.8, w: 0.2, h: 0.1 }, t), 'storyboard.wb.rect.bottom')
  assert.equal(rectLabelText({ x: 0.8, y: 0, w: 0.1, h: 0.1 }, t), 'storyboard.wb.rect.top_right')
})

test('costLineText composes segment price, full price saving and sample flag', () => {
  assert.equal(costLineText(null, t), '')
  const est = { segment: { seconds: 2 }, estimate: { cents: 20, currency: 'CNY', full: { cents: 100 }, sample_prices: true } }
  const line = costLineText(est, t)
  assert.match(line, /storyboard\.wb\.cost\.withNotes/)
  assert.ok(line.includes('cost.segment{\\"sec\\":2,\\"price\\":\\"¥0.20\\"}'), line)
  assert.match(line, /fullSave/)
  assert.match(line, /sample/)
  const plain = costLineText({ segment: { seconds: 1 }, estimate: { cents: 10, currency: 'CNY', known: true } }, t)
  assert.equal(plain, 'storyboard.wb.cost.segment{"sec":1,"price":"¥0.10"}')
})

test('strategy, refusal and region status labels', () => {
  assert.equal(strategyLabel('provider_mask', t), 'storyboard.wb.strategy.mask')
  assert.equal(strategyLabel('segment_splice', t), 'storyboard.wb.strategy.splice')
  assert.equal(strategyLabel('x', t), '')
  assert.equal(refusalLabel({ allowed: false, refusal: { message: 'over cap' } }, t), 'over cap')
  assert.equal(refusalLabel({ allowed: false }, t), 'storyboard.wb.refusal.cap')
  assert.equal(refusalLabel({ provider_ready: false, provider: 'kling' }, t), 'storyboard.wb.refusal.provider{"provider":"kling"}')
  assert.equal(refusalLabel({ allowed: true }, t), '')
  assert.equal(regionStatusLabel('done', t), 'storyboard.wb.regionStatus.done')
  assert.equal(regionStatusLabel('weird', t), 'weird')
})

test('regionLineText and version labels', () => {
  assert.match(regionLineText({ mode: 'segment', t0_ms: 1000, t1_ms: 2500, prompt: 'p' }, t), /segmentShort \| p$/)
  assert.match(regionLineText({ mode: 'region', rect: null, t0_ms: 0, t1_ms: 1000, prompt: 'q' }, t), /rect\.full/)
  assert.equal(regionLineText(null, t), '')
  assert.equal(versionSourceLabel('legacy-import', t), 'storyboard.wb.source.import')
  assert.equal(versionSourceLabel('ai-task:12', t), 'storyboard.wb.source.ai')
  assert.equal(versionSourceLabel('region-edit:3', t), 'storyboard.wb.source.regionEdit')
  assert.equal(versionSourceLabel('custom', t), 'custom')
  assert.equal(versionSourceLabel('', t), '')
  assert.equal(versionMetaLabel({ model: 'm', duration_ms: 3000 }, t), 'storyboard.wb.meta.model{"model":"m"} | storyboard.wb.meta.seconds{"sec":"3.0"}')
  assert.equal(versionMetaLabel(null, t), '')
  assert.equal(adoptLabel({ adopted: true }, t), 'storyboard.wb.adopt.current')
  assert.equal(adoptLabel({ isEdit: true }, t), 'storyboard.wb.adopt.edit')
  assert.equal(adoptLabel({}, t), 'storyboard.wb.adopt.plain')
})
