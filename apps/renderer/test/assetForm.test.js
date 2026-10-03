import test from 'node:test'
import assert from 'node:assert/strict'
import { createParts, emptyForm, formFromAsset, updatePatch, validateForm } from '../src/utils/assetForm.js'

test('emptyForm has the editable fields for each kind plus ref_image', () => {
  assert.deepEqual(Object.keys(emptyForm('characters')), ['name', 'role', 'appearance', 'personality', 'description', 'polished_prompt', 'stages', 'ref_image'])
  assert.deepEqual(Object.keys(emptyForm('scenes')), ['location', 'time', 'prompt', 'polished_prompt', 'polished_prompt_single', 'ref_image'])
  assert.deepEqual(Object.keys(emptyForm('props')), ['name', 'type', 'description', 'prompt', 'ref_image'])
})

test('formFromAsset copies values and turns null into empty strings', () => {
  const f = formFromAsset('characters', { name: '林夏', role: null, appearance: '短发', ref_image: 'a.png', identity_anchors: 'x' })
  assert.equal(f.name, '林夏')
  assert.equal(f.role, '')
  assert.equal(f.ref_image, 'a.png')
  assert.equal('identity_anchors' in f, false)
})

test('validateForm: name / location required, stages must be JSON', () => {
  assert.equal(validateForm('characters', { name: '  ' }), 'assets.form.nameRequired')
  assert.equal(validateForm('props', { name: '' }), 'assets.form.nameRequired')
  assert.equal(validateForm('scenes', { location: '', time: '夜' }), 'assets.form.locationRequired')
  assert.equal(validateForm('scenes', { location: '天台' }), null)
  assert.equal(validateForm('characters', { name: 'a', stages: '{bad' }), 'assets.form.stagesInvalid')
  assert.equal(validateForm('characters', { name: 'a', stages: '[{"label":"young"}]' }), null)
  assert.equal(validateForm('characters', { name: 'a', stages: '' }), null)
})

test('createParts splits the create body from the follow-up patch and drops empties', () => {
  const f = { ...emptyForm('characters'), name: ' 林夏 ', role: 'main', appearance: '短发', polished_prompt: 'p', stages: '[]', ref_image: 'r.png' }
  const { body, after } = createParts('characters', f)
  assert.deepEqual(body, { name: '林夏', role: 'main', appearance: '短发' })
  assert.deepEqual(after, { polished_prompt: 'p', stages: '[]', ref_image: 'r.png' })
  const s = createParts('scenes', { ...emptyForm('scenes'), location: '天台', time: '夜' })
  assert.deepEqual(s, { body: { location: '天台', time: '夜' }, after: {} })
})

test('updatePatch only contains changed fields; text can be cleared, role / stages cannot', () => {
  const item = { id: 1, name: '林夏', role: 'main', appearance: '短发', stages: '[]', ref_image: 'r.png' }
  const f = formFromAsset('characters', item)
  assert.deepEqual(updatePatch('characters', f, item), {})
  f.name = '林夏 ' // trailing space only: no change
  f.appearance = ''
  f.role = ''
  f.stages = ''
  assert.deepEqual(updatePatch('characters', f, item), { appearance: '' })
  f.personality = '冷静'
  f.ref_image = ''
  assert.deepEqual(updatePatch('characters', f, item), { appearance: '', personality: '冷静', ref_image: null })
})
