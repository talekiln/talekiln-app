// P2-C 登录页（手机验证码 / 微信扫码）的纯函数：文案、校验、倒计时、二维码状态判断、占位二维码矩阵。无 Vue 依赖，便于 node --test。

export const PHONE_RE = /^1[3-9]\d{9}$/
export const SMS_RESEND_SECONDS = 60
export const QR_POLL_MS = 2000
/** 轮询的硬上限（毫秒）：票据本身 5 分钟过期，这里再多留一点以免界面提前放弃 */
export const QR_POLL_MAX_MS = 6 * 60 * 1000

/** 大陆手机号规范化（去空格 / 连字符 / +86 前缀）；不合法返回空串。 */
export function normalizePhone(raw) {
  let s = String(raw || '').replace(/[\s-]/g, '')
  if (s.startsWith('+86')) s = s.slice(3)
  else if (s.startsWith('0086')) s = s.slice(4)
  else if (s.length === 13 && s.startsWith('86')) s = s.slice(2)
  return PHONE_RE.test(s) ? s : ''
}

export function validatePhone(phone) {
  if (!String(phone || '').trim()) return '请输入手机号'
  if (!normalizePhone(phone)) return '手机号格式不正确（需为 11 位大陆手机号）'
  return ''
}

/** 短信登录表单校验。needInvite 为真（云端已回 INVITE_REQUIRED）时邀请码必填。 */
export function validateSmsLogin({ phone, code, inviteCode, needInvite } = {}) {
  const errors = {}
  const p = validatePhone(phone)
  if (p) errors.phone = p
  const c = String(code || '').trim()
  if (!c) errors.code = '请输入验证码'
  else if (!/^\d{4,8}$/.test(c)) errors.code = '验证码应为 4–8 位数字'
  if (needInvite && !String(inviteCode || '').trim()) errors.inviteCode = '首次登录需要邀请码'
  return { ok: Object.keys(errors).length === 0, errors }
}

/** 「获取验证码」按钮：倒计时中禁用并显示剩余秒数。 */
export function smsButtonState({ secondsLeft = 0, phone = '', sending = false } = {}) {
  if (sending) return { disabled: true, text: '发送中…' }
  if (secondsLeft > 0) return { disabled: true, text: `${secondsLeft} 秒后重发` }
  if (!normalizePhone(phone)) return { disabled: true, text: '获取验证码' }
  return { disabled: false, text: '获取验证码' }
}

/** 倒计时：从 startedAt 起算，到 now 还剩几秒（不会为负）。 */
export function countdownLeft(startedAt, now, total = SMS_RESEND_SECONDS) {
  if (!startedAt) return 0
  return Math.max(0, Math.ceil((startedAt + total * 1000 - now) / 1000))
}

/** 本地接口的错误码 -> 是否该让用户补邀请码。 */
export function needsInvite(code) {
  return code === 'INVITE_REQUIRED'
}

const QR_TEXT = {
  idle: { title: '正在生成二维码…', hint: '', tone: 'info' },
  pending: { title: '请用微信扫一扫', hint: '扫码后在手机上确认登录', tone: 'info' },
  scanned: { title: '已扫码', hint: '请在手机上点击「确认登录」', tone: 'success' },
  confirmed: { title: '已确认，正在登录…', hint: '', tone: 'success' },
  need_invite: { title: '首次使用微信登录', hint: '请填写邀请码完成注册', tone: 'warning' },
  expired: { title: '二维码已过期', hint: '点击刷新重新获取', tone: 'danger' },
  error: { title: '二维码获取失败', hint: '请检查网络后刷新', tone: 'danger' },
  unavailable: { title: '微信登录暂不可用', hint: '请改用邮箱密码或手机验证码登录', tone: 'warning' }
}

export function qrStatusText(status) {
  return QR_TEXT[status] || QR_TEXT.error
}

/**
 * 轮询决策：根据云端状态与已耗时决定下一步。
 * - pending/scanned：继续轮询（超过 QR_POLL_MAX_MS 视为过期）
 * - confirmed：new_account 为真则停下来要邀请码，否则直接登录
 * - expired / 其它：停止并显示过期
 */
export function qrPollDecision(view, elapsedMs) {
  const status = view && view.status
  if (status === 'confirmed') return { action: view.new_account ? 'ask_invite' : 'login', status: view.new_account ? 'need_invite' : 'confirmed' }
  if (status === 'pending' || status === 'scanned') {
    if (elapsedMs >= QR_POLL_MAX_MS) return { action: 'stop', status: 'expired' }
    return { action: 'continue', status }
  }
  return { action: 'stop', status: 'expired' }
}

/** 是否显示「模拟确认」按钮：开发模式，或云端明确说自己是模拟适配器。 */
export function showSimulateConfirm({ dev = false, qr = null } = {}) {
  return Boolean(dev || (qr && qr.simulated === true))
}

/** 登录状态条上显示的账号名：手机号账号显示手机号，占位邮箱（微信账号）显示“微信用户”。 */
export function accountDisplayName(account) {
  if (!account) return ''
  if (account.phone) return account.phone
  const email = String(account.email || '')
  if (/@placeholder\.talekiln\.invalid$/i.test(email)) return account.login_method === 'wechat' || email.startsWith('wx-') ? '微信用户' : '手机用户'
  return email
}

// ---------------------------------------------------------------------------
// 占位二维码：把 URL 哈希成确定的点阵（带三个定位角），用 SVG 画出来。
// 这不是真正可扫的 QR 码（模拟适配器给的 URL 本来就扫不了）；接真实微信时换成二维码库即可，接口不变。
// ---------------------------------------------------------------------------
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function xorshift(seed) {
  let x = seed || 0x9e3779b9
  return () => {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    return x / 0x100000000
  }
}

function isFinder(n, r, c) {
  const inBox = (r0, c0) => r >= r0 && r < r0 + 7 && c >= c0 && c < c0 + 7
  return inBox(0, 0) || inBox(0, n - 7) || inBox(n - 7, 0)
}

function finderCell(n, r, c) {
  const rel = (r0, c0) => [r - r0, c - c0]
  let [y, x] = r < 7 ? (c < 7 ? rel(0, 0) : rel(0, n - 7)) : rel(n - 7, 0)
  const ring = Math.max(Math.abs(y - 3), Math.abs(x - 3))
  return ring === 3 || ring <= 1
}

/** 返回 n×n 布尔矩阵（默认 25）。同一文本总得到同一图案；文本为空返回全空矩阵。 */
export function placeholderMatrix(text, n = 25) {
  const rows = []
  if (!text) return Array.from({ length: n }, () => new Array(n).fill(false))
  const rnd = xorshift(fnv1a(String(text)))
  for (let r = 0; r < n; r++) {
    const row = []
    for (let c = 0; c < n; c++) {
      if (isFinder(n, r, c)) row.push(finderCell(n, r, c))
      else if ((r === 6 || c === 6) && r >= 7 - 1 && c >= 7 - 1 && r < n - 7 + 1 && c < n - 7 + 1) row.push((r + c) % 2 === 0) // 定时图案
      else row.push(rnd() < 0.45)
    }
    rows.push(row)
  }
  return rows
}

/** 矩阵 -> SVG path 的 d 属性（每个黑格一个 1×1 方块，viewBox 用 n n）。 */
export function matrixToPath(matrix) {
  const parts = []
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      if (matrix[r][c]) parts.push(`M${c} ${r}h1v1h-1z`)
    }
  }
  return parts.join('')
}
