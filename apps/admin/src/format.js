// 纯函数：展示格式化与数据整理（有单元测试）。

export const INVITE_STATUS = {
  unused: { label: '未使用', type: 'success' },
  used: { label: '已使用', type: 'info' },
  expired: { label: '已过期', type: 'warning' },
  revoked: { label: '已吊销', type: 'danger' },
}

export function formatTime(v) {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatBytes(n) {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(2)} MB`
}

/** 批量创建结果导出为 CSV（带 BOM，Excel 直接打开不乱码）。 */
export function invitesToCsv(invites) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const rows = [['邀请码', '套餐', '过期时间'], ...invites.map((i) => [i.code, i.plan, i.expiresAt ? formatTime(i.expiresAt) : '永不过期'])]
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
}

export const EVENT_LABEL = {
  export_failed: '导出失败',
  task_failed: '生成任务失败',
  connect_test: '连接测试失败',
}

export const STEP_LABEL = {
  welcome: '欢迎页',
  key: '填写 Key',
  connect_test: '连接测试',
  first_project: '创建首个项目',
  first_export: '首次导出',
}

export const FEEDBACK_NOTE = '诊断包已在用户电脑上脱敏，但仍请只在处理工单时下载，勿转发。'

/** 柱状条宽度百分比（0-100），最大值为 0 时返回 0。 */
export function barPercent(value, max) {
  if (!max || max <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)))
}

export const LEVELS = [
  { value: 'info', label: '通知' },
  { value: 'warn', label: '提醒' },
  { value: 'critical', label: '重要' },
]
export const KINDS = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'tts', label: '配音' },
]

let seq = 0
/** 前端生成条目 id（服务端只要求唯一且 ≤ 40/60 字符）。 */
export function newId(prefix) {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}`
}

/** 保存前的本地校验：返回错误文字或 null。 */
export function validateCatalog(list) {
  const ids = new Set()
  for (const [i, c] of list.entries()) {
    const n = i + 1
    if (!c.name || !c.name.trim()) return `第 ${n} 行：名称不能为空`
    if (!c.provider || !c.provider.trim()) return `第 ${n} 行：提供方不能为空`
    if (!c.unit || !c.unit.trim()) return `第 ${n} 行：计价单位不能为空`
    if (typeof c.price !== 'number' || Number.isNaN(c.price) || c.price < 0) return `第 ${n} 行：价格必须是不小于 0 的数字`
    if (ids.has(c.id)) return `第 ${n} 行：id 重复`
    ids.add(c.id)
  }
  return null
}

export function validateAnnouncements(list) {
  for (const [i, a] of list.entries()) {
    if (!a.title || !a.title.trim()) return `第 ${i + 1} 条：标题不能为空`
    if ((a.body || '').length > 2000) return `第 ${i + 1} 条：正文不能超过 2000 字`
  }
  return null
}
