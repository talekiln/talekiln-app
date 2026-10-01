/** C06 首次引导：纯逻辑（步骤、服务商资料、校验、请求体）。不接触网络，也不保存任何 Key。 */

export const STEPS = ['welcome', 'provider', 'key', 'test', 'done']

export const STEP_LABELS = {
  welcome: '欢迎',
  provider: '选择服务商',
  key: '填写 Key',
  test: '连通测试',
  done: '完成',
}

/** 服务商资料。consoleUrl 为官方控制台入口；默认模型名未经真 Key 验证，用户可在填写页改。 */
export const PROVIDERS = [
  {
    id: 'bailian',
    name: '阿里云百炼',
    tagline: '通义千问文本、万相图像与视频、CosyVoice 配音',
    configProvider: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    consoleUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    instructions: [
      '用阿里云账号登录百炼控制台，没有账号先完成注册和实名认证。',
      '如果提示开通服务，按页面提示开通“模型服务”（有新用户免费额度时优先使用）。',
      '进入“密钥管理”（API-KEY），点击“创建 API-KEY”，选择默认业务空间。',
      '复制生成的 Key，回到这里粘贴。Key 只会在创建时完整显示一次。',
    ],
  },
  {
    id: 'ark',
    name: '火山方舟',
    tagline: '豆包文本、Seedream 图像、Seedance 视频',
    configProvider: 'volces',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-1-6-250615',
    consoleUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey',
    instructions: [
      '用火山引擎账号登录方舟控制台，没有账号先完成注册和实名认证。',
      '在“开通管理”里开通要用的模型（文本、图像、视频需要分别开通）。',
      '进入“API Key 管理”，点击“创建 API Key”。',
      '复制生成的 Key 回到这里粘贴。如果你习惯使用推理接入点，可在下一页把模型名改成接入点 ID（ep- 开头）。',
    ],
  },
]

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null
}

export function stepIndex(step) {
  const i = STEPS.indexOf(step)
  return i < 0 ? 0 : i
}

export function nextStep(step) {
  return STEPS[Math.min(stepIndex(step) + 1, STEPS.length - 1)]
}

export function prevStep(step) {
  return STEPS[Math.max(stepIndex(step) - 1, 0)]
}

/**
 * 根据服务端状态决定恢复到哪一步。
 * - 已有 Key 却停在填写前的步骤：直接去连通测试；
 * - 想进入测试但没有已保存的配置：退回填写 Key；
 * - 没选服务商却在 key/test：退回选择服务商。
 */
export function resumeStep(status) {
  const s = status || {}
  let step = STEPS.includes(s.step) ? s.step : 'welcome'
  if (s.has_key && stepIndex(step) < stepIndex('test')) step = 'test'
  if ((step === 'test') && !s.config_id) step = s.provider ? 'key' : 'provider'
  if ((step === 'key') && !s.provider) step = 'provider'
  if (step === 'done' && !s.has_key) step = 'welcome'
  return step
}

/** 该不该显示向导：服务端 needed 为真（没有 Key 且没点过跳过）。 */
export function shouldShowOnboarding(status) {
  return !!(status && status.needed)
}

/** Key 粘贴校验：去首尾空白；拒绝空值、含空白字符、过短和掩码回显。返回 { ok, error?, key? }。 */
export function validateKeyInput(raw) {
  const key = String(raw == null ? '' : raw).trim()
  if (!key) return { ok: false, error: '请粘贴 API Key' }
  if (/\s/.test(key)) return { ok: false, error: 'Key 中间不应有空格或换行，请重新复制' }
  if (key.startsWith('****')) return { ok: false, error: '这是掩码显示，不是真正的 Key，请重新复制' }
  if (key.length < 8) return { ok: false, error: 'Key 太短，请确认复制完整' }
  if (/[^\x21-\x7e]/.test(key)) return { ok: false, error: 'Key 只应包含英文字母、数字和符号，请确认没有复制到中文说明' }
  return { ok: true, key }
}

/** 创建文本模型配置的请求体（图像、视频等可之后在 AI 配置页补充）。 */
export function buildConfigBody(providerId, key, model) {
  const p = getProvider(providerId)
  if (!p) throw new Error('未知的服务商')
  const m = String(model || '').trim() || p.defaultModel
  return {
    service_type: 'text',
    name: `${p.name}（引导创建）`,
    provider: p.configProvider,
    base_url: p.baseUrl,
    api_key: key,
    model: [m],
    default_model: m,
    is_default: true,
  }
}

/**
 * 占位：以后接入推广跳转（带推广参数的重定向）。
 * 目前直接返回官方控制台地址；接入时只需改这个函数，界面不用动。
 */
export function getKeyReferralUrl(providerId) {
  const p = getProvider(providerId)
  return p ? p.consoleUrl : ''
}

/** 在新窗口打开“获取 Key”页面；桌面端外链走白名单。 */
export function openKeyReferral(providerId, open = (...a) => window.open(...a)) {
  const url = getKeyReferralUrl(providerId)
  if (!url) return false
  open(url, '_blank', 'noopener,noreferrer')
  return true
}
