/**
 * 工作室页（P3-S）的纯逻辑：角色 / 状态文案、席位占用、成员行、共享条目的按钮状态、邀请表单校验、字节 / 时间格式化。
 * 没有 Vue / DOM 依赖，可 node --test。
 */

export const ROLE_LABEL = Object.freeze({ owner: '所有者', admin: '管理员', member: '成员' })
export const ROLE_OPTIONS = Object.freeze([
  { value: 'admin', label: '管理员', hint: '可邀请成员、发布与更新共享素材' },
  { value: 'member', label: '成员', hint: '可拉取共享素材，不能发布' },
])
export const WRITER_ROLES = Object.freeze(['owner', 'admin'])
export const SEAT_NOTE = '席位数由后台管理员设置（将来由订阅驱动）；席位定价待定，本页不涉及任何价格。待处理的邀请也会占用席位，撤销后释放。'
export const STORAGE_NOTE = '共享库使用「云备份」页配置的对象存储（同一个桶，shared/ 前缀下）；没配置时发布与拉取都不可用。'

export const roleLabel = (r) => ROLE_LABEL[r] || r || '—'
export const canPublish = (role, status = 'active') => WRITER_ROLES.includes(role) && (!status || status === 'active')

/** 席位：{ text: '2 / 3 席（1 份邀请待处理）', percent, tone } */
export function seatSummary(seats) {
  const s = seats && typeof seats === 'object' ? seats : {}
  const limit = Number.isInteger(s.limit) ? s.limit : 0
  const used = Number.isInteger(s.used) ? s.used : 0
  const pending = Number.isInteger(s.pending) ? s.pending : 0
  const occupied = used + pending
  const percent = limit > 0 ? Math.min(100, Math.round((occupied / limit) * 100)) : 100
  const tone = limit === 0 || occupied >= limit ? 'danger' : percent >= 80 ? 'warning' : 'success'
  const text = `${used} / ${limit} 席${pending ? `（${pending} 份邀请待处理）` : ''}`
  return { text, percent, tone, available: Math.max(0, limit - occupied), full: occupied >= limit }
}

/** 顶部状态条文案。 */
export function identitySummary(identity, { loggedIn = true } = {}) {
  if (!loggedIn) return { tone: 'warning', text: '工作室功能需要先登录账号' }
  const id = identity && typeof identity === 'object' ? identity : null
  if (!id) return { tone: 'info', text: '正在读取工作室信息…' }
  const n = Array.isArray(id.studios) ? id.studios.length : 0
  if (!n) return { tone: 'info', text: '你还没有加入任何工作室：创建一个，或输入邀请码加入' }
  const offline = id.online === false ? '（离线，显示的是上次同步的结果）' : ''
  const cur = id.studios.find((s) => s.id === id.current_studio_id)
  return { tone: id.online === false ? 'warning' : 'success', text: `已加入 ${n} 个工作室，当前：${cur ? cur.name : '—'}${offline}` }
}

export function studioOption(s) {
  const seats = seatSummary(s.seats)
  return { value: s.id, label: `${s.name} · ${roleLabel(s.my_role)} · ${seats.text}${s.status && s.status !== 'active' ? ' · 已停用' : ''}` }
}

/** 成员行：当前用户能对该成员做什么。 */
export function memberRow(m, { myRole, myEmail } = {}) {
  const self = !!myEmail && !!m.email && m.email.toLowerCase() === myEmail.toLowerCase()
  const isOwner = m.role === 'owner'
  const canRemove = !isOwner && (self || myRole === 'owner' || (myRole === 'admin' && m.role === 'member'))
  const canChangeRole = myRole === 'owner' && !isOwner && !self
  return {
    ...m, self, roleLabel: roleLabel(m.role), canRemove, canChangeRole,
    removeLabel: self ? '退出' : '移除',
    joinedText: m.joined_at ? formatDate(m.joined_at) : '—',
  }
}

/** 邀请表单校验：{ path: message }，空对象通过。 */
export function validateInvite(form) {
  const f = form || {}
  const errors = {}
  const email = String(f.email || '').trim()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = '邮箱格式不对'
  if (!ROLE_OPTIONS.some((o) => o.value === f.role)) errors.role = '请选择角色'
  const days = Number(f.expiresInDays)
  if (!Number.isInteger(days) || days < 1 || days > 90) errors.expiresInDays = '有效期须为 1–90 天'
  return errors
}

export function invitePayload(form) {
  const email = String(form.email || '').trim().toLowerCase()
  return { ...(email ? { email } : {}), role: form.role, expiresInDays: Number(form.expiresInDays) }
}

export const normalizeInviteCode = (s) => String(s || '').trim().toUpperCase().replace(/[\s-]/g, '')

/** 共享条目的状态 -> 标签与可用按钮。 */
export const STATE_LABEL = Object.freeze({
  mine: { label: '我发布的', type: 'success' },
  mine_outdated: { label: '我发布的 · 远端更新', type: 'warning' },
  pulled: { label: '已拉取 · 最新', type: 'info' },
  update_available: { label: '有更新', type: 'warning' },
  not_pulled: { label: '未拉取', type: '' },
})

/**
 * 条目的操作：pull（第一次拉取，角色要选项目）/ update（覆盖本机副本）/ republish（我发布的，重新发布）/ 无。
 * canPublish 来自列表接口（当前角色是否能写）。
 */
export function itemActions(item, { canPublish: writer = false } = {}) {
  const st = STATE_LABEL[item.state] || STATE_LABEL.not_pulled
  const actions = []
  if (item.state === 'mine' || item.state === 'mine_outdated') {
    if (writer && item.published_local_id != null) actions.push({ key: 'republish', label: item.state === 'mine_outdated' ? '覆盖远端' : '重新发布', type: 'default' })
  } else if (item.state === 'update_available') actions.push({ key: 'update', label: '更新本机副本', type: 'primary' })
  else if (item.state === 'not_pulled') actions.push({ key: 'pull', label: item.kind === 'template' ? '安装到本机' : '拉取到项目', type: 'primary' })
  return { ...st, actions, needsDrama: item.kind === 'character' && item.state === 'not_pulled' }
}

/** 列表行。 */
export function sharedRow(item, opts) {
  const a = itemActions(item, opts)
  const f = item.fields || {}
  return {
    ...item, stateLabel: a.label, stateType: a.type, actions: a.actions, needsDrama: a.needsDrama,
    subtitle: item.kind === 'template' ? [f.template_version ? `模板版本 ${f.template_version}` : '', f.genre || ''].filter(Boolean).join(' · ') : [f.role || '', f.description || ''].filter(Boolean).join(' · '),
    meta: [`v${item.version}`, item.author && item.author.email ? item.author.email : '匿名', formatDate(item.updated_at), item.kind === 'character' ? `${item.file_count} 张图 · ${formatBytes(item.total_size)}` : formatBytes(item.total_size)].filter(Boolean),
  }
}

/** 本机角色选项（发布选择器）：有本机主图的在前。 */
export function characterOption(c) {
  const hasImage = !!(c.local_path || (c.image_url && !/^https?:/i.test(c.image_url)))
  return { value: c.id, label: `${c.name || '（未命名）'}${c.role ? ` · ${c.role}` : ''}${hasImage ? '' : '（无本机图片）'}`, hasImage }
}

export function formatBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '—'
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
