import test from 'node:test'
import assert from 'node:assert/strict'
import { LIBRARY_KINDS, itemName, itemDescription, itemImage, editForm, updateBody, imagePrompt } from '../src/components/home/libraryKinds.js'

test('three kinds with their own fields', () => {
  assert.deepEqual(Object.keys(LIBRARY_KINDS), ['character', 'scene', 'prop'])
  assert.deepEqual(LIBRARY_KINDS.scene.fields, ['location', 'time', 'category', 'description', 'tags'])
  assert.deepEqual(LIBRARY_KINDS.character.fields, ['name', 'category', 'description', 'tags'])
})

test('itemName falls back per kind and is empty when nothing is set', () => {
  assert.equal(itemName('character', { name: 'Lin' }), 'Lin')
  assert.equal(itemName('scene', { location: 'Roof', time: 'night' }), 'Roof')
  assert.equal(itemName('scene', { time: 'night' }), 'night')
  assert.equal(itemName('prop', {}), '')
})

test('itemDescription uses description then prompt and trims to the limit', () => {
  assert.equal(itemDescription({ description: 'a', prompt: 'b' }), 'a')
  assert.equal(itemDescription({ prompt: 'b' }), 'b')
  assert.equal(itemDescription({ description: 'x'.repeat(70) }, 60), 'x'.repeat(60) + '…')
  assert.equal(itemDescription({}), '')
})

test('itemImage prefers local_path under /static', () => {
  assert.equal(itemImage({ local_path: '/images/a.png', image_url: 'http://x/y.png' }), '/static/images/a.png')
  assert.equal(itemImage({ image_url: 'http://x/y.png' }), 'http://x/y.png')
  assert.equal(itemImage({ local_path: '  ' }), '')
  assert.equal(itemImage(null), '')
})

test('editForm copies only the kind fields and updateBody nulls empty optionals', () => {
  const f = editForm('scene', { id: 3, location: 'Roof', time: '', category: null, description: 'd', tags: 't', image_url: 'u', local_path: 'p', extra: 1 })
  assert.deepEqual(f, { id: 3, location: 'Roof', time: '', category: '', description: 'd', tags: 't', image_url: 'u', local_path: 'p' })
  assert.deepEqual(updateBody('scene', f), { location: 'Roof', time: null, category: null, description: 'd', tags: 't', image_url: 'u', local_path: 'p' })
  const c = editForm('character', { id: 1, name: 'Lin' })
  assert.deepEqual(updateBody('character', c), { name: 'Lin', category: null, description: null, tags: null, image_url: null, local_path: null })
})

test('imagePrompt joins the descriptive fields', () => {
  assert.equal(imagePrompt('character', { name: 'Lin', description: 'tall' }), 'Lin, tall')
  assert.equal(imagePrompt('scene', { location: 'Roof', time: 'night', description: '' }), 'Roof, night')
  assert.equal(imagePrompt('prop', { name: '', description: '' }), '')
})
