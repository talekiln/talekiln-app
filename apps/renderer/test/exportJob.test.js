import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isFinal, encoderOptions, validateForm, buildStartRequest, stageLabel, progressStatus, errorText,
  formatElapsed, formatPercent, createJobPoller, FALLBACK_RESOLUTIONS
} from '../src/utils/exportJob.js'

const ENCODERS = [
  { name: 'h264_nvenc', listed: true, available: false, reason: 'Cannot load libcuda' },
  { name: 'libx264', listed: true, available: true },
  { name: 'h264_amf', listed: false, available: false },
]

test('encoderOptions: auto first, unavailable disabled with reason, unlisted hidden', () => {
  const o = encoderOptions(ENCODERS, 'libx264')
  assert.deepEqual(o.map((x) => x.value), ['auto', 'h264_nvenc', 'libx264'])
  assert.match(o[0].label, /推荐/)
  assert.equal(o[1].disabled, true)
  assert.equal(o[1].reason, 'Cannot load libcuda')
  assert.equal(o[2].disabled, false)
  assert.equal(encoderOptions([], null)[0].disabled, true)
})

test('validateForm', () => {
  const ok = { resolution: '1080p', fps: 30, output_path: 'D:\\out\\a.mp4' }
  assert.equal(validateForm(ok), '')
  assert.equal(validateForm({ ...ok, output_path: '/home/u/a.MP4' }), '')
  assert.match(validateForm({ ...ok, output_path: '' }), /导出位置/)
  assert.match(validateForm({ ...ok, output_path: 'out/a.mp4' }), /绝对路径/)
  assert.match(validateForm({ ...ok, output_path: 'D:\\a.mov' }), /\.mp4/)
  assert.match(validateForm({ ...ok, resolution: '' }), /分辨率/)
  assert.match(validateForm({ ...ok, fps: 0 }), /帧率/)
})

test('buildStartRequest maps the preset to even width/height', () => {
  const r = buildStartRequest({ resolution: '1080p-v', fps: '24', encoder: '', output_path: ' D:\\a.mp4 ' }, FALLBACK_RESOLUTIONS, '7')
  assert.deepEqual(r, { episode_id: 7, width: 1080, height: 1920, fps: 24, encoder: 'auto', output_path: 'D:\\a.mp4' })
})

test('stage / progress / error text', () => {
  assert.equal(stageLabel('running', 'segment 2/5'), '渲染分镜 2/5')
  assert.equal(stageLabel('running', 'final'), '合成音视频')
  assert.equal(stageLabel('running', 'AI 内容标识'), 'AI 内容标识')
  assert.equal(stageLabel('queued', 'queued'), '排队中')
  assert.equal(stageLabel('done', 'done'), '已完成')
  assert.equal(progressStatus('done'), 'success')
  assert.equal(progressStatus('failed'), 'exception')
  assert.equal(progressStatus('running'), undefined)
  assert.match(errorText({ code: -32031 }), /素材/)
  assert.equal(errorText({ code: 'AIGC_METADATA_FAILED', message: '写入 AI 内容标识失败：x' }), '写入 AI 内容标识失败：x')
  assert.equal(errorText(null), '导出失败')
  assert.equal(formatElapsed(65000), '1 分 05 秒')
  assert.equal(formatPercent(42.54), 42.5)
  assert.equal(formatPercent(150), 100)
  assert.equal(formatPercent(undefined), 0)
  assert.equal(isFinal('cancelled'), true)
  assert.equal(isFinal('running'), false)
})

/** Manual timers: run() fires the pending callback. */
function manualTimers() {
  const q = []
  return {
    setTimer: (fn) => { q.push(fn); return q.length },
    clearTimer: () => { q.length = 0 },
    pending: () => q.length,
    async run() { const fn = q.shift(); await fn() },
  }
}

test('poller polls until a final status, then stops', async () => {
  const seq = [{ status: 'queued', percent: 0 }, { status: 'running', percent: 50 }, { status: 'done', percent: 100 }]
  const calls = []
  const updates = []
  const t = manualTimers()
  const p = createJobPoller({ getStatus: async (id) => { calls.push(id); return seq.shift() }, onUpdate: (s) => updates.push(s.status), onError() { throw new Error('no') }, ...t })
  await p.start('job-1')
  assert.equal(p.active, true)
  await t.run()
  await t.run()
  assert.deepEqual(updates, ['queued', 'running', 'done'])
  assert.equal(p.active, false)
  assert.equal(t.pending(), 0)
  assert.deepEqual(calls, ['job-1', 'job-1', 'job-1'])
})

test('poller tolerates transient errors and gives up after maxErrors', async () => {
  let n = 0
  const updates = []
  const errors = []
  const t = manualTimers()
  const p = createJobPoller({
    getStatus: async () => { n++; if (n === 1 || n === 3 || n === 4 || n === 5) throw new Error('boom ' + n); return { status: 'running', percent: 1 } },
    onUpdate: (s) => updates.push(s), onError: (e) => errors.push(e.message), maxErrors: 3, ...t,
  })
  await p.start('j')       // 1: error (1 in a row)
  await t.run()            // 2: ok -> reset
  await t.run()            // 3: error
  await t.run()            // 4: error
  await t.run()            // 5: error -> 3 in a row, give up
  assert.equal(updates.length, 1)
  assert.deepEqual(errors, ['boom 5'])
  assert.equal(p.active, false)
})

test('poller stop() cancels the pending tick and ignores late responses', async () => {
  let release
  const t = manualTimers()
  const updates = []
  const p = createJobPoller({ getStatus: () => new Promise((r) => { release = r }), onUpdate: (s) => updates.push(s), onError() {}, ...t })
  const first = p.start('j')
  p.stop()
  release({ status: 'running' })
  await first
  assert.equal(updates.length, 0)
  assert.equal(t.pending(), 0)
  assert.equal(p.active, false)
})

test('restarting the poller drops the old job', async () => {
  const t = manualTimers()
  const seen = []
  const p = createJobPoller({ getStatus: async (id) => ({ status: 'running', id }), onUpdate: (s) => seen.push(s.id), onError() {}, ...t })
  await p.start('a')
  await p.start('b')
  assert.equal(t.pending(), 1)
  await t.run()
  assert.deepEqual(seen, ['a', 'b', 'b'])
})

test('libopenh264（LGPL 构建的软件编码）有中文标签，并可作为推荐项', () => {
  const o = encoderOptions([{ name: 'libopenh264', listed: true, available: true }], 'libopenh264')
  assert.equal(o[0].label, '自动（推荐：软件编码 (libopenh264)）')
  assert.equal(o[1].label, '软件编码 (libopenh264)')
})
