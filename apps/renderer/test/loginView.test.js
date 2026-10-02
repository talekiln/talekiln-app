import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizePhone,
  validatePhone,
  validateSmsLogin,
  smsButtonState,
  countdownLeft,
  needsInvite,
  qrStatusText,
  qrPollDecision,
  showSimulateConfirm,
  accountDisplayName,
  placeholderMatrix,
  matrixToPath,
  QR_POLL_MAX_MS
} from '../src/utils/loginView.js'
import { accountErrorMessage } from '../src/utils/account.js'

const apiError = (code, message) => ({ response: { data: { success: false, error: { code, message } } } })

test('手机号规范化：接受 +86 / 86 / 空格 / 连字符，拒绝非大陆号码', () => {
  assert.equal(normalizePhone('+86 138 0013 8000'), '13800138000')
  assert.equal(normalizePhone('86-13800138000'), '13800138000')
  assert.equal(normalizePhone('008613800138000'), '13800138000')
  assert.equal(normalizePhone('12345678901'), '')
  assert.equal(normalizePhone(''), '')
  assert.equal(validatePhone(''), '请输入手机号')
  assert.match(validatePhone('1380013800'), /格式不正确/)
  assert.equal(validatePhone('13800138000'), '')
})

test('短信登录表单校验：验证码 4–8 位数字；首登时邀请码必填', () => {
  assert.deepEqual(validateSmsLogin({ phone: '13800138000', code: '123456' }), { ok: true, errors: {} })
  const r = validateSmsLogin({ phone: '', code: 'ab' })
  assert.equal(r.ok, false)
  assert.equal(r.errors.phone, '请输入手机号')
  assert.equal(r.errors.code, '验证码应为 4–8 位数字')
  assert.equal(validateSmsLogin({ phone: '13800138000', code: '' }).errors.code, '请输入验证码')
  const need = validateSmsLogin({ phone: '13800138000', code: '123456', needInvite: true })
  assert.equal(need.errors.inviteCode, '首次登录需要邀请码')
  assert.equal(validateSmsLogin({ phone: '13800138000', code: '123456', needInvite: true, inviteCode: 'ABC' }).ok, true)
  assert.equal(needsInvite('INVITE_REQUIRED'), true)
  assert.equal(needsInvite('INVALID_CODE'), false)
})

test('获取验证码按钮：手机号不合法禁用，倒计时中禁用并显示剩余秒数，60 秒后可重发', () => {
  assert.deepEqual(smsButtonState({ phone: '' }), { disabled: true, text: '获取验证码' })
  assert.deepEqual(smsButtonState({ phone: '13800138000' }), { disabled: false, text: '获取验证码' })
  assert.deepEqual(smsButtonState({ phone: '13800138000', secondsLeft: 42 }), { disabled: true, text: '42 秒后重发' })
  assert.deepEqual(smsButtonState({ phone: '13800138000', sending: true }), { disabled: true, text: '发送中…' })
  const t0 = 1_000_000
  assert.equal(countdownLeft(0, t0), 0)
  assert.equal(countdownLeft(t0, t0), 60)
  assert.equal(countdownLeft(t0, t0 + 30_500), 30)
  assert.equal(countdownLeft(t0, t0 + 60_000), 0)
  assert.equal(countdownLeft(t0, t0 + 99_000), 0)
})

