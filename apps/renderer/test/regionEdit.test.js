import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FULL_RECT, MIN_SEGMENT_MS, MODES, normalizeRect, isFullRect, rectFromDrag, rectStyle, rectLabel, rectPercent, contentBox,
  clampRange, fullRange, markIn, markOut, rangeStyle, msAtFraction, formatMs, segmentSeconds,
  formatCents, savingPercent, costLine, strategyText, refusalText, editRequestBody, canSubmitEdit,
  regionStatusText, regionStatusType, isRegionPending, regionLine,
  findVideoVersions, versionVideoSrc, versionItems, versionAt, defaultVersionCompare, adoptHint,
} from '../src/utils/regionEdit.js'
import { setCompareSide, toggleCompare, shownSlot } from '../src/utils/shotWorkbench.js'
import { setLocale } from '../src/i18n/index.js'

setLocale('zh-CN')

const RECT = { x: 0.25, y: 0.1, w: 0.5, h: 0.4 }

test('normalizeRect: 裁到画面内、四位小数、太小或无效为 null', () => {
  assert.deepEqual(normalizeRect(RECT), RECT)
  assert.deepEqual(normalizeRect({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 }), { x: 0.8, y: 0.9, w: 0.2, h: 0.1 })
  assert.deepEqual(normalizeRect({ x: '0.123456', y: 0, w: '0.5', h: 1 }), { x: 0.1235, y: 0, w: 0.5, h: 1 })
  assert.deepEqual(normalizeRect({ x: -1, y: -1, w: 3, h: 3 }), FULL_RECT)
  assert.equal(normalizeRect({ x: 0, y: 0, w: 0.01, h: 0.5 }), null)
  assert.equal(normalizeRect({ x: 0, y: 0, w: 'a', h: 0.5 }), null)
  assert.equal(normalizeRect(null), null)
  assert.equal(isFullRect(FULL_RECT), true)
  assert.equal(isFullRect(RECT), false)
})

test('rectFromDrag: 任意方向拖拽 -> 归一化矩形；太小为 null', () => {
  const box = { width: 400, height: 200 }
  assert.deepEqual(rectFromDrag({ x0: 100, y0: 20, x1: 300, y1: 100 }, box), RECT)
  assert.deepEqual(rectFromDrag({ x0: 300, y0: 100, x1: 100, y1: 20 }, box), RECT, '反向拖拽相同')
  assert.deepEqual(rectFromDrag({ x0: -50, y0: -50, x1: 1000, y1: 1000 }, box), FULL_RECT, '拖出画面裁到边界')
  assert.equal(rectFromDrag({ x0: 10, y0: 10, x1: 12, y1: 12 }, box), null)
  assert.equal(rectFromDrag({ x0: 0, y0: 0, x1: 10, y1: 10 }, { width: 0, height: 0 }), null)
  assert.deepEqual(rectStyle(RECT), { left: '25.00%', top: '10.00%', width: '50.00%', height: '40.00%' })
  assert.deepEqual(rectStyle(null), { left: '0.00%', top: '0.00%', width: '100.00%', height: '100.00%' })
})

test('contentBox: contain 布局下画面在元素里的位置（黑边不算画面）', () => {
  assert.deepEqual(contentBox({ elWidth: 800, elHeight: 450, videoWidth: 1920, videoHeight: 1080 }), { left: 0, top: 0, width: 800, height: 450 })
  assert.deepEqual(contentBox({ elWidth: 800, elHeight: 600, videoWidth: 1920, videoHeight: 1080 }), { left: 0, top: 75, width: 800, height: 450 })
  assert.deepEqual(contentBox({ elWidth: 800, elHeight: 450, videoWidth: 1080, videoHeight: 1920 }), { left: 400 - 253.125 / 2, top: 0, width: 253.125, height: 450 })
  assert.deepEqual(contentBox({ elWidth: 800, elHeight: 450, videoWidth: 0, videoHeight: 0 }), { left: 0, top: 0, width: 800, height: 450 })
  assert.deepEqual(contentBox({ elWidth: 0, elHeight: 0, videoWidth: 1, videoHeight: 1 }), { left: 0, top: 0, width: 0, height: 0 })
})

