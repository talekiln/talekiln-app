import test from 'node:test'
import assert from 'node:assert/strict'
import { eventToCombo, formatComboFor, formatCombo, isMacPlatform, normalizeCombo } from '../src/utils/keymap.js'

const ev = (o) => ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o })

test('⌘ (metaKey) and Ctrl map to the same combo, so one keymap serves both systems', () => {
  assert.equal(eventToCombo(ev({ key: 'k', code: 'KeyK', metaKey: true })), 'Ctrl+K')
  assert.equal(eventToCombo(ev({ key: 'k', code: 'KeyK', ctrlKey: true })), 'Ctrl+K')
  assert.equal(eventToCombo(ev({ key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true })), 'Ctrl+Shift+Z')
  // user-typed Cmd/Command in a saved keymap normalises to Ctrl
  assert.equal(normalizeCombo('Cmd+K'), 'Ctrl+K')
  assert.equal(normalizeCombo('Command+Shift+Z'), 'Ctrl+Shift+Z')
})

test('Option+digit on macOS yields a symbol in e.key but the physical code wins', () => {
  assert.equal(eventToCombo(ev({ key: '¡', code: 'Digit1', altKey: true })), 'Alt+1')
  assert.equal(eventToCombo(ev({ key: 'å', code: 'KeyA', altKey: true })), 'Alt+A')
})

test('display: Ctrl+K on Windows/Linux, ⌘K on macOS', () => {
  assert.equal(formatComboFor('Ctrl+K', false), 'Ctrl+K')
  assert.equal(formatComboFor('Ctrl+K', true), '⌘K')
  assert.equal(formatComboFor('Ctrl+Shift+Z', true), '⇧⌘Z')
  assert.equal(formatComboFor('Alt+Ctrl+Delete', true), '⌥⌘Del')
  assert.equal(formatComboFor('Space', true), '空格')
  assert.equal(formatComboFor('Ctrl+ArrowLeft', true), '⌘←')
  assert.equal(formatCombo('Ctrl+K', false), 'Ctrl+K')
})

test('isMacPlatform: injectable navigator', () => {
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true)
  assert.equal(isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: '' }), true)
  assert.equal(isMacPlatform({ platform: 'Win32' }), false)
  assert.equal(isMacPlatform({ platform: 'Linux x86_64' }), false)
  assert.equal(isMacPlatform(null), false)
})
