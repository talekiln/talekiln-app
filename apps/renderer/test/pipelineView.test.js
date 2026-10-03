import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale, t } from '../src/i18n/index.js'
import { pipelineRows, pipelineEstimate, pipelineErrorLines, pipelineStatus } from '../src/components/generate/pipelineView.js'
import { buildPlan, STEP_ORDER } from '../src/utils/pipelinePlan.js'

const fmt = (v, c = 'CNY') => `${c}${Number(v).toFixed(2)}`

function planWith(over = {}) {
  return buildPlan({
    hasScript: true,
    characters: [{ id: 1, hasImage: true }],
    scenes: [{ id: 2, hasImage: false }],
    props: [],
    shots: [
      { id: 1, storyboardId: 11, image: 'none', video: 'none', narration: 'none', hasText: true },
      { id: 2, storyboardId: 12, image: 'fresh', video: 'none', narration: 'none', hasText: false },
    ],
    ...over,
  }, {})
}

test('pipelineRows: one row per step in order, skipped steps carry their reason', () => {
  setLocale('en')
  const plan = planWith()
  const rows = pipelineRows(null, plan, t)
  assert.deepEqual(rows.map((r) => r.id), STEP_ORDER)
  const chars = rows.find((r) => r.id === 'extractCharacters')
  assert.equal(chars.status, 'skipped')
  assert.equal(chars.info, 'Already exists')
  const sceneImages = rows.find((r) => r.id === 'sceneImages')
  assert.equal(sceneImages.status, 'pending')
  assert.equal(sceneImages.billable, true)
  assert.match(sceneImages.info, /1 item/)
  assert.equal(rows.find((r) => r.id === 'extractProps').status, 'pending')
  assert.equal(rows.find((r) => r.id === 'storyboards').info, 'Already exists')
})

test('pipelineRows: running and done show progress; skipped steps are never marked billable', () => {
  setLocale('zh-CN')
  const plan = planWith()
  const snap = {
    state: 'running',
    steps: [
      { id: 'firstFrames', phase: 'frames', billable: true, status: 'running', done: 1, total: 4 },
      { id: 'videos', phase: 'video', billable: true, status: 'done', done: 4, total: 4 },
      { id: 'voice', phase: 'voice', billable: true, status: 'skipped', done: 0, total: 0 },
    ],
  }
  const rows = pipelineRows(snap, plan, t)
  assert.equal(rows[0].info, '1/4')
  assert.equal(rows[1].info, '完成 4/4')
  assert.equal(rows[2].billable, false)
  assert.equal(rows[0].name, '首帧图')
})

test('pipelineEstimate: no billable work means no estimate line', () => {
  setLocale('en')
  const plan = buildPlan({ hasScript: true, characters: [{ id: 1, hasImage: true }], scenes: [{ id: 1, hasImage: true }], props: [{ id: 1, hasImage: true }], shots: [{ id: 1, storyboardId: 1, image: 'fresh', video: 'fresh', narration: 'fresh', hasText: false }] }, {})
  assert.deepEqual(pipelineEstimate({ total: 0, max: 0 }, plan, t, fmt), { line: '', warnings: [] })
})

test('pipelineEstimate: totals, sample prices, unknown prices and a blocked limit', () => {
  setLocale('en')
  const plan = planWith()
  const r = pipelineEstimate({ pending: false, total: 1.5, max: 3, currency: 'CNY', allowed: false, providerReady: false, blockedText: 'Monthly cap reached', sample: true, known: false }, plan, t, fmt)
  assert.equal(r.line, 'Estimated cost CNY1.50 (up to CNY3.00)')
  assert.ok(r.warnings.includes('Monthly cap reached'))
  assert.ok(r.warnings.some((w) => /sample/i.test(w)))
  assert.ok(r.warnings.some((w) => /no price/i.test(w)))
  assert.ok(r.warnings.some((w) => /key/i.test(w)))
  assert.ok(r.warnings.some((w) => /not included/i.test(w)), 'asset images are billable but not priced')
})

test('pipelineEstimate: a pending count says the cost is re-checked later', () => {
  setLocale('en')
  const r = pipelineEstimate({ pending: true, total: 0, max: 0 }, planWith({ characters: [], hasScript: true }), t, fmt)
  assert.match(r.line, /after earlier steps/)
})

test('pipelineErrorLines: per-item failures name the step and the item', () => {
  setLocale('en')
  const lines = pipelineErrorLines({ errors: [{ stepId: 'characterImages', item: 7, code: 'item_failed', message: 'timeout' }, { stepId: 'videos', code: 'no_provider', message: '' }] }, t)
  assert.deepEqual(lines, ['Character images #7: timeout', 'Videos: No provider key is available yet. Add one in Settings first'])
  assert.deepEqual(pipelineErrorLines(null, t), [])
})

test('pipelineStatus: every terminal and paused state has text; running has none', () => {
  setLocale('en')
  assert.equal(pipelineStatus({ state: 'running' }, 'running', t).text, '')
  assert.deepEqual(pipelineStatus({ state: 'done', errors: [] }, 'finished', t), { text: 'All done', type: 'success' })
  assert.equal(pipelineStatus({ state: 'done', errors: [{}, {}] }, 'finished', t).type, 'warning')
  assert.equal(pipelineStatus({ state: 'cancelled' }, 'finished', t).type, 'warning')
  assert.match(pipelineStatus({ state: 'paused', pausedAfter: 'storyboards' }, 'running', t).text, /Split storyboards/)
  const failed = pipelineStatus({ state: 'failed', error: { stepId: 'firstFrames', code: 'blocked', message: 'Over the limit' } }, 'finished', t)
  assert.equal(failed.type, 'error')
  assert.equal(failed.text, 'First frames failed: Over the limit')
  assert.equal(pipelineStatus({ state: 'failed', error: { stepId: null, code: 'no_script', message: '' } }, 'finished', t).text, 'This episode has no script yet. Add one in the Script view first')
})