test('二维码状态文案与轮询决策', () => {
  assert.equal(qrStatusText('pending').title, '请用微信扫一扫')
  assert.equal(qrStatusText('scanned').tone, 'success')
  assert.equal(qrStatusText('need_invite').hint, '请填写邀请码完成注册')
  assert.equal(qrStatusText('expired').tone, 'danger')
  assert.equal(qrStatusText('whatever').title, '二维码获取失败')

  assert.deepEqual(qrPollDecision({ status: 'pending' }, 1000), { action: 'continue', status: 'pending' })
  assert.deepEqual(qrPollDecision({ status: 'scanned' }, 1000), { action: 'continue', status: 'scanned' })
  assert.deepEqual(qrPollDecision({ status: 'pending' }, QR_POLL_MAX_MS), { action: 'stop', status: 'expired' })
  assert.deepEqual(qrPollDecision({ status: 'confirmed', new_account: false }, 1000), { action: 'login', status: 'confirmed' })
  assert.deepEqual(qrPollDecision({ status: 'confirmed', new_account: true }, 1000), { action: 'ask_invite', status: 'need_invite' })
  assert.deepEqual(qrPollDecision({ status: 'expired' }, 1000), { action: 'stop', status: 'expired' })
  assert.deepEqual(qrPollDecision(null, 1000), { action: 'stop', status: 'expired' })
})

test('模拟确认按钮：开发模式或云端为模拟适配器时显示', () => {
  assert.equal(showSimulateConfirm({ dev: true }), true)
  assert.equal(showSimulateConfirm({ dev: false, qr: { simulated: true } }), true)
  assert.equal(showSimulateConfirm({ dev: false, qr: { simulated: false } }), false)
  assert.equal(showSimulateConfirm({}), false)
})

test('账号显示名：手机号优先，占位邮箱显示为微信用户 / 手机用户，普通邮箱原样', () => {
  assert.equal(accountDisplayName(null), '')
  assert.equal(accountDisplayName({ email: 'a@b.co' }), 'a@b.co')
  assert.equal(accountDisplayName({ email: 'sms-13800138000@placeholder.talekiln.invalid', phone: '13800138000' }), '13800138000')
  assert.equal(accountDisplayName({ email: 'wx-0123456789abcdef@placeholder.talekiln.invalid', phone: null }), '微信用户')
  assert.equal(accountDisplayName({ email: 'x@placeholder.talekiln.invalid', login_method: 'wechat' }), '微信用户')
  assert.equal(accountDisplayName({ email: 'sms-1@placeholder.talekiln.invalid', phone: null }), '手机用户')
})

test('占位二维码矩阵：确定性、含三个定位角、空文本为全空；path 只画黑格', () => {
  const a = placeholderMatrix('talekiln://wechat-mock/confirm?state=abc', 25)
  const b = placeholderMatrix('talekiln://wechat-mock/confirm?state=abc', 25)
  const c = placeholderMatrix('talekiln://wechat-mock/confirm?state=xyz', 25)
  assert.equal(a.length, 25)
  assert.ok(a.every((row) => row.length === 25))
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
  // 定位角：外环黑、中间白环、中心 3×3 黑
  for (const [r0, c0] of [[0, 0], [0, 18], [18, 0]]) {
    assert.equal(a[r0][c0], true)
    assert.equal(a[r0 + 1][c0 + 1], false)
    assert.equal(a[r0 + 3][c0 + 3], true)
    assert.equal(a[r0 + 6][c0 + 6], true)
  }
  const empty = placeholderMatrix('', 21)
  assert.ok(empty.every((row) => row.every((x) => x === false)))
  assert.equal(matrixToPath(empty), '')
  assert.equal(matrixToPath([[true, false], [false, true]]), 'M0 0h1v1h-1zM1 1h1v1h-1z')
  const dark = a.flat().filter(Boolean).length
  assert.ok(dark > 100 && dark < 500, `dark cells ${dark}`)
})

test('新错误码有中文提示', () => {
  assert.equal(accountErrorMessage(apiError('INVITE_REQUIRED')), '首次登录需要邀请码')
  assert.equal(accountErrorMessage(apiError('INVALID_CODE')), '验证码错误')
  assert.equal(accountErrorMessage(apiError('QR_EXPIRED')), '二维码已过期或已使用，请刷新')
  assert.equal(accountErrorMessage(apiError('LOGIN_METHOD_UNAVAILABLE')), '该登录方式暂不可用，请改用邮箱密码登录')
  assert.equal(accountErrorMessage(apiError('CLOUD_RATE_LIMITED')), '操作过于频繁，请稍后再试')
})
