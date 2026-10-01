import test from 'node:test'
import assert from 'node:assert/strict'

import {
  validateLogin,
  validateRegister,
  accountErrorMessage,
  accountErrorCode,
  statusSummary,
  routeDecision,
  loginReasonText,
  safeRedirect,
  isStale
} from '../src/utils/account.js'
import { pickOpenableUrl } from '../src/utils/referralUrl.js'

const apiError = (code, message) => ({ response: { data: { success: false, error: { code, message } } } })

test('登录表单校验：邮箱与密码必填，格式错误给出中文提示', () => {
  assert.deepEqual(validateLogin({ email: 'a@b.co', password: 'x' }), { ok: true, errors: {} })
  const r = validateLogin({ email: ' ', password: '' })
  assert.equal(r.ok, false)
  assert.equal(r.errors.email, '请输入邮箱')
  assert.equal(r.errors.password, '请输入密码')
  assert.equal(validateLogin({ email: 'not-an-email', password: 'x' }).errors.email, '邮箱格式不正确')
  assert.equal(validateLogin({ email: 'a b@c.d', password: 'x' }).errors.email, '邮箱格式不正确')
})

test('注册表单校验：邀请码、密码长度、两次密码一致', () => {
  const ok = { inviteCode: 'ABC', email: 'a@b.co', password: 'password1', confirm: 'password1' }
  assert.equal(validateRegister(ok).ok, true)
  assert.equal(validateRegister({ ...ok, inviteCode: '  ' }).errors.inviteCode, '请输入邀请码')
  assert.equal(validateRegister({ ...ok, password: 'short', confirm: 'short' }).errors.password, '密码至少 8 位')
  assert.equal(validateRegister({ ...ok, confirm: 'different1' }).errors.confirm, '两次输入的密码不一致')
  assert.equal(validateRegister({}).ok, false)
})

test('错误提示：按本地错误码映射中文；未知码退回服务端文案；无响应视为本地服务不可用', () => {
  assert.equal(accountErrorMessage(apiError('INVALID_CREDENTIALS')), '邮箱或密码错误')
  assert.equal(accountErrorMessage(apiError('INVALID_INVITE')), '邀请码无效、已被使用或已过期')
  assert.equal(accountErrorMessage(apiError('EMAIL_TAKEN')), '该邮箱已注册，请直接登录')
  assert.equal(accountErrorMessage(apiError('CLOUD_UNREACHABLE')), '无法连接云端，请检查网络后重试')
  assert.equal(accountErrorMessage(apiError('SESSION_EXPIRED')), '登录已失效，请重新登录')
  assert.equal(accountErrorMessage(apiError('WEIRD', '服务端说的话')), '服务端说的话')
  assert.match(accountErrorMessage(new Error('Network Error')), /本地服务/)
  assert.equal(accountErrorCode(apiError('EMAIL_TAKEN')), 'EMAIL_TAKEN')
  assert.equal(accountErrorCode({}), null)
})

test('授权状态摘要：有效 / 离线 / 宽限 / 过期 / 未登录 / 会话失效', () => {
  const base = { logged_in: true, offline: false, licence: { state: 'valid' } }
  assert.deepEqual(statusSummary(base), { label: '已登录 · 授权有效', tone: 'success' })
  assert.equal(statusSummary({ ...base, offline: true }).label, '已登录 · 授权有效（离线）')
  const grace = statusSummary({ ...base, licence: { state: 'grace', days_left: 9 } })
  assert.equal(grace.tone, 'warning')
  assert.match(grace.label, /剩余 9 天/)
  assert.equal(statusSummary({ ...base, licence: { state: 'expired' } }).tone, 'danger')
  assert.equal(statusSummary({ ...base, licence: { state: 'none' } }).tone, 'warning')
  assert.deepEqual(statusSummary({ logged_in: false }), { label: '未登录', tone: 'info' })
  assert.deepEqual(statusSummary(null), { label: '未登录', tone: 'info' })
  assert.equal(statusSummary({ logged_in: false, session: 'expired' }).tone, 'danger')
})

test('路由门禁：未开启门禁一律放行；开启后未授权跳登录并带原因与回跳地址', () => {
  const to = { name: 'film', fullPath: '/film/3' }
  assert.equal(routeDecision(null, to), true)
  assert.equal(routeDecision({ require_login: false, entitled: false }, to), true)
  assert.equal(routeDecision({ require_login: true, entitled: true }, to), true)
  assert.equal(routeDecision({ require_login: true, entitled: false }, { name: 'login' }), true)
  assert.deepEqual(routeDecision({ require_login: true, entitled: false, logged_in: false, session: 'none' }, to), {
    name: 'login',
    query: { redirect: '/film/3', reason: 'login_required' }
  })
  assert.equal(routeDecision({ require_login: true, entitled: false, logged_in: false, session: 'expired' }, to).query.reason, 'session_expired')
  assert.equal(routeDecision({ require_login: true, entitled: false, logged_in: true, session: 'active' }, to).query.reason, 'licence_expired')
})

test('登录原因文案', () => {
  assert.match(loginReasonText('session_expired'), /已失效/)
  assert.match(loginReasonText('licence_expired'), /过期/)
  assert.equal(loginReasonText('whatever'), '')
})

test('登录后回跳只接受站内相对路径', () => {
  assert.equal(safeRedirect('/film/3?x=1'), '/film/3?x=1')
  for (const bad of ['https://evil.com', '//evil.com', 'javascript:alert(1)', '\\\\evil', '/\\evil', '', undefined, null]) {
    assert.equal(safeRedirect(bad), '/', String(bad))
  }
})

test('状态过期判断', () => {
  assert.equal(isStale(0, 1000), true)
  assert.equal(isStale(1000, 2000), false)
  assert.equal(isStale(1000, 1000 + 5 * 60 * 1000 + 1), true)
})

test('密钥页地址只接受无凭据的 https', () => {
  assert.equal(pickOpenableUrl({ url: 'https://cloud.example.com/r/ark?src=addkey' }), 'https://cloud.example.com/r/ark?src=addkey')
  for (const bad of ['http://x.com', 'javascript:alert(1)', 'https://u:p@x.com/', 'not a url', '', null, 5]) {
    assert.equal(pickOpenableUrl({ url: bad }), null, String(bad))
  }
  assert.equal(pickOpenableUrl(null), null)
})
