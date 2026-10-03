// 任务中心的展示文案（utils/aiTaskView.js）：状态、客户端兜底的错误说明、筛选。
// 服务端带回的 error_readable 保持原样；这里只是服务端没给时的兜底（与 providers/errors.js READABLE 对应）。
// key 必须以 aiTask. 开头；用 [key, 中文, English] 三元组书写，保证两种语言键集合一致。
const rows = [
  ['aiTask.state.queued', '排队中', 'Queued'],
  ['aiTask.state.submitting', '提交中', 'Submitting'],
  ['aiTask.state.submitted', '已提交', 'Submitted'],
  ['aiTask.state.polling', '生成中', 'Generating'],
  ['aiTask.state.downloading', '下载中', 'Downloading'],
  ['aiTask.state.succeeded', '已完成', 'Done'],
  ['aiTask.state.failed', '失败', 'Failed'],
  ['aiTask.state.cancelled', '已取消', 'Cancelled'],
  ['aiTask.state.unknown', '未知', 'Unknown'],
  ['aiTask.error.INVALID_API_KEY', 'API Key 无效或已过期，请检查设置中的 Key', 'The API key is invalid or expired. Check the key in Settings'],
  ['aiTask.error.MODEL_NOT_ENABLED', '该模型未开通或无权限，请在服务商控制台开通后重试', 'This model is not enabled or you have no access. Enable it in the provider console and retry'],
  ['aiTask.error.INSUFFICIENT_BALANCE', '账户余额不足或已欠费，请充值后重试', 'The account balance is too low or overdue. Top up and retry'],
  ['aiTask.error.RATE_LIMITED', '请求过于频繁或额度受限，请稍后重试', 'Too many requests or the quota is limited. Try again later'],
  ['aiTask.error.INVALID_PARAMS', '请求参数不合法', 'The request parameters are invalid'],
  ['aiTask.error.TASK_FAILED', '生成任务失败', 'The generation task failed'],
  ['aiTask.error.NETWORK', '网络请求失败', 'The network request failed'],
  ['aiTask.error.BAD_RESPONSE', '服务商返回格式异常', 'The provider returned an unexpected response'],
  ['aiTask.error.PROVIDER_NOT_AVAILABLE', '该服务商暂未开放', 'This provider is not available yet'],
  ['aiTask.error.CAPABILITY_NOT_SUPPORTED', '该服务商不支持此能力', 'This provider does not support this capability'],
  ['aiTask.error.UNKNOWN', '未知错误', 'Unknown error'],
  ['aiTask.uncertain', '提交结果不确定：请求可能已到达服务商。为避免重复扣费未自动重试，请先到服务商控制台确认后再手动重试', 'The submit result is uncertain: the request may have reached the provider. It was not retried automatically to avoid being charged twice. Check the provider console first, then retry by hand'],
  ['aiTask.filter.all', '全部', 'All'],
  ['aiTask.filter.running', '进行中', 'In progress'],
  ['aiTask.filter.failed', '失败', 'Failed'],
  ['aiTask.filter.done', '已完成', 'Done'],
  // ROWS-END
]

export default {
  'zh-CN': Object.fromEntries(rows.map(([k, zh]) => [k, zh])),
  en: Object.fromEntries(rows.map(([k, , en]) => [k, en])),
}
