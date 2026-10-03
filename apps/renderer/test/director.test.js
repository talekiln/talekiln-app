import test from 'node:test'
import assert from 'node:assert/strict'

import {
  validateMessage, turnStatus, canApply, canUndo, shotNumberMap, describeStep, impactSummary, durationText, formatSeconds,
  rhythmBars, previewShots, costSummary, describeTurn, sortTurns, upsertTurn, MESSAGE_MAX,
} from '../src/utils/director.js'

const impact = () => ({
  changed_shots: [
    { id: 'shot_2', no: 2, title: '公交车内', change: 'modified', changes: ['content', 'segments'] },
    { id: 'shot_3', no: 3, title: '', change: 'modified', changes: ['lines'] },
    { id: 'shot_6', no: 4, title: '车窗笑脸', change: 'added', changes: ['added'] },
  ],
  unchanged_shots: ['shot_1', 'shot_4', 'shot_5'],
  added_shots: ['shot_6'],
  removed_shots: [],
  duration: { before_ms: 16000, after_ms: 19000 },
  shots_before: [
    { id: 'shot_1', no: 1, title: '雨夜街头', used_ms: 3000, change: 'unchanged' },
    { id: 'shot_2', no: 2, title: '公交车内', used_ms: 3500, change: 'modified' },
    { id: 'shot_3', no: 3, title: '', used_ms: 3000, change: 'modified' },
    { id: 'shot_4', no: 4, title: '', used_ms: 3000, change: 'unchanged' },
    { id: 'shot_5', no: 5, title: '终点站', used_ms: 3500, change: 'unchanged' },
  ],
  shots_after: [
    { id: 'shot_1', no: 1, title: '雨夜街头', used_ms: 3000, change: 'unchanged' },
    { id: 'shot_2', no: 2, title: '公交车内', used_ms: 3500, change: 'modified' },
    { id: 'shot_3', no: 3, title: '', used_ms: 3000, change: 'modified' },
    { id: 'shot_6', no: 4, title: '车窗笑脸', used_ms: 3000, change: 'added' },
    { id: 'shot_4', no: 5, title: '', used_ms: 3000, change: 'unchanged' },
    { id: 'shot_5', no: 6, title: '终点站', used_ms: 3500, change: 'unchanged' },
  ],
  stale_nodes: [{ node: 'img_2', type: 'image', step: 0, shot_id: 'shot_2', shot_no: 2 }],
})
import { setLocale } from '../src/i18n/index.js'

setLocale('zh-CN')

test('validateMessage: trims, rejects empty and over-long input', () => {
  assert.deepEqual(validateMessage('  改一下 '), { ok: true, value: '改一下' })
  assert.equal(validateMessage('   ').ok, false)
  assert.match(validateMessage('').error, /要改什么/)
  assert.match(validateMessage('x'.repeat(MESSAGE_MAX + 1)).error, /太长/)
})

test('turnStatus / canApply / canUndo follow the record status and the live history state', () => {
  assert.deepEqual(turnStatus({ status: 'planned' }), { key: 'planned', label: '待执行', type: 'primary', note: '' })
  assert.equal(turnStatus({ status: 'rejected' }).label, '已拒绝')
  assert.equal(turnStatus({ status: 'applied', history_state: 'applied' }).label, '已执行')
  const top = turnStatus({ status: 'applied', history_state: 'undone' })
  assert.equal(top.label, '已在顶栏撤销')
  assert.match(top.note, /重做/)
  assert.equal(turnStatus({ status: 'applied', history_state: 'discarded' }).label, '已被覆盖')
  assert.equal(turnStatus({ status: 'undone' }).label, '已撤销')
  assert.equal(canApply({ status: 'planned' }), true)
  assert.equal(canApply({ status: 'planned' }, { busy: true }), false)
  assert.equal(canApply({ status: 'applied' }), false)
  assert.equal(canUndo({ status: 'applied', history_state: 'applied' }), true)
  assert.equal(canUndo({ status: 'applied', history_state: null }), true)
  assert.equal(canUndo({ status: 'applied', history_state: 'undone' }), false)
  assert.equal(canUndo({ status: 'applied', history_state: 'discarded' }), false)
  assert.equal(canUndo({ status: 'planned' }), false)
  assert.equal(canUndo({ status: 'applied', history_state: 'applied' }, { busy: true }), false)
})

test('shotNumberMap prefers the numbering before the plan and adds new shots from after', () => {
  const nums = shotNumberMap(impact())
  assert.equal(nums.shot_4, 4, 'shot 4 keeps its old number even though it becomes 5 after the insert')
  assert.equal(nums.shot_6, 4, 'the new shot only has a number after the plan')
  assert.deepEqual(shotNumberMap(null), {})
})