test('rectLabel / rectPercent 与服务端规则一致', () => {
  assert.equal(rectLabel(FULL_RECT), '整幅画面')
  assert.equal(rectLabel(null), '整幅画面')
  assert.equal(rectLabel(RECT), '画面上方')
  assert.equal(rectLabel({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 }), '画面中央')
  assert.equal(rectLabel({ x: 0, y: 0.3, w: 0.2, h: 0.4 }), '画面左侧')
  assert.equal(rectLabel({ x: 0.75, y: 0.75, w: 0.2, h: 0.2 }), '画面下右')
  assert.equal(rectPercent(RECT), 20)
  assert.equal(rectPercent(FULL_RECT), 100)
})

test('clampRange / markIn / markOut: 不越界、不短于最小长度、入出点互推', () => {
  assert.deepEqual(clampRange({ t0: -5, t1: 9999 }, 3000), { t0: 0, t1: 3000 })
  assert.deepEqual(clampRange({ t0: 2900, t1: 2950 }, 3000), { t0: 2800, t1: 3000 }, '太短时向前扩到最小长度')
  assert.deepEqual(clampRange({ t0: 1000.4, t1: '2500' }, 3000), { t0: 1000, t1: 2500 })
  assert.deepEqual(clampRange({}, 3000), { t0: 0, t1: 3000 })
  assert.deepEqual(clampRange({ t0: 100 }, 0), { t0: 100, t1: 100 + MIN_SEGMENT_MS }, '片长未知只保证顺序')
  assert.deepEqual(fullRange(3000), { t0: 0, t1: 3000 })
  const r = fullRange(3000)
  const a = markIn(r, 1000, 3000)
  assert.deepEqual(a, { t0: 1000, t1: 3000 })
  const b = markOut(a, 2500, 3000)
  assert.deepEqual(b, { t0: 1000, t1: 2500 })
  assert.deepEqual(markIn(b, 2900, 3000), { t0: 2800, t1: 3000 }, '入点越过出点：出点后推，到片尾再把入点前拉')
  assert.deepEqual(markOut(b, 500, 3000), { t0: 300, t1: 500 }, '出点早于入点：入点前拉')
  assert.deepEqual(markIn(b, 2700, 3000), { t0: 2700, t1: 2900 })
  assert.deepEqual(rangeStyle(b, 3000), { left: '33.33%', width: '50.00%' })
  assert.deepEqual(rangeStyle(b, 0), { left: '0%', width: '100%' })
  assert.equal(msAtFraction(0.5, 3000), 1500)
  assert.equal(msAtFraction(2, 3000), 3000)
  assert.equal(formatMs(1500), '1.50s')
  assert.equal(formatMs('x'), '--')
})

test('segmentSeconds: 向上取整到整秒，1..15', () => {
  assert.equal(segmentSeconds(1000, 2500), 2)
  assert.equal(segmentSeconds(0, 300), 1)
  assert.equal(segmentSeconds(0, 60000), 15)
  assert.equal(segmentSeconds(0, 3000), 3)
})

test('费用文案：只改一段 vs 整镜，省多少，样例价标注', () => {
  assert.equal(formatCents(20), '¥0.20')
  assert.equal(formatCents(1234, 'USD'), '$12.34')
  assert.equal(formatCents('x'), '--')
  assert.equal(savingPercent(20, 30), 33)
  assert.equal(savingPercent(30, 30), 0)
  assert.equal(savingPercent(20, 0), 0)
  const est = { segment: { seconds: 2 }, estimate: { cents: 20, currency: 'CNY', full: { cents: 30, seconds: 3 }, sample_prices: true, known: true } }
  assert.equal(costLine(est), '只改这 2 秒约 ¥0.20（整镜重做约 ¥0.30，省 33%；样例价）')
  assert.equal(costLine({ edit: { t0_ms: 0, t1_ms: 1000 }, estimate: { cents: 10, currency: 'CNY', full: { cents: 10 }, sample_prices: false, known: true } }), '只改这 1 秒约 ¥0.10（整镜重做约 ¥0.10）')
  assert.equal(costLine(null), '')
  assert.match(strategyText('segment_splice'), /拼回原片/)
  assert.match(strategyText('provider_mask'), /直接/)
  assert.equal(strategyText('x'), '')
  assert.equal(refusalText({ allowed: false, refusal: { message: '超了' } }), '超了')
  assert.equal(refusalText({ allowed: true, provider_ready: false, provider: 'bailian' }), '未配置 bailian 的视频服务或 Key')
  assert.equal(refusalText({ allowed: true, provider_ready: true }), '')
})

