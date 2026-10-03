import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../src/i18n/index.js'
import { previewSummary, submittedText, voiceSummary, voiceResultText, rerunSummary, kindOf } from '../src/components/generate/generateConfirm.js'

const PREVIEW = {
  items: [
    { kind: 'image', action: 'create' },
    { kind: 'image', action: 'create' },
    { kind: 'video', action: 'chain' },
    { kind: 'video', action: 'create' },
    { kind: 'image', action: 'cache_hit' },
    { kind: 'video', action: 'fresh' },
    { kind: 'video', action: 'blocked' },
  ],
  estimate: { total: 1.5, max: 2, currency: 'CNY', sample_prices: true, known: false },
  cap: { monthly_cap: 100, monthly_remaining: 90, per_run_cap: 5, currency: 'CNY' },
  billable: 4,
  allowed: true,
  provider_ready: true,
}

test('previewSummary: counts, money, cap lines and warnings (en)', () => {
  setLocale('en')
  const s = previewSummary(PREVIEW)
  assert.equal(s.free, false)
  assert.equal(s.blocked, false)
  assert.equal(s.canConfirm, true)
  assert.match(s.title, /cost/i)
  assert.ok(s.lines.some((l) => l === 'First frames: 2'))
  assert.ok(s.lines.some((l) => /^Videos: 2/.test(l)))
  assert.ok(s.lines.some((l) => l.includes('¥1.50') && l.includes('¥2.00')))
  assert.ok(s.lines.some((l) => l.includes('¥90.00') && l.includes('¥100.00')))
  assert.ok(s.lines.some((l) => l.includes('¥5.00')))
  assert.equal(s.warnings.length, 2)
})

test('previewSummary: same preview in zh-CN is localized and has no unreplaced placeholders', () => {
  setLocale('zh-CN')
  const s = previewSummary(PREVIEW)
  assert.ok(s.lines.some((l) => l.includes('首帧图')))
  for (const l of [...s.lines, ...s.warnings, s.title]) assert.doesNotMatch(l, /\{\w+\}/)
})

test('previewSummary: a free preview with only cache hits can still confirm; nothing billable and no hits cannot', () => {
  setLocale('en')
  const hits = previewSummary({ items: [{ kind: 'image', action: 'cache_hit' }], billable: 0, allowed: true, provider_ready: true })
  assert.equal(hits.free, true)
  assert.equal(hits.canConfirm, true)
  assert.ok(!hits.lines.some((l) => l.includes('¥')))
  const none = previewSummary({ items: [{ kind: 'image', action: 'fresh' }], billable: 0, allowed: true })
  assert.equal(none.canConfirm, false)
})

test('previewSummary: refusal blocks confirm and carries the backend message; missing provider blocks too', () => {
  setLocale('en')
  const b = previewSummary({ ...PREVIEW, allowed: false, refusal: { message: 'Monthly cap exceeded' } })
  assert.equal(b.blocked, true)
  assert.equal(b.canConfirm, false)
  assert.equal(b.blockedText, 'Monthly cap exceeded')
  const b2 = previewSummary({ ...PREVIEW, allowed: false })
  assert.ok(b2.blockedText.length > 0)
  const np = previewSummary({ ...PREVIEW, provider_ready: false })
  assert.equal(np.canConfirm, false)
  assert.ok(np.warnings.length >= 3)
  assert.equal(previewSummary(null).canConfirm, false)
})

test('previewSummary: unlimited quota line when no monthly cap', () => {
  setLocale('en')
  const s = previewSummary({ ...PREVIEW, cap: { monthly_cap: null } })
  assert.ok(s.lines.some((l) => /no limit/i.test(l)))
})

test('kindOf maps the menu action to the generate kind and regenerate flag', () => {
  assert.deepEqual(kindOf('generate.missing'), { kind: 'both', regenerate: false })
  assert.deepEqual(kindOf('generate.allFirstFrames'), { kind: 'image', regenerate: false })
  assert.deepEqual(kindOf('generate.allVideos'), { kind: 'video', regenerate: false })
  assert.equal(kindOf('nope'), null)
})

test('submittedText: none / some / reused', () => {
  setLocale('en')
  assert.match(submittedText({ tasks: [] }), /Nothing to generate/)
  assert.match(submittedText({ tasks: [{ outcome: 'created' }, { outcome: 'retried' }] }), /2 task/)
  assert.match(submittedText({ tasks: [{ outcome: 'created' }, { outcome: 'exists' }] }), /1 task.*1 already/)
})

test('voiceSummary and voiceResultText', () => {
  setLocale('en')
  const v = voiceSummary({ shots: 3, chars: 86, estimate: 0.02, max: 0.03, currency: 'CNY', sample_prices: true, price_known: false, confirm_required: true })
  assert.ok(v.lines.some((l) => l.includes('3') && l.includes('86')))
  assert.ok(v.lines.some((l) => l.includes('¥0.02')))
  assert.equal(v.warnings.length, 2)
  assert.equal(v.canConfirm, true)
  assert.equal(voiceSummary({ shots: 0, chars: 0, confirm_required: false }).canConfirm, false)
  assert.equal(voiceSummary({ shots: 2, confirm_required: true, allowed: false, refusal: { message: 'cap' } }).canConfirm, false)
  assert.match(voiceResultText({ tasks: [{ outcome: 'created' }], skipped: [1, 2] }), /1 voiceover task.*skipped 2/i)
  assert.match(voiceResultText({ tasks: [] }), /No shots/)
})

test('rerunSummary reads draft-nodes info', () => {
  setLocale('en')
  const r = rerunSummary({ count: 4, estimate: { amount: 3, max: 4, currency: 'CNY' }, allowed: true })
  assert.equal(r.canConfirm, true)
  assert.ok(r.lines.some((l) => l.includes('4')))
  assert.ok(r.lines.some((l) => l.includes('¥3.00')))
  assert.equal(rerunSummary({ count: 0 }).canConfirm, false)
  const blocked = rerunSummary({ count: 2, estimate: { amount: 1, max: 1 }, allowed: false, refusal: { message: 'no' } })
  assert.equal(blocked.canConfirm, false)
  assert.equal(blocked.blockedText, 'no')
})
