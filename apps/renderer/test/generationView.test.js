import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chipFor, shotStatusMap, chipForShot, failureText, buildGenerateBody, pollInterval, isBusy,
  confirmSummary, submittedText, taskTarget, kindLabel,
} from '../src/utils/generationView.js'
import { setLocale } from '../src/i18n/index.js'

setLocale('zh-CN')

const item = (kind, action, extra = {}) => ({ shot_id: `shot_${Math.random()}`, kind, action, warnings: [], ...extra })
const preview = (over = {}) => ({
  items: [item('image', 'create'), item('video', 'chain'), item('video', 'create'), item('image', 'fresh')],
  billable: 3,
  estimate: { total: 1.2, max: 1.44, currency: 'CNY', sample_prices: true, known: true },
  cap: { monthly_cap: 100, monthly_remaining: 80, per_run_cap: null, currency: 'CNY' },
  allowed: true, refusal: null, provider_ready: true,
  ...over,
})

test('chipFor maps the six states and falls back to none', () => {
  assert.deepEqual(chipFor('fresh'), { state: 'fresh', label: '最新', type: 'success' })
  assert.equal(chipFor('running').label, '生成中')
  assert.equal(chipFor('failed').type, 'danger')
  assert.equal(chipFor('stale').label, '需更新')
  assert.equal(chipFor('queued').label, '排队中')
  assert.equal(chipFor('???').label, '未生成')
  assert.equal(chipFor(undefined).state, 'none')
})

test('shotStatusMap keys by storyboard id; chipForShot is null until status is known', () => {
  const m = shotStatusMap({ shots: [{ storyboard_id: 7, state: 'queued' }, { storyboard_id: null, state: 'none' }] })
  assert.equal(m.size, 1)
  assert.equal(chipForShot(m, '7').label, '排队中')
  assert.equal(chipForShot(m, 8), null)
  assert.equal(chipForShot(null, 1), null)
  assert.equal(shotStatusMap(null).size, 0)
})

test('failureText prefers the failed node message', () => {
  assert.equal(failureText({ state: 'fresh' }), '')
  assert.equal(failureText({ state: 'failed', image: { state: 'fresh' }, video: { state: 'failed', error_message: '余额不足' } }), '余额不足')
  assert.match(failureText({ state: 'failed', image: { state: 'failed' } }), /任务中心/)
})

test('buildGenerateBody defaults to a dry run', () => {
  assert.deepEqual(buildGenerateBody({ shots: [1, 2], kind: 'video' }), { shots: [1, 2], kind: 'video', confirm: false })
  assert.deepEqual(buildGenerateBody({ confirm: true, regenerate: true }), { shots: 'all', kind: 'both', confirm: true, regenerate: true })
})

test('pollInterval is fast only while something is queued or running', () => {
  assert.equal(pollInterval({ counts: { queued: 1 } }), 3000)
  assert.equal(pollInterval({ counts: { running: 2, fresh: 3 } }), 3000)
  assert.equal(pollInterval({ counts: { fresh: 3, failed: 1 } }), 15000)
  assert.equal(pollInterval(null), 15000)
  assert.equal(isBusy({ state: 'running' }), true)
  assert.equal(isBusy({ state: 'stale' }), false)
})

test('confirmSummary shows counts, estimated spend and remaining cap', () => {
  const s = confirmSummary(preview())
  assert.equal(s.canConfirm, true)
  assert.equal(s.blocked, false)
  assert.equal(s.free, false)
  assert.ok(s.lines.includes('首帧图：1'))
  assert.ok(s.lines.some((l) => l.startsWith('视频：2') && l.includes('自动接着')))
  assert.ok(s.lines.includes('预计费用 ¥1.20（最高 ¥1.44）'))
  assert.ok(s.lines.some((l) => l.includes('本月剩余额度 ¥80.00') && l.includes('上限 ¥100.00')))
  assert.ok(s.lines.includes('1 项已是最新，跳过'))
  assert.deepEqual(s.warnings, ['价格表为示例价，实际以服务商账单为准'])
})

test('confirmSummary blocks when the cap check failed', () => {
  const s = confirmSummary(preview({ allowed: false, refusal: { reason: 'monthly', message: '将超过月度上限 1 CNY' } }))
  assert.equal(s.blocked, true)
  assert.equal(s.canConfirm, false)
  assert.equal(s.blockedText, '将超过月度上限 1 CNY')
})

test('confirmSummary: nothing billable is free; cache hits can still be confirmed', () => {
  const none = confirmSummary(preview({ items: [item('image', 'fresh')], billable: 0, estimate: { total: 0, max: 0, currency: 'CNY' } }))
  assert.equal(none.free, true)
  assert.equal(none.canConfirm, false)
  assert.ok(!none.lines.some((l) => l.includes('预计费用')))
  const hit = confirmSummary(preview({ items: [item('image', 'cache_hit')], billable: 0, estimate: { total: 0, max: 0, currency: 'CNY' } }))
  assert.equal(hit.canConfirm, true)
  assert.ok(hit.lines.some((l) => l.includes('不收费')))
})

test('confirmSummary: unlimited month, missing key, stale first frame, unknown price', () => {
  const s = confirmSummary(preview({
    cap: { monthly_cap: null, monthly_remaining: null, per_run_cap: 5, currency: 'CNY' },
    provider_ready: false,
    estimate: { total: 1, max: 1.2, currency: 'CNY', sample_prices: false, known: false },
    items: [item('video', 'create', { warnings: ['first_frame_stale'] })],
  }))
  assert.ok(s.lines.includes('本月额度：未设置上限'))
  assert.ok(s.lines.includes('单次上限 ¥5.00'))
  assert.equal(s.canConfirm, false)
  assert.equal(s.warnings.length, 3)
  assert.equal(confirmSummary(null).canConfirm, false)
})

test('submittedText and taskTarget', () => {
  assert.match(submittedText({ tasks: [] }), /没有需要生成/)
  assert.equal(submittedText({ tasks: [{ outcome: 'created' }, { outcome: 'already_queued' }] }), '已加入队列 1 个任务，1 个已在队列中；可在任务中心查看进度')
  assert.equal(taskTarget({ params: { _gen: { storyboard_id: 4, kind: 'video' } } }), '镜头 #4 · 视频')
  assert.equal(taskTarget({ params: { _gen: { storyboard_id: 4, kind: 'image' } } }), '镜头 #4 · 首帧图')
  assert.equal(taskTarget({ params: { _vo: { legacy_id: 7, shot_id: 's1' } } }), '镜头 #7 · 旁白配音')
  assert.equal(taskTarget({ params: { prompt: 'x' } }), '')
  assert.equal(taskTarget(null), '')
})

test('chip labels, kind labels, task targets and the confirm text follow the language', () => {
  try {
    setLocale('en')
    assert.equal(chipFor('stale').label, 'Needs update')
    assert.equal(kindLabel('both'), 'First frame + video')
    assert.equal(taskTarget({ params: { _gen: { storyboard_id: 4, kind: 'video' } } }), 'Shot #4 · Video')
    assert.equal(taskTarget({ params: { _vo: { legacy_id: 7 } } }), 'Shot #7 · Narration voiceover')
    assert.equal(confirmSummary(preview()).lines[0], 'First frames: 1')
    assert.equal(submittedText({ tasks: [] }), 'Nothing to generate (already up to date or reused earlier results)')
  } finally {
    setLocale('zh-CN')
  }
})
