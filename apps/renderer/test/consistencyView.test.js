import test from 'node:test'
import assert from 'node:assert/strict'
import {
  autoPickSummary, badgeForShot, busyCount, consistencyBadge, consistencyHint, consistencyShotMap, rankedToCandidates,
  regenerateCostText, shouldRefreshConsistency, unavailableText, faceText,
} from '../src/utils/consistencyView.js'

const shot = (over = {}) => ({
  shot_id: 'shot_1', storyboard_id: 7, number: 1, scored: true, best: 90, worst: 35.4, suggestion: 'retry',
  entity: { type: 'character', id: 3, name: '李雷' },
  image: { scored: true, best: 90, worst: 35.4, suggestion: 'retry' },
  video: null,
  regenerate: { kind: 'both', estimate: 0.5, max: 0.6, currency: 'CNY', known: true, allowed: true },
  ...over,
})

test('consistencyBadge: 按建议给颜色，分数取最差分；没评过分不显示', () => {
  assert.deepEqual(consistencyBadge(shot()), { suggestion: 'retry', label: '一致性 35', type: 'danger', score: 35.4 })
  assert.equal(consistencyBadge(shot({ suggestion: 'ok', worst: 92 })).type, 'success')
  assert.equal(consistencyBadge(shot({ suggestion: 'check', worst: 55 })).type, 'warning')
  assert.equal(consistencyBadge(shot({ suggestion: 'weird', worst: 55 })).suggestion, 'check')
  assert.equal(consistencyBadge(shot({ scored: false, suggestion: null, worst: null })), null)
  assert.equal(consistencyBadge(null), null)
})

test('consistencyShotMap / badgeForShot 按旧表 id 查', () => {
  const m = consistencyShotMap({ shots: [shot(), shot({ storyboard_id: null })] })
  assert.equal(m.size, 1)
  assert.equal(badgeForShot(m, '7').label, '一致性 35')
  assert.equal(badgeForShot(m, 8), null)
  assert.equal(badgeForShot(null, 7), null)
  assert.equal(consistencyShotMap(null).size, 0)
})

test('regenerateCostText：按建议的重做范围给估价；没有估价为空', () => {
  assert.equal(regenerateCostText(shot().regenerate), '重做首帧图 + 视频预计 ¥0.50（最高 ¥0.60）')
  assert.equal(regenerateCostText({ kind: 'video', estimate: 0.3, max: 0.3, currency: 'CNY', known: false, allowed: false }), '重做视频预计 ¥0.30（最高 ¥0.30），部分模型没有价格，已超出花费上限')
  assert.equal(regenerateCostText(null), '')
})

test('consistencyHint：说明最差的是哪一项、对哪个实体、分数与阈值，并附重做估价', () => {
  assert.equal(consistencyHint(shot(), 60), '首帧图与「李雷」的锁定参考图相差较大（最低 35 分，阈值 60）：重做首帧图 + 视频预计 ¥0.50（最高 ¥0.60）')
  assert.equal(consistencyHint(shot({ suggestion: 'retry', regenerate: null })), '首帧图与「李雷」的锁定参考图相差较大（最低 35 分）：建议重新生成')
  const vid = shot({ suggestion: 'check', worst: 52, image: { scored: true, worst: 80 }, video: { scored: true, worst: 52 }, regenerate: { kind: 'video', estimate: 0.3, max: 0.3, currency: 'CNY' } })
  assert.equal(consistencyHint(vid, 60), '视频与「李雷」的锁定参考图有差异（最低 52 分，阈值 60）：请检查画面；重做视频预计 ¥0.30（最高 ¥0.30）')
  assert.equal(consistencyHint(shot({ suggestion: 'ok', worst: 92, entity: { type: 'scene', id: 1, name: '' }, regenerate: null })), '首帧图与锁定参考图一致（最低 92 分）')
  assert.equal(consistencyHint(null), '')
})

test('unavailableText / busyCount / shouldRefreshConsistency', () => {
  assert.equal(unavailableText({ available: false, enabled: true }), '渲染核心未启动，暂时无法评分')
  assert.equal(unavailableText({ available: false, enabled: false }), '一致性评分已在配置里关闭')
  assert.equal(unavailableText({ available: true }), '')
  assert.equal(unavailableText(null), '')
  assert.equal(busyCount({ counts: { queued: 1, running: 2, fresh: 3 } }), 3)
  assert.equal(busyCount(null), 0)
  assert.equal(shouldRefreshConsistency('running', 'fresh'), true)
  assert.equal(shouldRefreshConsistency('queued', 'running'), true)
  assert.equal(shouldRefreshConsistency('running', 'running'), false)
  assert.equal(shouldRefreshConsistency('fresh', 'stale'), false)
  assert.equal(shouldRefreshConsistency(undefined, 'fresh'), false)
})