test('describeStep: Chinese action name, target by shot number, patch fields and cost text', () => {
  const nums = { shot_2: 2, shot_1: 1, shot_3: 3 }
  const s = describeStep({ index: 0, view: 'shot', name: 'setShotField', args: { shot_id: 'shot_2', patch: { shot_type: '特写', description: '深夜的公交车内' } }, reason: '用户要求', ok: true, cost: 0.2 }, nums)
  assert.equal(s.title, '修改镜头')
  assert.equal(s.target, '镜头 2')
  assert.equal(s.detail, '景别：特写；画面描述：深夜的公交车内')
  assert.equal(s.reason, '用户要求')
  assert.equal(s.costText, '¥0.20')
  assert.equal(s.ok, true)
  const r = describeStep({ index: 1, view: 'shot', name: 'reorderShots', args: { group_id: 'grp_1', ids: ['shot_2', 'shot_1', 'shot_3'] }, cost: 0 }, nums)
  assert.equal(r.title, '镜头排序')
  assert.equal(r.target, '场景 grp_1')
  assert.equal(r.detail, '新顺序：2 → 1 → 3')
  assert.equal(r.costText, '不花钱')
  const m = describeStep({ index: 2, view: 'shot', name: 'mergeShots', args: { a_id: 'shot_1', b_id: 'shot_2' } }, nums)
  assert.equal(m.target, '镜头 1、镜头 2')
  const t = describeStep({ index: 3, view: 'timeline', name: 'setTransition', args: { segment_id: 'seg-9', transition: null } }, nums)
  assert.equal(t.title, '改转场')
  assert.equal(t.target, '片段 seg-9')
  assert.equal(t.detail, '转场：清除')
  const bad = describeStep({ index: 4, view: 'shot', name: 'explodeShot', args: 'nope', ok: false, error: '不在清单里' }, nums)
  assert.equal(bad.title, 'explodeShot')
  assert.equal(bad.ok, false)
  assert.equal(bad.error, '不在清单里')
  assert.equal(bad.detail, '')
  const a = describeStep({ index: 5, view: 'shot', name: 'addShot', args: { group: 'grp_1', index: 2, params: { title: '车窗笑脸', duration_ms: 3000 }, lines: ['line_9'] } }, nums)
  assert.equal(a.target, '场景 grp_1')
  assert.equal(a.detail, '位置：2；标题：车窗笑脸；时长（毫秒）：3000；挂上的行：line_9')
})

test('impactSummary: changed with change text, unchanged count, untouched list, duration text', () => {
  const im = impactSummary(impact(), ['其余镜头不变'])
  assert.deepEqual(im.changed.map((c) => [c.no, c.changeText]), [[2, '修改（画面、片段）'], [3, '修改（台词）'], [4, '新增']])
  assert.deepEqual(im.unchanged, ['shot_1', 'shot_4', 'shot_5'])
  assert.equal(im.unchangedText, '3 个镜头不受影响')
  assert.deepEqual(im.untouched, ['其余镜头不变'])
  assert.equal(im.durationText, '16.0 秒 → 19.0 秒（+3.0 秒）')
  assert.equal(im.staleCount, 1)
  assert.equal(impactSummary(null), null)
  const none = impactSummary({ changed_shots: [], unchanged_shots: ['a'], duration: { before_ms: 1000, after_ms: 1000 } })
  assert.equal(none.unchangedText, '1 个镜头不受影响（全部）')
  assert.equal(none.durationText, '1.0 秒（不变）')
})

test('durationText / formatSeconds', () => {
  assert.equal(durationText(16000, 14500), '16.0 秒 → 14.5 秒（−1.5 秒）')
  assert.equal(durationText(0, 0), '0.0 秒（不变）')
  assert.equal(formatSeconds(3500), '3.5 秒')
  assert.equal(formatSeconds(null), '0.0 秒')
})

test('rhythmBars: both rows share one scale (the longer total); widths add up to 100 on the longer row', () => {
  const b = rhythmBars(impact())
  assert.equal(b.scale_ms, 19000)
  assert.equal(b.before.length, 5)
  assert.equal(b.after.length, 6)
  const sum = (row) => Math.round(row.reduce((a, s) => a + s.width, 0))
  assert.equal(sum(b.after), 100)
  assert.equal(sum(b.before), Math.round((16000 / 19000) * 100))
  assert.equal(b.after[3].change, 'added')
  assert.equal(b.after[3].seconds, '3.0 秒')
  assert.equal(b.before[1].width, b.after[1].width, 'same shot, same width on both rows')
  assert.deepEqual(rhythmBars(null), { before: [], after: [], scale_ms: 0 })
})

test('previewShots: changed shots are dashed, unnamed shots get a placeholder', () => {
  const p = previewShots(impact())
  assert.deepEqual(p.map((s) => [s.no, s.dashed, s.changeText]), [[1, false, '不变'], [2, true, '修改'], [3, true, '修改'], [4, true, '新增'], [5, false, '不变'], [6, false, '不变']])
  assert.equal(p[2].title, '（未命名镜头）')
  assert.deepEqual(previewShots(null), [])
})

