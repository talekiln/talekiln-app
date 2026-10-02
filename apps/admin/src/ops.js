// P2-H 新增屏幕用到的纯函数：金额、状态、漏斗、套餐版本、版本灰度、公告、审计。有单元测试。

// ---- 金额（整数分）----
export function formatMoney(cents) {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return '—'
  const n = Number(cents)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(n))
  return `${sign}¥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** 把用户输入的元（如 "39"、"39.9"、"0.01"）转为整数分；不合法返回 null。不经过浮点乘法。 */
export function yuanToCents(input) {
  const s = String(input ?? '').trim()
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) return null
  const [y, f = ''] = s.split('.')
  return Number(y) * 100 + Number(f.padEnd(2, '0'))
}

export function centsToYuan(cents) {
  if (cents === null || cents === undefined) return ''
  const n = Number(cents)
  return n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2)
}

// ---- 订单、退款、发票 ----
export const ORDER_STATUS = {
  PENDING: { label: '待支付', type: 'warning' },
  PAID: { label: '已支付', type: 'success' },
  CLOSED: { label: '已关闭', type: 'info' },
  REFUNDING: { label: '退款中', type: 'warning' },
  REFUNDED: { label: '已退款', type: 'danger' },
}
export const REFUND_STATUS = {
  PENDING: { label: '处理中', type: 'warning' },
  SUCCESS: { label: '已退款', type: 'success' },
  FAILED: { label: '失败', type: 'danger' },
}
export const INVOICE_STATUS = {
  REQUESTED: { label: '待开票', type: 'warning' },
  ISSUED: { label: '已开具', type: 'success' },
  VOID: { label: '已作废', type: 'info' },
}
export const PERIOD_LABEL = { MONTH: '月付', YEAR: '年付' }
export const PROVIDER_LABEL = { wechat: '微信支付', alipay: '支付宝' }

export const statusTag = (map, key) => map[key] || { label: key || '—', type: 'info' }

/** 退款入口是否可用：仅已支付订单；已开具的发票须先作废（云端同样会拒绝）。 */
export function refundBlockReason(detail) {
  if (!detail || !detail.order) return '订单不存在'
  if (detail.order.status !== 'PAID') return `订单状态为「${statusTag(ORDER_STATUS, detail.order.status).label}」，只有已支付的订单可以退款`
  if (detail.invoice && detail.invoice.status === 'ISSUED') return '该订单已开具发票，请先作废发票再退款'
  if (!detail.refundQuote || detail.refundQuote.refundCents <= 0) return '授权已到期，应退金额为 0'
  return null
}

// ---- 漏斗 ----
export const FUNNEL_LABEL = {
  clicks: '推广点击',
  registered: '注册账号',
  activated: '已激活（登记设备）',
  firstExport: '首次导出',
}

export function formatPercent(rate) {
  if (rate === null || rate === undefined || Number.isNaN(Number(rate))) return '—'
  return `${(Number(rate) * 100).toFixed(1)}%`
}

/** 云端 stages -> 带中文名、柱宽、转化率文字的行。柱宽按第一阶段（有则）或最大值归一。 */
export function funnelRows(stages) {
  const list = Array.isArray(stages) ? stages : []
  const max = Math.max(0, ...list.map((s) => s.count))
  return list.map((s) => ({
    key: s.key,
    label: FUNNEL_LABEL[s.key] || s.key,
    count: s.count,
    width: max > 0 && s.count > 0 ? Math.max(2, Math.round((s.count / max) * 100)) : 0,
    fromPrev: formatPercent(s.rateFromPrev),
    fromFirst: formatPercent(s.rateFromFirst),
  }))
}

// ---- 套餐与价格版本 ----
export const FEATURE_OPTIONS = ['generate', 'export', 'cloud-sync', 'batch', 'pro-models']

/** 套餐的最新版本（versions 按版本号升序）。 */
export function latestVersion(entry) {
  const v = entry && entry.versions
  return v && v.length ? v[v.length - 1] : null
}

export function describeEntitlements(e) {
  if (!e) return '—'
  return `${e.maxDevices} 台设备 · 导出最高 ${e.exportMaxHeight}p · ${e.watermark ? '带水印' : '无水印'}`
}

/** 版本表单 -> 请求体；有错误返回 { error }。价格留空 = 不可购买（null）。 */
export function buildVersionBody(form) {
  const price = (v, name) => {
    if (v === '' || v === null || v === undefined) return { ok: null }
    const c = yuanToCents(v)
    if (c === null || c < 1) return { error: `${name}价格需为大于 0 的金额（最多两位小数），留空表示不可购买` }
    return { ok: c }
  }
  const m = price(form.priceMonth, '月付')
  if (m.error) return { error: m.error }
  const y = price(form.priceYear, '年付')
  if (y.error) return { error: y.error }
  const maxDevices = Number(form.maxDevices)
  const exportMaxHeight = Number(form.exportMaxHeight)
  if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 100) return { error: '设备数需为 1–100 的整数' }
  if (!Number.isInteger(exportMaxHeight) || exportMaxHeight < 144 || exportMaxHeight > 8640) return { error: '导出最大高度需为 144–8640 的整数' }
  return {
    body: {
      priceMonthCents: m.ok,
      priceYearCents: y.ok,
      entitlements: { maxDevices, exportMaxHeight, watermark: !!form.watermark, features: [...(form.features || [])] },
    },
  }
}

export function versionToForm(v) {
  const e = (v && v.entitlements) || {}
  return {
    priceMonth: centsToYuan(v ? v.priceMonthCents : null),
    priceYear: centsToYuan(v ? v.priceYearCents : null),
    maxDevices: e.maxDevices ?? 1,
    exportMaxHeight: e.exportMaxHeight ?? 720,
    watermark: e.watermark ?? true,
    features: [...(e.features || [])],
  }
}

export const PLAN_CODE_RE = /^[a-z][a-z0-9_-]{1,29}$/

// ---- 版本灰度 ----
export const CHANNELS = [
  { value: 'stable', label: '正式版 stable' },
  { value: 'beta', label: '测试版 beta' },
]
export const channelLabel = (c) => (CHANNELS.find((x) => x.value === c) || { label: c || '—' }).label

const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
export const isSemver = (v) => SEMVER.test(String(v || ''))

function cmpSemver(a, b) {
  const x = SEMVER.exec(a)
  const y = SEMVER.exec(b)
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1
  const p = x[4].split('.')
  const q = y[4].split('.')
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1
    if (q[i] === undefined) return 1
    if (p[i] === q[i]) continue
    const pn = /^\d+$/.test(p[i])
    const qn = /^\d+$/.test(q[i])
    if (pn && qn) return Number(p[i]) < Number(q[i]) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p[i] < q[i] ? -1 : 1
  }
  return 0
}
export const compareSemver = cmpSemver

export function validateRelease(f) {
  if (!isSemver(f.version)) return '版本号需为语义化版本，如 1.2.3 或 1.3.0-beta.1'
  if (!CHANNELS.some((c) => c.value === f.channel)) return '请选择发布通道'
  const p = Number(f.rolloutPercent)
  if (!Number.isInteger(p) || p < 0 || p > 100) return '灰度百分比需为 0–100 的整数'
  if (f.minVersion) {
    if (!isSemver(f.minVersion)) return '最低版本不是合法的语义化版本'
    if (cmpSemver(f.minVersion, f.version) > 0) return '最低版本不能高于发布版本'
  }
  if ((f.notes || '').length > 2000) return '说明不能超过 2000 字'
  return null
}

export function releaseBody(f) {
  return {
    version: String(f.version).trim(),
    channel: f.channel,
    rolloutPercent: Number(f.rolloutPercent),
    minVersion: f.minVersion ? String(f.minVersion).trim() : null,
    forced: !!f.forced,
    notes: f.notes || '',
    enabled: f.enabled !== false,
  }
}

/** 发布状态：暂停 / 未开始（0%）/ 灰度中 / 全量。 */
export function releaseState(r) {
  if (!r.enabled) return { label: '已暂停', type: 'info' }
  if (r.rolloutPercent <= 0) return { label: '未开始（0%）', type: 'info' }
  if (r.rolloutPercent >= 100) return { label: '全量', type: 'success' }
  return { label: `灰度 ${r.rolloutPercent}%`, type: 'warning' }
}

// ---- 公告 ----
export const ANNOUNCE_CHANNELS = [{ value: 'all', label: '全部' }, ...CHANNELS.map((c) => ({ value: c.value, label: c.label }))]
export const announceChannelLabel = (c) => (ANNOUNCE_CHANNELS.find((x) => x.value === c) || { label: c || '—' }).label

/** 公告当前状态（按 now 判断时间窗）。 */
export function announcementState(a, now = new Date()) {
  if (!a.enabled) return { label: '已停用', type: 'info' }
  const t = now.getTime()
  if (new Date(a.startsAt).getTime() > t) return { label: '未开始', type: 'warning' }
  if (a.endsAt && new Date(a.endsAt).getTime() <= t) return { label: '已结束', type: 'info' }
  return { label: '生效中', type: 'success' }
}

export function validateAnnouncement(f) {
  if (!f.title || !f.title.trim()) return '标题不能为空'
  if (f.title.length > 100) return '标题不能超过 100 字'
  if ((f.body || '').length > 2000) return '正文不能超过 2000 字'
  if (!f.startsAt) return '请选择生效时间'
  if (Number.isNaN(new Date(f.startsAt).getTime())) return '生效时间不合法'
  if (f.endsAt) {
    if (Number.isNaN(new Date(f.endsAt).getTime())) return '结束时间不合法'
    if (new Date(f.endsAt).getTime() <= new Date(f.startsAt).getTime()) return '结束时间必须晚于生效时间'
  }
  return null
}

export function announcementBody(f) {
  return {
    title: f.title.trim(),
    body: f.body || '',
    level: f.level,
    channel: f.channel,
    startsAt: new Date(f.startsAt).toISOString(),
    endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null,
    enabled: !!f.enabled,
  }
}

// ---- 管理员与审计 ----
export function validateGrant(f) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((f.email || '').trim())) return '请输入合法的邮箱'
  if (!f.role) return '请选择角色'
  if (f.password && f.password.length < 12) return '初始口令至少 12 位'
  return null
}

/** 路由模板 -> 中文动作名；未登记的回退为原文。 */
const AUDIT_ACTIONS = {
  'POST /admin/auth/login': '登录后台',
  'POST /admin/invites': '创建邀请码',
  'POST /admin/invites/:id/revoke': '吊销邀请码',
  'POST /admin/users/:id/disable': '禁用用户',
  'POST /admin/users/:id/enable': '启用用户',
  'PUT /admin/catalog': '更新模型目录',
  'POST /admin/orders/:id/refund': '订单退款',
  'POST /admin/orders/:id/invoice': '登记发票',
  'POST /admin/invoices/:id/issue': '开具发票',
  'POST /admin/invoices/:id/void': '作废发票',
  'POST /admin/plans': '新建套餐',
  'POST /admin/plans/:code/versions': '新增价格版本',
  'PUT /admin/plans/:code/enabled': '启用/停用套餐',
  'POST /admin/releases': '新建版本发布',
  'PUT /admin/releases/:id': '调整版本发布',
  'POST /admin/announcements': '新建公告',
  'PUT /admin/announcements/:id': '修改公告',
  'DELETE /admin/announcements/:id': '删除公告',
  'POST /admin/admins': '授予管理员',
  'PUT /admin/admins/:accountId/role': '修改管理员角色',
  'DELETE /admin/admins/:accountId': '撤销管理员',
}
export const auditActionLabel = (action) => AUDIT_ACTIONS[action] || action || '—'
export const AUDIT_ACTION_OPTIONS = Object.entries(AUDIT_ACTIONS).map(([value, label]) => ({ value, label }))

/** 审计详情：对象 + 请求摘要的一行文字（摘要已在云端脱敏）。 */
export function auditSummary(row) {
  const parts = []
  if (row.targetType) parts.push(row.targetId ? `${row.targetType}/${String(row.targetId).slice(0, 8)}` : row.targetType)
  const body = row.detail && row.detail.body
  if (body && typeof body === 'object') {
    const keys = Object.keys(body).slice(0, 4).map((k) => `${k}=${typeof body[k] === 'object' ? '…' : String(body[k]).slice(0, 24)}`)
    if (keys.length) parts.push(keys.join(' '))
  }
  if (row.detail && row.detail.truncated) parts.push('（内容过长已省略）')
  return parts.join('  ') || '—'
}
