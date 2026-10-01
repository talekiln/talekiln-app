import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isFinal, encoderOptions, validateForm, buildStartRequest, stageLabel, progressStatus, errorText,
  formatElapsed, formatPercent, createJobPoller, FALLBACK_RESOLUTIONS,
  FALLBACK_PLATFORM_PRESETS, sizeTable, presetOf, presetHint, validateMediaForm, buildMediaRequest, mediaResultText, MEDIA_TARGETS
} from '../src/utils/exportJob.js'
import { createRequire } from 'node:module'

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

test('平台预设兜底与后端 exporters/presets.js 一致（防漂移）', () => {
  const { PLATFORM_PRESETS } = createRequire(import.meta.url)('../../../packages/local/src/export/exporters/presets.js')
  assert.deepEqual(FALLBACK_PLATFORM_PRESETS, PLATFORM_PRESETS)
})

test('预设：合并尺寸表后 buildStartRequest 取预设宽高；presetOf / presetHint', () => {
  const sizes = sizeTable(FALLBACK_RESOLUTIONS, FALLBACK_PLATFORM_PRESETS)
  assert.equal(sizes.length, 8)
  const r = buildStartRequest({ resolution: 'shipinhao-3x4', fps: 30, encoder: 'auto', output_path: 'D:\\a.mp4' }, sizes, 3)
  assert.deepEqual([r.width, r.height], [1080, 1440])
  assert.equal(presetOf(FALLBACK_PLATFORM_PRESETS, '1080p'), null)
  assert.match(presetHint(presetOf(FALLBACK_PLATFORM_PRESETS, 'douyin-9x16')), /8000 kbps/)
  assert.equal(presetHint(null), '')
})

test('validateMediaForm：文件夹必填且为绝对路径（含中文空格可通过）', () => {
  const ok = { resolution: '1080p', media_dir: 'D:\\导出 文件夹' }
  assert.equal(validateMediaForm(ok), '')
  assert.equal(validateMediaForm({ ...ok, media_dir: '/Users/张三/导出 一' }), '')
  assert.match(validateMediaForm({ ...ok, media_dir: '' }), /文件夹/)
  assert.match(validateMediaForm({ ...ok, media_dir: 'out' }), /绝对路径/)
  assert.match(validateMediaForm({ ...ok, resolution: '' }), /尺寸/)
})

test('buildMediaRequest：剪映走 jianying；Premiere 与 FCPXML 走 fcpxml 并带 format', () => {
  const sizes = sizeTable(FALLBACK_RESOLUTIONS, FALLBACK_PLATFORM_PRESETS)
  const form = { resolution: 'douyin-9x16', fps: '30', media_dir: ' D:\\导出 ', media_name: ' 第一集 ' }
  const j = buildMediaRequest(form, sizes, '5', 'jianying')
  assert.equal(j.kind, 'jianying')
  assert.deepEqual(j.body, { episode_id: 5, output_dir: 'D:\\导出', width: 1080, height: 1920, fps: 30, name: '第一集' })
  const p = buildMediaRequest({ ...form, media_name: '' }, sizes, 5, 'xmeml', { dry_run: true })
  assert.equal(p.kind, 'fcpxml')
  assert.equal(p.body.format, 'xmeml')
  assert.equal(p.body.dry_run, true)
  assert.equal('name' in p.body, false)
  assert.equal(buildMediaRequest(form, sizes, 5, 'fcpxml').body.format, 'fcpxml')
  assert.deepEqual(MEDIA_TARGETS.map((t) => t.value), ['jianying', 'xmeml', 'fcpxml'])
})

test('mediaResultText', () => {
  assert.equal(mediaResultText(null), '')
  assert.equal(mediaResultText({ written: true, output_dir: 'D:\\x', stats: { video_segments: 4, subtitle_segments: 6 } }), '已导出：D:\\x · 视频 4 段 · 字幕 6 条')
  assert.match(mediaResultText({ written: false, output_dir: 'x', stats: { video_clips: 2, subtitle_cues: 1 } }), /未写文件.*视频 2 段 · 字幕 1 条/)
})
