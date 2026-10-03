// 请求层与项目图 store 里由前端自己生成的提示（utils/request.js、utils/errorToast.js、api/storyboards.js、stores/projectViews.js）。
// 服务端返回的错误文案（含 error-codes.json 里的 message / action）保持原样，不在这里翻译。
// key 必须以 request. 开头；用 [key, 中文, English] 三元组书写，保证两种语言键集合一致。
const rows = [
  ['request.failed', '请求失败', 'Request failed'],
  ['request.failedStatus', '请求失败 ({status})', 'Request failed ({status})'],
  ['request.network', '网络错误', 'Network error'],
  ['request.advice', '{message}。建议：{action}', '{message}. Suggestion: {action}'],
  ['request.noStream', '浏览器不支持流式读取', 'This browser does not support streaming reads'],
  ['request.opFailed', '操作失败', 'Action failed'],
  ['request.loadFailed', '加载失败', 'Could not load'],
  // ROWS-END
]

export default {
  'zh-CN': Object.fromEntries(rows.map(([k, zh]) => [k, zh])),
  en: Object.fromEntries(rows.map(([k, , en]) => [k, en])),
}
