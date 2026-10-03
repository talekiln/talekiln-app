import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStoryboardOptions, parseMeta, storyboardToggles, togglePatch } from '../src/components/shot/storyboardOptions.js'

test('parseMeta accepts objects and JSON strings, falls back to {}', () => {
  assert.deepEqual(parseMeta({ a: 1 }), { a: 1 })
  assert.deepEqual(parseMeta('{"a":2}'), { a: 2 })
  assert.deepEqual(parseMeta('nope'), {})
  assert.deepEqual(parseMeta('[1]'), {})
  assert.deepEqual(parseMeta(null), {})
})

test('storyboardToggles reads the three flags', () => {
  assert.deepEqual(storyboardToggles({ metadata: '{"storyboard_universal_omni":true}' }), { useFirstLast: false, universal: true, narration: false })
  assert.deepEqual(storyboardToggles(null), { useFirstLast: false, universal: false, narration: false })
})

test('togglePatch builds a metadata-only body and rejects unknown names', () => {
  assert.deepEqual(togglePatch('useFirstLast', 1), { metadata: { storyboard_use_first_last_frame: true } })
  assert.throws(() => togglePatch('x', true))
})

test('buildStoryboardOptions: defaults, explicit clip duration, estimated duration from the script', () => {
  const base = buildStoryboardOptions({ style: 'ink', metadata: {} })
  assert.equal(base.style, 'ink')
  assert.equal(base.aspect_ratio, '16:9')
  assert.equal(base.video_duration, undefined)
  assert.equal(base.include_narration, false)
  assert.equal(buildStoryboardOptions({ metadata: { video_clip_duration: '45' } }).video_duration, 45)
  assert.equal(buildStoryboardOptions({ metadata: {} }, 1200).video_duration, 130)
  assert.equal(buildStoryboardOptions({ metadata: {} }, 10).video_duration, 11)
  const o = buildStoryboardOptions({ metadata: { style_prompt_en: 'noir', aspect_ratio: '9:16', storyboard_universal_omni: true, storyboard_include_narration: true } })
  assert.equal(o.style, 'noir')
  assert.equal(o.aspect_ratio, '9:16')
  assert.equal(o.universal_omni_storyboard, true)
  assert.equal(o.include_narration, true)
})