test('editRequestBody / canSubmitEdit：区域模式要有矩形，整段模式缺省整幅', () => {
  const body = editRequestBody({ range: { t0: 1000, t1: 2500 }, rect: RECT, prompt: ' 把伞换成红色 ', total: 3000 })
  assert.deepEqual(body, { t0_ms: 1000, t1_ms: 2500, prompt: '把伞换成红色', mode: 'region', rect: RECT })
  assert.equal(editRequestBody({ range: { t0: 0, t1: 1000 }, rect: RECT, prompt: '  ', total: 3000 }), null)
  assert.equal(editRequestBody({ range: { t0: 0, t1: 1000 }, rect: null, prompt: 'x', total: 3000 }), null, '区域模式没框选')
  assert.deepEqual(editRequestBody({ range: { t0: 0, t1: 1000 }, rect: null, prompt: 'x', mode: 'segment', total: 3000 }).rect, FULL_RECT)
  assert.equal(editRequestBody({ range: { t0: 0, t1: 1000 }, rect: RECT, prompt: 'x', mode: 'inpaint', total: 3000 }), null)
  assert.equal(canSubmitEdit({ total: 3000, prompt: 'x', range: { t0: 0, t1: 1000 }, rect: RECT }), true)
  assert.equal(canSubmitEdit({ total: 0, prompt: 'x', range: { t0: 0, t1: 1000 }, rect: RECT }), false, '没有视频')
  assert.equal(canSubmitEdit({ total: 3000, prompt: 'x', range: { t0: 0, t1: 1000 }, rect: RECT, busy: true }), false)
})

test('改片记录的状态与摘要', () => {
  assert.equal(regionStatusText('queued'), '排队中')
  assert.equal(regionStatusText('weird'), 'weird')
  assert.equal(regionStatusType('done'), 'success')
  assert.equal(regionStatusType('failed'), 'danger')
  assert.equal(isRegionPending('running'), true)
  assert.equal(isRegionPending('done'), false)
  assert.equal(regionLine({ t0_ms: 1000, t1_ms: 2500, rect: RECT, prompt: '把伞换成红色', mode: 'region' }), '1.00s–2.50s · 画面上方 · 把伞换成红色')
  assert.equal(regionLine({ t0_ms: 0, t1_ms: 3000, rect: FULL_RECT, prompt: '重做', mode: 'segment' }), '0.00s–3.00s · 整段 · 重做')
  assert.equal(regionLine(null), '')
})

test('内核版本 -> V1..Vn 卡片；改片结果带记录；默认 A/B 与采用提示', () => {
  const all = [
    { node: 'img_1', type: 'image', shot_id: 'shot_1', versions: [] },
    { node: 'vid_1', type: 'video', shot_id: 'shot_1', adopted: 'v_base', versions: [
      { id: 'v_base', adopted: true, current: true, source: 'ai-task:1', asset: { ref: '/static/blobs/aa/a', kind: 'video' }, metadata: { duration_ms: 3000, model: 'wan2.6-t2v' }, created_at: '2026-01-01T00:00:00Z' },
      { id: 't_9', adopted: false, current: false, source: 'region-edit:7', asset: { ref: 'blobs/bb/b', kind: 'video' }, metadata: { duration_ms: 3018 } },
      { id: 'v_old', adopted: false, current: false, source: 'legacy-import', asset: null, metadata: null },
    ] },
  ]
  assert.equal(findVideoVersions(all, { node: 'vid_1' }).node, 'vid_1')
  assert.equal(findVideoVersions(all, { shotId: 'shot_1' }).node, 'vid_1')
  assert.equal(findVideoVersions(all, { node: 'nope' }), null)
  assert.equal(findVideoVersions(null, { node: 'vid_1' }), null)
  const regions = [{ id: 7, result_version_id: 't_9', t0_ms: 1000, t1_ms: 2500, rect: RECT, prompt: '把伞换成红色', mode: 'region', status: 'done' }]
  const items = versionItems(all[1], regions)
  assert.deepEqual(items.map((i) => i.label), ['V1', 'V2', 'V3'])
  assert.equal(items[0].adopted, true)
  assert.equal(items[0].src, '/static/blobs/aa/a')
  assert.equal(items[0].source, 'AI 生成')
  assert.equal(items[0].meta, '模型 wan2.6-t2v · 3.0 秒')
  assert.equal(items[1].isEdit, true)
  assert.equal(items[1].src, '/static/blobs/bb/b')
  assert.equal(items[1].source, '选镜改片')
  assert.equal(items[1].region.id, 7)
  assert.equal(items[1].regionText, '1.00s–2.50s · 画面上方 · 把伞换成红色')
  assert.equal(items[2].playable, false)
  assert.equal(items[2].source, '导入')
  // 记录还没回填 result_version_id 时也能从来源 region-edit:<id> 对上
  const byId = versionItems(all[1], [{ id: 7, t0_ms: 0, t1_ms: 1000, rect: FULL_RECT, prompt: 'x', mode: 'segment' }])
  assert.equal(byId[1].region.id, 7)
  assert.equal(versionItems(null).length, 0)
  assert.equal(versionAt(items, 1).id, 'v_base')
  assert.equal(versionAt(items, 3), null, '没有资产不可采用')
  assert.equal(versionAt(items, 9), null)
  assert.deepEqual(defaultVersionCompare(items), { a: 1, b: 2, showing: 'a' })
  assert.deepEqual(defaultVersionCompare([]), { a: null, b: null, showing: 'a' })
  assert.equal(adoptHint(items[0]), '当前采用')
  assert.match(adoptHint(items[1]), /改片结果/)
  assert.equal(adoptHint(items[2]), '采用这一版')
  // A/B 状态机沿用候选的实现（槽位号 = 版本序号）
  let st = defaultVersionCompare(items)
  st = toggleCompare(st)
  assert.equal(shownSlot(st), 2)
  st = setCompareSide(st, 'a', 2)
  assert.equal(st.b, null)
  assert.equal(versionVideoSrc('https://x/v.mp4'), 'https://x/v.mp4')
  assert.equal(versionVideoSrc('videos/a.mp4'), '/static/videos/a.mp4')
  assert.equal(versionVideoSrc(''), '')
})

