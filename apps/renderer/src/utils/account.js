// 账号相关的纯函数（无 Vue 依赖，便于 node --test）

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STATUS_STALE_MS = 5 * 60 * 1000

function checkEmail(email, errors) {
  const v = String(email || '').trim()
  if (!v) errors.email = '请输入邮箱'
  else if (v.length > 200 || !EMAIL_RE.test(v)) errors.email = '邮箱格式不正确'
}

export function validateLogin({ email, password } = {}) {
  const errors = {}
  checkEmail(email, errors)
  if (!password) errors.password = '请输入密码'
  return { ok: Object.keys(errors).length === 0, errors }
}

export function validateRegister({ inviteCode, email, password, confirm } = {}) {
  const errors = {}
  if (!String(inviteCode || '').trim()) errors.inviteCode = '请输入邀请码'
  checkEmail(email, errors)
  if (!password) errors.password = '请输入密码'
  else if (password.length < 8) errors.password = '密码至少 8 位'
  else if (password.length > 200) errors.password = '密码过长'
  if (!errors.password && password !== confirm) errors.confirm = '两次输入的密码不一致'
  return { ok: Object.keys(errors).length === 0, errors }
}

const ERROR_TEXT = {
  INVALID_INVITE: '邀请码无效、已被使用或已过期',
  EMAIL_TAKEN: '该邮箱已注册，请直接登录',
  INVALID_CREDENTIALS: '邮箱或密码错误',
  DEVICE_REVOKED: '此设备已被停用，请联系管理员',
  BAD_REQUEST: '输入格式不正确',
  SESSION_EXPIRED: '登录已失效，请重新登录',
  CLOUD_UNREACHABLE: '无法连接云端，请检查网络后重试',
  CLOUD_NOT_CONFIGURED: '尚未配置云端地址，请先在 config.yaml 中设置 cloud.base_url',
  CLOUD_ERROR: '云端暂时不可用，请稍后重试',
  SECRET_STORE_UNAVAILABLE: '系统密钥加密不可用，无法安全保存登录状态'
}

/** 从 axios 错误里取本地接口的错误码，映射成中文提示；未知情况退回服务端文案或通用提示。 */
export function accountErrorMessage(err) {
  const code = err?.response?.data?.error?.code
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code]
  const msg = err?.response?.data?.error?.message
  if (msg) return msg
  if (!err?.response) return '无法连接本地服务，请重启应用后重试'
  return '操作失败，请稍后重试'
}

export function accountErrorCode(err) {
  return err?.response?.data?.error?.code || null
}

/** 用于界面展示的授权状态摘要 */
export function statusSummary(status) {
  if (!status || !status.logged_in) {
    if (status && status.session === 'expired') return { label: '登录已失效', tone: 'danger' }
    return { label: '未登录', tone: 'info' }
  }
  const l = status.licence || {}
  if (l.state === 'valid') return { label: status.offline ? '已登录 · 授权有效（离线）' : '已登录 · 授权有效', tone: 'success' }
  if (l.state === 'grace') return { label: `离线宽限中 · 剩余 ${l.days_left ?? 0} 天，请联网续期`, tone: 'warning' }
  if (l.state === 'expired') return { label: '授权已过期，请联网续期', tone: 'danger' }
  return { label: '已登录 · 授权待同步', tone: 'warning' }
}

/** 路由门禁：返回 true 放行，或返回跳转到登录页的位置。 */
export function routeDecision(status, to) {
  if (!to || to.name === 'login') return true
  if (!status || !status.require_login) return true
  if (status.entitled) return true
  let reason = 'login_required'
  if (status.session === 'expired') reason = 'session_expired'
  else if (status.logged_in) reason = 'licence_expired'
  return { name: 'login', query: { redirect: to.fullPath || '/', reason } }
}

export function loginReasonText(reason) {
  if (reason === 'session_expired') return '登录已失效，请重新登录'
  if (reason === 'licence_expired') return '授权已过期，请联网后重新登录或续期'
  if (reason === 'login_required') return '请先登录后使用'
  return ''
}

/** 只允许站内相对路径作为登录后的跳转目标，避免被构造成开放重定向。 */
export function safeRedirect(target) {
  const t = String(target || '')
  if (!t.startsWith('/') || t.startsWith('//') || t.includes('\\')) return '/'
  return t
}

export function isStale(lastAt, now, maxAge = STATUS_STALE_MS) {
  return !lastAt || now - lastAt > maxAge
}
