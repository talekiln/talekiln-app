import test from 'node:test'
import assert from 'node:assert/strict'
import { undoRedoIntent } from '../src/shell/shortcuts.js'
import { pickProjectCost, formatSpend } from '../src/shell/spend.js'

const ev = (o) => ({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: { tagName: 'DIV' }, ...o })

test('Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y map to undo / redo', () => {
  assert.equal(undoRedoIntent(ev({}), 'script'), 'undo')
  assert.equal(undoRedoIntent(ev({ key: 'Z', shiftKey: true }), 'canvas'), 'redo')
  assert.equal(undoRedoIntent(ev({ key: 'y' }), 'storyboard'), 'redo')
  assert.equal(undoRedoIntent(ev({ key: 'z', ctrlKey: false, metaKey: true }), 'script'), 'undo')
})

test('shortcuts are ignored in inputs, editable text, the timeline view and with Alt', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(undoRedoIntent(ev({ target: { tagName } }), 'script'), null)
  }
  assert.equal(undoRedoIntent(ev({ target: { tagName: 'DIV', isContentEditable: true } }), 'script'), null)
  assert.equal(undoRedoIntent(ev({}), 'timeline'), null)
  assert.equal(undoRedoIntent(ev({ altKey: true }), 'script'), null)
  assert.equal(undoRedoIntent(ev({ key: 'a' }), 'script'), null)
  assert.equal(undoRedoIntent(ev({ ctrlKey: false }), 'script'), null)
})

test('pickProjectCost finds the project row; missing data -> null', () => {
  const s = { total: { cost: 30 }, by_project: [{ project_id: 1, cost: 12.4 }, { project_id: 2, cost: 1 }], currency: 'CNY' }
  assert.equal(pickProjectCost(s, 1), 12.4)
  assert.equal(pickProjectCost(s, '2'), 1)
  assert.equal(pickProjectCost(s, 9), null)
  assert.equal(pickProjectCost(null, 1), null)
  assert.equal(pickProjectCost({ by_project: [{ project_id: 1, cost: 'x' }] }, 1), null)
})

test('formatSpend', () => {
  assert.equal(formatSpend(12.4, 'CNY'), '¥12.40')
  assert.equal(formatSpend(0, 'CNY'), '¥0.00')
  assert.equal(formatSpend(3, 'USD'), '$3.00')
  assert.equal(formatSpend(null, 'CNY'), '')
  assert.equal(formatSpend(2, undefined), '¥2.00')
})