test('English locale: rect label, cost line, strategy, refusal, status, source and adopt text', () => {
  setLocale('en')
  try {
    assert.equal(rectLabel(FULL_RECT), 'The whole frame')
    assert.equal(rectLabel(RECT), 'The top of the frame')
    assert.equal(rectLabel({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 }), 'The center of the frame')
    assert.equal(rectLabel({ x: 0, y: 0.3, w: 0.2, h: 0.4 }), 'The left side of the frame')
    assert.equal(rectLabel({ x: 0.75, y: 0.75, w: 0.2, h: 0.2 }), 'The bottom right of the frame')
    const est = { segment: { seconds: 2 }, estimate: { cents: 20, currency: 'CNY', full: { cents: 30, seconds: 3 }, sample_prices: true, known: true } }
    assert.equal(costLine(est), 'Editing only these 2s costs about ¥0.20 (redoing the whole shot costs about ¥0.30, saving 33%; sample prices)')
    assert.equal(costLine({ edit: { t0_ms: 0, t1_ms: 1000 }, estimate: { cents: 10, currency: 'CNY', full: { cents: 10 }, sample_prices: false, known: true } }), 'Editing only these 1s costs about ¥0.10 (redoing the whole shot costs about ¥0.10)')
    assert.match(strategyText('segment_splice'), /spliced back/)
    assert.equal(refusalText({ allowed: false }), 'Over the spending cap')
    assert.equal(refusalText({ allowed: true, provider_ready: false, provider: 'bailian' }), 'No video service or key is configured for bailian')
    assert.equal(regionStatusText('queued'), 'Queued')
    assert.equal(regionStatusText('weird'), 'weird')
    assert.equal(regionLine({ t0_ms: 0, t1_ms: 3000, rect: FULL_RECT, prompt: 'redo', mode: 'segment' }), '0.00s–3.00s · whole segment · redo')
    assert.deepEqual(MODES.map((m) => m.label), ['Only the boxed region', 'Redo the whole segment'])
    assert.equal(adoptHint({ adopted: true }), 'Currently adopted')
    assert.equal(adoptHint({ isEdit: false }), 'Adopt this version')
    const items = versionItems({ versions: [{ id: 'a', source: 'ai-task:1', metadata: { model: 'wan', duration_ms: 3000 } }, { id: 'b', source: 'legacy-sync' }] })
    assert.equal(items[0].source, 'AI generated')
    assert.equal(items[0].meta, 'Model wan · 3.0s')
    assert.equal(items[1].source, 'Synced from old assets')
  } finally {
    setLocale('zh-CN')
  }
})
