import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../src/i18n/index.js'
import {
  formatCents, estimateText, remainingText, clampConcurrency, concurrencyBody, validatePolicy, parseBudgetYuan, buildCreateBody,
  batchStatusTag, itemStatusTag, progressPercent, kindsLabel, nightText, elapsedText, pollInterval, summaryCards,
  canPause, canResume, canCancel, canRetryFailed, itemTasksText, itemShotsText, waitingText,
} from '../src/utils/batchView.js'

setLocale('zh-CN')

test('formatCents / estimateText / remainingText', () => {
  assert.equal(formatCents(1234), '¥12.34')
  assert.equal(formatCents(5), '¥0.05')
  assert.equal(formatCents('x'), '-')
  assert.equal(estimateText({ estimate_min_cents: 1000, estimate_max_cents: 1200 }), '全部完成预计 ¥10.00–12.00')
  assert.equal(estimateText({ estimate_min_cents: 1000, estimate_max_cents: 1200 }, 1500), '全部完成预计 ¥10.00–12.00（最多 ¥15.00）')
  assert.equal(estimateText({ estimate_min_cents: 0, estimate_max_cents: 0 }), '全部完成预计 ¥0.00')
  assert.equal(estimateText(null), '')
  assert.equal(remainingText({ remaining_min_cents: 300, remaining_max_cents: 360 }), '剩余预计 ¥3.00–3.60')
  assert.equal(remainingText({ remaining_min_cents: 0, remaining_max_cents: 0 }), '剩余预计 ¥0.00')
})

test('clampConcurrency never exceeds the provider limit and never goes below 1', () => {
  assert.equal(clampConcurrency(10, 3), 3)
  assert.equal(clampConcurrency(0, 3), 1)
  assert.equal(clampConcurrency(2.7, 3), 2)
  assert.equal(clampConcurrency('', 3), 3, '空 = 上限')
  assert.equal(clampConcurrency('abc', 3, 2), 2, '非法取 fallback')
  assert.equal(clampConcurrency(5, 0), 1)
  assert.deepEqual(concurrencyBody([{ id: 'bailian', limit: 3 }, { id: 'ark', limit: 2 }], { bailian: 9 }), { bailian: 3, ark: 2 })
})

test('validatePolicy', () => {
  assert.deepEqual(validatePolicy({ retry: 2, on_fail: 'pause', night_enabled: false }), { ok: true, errors: [], value: { retry: 2, on_fail: 'pause', night: null } })
  const night = validatePolicy({ retry: 0, on_fail: 'skip', night_enabled: true, night_start: '22:00', night_end: '06:00' })
  assert.equal(night.ok, true)
  assert.deepEqual(night.value.night, { start: '22:00', end: '06:00' })
  assert.ok(validatePolicy({ retry: 11, on_fail: 'skip' }).errors[0].includes('0–10'))
  assert.ok(validatePolicy({ retry: 1, on_fail: 'retry' }).errors.length)
  assert.ok(validatePolicy({ retry: 1, on_fail: 'skip', night_enabled: true, night_start: '25:00', night_end: '06:00' }).errors[0].includes('HH:MM'))
  assert.ok(validatePolicy({ retry: 1, on_fail: 'skip', night_enabled: true, night_start: '06:00', night_end: '06:00' }).errors[0].includes('不能相同'))
  assert.equal(validatePolicy({ retry: 'x' }).ok, false)
})

test('parseBudgetYuan / buildCreateBody', () => {
  assert.deepEqual(parseBudgetYuan(''), { value: null })
  assert.deepEqual(parseBudgetYuan(' 12.345 '), { value: 1235 })
  assert.deepEqual(parseBudgetYuan('0'), { value: 0 })
  assert.ok(parseBudgetYuan('-1').error)
  assert.ok(parseBudgetYuan('abc').error)
  assert.deepEqual(
    buildCreateBody({ dramaId: '7', episodeIds: ['1', 2], kinds: 'video', concurrency: { bailian: 2 }, budgetCents: 500, policy: { retry: 1, on_fail: 'skip', night: null } }),
    { drama_id: 7, episode_ids: [1, 2], kinds: 'video', concurrency: { bailian: 2 }, budget_cap_cents: 500, failure_policy: { retry: 1, on_fail: 'skip', night: null } }
  )
  assert.equal(buildCreateBody({ dramaId: 1, episodeIds: [1] }).failure_policy, undefined)
})

