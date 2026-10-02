// 工作室（P3-S）后台页用到的纯函数：席位占用文案、席位数校验、状态标签、列表行。有单元测试。
// 计费占位：席位数由这里的管理员手动设置，将来由订阅驱动；席位定价待定，本页不涉及任何价格。

export const STATUS_OPTIONS = [
  { value: 'active', label: '正常' },
  { value: 'suspended', label: '已停用' },
]
export const statusTag = (s) => (s === 'suspended' ? { label: '已停用', type: 'danger' } : { label: '正常', type: 'success' })
export const ROLE_LABEL = { owner: '所有者', admin: '管理员', member: '成员' }
export const roleLabel = (r) => ROLE_LABEL[r] || r || '—'
export const MAX_SEATS = 1000
export const SEAT_PRICING_NOTE = '席位定价待定：这里只设置席位上限，不涉及价格；接入订阅后由订阅驱动。'

/** 「2 / 3（1 份待处理邀请）」 */
export function seatText(seats) {
  const s = seats || {}
  const used = Number.isInteger(s.used) ? s.used : 0
  const limit = Number.isInteger(s.limit) ? s.limit : 0
  const pending = Number.isInteger(s.pending) ? s.pending : 0
  return `${used} / ${limit}${pending ? `（${pending} 份待处理邀请）` : ''}`
}

/** 席位占用的标签颜色：满了 danger，≥80% warning，否则 success。 */
export function seatTag(seats) {
  const s = seats || {}
  const limit = Number.isInteger(s.limit) ? s.limit : 0
  const occupied = (Number.isInteger(s.used) ? s.used : 0) + (Number.isInteger(s.pending) ? s.pending : 0)
  if (limit === 0 || occupied >= limit) return { label: seatText(s), type: 'danger' }
  if (occupied / limit >= 0.8) return { label: seatText(s), type: 'warning' }
  return { label: seatText(s), type: 'success' }
}

/** 新席位数 -> 错误文案或 null。不能低于当前 active 成员数（云端也会拒绝）。 */
export function validateSeatLimit(value, seats) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) return '席位数须为不小于 0 的整数'
  if (n > MAX_SEATS) return `席位数不能超过 ${MAX_SEATS}`
  const used = seats && Number.isInteger(seats.used) ? seats.used : 0
  if (n < used) return `席位数不能低于当前成员数（${used}），请先移除成员`
  return null
}

export const seatBody = (value) => ({ seatLimit: Number(value) })

/** 列表行。 */
export function studioRow(s) {
  return {
    ...s,
    seatLabel: seatText(s.seats),
    seatTag: seatTag(s.seats),
    statusTag: statusTag(s.status),
    ownerText: s.owner_email || s.ownerId || '—',
  }
}

/** 详情里的成员行（含已移除）。 */
export function memberRow(m) {
  return { ...m, roleLabel: roleLabel(m.role), statusLabel: m.status === 'removed' ? '已移除' : m.status === 'invited' ? '已邀请' : '在席', removed: m.status === 'removed' }
}

/** 详情里的邀请行。 */
export function inviteRow(i) {
  const state = i.used_at ? '已接受' : i.revoked_at ? '已撤销' : i.open === false ? '已过期' : '待处理'
  return { ...i, roleLabel: roleLabel(i.role), state, target: i.email || '任何人' }
}
