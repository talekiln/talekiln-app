// Pure presentation logic for the task center (no Vue / DOM).

export const STATE_LABELS = {
  queued: '排队中',
  submitting: '提交中',
  submitted: '已提交',
  polling: '生成中',
  downloading: '下载中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

// Mirrors packages/local/src/providers/errors.js READABLE; used when the server sent no error_readable.
export const ERROR_TEXT = {
  INVALID_API_KEY: 'API Key 无效或已过期，请检查设置中的 Key',
  MODEL_NOT_ENABLED: '该模型未开通或无权限，请在服务商控制台开通后重试',
  INSUFFICIENT_BALANCE: '账户余额不足或已欠费，请充值后重试',
  RATE_LIMITED: '请求过于频繁或额度受限，请稍后重试',
  INVALID_PARAMS: '请求参数不合法',
  TASK_FAILED: '生成任务失败',
  NETWORK: '网络请求失败',
  BAD_RESPONSE: '服务商返回格式异常',
  PROVIDER_NOT_AVAILABLE: '该服务商暂未开放',
  CAPABILITY_NOT_SUPPORTED: '该服务商不支持此能力',
  UNKNOWN: '未知错误'
}

export const UNCERTAIN_TEXT = '提交结果不确定：请求可能已到达服务商。为避免重复扣费未自动重试，请先到服务商控制台确认后再手动重试'

// Fallback consoles when the server did not send console_url (https only).
export const VENDOR_CONSOLES = {
  bailian: 'https://bailian.console.aliyun.com/',
  ark: 'https://console.volcengine.com/ark'
}

const TERMINAL = ['succeeded', 'failed', 'cancelled']

export const isTerminal = (state) => TERMINAL.includes(state)
export const stateLabel = (state) => STATE_LABELS[state] || state || '未知'
export const canRetry = (task) => !!task && task.state === 'failed'
export const canCancel = (task) => !!task && !isTerminal(task.state)

export function stateTagType(state) {
  if (state === 'succeeded') return 'success'
  if (state === 'failed') return 'danger'
  if (state === 'cancelled') return 'info'
  if (state === 'queued') return 'warning'
  return 'primary'
}

export function errorText(task) {
  if (!task || !task.error_code) return ''
  if (task.error_readable) return task.error_readable
  if (task.uncertain || String(task.error_message || '').startsWith('SUBMIT_UNCERTAIN')) return UNCERTAIN_TEXT
  return ERROR_TEXT[task.error_code] || ERROR_TEXT.UNKNOWN
}

// Only https links may be opened externally.
export function consoleUrl(task) {
  const u = (task && task.console_url) || VENDOR_CONSOLES[task && task.provider] || ''
  return /^https:\/\//.test(u) ? u : ''
}

// Show the console link when it can help the user fix the problem.
export function showConsoleLink(task) {
  return !!task && !!consoleUrl(task) && (task.state === 'failed' || !!task.uncertain)
}

export function formatTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export const FILTERS = [
  { key: 'all', label: '全部', states: '' },
  { key: 'running', label: '进行中', states: 'queued,submitting,submitted,polling,downloading' },
  { key: 'failed', label: '失败', states: 'failed' },
  { key: 'done', label: '已完成', states: 'succeeded' }
]

export const filterStates = (key) => (FILTERS.find((f) => f.key === key) || FILTERS[0]).states

// Retry of an uncertain submit needs explicit user confirmation (the API requires force=true).
export function retryRequest(task) {
  return { id: task.id, needsConfirm: !!task.uncertain, body: task.uncertain ? { force: true } : {} }
}

// Poll faster while something is running.
export function refreshInterval(tasks) {
  return (tasks || []).some((t) => !isTerminal(t.state)) ? 3000 : 15000
}
