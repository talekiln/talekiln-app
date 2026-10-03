import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../src/i18n/index.js'
import { applyOptions, dirOfPath, draftHint } from '../src/components/export/exportDialogModel.js'

const OPTS = {
  resolutions: [{ key: '720p', label: 'x', width: 1280, height: 720 }],
  platform_presets: [{ key: 'douyin-9x16', fps: 30, bitrate_kbps: 8000, width: 1080, height: 1920 }],
  fps_options: [30, 60],
  default_resolution: '720p',
  default_fps: 60,
  output_path: 'D:\\out\\ep1.mp4',
  aigc: { watermark: false, metadata: true, producer: 'Me' },
  encoders: [{ name: 'libx264', available: true }, { name: 'h264_nvenc', available: false, reason: 'no gpu' }],
  best_encoder: 'libx264',
}

test('applyOptions: first load takes defaults, path and AIGC settings from the server', () => {
  const r = applyOptions(OPTS)
  assert.equal(r.resolution, '720p')
  assert.equal(r.fps, 60)
  assert.equal(r.outputPath, 'D:\\out\\ep1.mp4')
  assert.deepEqual(r.aigc, OPTS.aigc)
  assert.deepEqual(r.fpsOptions, [30, 60])
  assert.equal(r.encoders[0].value, 'auto')
  assert.equal(r.encoders.find((e) => e.value === 'h264_nvenc').disabled, true)
})

test('applyOptions: missing lists fall back to the built-in tables', () => {
  const r = applyOptions({})
  assert.ok(r.resolutions.length >= 4)
  assert.ok(r.presets.length >= 4)
  assert.deepEqual(r.fpsOptions, [24, 25, 30, 60])
  assert.equal(r.resolution, '1080p')
  assert.equal(r.encoders[0].disabled, true)
})

test('applyOptions: a re-detect keeps the user choices and only resets an encoder that vanished', () => {
  const kept = applyOptions(OPTS, { encoder: 'libx264', resolution: '720p' }, { refresh: true })
  assert.equal(kept.resolution, undefined)
  assert.equal(kept.outputPath, undefined)
  assert.equal(kept.encoder, undefined)
  const reset = applyOptions(OPTS, { encoder: 'h264_nvenc' }, { refresh: true })
  assert.equal(reset.encoder, 'auto')
})

test('dirOfPath: windows and posix paths; drive roots keep their slash; bare names give nothing', () => {
  assert.equal(dirOfPath('D:\\out\\ep1.mp4'), 'D:\\out')
  assert.equal(dirOfPath('/home/me/ep1.mp4'), '/home/me')
  assert.equal(dirOfPath('D:\\ep1.mp4'), 'D:\\')
  assert.equal(dirOfPath('ep1.mp4'), '')
  assert.equal(dirOfPath(''), '')
})

test('draftHint: only shows when drafts exist', () => {
  setLocale('en')
  assert.equal(draftHint(0), '')
  assert.equal(draftHint(undefined), '')
  assert.match(draftHint(3), /3/)
})
