import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MIX, mergeMix, toPercent, fromPercent, formatDuration, formatSize, shortTrackHint, checkMusicFile
} from '../src/utils/mixView.js'

test('mergeMix fills defaults and merges patches', () => {
  assert.deepEqual(mergeMix(undefined), DEFAULT_MIX)
  assert.deepEqual(mergeMix(null, { ducking: { gain: 0.1 } }), { ducking: { enabled: true, gain: 0.1, rampMs: 200 }, loudnorm: true })
  const base = { ducking: { enabled: false, gain: 0.5, rampMs: 300 }, loudnorm: false }
  assert.deepEqual(mergeMix(base, { loudnorm: true }), { ducking: { enabled: false, gain: 0.5, rampMs: 300 }, loudnorm: true })
  assert.deepEqual(mergeMix(base, { ducking: { enabled: true } }).ducking, { enabled: true, gain: 0.5, rampMs: 300 })
})

test('mergeMix clamps out-of-range and rejects junk', () => {
  assert.equal(mergeMix(null, { ducking: { gain: 7 } }).ducking.gain, 1)
  assert.equal(mergeMix(null, { ducking: { gain: -1 } }).ducking.gain, 0)
  assert.equal(mergeMix(null, { ducking: { rampMs: 99999 } }).ducking.rampMs, 5000)
  assert.equal(mergeMix(null, { ducking: { rampMs: 10.6 } }).ducking.rampMs, 11)
  assert.equal(mergeMix(null, { ducking: { gain: 'abc' } }).ducking.gain, DEFAULT_MIX.ducking.gain)
  assert.equal(mergeMix(null, { ducking: { enabled: 'yes' } }).ducking.enabled, true)
  assert.equal(mergeMix(null, { loudnorm: 'x' }).loudnorm, true)
})

test('percent conversion', () => {
  assert.equal(toPercent(0.25), 25)
  assert.equal(toPercent(undefined), 0)
  assert.equal(fromPercent(150), 1.5)
  assert.equal(fromPercent(900), 4)
  assert.equal(fromPercent(-5), 0)
})

test('format helpers', () => {
  assert.equal(formatDuration(30000), '0:30')
  assert.equal(formatDuration(125400), '2:05')
  assert.equal(formatSize(500), '1 KB')
  assert.equal(formatSize(2.5 * 1024 * 1024), '2.5 MB')
})

test('shortTrackHint only warns for short non-looped tracks', () => {
  assert.match(shortTrackHint(30000, 70000, false), /短于视频/)
  assert.equal(shortTrackHint(30000, 70000, true), '')
  assert.equal(shortTrackHint(90000, 70000, false), '')
  assert.equal(shortTrackHint(30000, 0, false), '')
})

test('checkMusicFile mirrors the server whitelist', () => {
  assert.equal(checkMusicFile({ name: 'a.MP3', size: 10 }), '')
  assert.match(checkMusicFile({ name: 'a.exe', size: 10 }), /只支持/)
  assert.match(checkMusicFile({ name: 'a.wav', size: 51 * 1024 * 1024 }), /50MB/)
  assert.match(checkMusicFile({ name: 'a.wav', size: 0 }), /为空/)
})
