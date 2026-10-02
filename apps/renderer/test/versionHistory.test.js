import test from 'node:test'
import assert from 'node:assert/strict'

import {
  txLabel, sourceLabel, formatTime, shotNumberMap, nodeLabel, describeVersion, adoptOps, thumbUrl, describeEntry, jumpPlan,
} from '../src/utils/versionHistory.js'
import { episodeOfRoute } from '../src/utils/episodeContext.js'

test('txLabel / sourceLabel map known names and keep unknown ones readable', () => {
  assert.equal(txLabel('rewriteLine'), '改写台词')
  assert.equal(txLabel('recordGeneration'), '记录生成结果')
  assert.equal(txLabel('somethingNew'), 'somethingNew')
  assert.equal(txLabel(''), '修改')
  assert.equal(sourceLabel('ai-task:12'), 'AI 生成')
  assert.equal(sourceLabel('legacy-import'), '导入')
  assert.equal(sourceLabel('rebase'), '改记（沿用旧素材）')
  assert.equal(sourceLabel(null), '未知来源')
})

test('formatTime: local MM-DD HH:mm; invalid -> empty', () => {
  const d = new Date(2026, 4, 3, 9, 5)
  assert.equal(formatTime(d.toISOString()), '05-03 09:05')
  assert.equal(formatTime('nope'), '')
  assert.equal(formatTime(null), '')
})

test('nodeLabel uses the shot number from the shots view', () => {
  const nums = shotNumberMap({ groups: [{ shots: [{ id: 'a' }, { id: 'b' }] }, { shots: [{ id: 'c' }] }] })
  assert.deepEqual(nums, { a: 1, b: 2, c: 3 })
  assert.equal(nodeLabel({ type: 'image', shot_id: 'c' }, nums), '镜头 3 · 首帧图')
  assert.equal(nodeLabel({ type: 'video', shot_id: 'zz' }, nums), '镜头 · 视频')
  assert.equal(nodeLabel({ type: 'compose', shot_id: null }, nums), '合成')
})

test('describeVersion: adoption, input match, source, time and metadata line', () => {
  const info = { type: 'video', node: 'n1' }
  const v = describeVersion(info, {
    id: 't_9', adopted: false, current: false, source: 'ai-task:9', created_at: new Date(2026, 0, 2, 3, 4).toISOString(),
    asset: { ref: 'videos/a.mp4', kind: 'video', hash: 'abcdef012345' }, metadata: { model: 'seedance', duration_ms: 5200, voice: 'v1' },
  })
  assert.equal(v.id, 't_9')
  assert.equal(v.canAdopt, true)
  assert.equal(v.freshIfAdopted, false)
  assert.equal(v.source, 'AI 生成')
  assert.equal(v.time, '01-02 03:04')
  assert.equal(v.meta, '模型 seedance · 音色 v1 · 5.2 秒')
  assert.equal(v.kind, 'video')
  const adopted = describeVersion(info, { id: 'x', adopted: true, current: true, source: null, created_at: null, asset: null, metadata: null })
  assert.equal(adopted.canAdopt, false)
  assert.equal(adopted.time, '')
  assert.equal(adopted.meta, '')
  assert.equal(adopted.ref, null)
})

test('adoptOps is the kernel adoptVersion op (the only write path of the version list)', () => {
  assert.deepEqual(adoptOps('n1', 'v2'), [{ op: 'adoptVersion', node: 'n1', version_id: 'v2' }])
})

test('thumbUrl: only image assets; relative refs go through /static, absolute urls pass', () => {
  assert.equal(thumbUrl('images/a.png', 'image'), '/static/images/a.png')
  assert.equal(thumbUrl('/images/a.png', 'image'), '/static/images/a.png')
  assert.equal(thumbUrl('https://x/y.png', 'image'), 'https://x/y.png')
  assert.equal(thumbUrl('videos/a.mp4', 'video'), '')
  assert.equal(thumbUrl(null, 'image'), '')
})

test('jumpPlan: applied -> undo N, undone -> redo N, nothing for head / discarded / events', () => {
  assert.deepEqual(jumpPlan({ state: 'applied', undo_steps: 2 }), { type: 'undo', steps: 2, label: '回到此步（撤销 2 步）' })
  assert.equal(jumpPlan({ state: 'applied', undo_steps: 0 }), null)
  assert.deepEqual(jumpPlan({ state: 'undone', redo_steps: 3 }), { type: 'redo', steps: 3, label: '恢复到此步（重做 3 步）' })
  assert.equal(jumpPlan({ state: 'discarded' }), null)
  assert.equal(jumpPlan({ state: 'event' }), null)
})

test('describeEntry: label, op summary, state text, jump; undo/redo records are events without jump', () => {
  const e = describeEntry({
    seq: 7, tx_id: 't', kind: 'apply', label: 'setShotField', created_at: new Date(2026, 5, 1, 8, 0).toISOString(),
    op_kinds: { setParam: 2, addVersion: 1 }, state: 'applied', undo_steps: 1,
  })
  assert.equal(e.title, '修改镜头')
  assert.equal(e.detail, '改参数 ×2、新增版本')
  assert.equal(e.stateText, '已生效')
  assert.equal(e.jump.type, 'undo')
  assert.equal(e.time, '06-01 08:00')
  const u = describeEntry({ seq: 8, tx_id: 'u', kind: 'undo', target: 't', created_at: null, state: 'event' })
  assert.equal(u.title, '撤销')
  assert.equal(u.jump, null)
  assert.equal(describeEntry({ seq: 9, tx_id: 'r', kind: 'redo', target: 't', state: 'event' }).title, '重做')
  assert.equal(describeEntry({ seq: 1, tx_id: 'd', kind: 'apply', label: 'x', state: 'discarded' }).stateText, '已被覆盖')
})

test('episodeOfRoute: episode routes use the param, storyboard uses query then loaded store, others none', () => {
  assert.equal(episodeOfRoute({ name: 'episode-canvas', params: { id: '12' }, query: {} }), 12)
  assert.equal(episodeOfRoute({ name: 'episode-export', params: { id: '3' }, query: {} }), 3)
  assert.equal(episodeOfRoute({ name: 'episode-script', params: { id: 'x' }, query: {} }), null)
  assert.equal(episodeOfRoute({ name: 'storyboard', params: {}, query: { episode: '8' } }, 99), 8)
  assert.equal(episodeOfRoute({ name: 'storyboard', params: {}, query: {} }, 99), 99)
  assert.equal(episodeOfRoute({ name: 'storyboard', params: {}, query: {} }, null), null)
  assert.equal(episodeOfRoute({ name: 'list', params: {}, query: {} }, 5), null)
  assert.equal(episodeOfRoute(null), null)
})
