import test from 'node:test'
import assert from 'node:assert/strict'
import { parseApiError, toastText, lookupError } from '../src/utils/errorToast.js'

const http = (data, message = 'Request failed with status code 500') => ({ message, response: { data } })

test('local shape: server message kept, action filled from table', () => {
  const e = http({ success: false, error: { code: 'SPEND_LIMIT', message: '预计 ¥12 超过单次上限 ¥10' } })
  const p = parseApiError(e)
  assert.equal(p.code, 'SPEND_LIMIT')
  assert.equal(p.message, '预计 ¥12 超过单次上限 ¥10')
  assert.match(p.action, /费用/)
  assert.match(toastText(e), /建议：/)
})

test('local shape with action already supplied by service', () => {
  const p = parseApiError(http({ error: { code: 'CONFLICT', message: 'm', action: 'a' } }))
  assert.equal(p.action, 'a')
})

test('cloud shape: lowercase code string + message', () => {
  const p = parseApiError(http({ error: 'invalid_invite' }))
  assert.equal(p.code, 'invalid_invite')
  assert.match(p.message, /邀请码/)
  assert.ok(p.action)
})

test('unknown code and no body fall back to message', () => {
  assert.equal(parseApiError(http({ error: { code: 'ZZZ', message: 'boom' } })).message, 'boom')
  assert.equal(parseApiError(http({ error: { code: 'ZZZ', message: 'boom' } })).action, null)
  assert.equal(toastText({ message: 'Network Error' }), 'Network Error')
  assert.equal(toastText(null), '网络错误')
})

test('numeric core codes and prototype keys', () => {
  assert.match(lookupError(-32031).message, /素材/)
  assert.equal(lookupError('constructor'), null)
  assert.equal(lookupError('__proto__'), null)
})
