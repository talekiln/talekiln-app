// Pure presentation logic for the task center (no Vue / DOM).
import { t } from '../i18n/index.js'

export const STATE_LABELS = {
  get queued() { return t('aiTask.state.queued') },
  get submitting() { return t('aiTask.state.submitting') },
  get submitted() { return t('aiTask.state.submitted') },
  get polling() { return t('aiTask.state.polling') },
  get downloading() { return t('aiTask.state.downloading') },
  get succeeded() { return t('aiTask.state.succeeded') },
  get failed() { return t('aiTask.state.failed') },
  get cancelled() { return t('aiTask.state.cancelled') }
}

// Mirrors packages/local/src/providers/errors.js READABLE; used when the server sent no error_readable.
// Getters, so the text follows the language at the time it is read.
export const ERROR_TEXT = {
  get INVALID_API_KEY() { return t('aiTask.error.INVALID_API_KEY') },
  get MODEL_NOT_ENABLED() { return t('aiTask.error.MODEL_NOT_ENABLED') },
  get INSUFFICIENT_BALANCE() { return t('aiTask.error.INSUFFICIENT_BALANCE') },
  get RATE_LIMITED() { return t('aiTask.error.RATE_LIMITED') },
  get INVALID_PARAMS() { return t('aiTask.error.INVALID_PARAMS') },
  get TASK_FAILED() { return t('aiTask.error.TASK_FAILED') },
  get NETWORK() { return t('aiTask.error.NETWORK') },
  get BAD_RESPONSE() { return t('aiTask.error.BAD_RESPONSE') },
  get PROVIDER_NOT_AVAILABLE() { return t('aiTask.error.PROVIDER_NOT_AVAILABLE') },
  get CAPABILITY_NOT_SUPPORTED() { return t('aiTask.error.CAPABILITY_NOT_SUPPORTED') },
  get UNKNOWN() { return t('aiTask.error.UNKNOWN') }
}

export const uncertainText = () => t('aiTask.uncertain')

// Fallback consoles when the server did not send console_url (https only).
export const VENDOR_CONSOLES = {
  bailian: 'https://bailian.console.aliyun.com/',
  ark: 'https://console.volcengine.com/ark'
}

const TERMINAL = ['succeeded', 'failed', 'cancelled']

export const isTerminal = (state) => TERMINAL.includes(state)
export const stateLabel = (state) => STATE_LABELS[state] || state || t('aiTask.state.unknown')
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
  if (task.uncertain || String(task.error_message || '').startsWith('SUBMIT_UNCERTAIN')) return uncertainText()
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
  { key: 'all', get label() { return t('aiTask.filter.all') }, states: '' },
  { key: 'running', get label() { return t('aiTask.filter.running') }, states: 'queued,submitting,submitted,polling,downloading' },
  { key: 'failed', get label() { return t('aiTask.filter.failed') }, states: 'failed' },
  { key: 'done', get label() { return t('aiTask.filter.done') }, states: 'succeeded' }
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
