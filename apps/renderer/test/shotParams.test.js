import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LIGHTING, DEPTH_OF_FIELD, SHOT_TYPES, MOVEMENT_GROUPS, ANGLE_SIZE, ANGLE_PITCH, ANGLE_YAW,
  optionKey, isKnownOption, validateShotParams, countDialogueLines, canSplitByAudio, DURATION_RANGE,
  anglePromptKey, VIDEO_PROMPT_TEMPLATES, applyTemplate,
} from '../src/components/shot/shotParams.js'

test('option tables have the required sizes and unique values', () => {
  assert.equal(LIGHTING.length, 12)
  assert.equal(DEPTH_OF_FIELD.length, 4)
  assert.equal(SHOT_TYPES.length, 5)
  assert.equal(ANGLE_SIZE.length, 3)
  assert.equal(ANGLE_PITCH.length, 4)
  assert.equal(ANGLE_YAW.length, 8)
  const mv = MOVEMENT_GROUPS.flatMap((g) => g.options)
  assert.equal(mv.length, 19)
  for (const list of [LIGHTING, DEPTH_OF_FIELD, SHOT_TYPES, ANGLE_SIZE, ANGLE_PITCH, ANGLE_YAW, mv]) {
    assert.equal(new Set(list.map((o) => o.value)).size, list.length)
  }
})

test('every option has an i18n key under the storyboard namespace', () => {
  assert.equal(optionKey('lighting', 'backlit'), 'storyboard.opt.lighting.backlit')
  assert.equal(optionKey('dof', 'deep'), 'storyboard.opt.dof.deep')
  for (const o of LIGHTING) assert.ok(o.key.startsWith('storyboard.opt.lighting.'))
  for (const g of MOVEMENT_GROUPS) assert.ok(g.key.startsWith('storyboard.opt.movementGroup.'))
})

test('isKnownOption accepts empty and listed values only', () => {
  assert.equal(isKnownOption('lighting', ''), true)
  assert.equal(isKnownOption('lighting', 'neon'), true)
  assert.equal(isKnownOption('lighting', 'disco'), false)
  assert.equal(isKnownOption('movement', 'orbit'), true)
  assert.equal(isKnownOption('angle_v', 'worm'), true)
  assert.equal(isKnownOption('bogus', 'x'), false)
})

test('validateShotParams reports field errors by key', () => {
  assert.deepEqual(validateShotParams({ lighting_style: 'natural', duration: 5 }), { ok: true, errors: {} })
  const bad = validateShotParams({ lighting_style: 'disco', depth_of_field: 'x', duration: 0 })
  assert.equal(bad.ok, false)
  assert.equal(bad.errors.lighting_style, 'storyboard.err.badOption')
  assert.equal(bad.errors.depth_of_field, 'storyboard.err.badOption')
  assert.equal(bad.errors.duration, 'storyboard.err.duration')
  assert.equal(validateShotParams({ duration: DURATION_RANGE.max + 1 }).errors.duration, 'storyboard.err.duration')
  assert.equal(validateShotParams({ duration: 2.5 }).ok, true)
  assert.equal(validateShotParams({ duration: 'abc' }).errors.duration, 'storyboard.err.duration')
  assert.equal(validateShotParams({ layout_description: 'x'.repeat(2001) }).errors.layout_description, 'storyboard.err.tooLong')
})

test('countDialogueLines counts speaker prefixes, falls back to 1', () => {
  assert.equal(countDialogueLines(''), 0)
  assert.equal(countDialogueLines(null), 0)
  assert.equal(countDialogueLines('hello there'), 1)
  assert.equal(countDialogueLines('Ann: hi\nBob: yo'), 2)
  assert.equal(countDialogueLines('林夏：你好\n陈默：嗯'), 2)
})

test('canSplitByAudio needs two or more spoken parts', () => {
  assert.equal(canSplitByAudio({ dialogue: 'Ann: hi', narration: '' }), false)
  assert.equal(canSplitByAudio({ dialogue: 'Ann: hi\nBob: yo', narration: '' }), true)
  assert.equal(canSplitByAudio({ dialogue: 'Ann: hi', narration: 'It rained.' }), true)
  assert.equal(canSplitByAudio({ dialogue: '', narration: 'It rained.' }), false)
})

test('anglePromptKey needs all three angle parts', () => {
  assert.equal(anglePromptKey({ s: 'close_up', v: 'low' }), null)
  assert.deepEqual(anglePromptKey({ s: 'close_up', v: 'low', h: 'front' }), {
    size: 'storyboard.opt.angle_s.close_up', pitch: 'storyboard.opt.angle_v.low', yaw: 'storyboard.opt.angle_h.front',
  })
})

test('video prompt templates append without duplicating', () => {
  assert.ok(VIDEO_PROMPT_TEMPLATES.length >= 4)
  const tpl = VIDEO_PROMPT_TEMPLATES[0]
  assert.ok(tpl.key.startsWith('storyboard.tpl.') && tpl.text)
  assert.equal(applyTemplate('', tpl), tpl.text)
  const once = applyTemplate('a girl walks', tpl)
  assert.ok(once.startsWith('a girl walks') && once.endsWith(tpl.text))
  assert.equal(applyTemplate(once, tpl), once)
})