test('status tags, actions and progress', () => {
  assert.equal(batchStatusTag('completed'), 'success')
  assert.equal(batchStatusTag('failed'), 'danger')
  assert.equal(batchStatusTag('paused'), 'warning')
  assert.equal(batchStatusTag('running'), 'primary')
  assert.equal(itemStatusTag('succeeded'), 'success')
  assert.equal(itemStatusTag('pending'), 'warning')
  const running = { status: 'running', progress: { shots_total: 10, shots_done: 4, items_total: 2, items_done: 0, items_failed: 0 } }
  assert.equal(progressPercent(running), 40)
  assert.equal(progressPercent({ status: 'completed', progress: { shots_total: 10, shots_done: 9 } }), 100)
  assert.equal(progressPercent({ status: 'running', progress: { shots_total: 0, items_total: 4, items_done: 1 } }), 25)
  assert.equal(progressPercent(null), 0)
  assert.equal(canPause(running), true)
  assert.equal(canResume(running), false)
  assert.equal(canResume({ status: 'paused' }), true)
  assert.equal(canCancel({ status: 'paused' }), true)
  assert.equal(canCancel({ status: 'completed' }), false)
  assert.equal(canRetryFailed({ status: 'completed', progress: { items_failed: 1 } }), true)
  assert.equal(canRetryFailed({ status: 'cancelled', progress: { items_failed: 1 } }), false)
  assert.equal(canRetryFailed(running), false)
  assert.equal(waitingText('night'), '不在夜间时段内，等待时段开始后再提交')
  assert.equal(waitingText(null), '')
})

test('labels: kinds, night, elapsed, tasks, shots', () => {
  assert.equal(kindsLabel(['image', 'video']), '首帧图 + 视频')
  assert.equal(kindsLabel(['video']), '视频')
  assert.equal(kindsLabel([]), '-')
  assert.equal(nightText(null), '不限时段')
  assert.equal(nightText({ start: '22:00', end: '06:00' }), '22:00–06:00（跨午夜）')
  assert.equal(nightText({ start: '01:00', end: '06:00' }), '01:00–06:00')
  assert.equal(elapsedText(0), '0 秒')
  assert.equal(elapsedText(45_000), '45 秒')
  assert.equal(elapsedText(185_000), '3 分 05 秒')
  assert.equal(elapsedText(3_780_000), '1 小时 03 分')
  assert.equal(itemTasksText({ tasks: { running: 1, queued: 2, succeeded: 3, failed: 0 } }), '1 在跑 · 2 排队 · 3 完成')
  assert.equal(itemTasksText({ tasks: {} }), '-')
  assert.equal(itemShotsText({ shots_total: 5, shots_done: 2 }), '2 / 5')
  assert.equal(itemShotsText({ shots_total: null, shots_done: 0 }), '0')
})

test('pollInterval and summaryCards', () => {
  assert.equal(pollInterval([{ status: 'completed' }, { status: 'running' }]), 3000)
  assert.equal(pollInterval([{ status: 'paused' }]), 15000)
  assert.equal(pollInterval([]), 15000)
  const cards = summaryCards({
    status: 'running', currency: 'CNY', elapsed_ms: 65_000, started_at: 1,
    progress: { items_total: 3, items_done: 1, shots_total: 15, shots_done: 6 },
    totals: { spent_cents: 250, in_flight_max_cents: 120, estimate_min_cents: 600, estimate_max_cents: 720, remaining_min_cents: 300, remaining_max_cents: 360 },
  })
  assert.deepEqual(cards.map((c) => c.key), ['progress', 'spent', 'estimate', 'elapsed'])
  assert.equal(cards[0].value, '40%')
  assert.equal(cards[0].sub, '1 / 3 集 · 6 / 15 镜')
  assert.equal(cards[1].value, '¥2.50')
  assert.equal(cards[1].sub, '在途最高 ¥1.20')
  assert.equal(cards[2].value, '¥6.00–7.20')
  assert.equal(cards[2].sub, '剩余预计 ¥3.00–3.60')
  assert.equal(cards[3].value, '1 分 05 秒')
  assert.deepEqual(summaryCards(null), [])
})

test('labels follow the locale (English)', async () => {
  const m = await import('../src/utils/batchView.js')
  setLocale('en')
  try {
    assert.equal(m.batchStatusLabel('paused'), 'Paused')
    assert.equal(m.itemStatusLabel('succeeded'), 'Done')
    assert.equal(m.kindsLabel(['image', 'video']), 'First frames + videos')
    assert.equal(m.elapsedText(185_000), '3 min 05 s')
    assert.equal(m.nightText({ start: '22:00', end: '06:00' }), '22:00–06:00 (crosses midnight)')
    assert.equal(m.estimateText({ estimate_min_cents: 1000, estimate_max_cents: 1200 }, 1500), 'Estimated total ¥10.00–12.00 (up to ¥15.00)')
    assert.equal(m.KINDS_OPTIONS[1].label, 'First frames only')
    assert.equal(m.batchStatusLabel('weird'), 'weird')
    assert.equal(m.validatePolicy({ retry: 11, on_fail: 'skip' }).errors[0], 'Automatic retries must be a whole number from 0 to 10')
  } finally {
    setLocale('zh-CN')
  }
})
