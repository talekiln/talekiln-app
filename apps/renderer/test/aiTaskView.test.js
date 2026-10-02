import test from 'node:test'
import assert from 'node:assert/strict'
import {
  stateLabel, canRetry, canCancel, errorText, consoleUrl, showConsoleLink, retryRequest, filterStates,
  refreshInterval, formatTime, stateTagType, ERROR_TEXT, UNCERTAIN_TEXT
} from '../src/utils/aiTaskView.js'

test('state labels and button availability', () => {
  assert.equal(stateLabel('polling'), '生成中')
  assert.equal(stateLabel('weird'), 'weird')
  assert.equal(canRetry({ state: 'failed' }), true)
  assert.equal(canRetry({ state: 'cancelled' }), false)
  assert.equal(canCancel({ state: 'queued' }), true)
  assert.equal(canCancel({ state: 'succeeded' }), false)
  assert.equal(stateTagType('failed'), 'danger')
})

test('error text is readable Chinese for every provider error code', () => {
  for (const code of Object.keys(ERROR_TEXT)) {
    assert.match(errorText({ error_code: code }), /[一-龥]/)
  }
  assert.equal(errorText({ state: 'queued' }), '')
  assert.equal(errorText({ error_code: 'NOPE' }), ERROR_TEXT.UNKNOWN)
  assert.equal(errorText({ error_code: 'UNKNOWN', error_message: 'SUBMIT_UNCERTAIN: x' }), UNCERTAIN_TEXT)
  assert.equal(errorText({ error_code: 'NETWORK', error_readable: '服务端文案' }), '服务端文案')
})

test('console link: server url first, https only, shown for failures', () => {
  assert.equal(consoleUrl({ provider: 'ark' }), 'https://console.volcengine.com/ark')
  assert.equal(consoleUrl({ provider: 'x', console_url: 'http://evil' }), '')
  assert.equal(consoleUrl({ provider: 'x', console_url: 'javascript:alert(1)' }), '')
  assert.equal(showConsoleLink({ provider: 'bailian', state: 'failed' }), true)
  assert.equal(showConsoleLink({ provider: 'bailian', state: 'polling' }), false)
  assert.equal(showConsoleLink({ provider: 'unknown', state: 'failed' }), false)
})

test('retry request needs force confirm only for uncertain submits', () => {
  assert.deepEqual(retryRequest({ id: 'a' }), { id: 'a', needsConfirm: false, body: {} })
  assert.deepEqual(retryRequest({ id: 'b', uncertain: true }), { id: 'b', needsConfirm: true, body: { force: true } })
})

test('filters, refresh interval, time format', () => {
  assert.equal(filterStates('failed'), 'failed')
  assert.equal(filterStates('nope'), '')
  assert.equal(refreshInterval([{ state: 'polling' }]), 3000)
  assert.equal(refreshInterval([{ state: 'failed' }]), 15000)
  assert.equal(formatTime(0), '')
  assert.match(formatTime(1700000000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})