test('costSummary: total / max text, per-item lines, notes and cap refusal', () => {
  const c = costSummary({
    total: 0.4, max: 0.48, currency: 'CNY', sample_prices: true, known: true, allowed: true, refusal: null,
    items: [
      { node: 'img_2', type: 'image', shot_no: 2, kind: 'image', model: 'wan2.6-t2i', step: 0, estimate: 0.2, known: true, basis: '1 image x 0.2' },
      { node: 'img_3', type: 'image', shot_no: 3, kind: 'image', model: 'wan2.6-t2i', step: 1, estimate: 0.2, known: true },
      { node: 'nar_3', type: 'narration', shot_no: 3, kind: 'tts', step: 1, estimate: 0, known: true, basis: '没有可配音的文字' },
    ],
  })
  assert.equal(c.text, '预计 ¥0.40（最高 ¥0.48）')
  assert.equal(c.note, '示例价目')
  assert.equal(c.zero, false)
  assert.deepEqual(c.items.map((i) => i.text), ['镜头 2 首帧图（wan2.6-t2i）：¥0.20', '镜头 3 首帧图（wan2.6-t2i）：¥0.20', '镜头 3 配音：不花钱'])
  assert.equal(c.refusal, '')
  const zero = costSummary({ total: 0, max: 0, currency: 'CNY', sample_prices: false, known: true, allowed: true, items: [] })
  assert.equal(zero.text, '不花钱')
  assert.equal(zero.zero, true)
  assert.equal(zero.note, '')
  const capped = costSummary({ total: 5, max: 6, currency: 'CNY', allowed: false, refusal: { reason: 'per_run', message: '本次预计最高费用 6 CNY 超过单次上限 1 CNY' }, items: [], known: false })
  assert.match(capped.refusal, /超出花费上限：本次预计最高费用 6 CNY 超过单次上限 1 CNY/)
  assert.equal(capped.note, '部分价格未知')
  assert.equal(costSummary(null).text, '花费未估算')
})

test('describeTurn assembles the card: status, steps, impact, bars, preview, cost, buttons', () => {
  const turn = {
    id: 7, message: '第二镜改成夜景特写', status: 'planned', history_state: null, created_at: new Date(2026, 9, 2, 10, 30).toISOString(),
    provider: 'bailian', model: 'qwen-plus', summary: '第二镜改为夜景特写', untouched: ['其余镜头不变'],
    steps: [{ index: 0, view: 'shot', name: 'setShotField', args: { shot_id: 'shot_2', patch: { shot_type: '特写' } }, reason: '按要求', ok: true, cost: 0.2 }],
    validation: { ok: true, errors: [], attempts: 1 }, impact: impact(),
    cost_estimate: { total: 0.2, max: 0.24, currency: 'CNY', allowed: true, items: [] },
    raw: ['{"summary":"x"}'],
  }
  const card = describeTurn(turn, { busy: false })
  assert.equal(card.id, 7)
  assert.equal(card.time, '10-02 10:30')
  assert.equal(card.model, 'bailian · qwen-plus')
  assert.equal(card.status.label, '待执行')
  assert.equal(card.rejected, false)
  assert.equal(card.steps[0].title, '修改镜头')
  assert.equal(card.steps[0].target, '镜头 2')
  assert.equal(card.impact.changed.length, 3)
  assert.equal(card.bars.after.length, 6)
  assert.equal(card.preview.filter((s) => s.dashed).length, 3)
  assert.equal(card.cost.text, '预计 ¥0.20（最高 ¥0.24）')
  assert.equal(card.canApply, true)
  assert.equal(card.canUndo, false)
  assert.equal(card.raw, '{"summary":"x"}')
  const rejected = describeTurn({ id: 8, message: 'x', status: 'rejected', steps: [], validation: { ok: false, errors: ['第 1 步：动作 shot.explodeShot 不在可用动作清单里'], attempts: 2 }, impact: null, cost_estimate: null, raw: ['a', 'b'] })
  assert.equal(rejected.rejected, true)
  assert.equal(rejected.errors.length, 1)
  assert.equal(rejected.impact, null)
  assert.equal(rejected.preview.length, 0)
  assert.equal(rejected.cost.text, '花费未估算')
  assert.equal(rejected.raw, 'a\n\n----\n\nb')
  assert.equal(rejected.attempts, 2)
  assert.equal(rejected.canApply, false)
  assert.equal(rejected.model, '')
})

test('sortTurns / upsertTurn keep newest first and replace by id', () => {
  const list = sortTurns([{ id: 1 }, { id: 3 }, { id: 2 }])
  assert.deepEqual(list.map((t) => t.id), [3, 2, 1])
  const next = upsertTurn(list, { id: 2, status: 'applied' })
  assert.deepEqual(next.map((t) => [t.id, t.status]), [[3, undefined], [2, 'applied'], [1, undefined]])
  assert.deepEqual(upsertTurn(list, { id: 9 }).map((t) => t.id), [9, 3, 2, 1])
  assert.equal(upsertTurn(list, null), list)
})