test('autoPickSummary / rankedToCandidates', () => {
  const r = {
    anchor: { local_path: 'characters/four.png' },
    ranked: [
      { local_path: 'characters/gen.png', image_url: '/static/characters/gen.png', source_image_id: 12, source: 'generated', score: 91.6 },
      { local_path: 'characters/main.png', image_url: null, source_image_id: null, source: 'main', score: 70 },
    ],
    skipped: [{ reason: 'remote' }],
    picked: { source: 'generated', score: 91.6 },
    locked: true,
  }
  assert.equal(autoPickSummary(r), '已按清晰度、分辨率与四视图相似度排序 2 张候选，第一名：生成图（92 分），已锁定为参考图；1 张远程或缺失的图未参与')
  assert.equal(autoPickSummary({ ...r, anchor: null, locked: false, skipped: [] }), '已按清晰度、分辨率排序 2 张候选，第一名：生成图（92 分）')
  assert.equal(autoPickSummary({ ranked: [] }), '没有可排序的候选图')
  assert.equal(autoPickSummary(null), '')
  assert.deepEqual(rankedToCandidates(r), [
    { id: 12, status: 'completed', image_url: '/static/characters/gen.png', local_path: 'characters/gen.png', score: 91.6, source: 'generated', sourceLabel: '生成图' },
    { id: null, status: 'completed', image_url: null, local_path: 'characters/main.png', score: 70, source: 'main', sourceLabel: '主图' },
  ])
  assert.deepEqual(rankedToCandidates(null), [])
})

test('faceText / consistencyHint 带人脸部分：人脸 NN、未检测到人脸、参考图未检测到人脸、人脸模型未安装', () => {
  const row = (face) => ({ entity_type: 'character', entity_id: 3, parts: { phash: 50, face } })
  assert.equal(faceText(row({ ref_faces: 1, target_faces: 1, matched_frames: 1, similarity: 0.751, score: 84.4 })), '人脸 84')
  assert.equal(faceText(row({ ref_faces: 1, target_faces: 0, matched_frames: 0, similarity: null, score: 0 })), '未检测到人脸')
  assert.equal(faceText(row({ ref_faces: 1, target_faces: 2, matched_frames: 0, similarity: null, score: 0 })), '未检测到人脸')
  assert.equal(faceText(row({ ref_faces: 0, target_faces: 0, matched_frames: 0, similarity: null, score: null })), '参考图未检测到人脸')
  assert.equal(faceText(row(undefined), { face_available: false, face_reason: 'models_missing' }), '人脸模型未安装')
  assert.equal(faceText(row(undefined), { face_available: false, face_reason: 'disabled' }), '')
  assert.equal(faceText(row(undefined), { face_available: true }), '')
  assert.equal(faceText(row({ error: 'boom' }), { face_available: true }), '')
  assert.equal(faceText({ entity_type: 'scene', entity_id: 1, parts: {} }, { face_available: false }), '')
  assert.equal(faceText(null), '')
  const rows = (face) => [{ entity_type: 'character', entity_id: 3, parts: { face } }]
  const ok = shot({ suggestion: 'ok', worst: 70, image: { scored: true, best: 70, worst: 70, suggestion: 'ok', scores: rows({ ref_faces: 1, matched_frames: 1, similarity: 0.751, score: 84.4 }) }, regenerate: null })
  assert.equal(consistencyHint(ok, 60, { face_available: true }), '首帧图与「李雷」的锁定参考图一致（最低 70 分，人脸 84）')
  const none = shot({ suggestion: 'check', worst: 40, image: { scored: true, best: 40, worst: 40, suggestion: 'check', scores: rows({ ref_faces: 1, matched_frames: 0, similarity: null, score: 0 }) }, regenerate: null })
  assert.equal(consistencyHint(none, 60), '首帧图与「李雷」的锁定参考图有差异（最低 40 分，未检测到人脸，阈值 60）：请检查画面')
  const noModel = shot({ image: { scored: true, best: 90, worst: 35.4, suggestion: 'retry', scores: [{ entity_type: 'character', entity_id: 3, parts: { phash: 35 } }] } })
  assert.equal(consistencyHint(noModel, 60, { face_available: false, face_reason: 'models_missing' }), '首帧图与「李雷」的锁定参考图相差较大（最低 35 分，人脸模型未安装，阈值 60）：重做首帧图 + 视频预计 ¥0.50（最高 ¥0.60）')
  // 最差的是视频时从视频那一行取
  const vid = shot({ suggestion: 'check', worst: 52, image: { scored: true, worst: 80, scores: rows({ ref_faces: 1, matched_frames: 1, similarity: 0.9, score: 95 }) }, video: { scored: true, worst: 52, scores: rows({ ref_faces: 1, matched_frames: 2, similarity: 0.4, score: 62.3 }) }, regenerate: null })
  assert.equal(consistencyHint(vid, 60), '视频与「李雷」的锁定参考图有差异（最低 52 分，人脸 62，阈值 60）：请检查画面')
  // 没传报告、行里没有人脸部分：文案与以前完全一样
  assert.equal(consistencyHint(shot(), 60), '首帧图与「李雷」的锁定参考图相差较大（最低 35 分，阈值 60）：重做首帧图 + 视频预计 ¥0.50（最高 ¥0.60）')
})
