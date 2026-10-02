/**
 * 云备份页（P3-K）的纯逻辑：设置表单的默认值 / 校验 / 提交载荷、地址策略提示、快照按项目分组、
 * 运行记录与状态文案、字节与时间格式化。没有 Vue / DOM 依赖，可 node --test。
 *
 * 地址策略与本地服务一致：https:// 一律允许；http:// 只允许本机或局域网（10.x、172.16–31.x、192.168.x）。
 */

export const AUTO_OPTIONS = Object.freeze([
  { value: 'off', label: '关闭', hint: '只在你点「立即备份」时备份' },
  { value: 'daily', label: '每天一次', hint: '应用空闲时每天把所有项目各备份一次；离线则下次再试' },
  { value: 'after_export', label: '导出成片后', hint: '每次导出成片完成后，自动备份该项目' },
])

export const DEFAULT_FORM = Object.freeze({
  endpoint: '', region: 'us-east-1', bucket: '', prefix: 'talekiln', access_key: '', secret_key: '', auto: 'off', keep: 10, path_style: true,
})

export const PROVIDER_NOTE = '支持任何 S3 兼容的对象存储：自建 MinIO、阿里云 OSS（S3 兼容接口）、腾讯云 COS、Cloudflare R2 等。'
  + '只需填对地址、区域与存储桶；Secret Key 保存在系统密钥存储里，不会写进设置文件，也不会再显示。'

export const RESTORE_NOTE = '恢复总是新建一个项目（重名时自动加「导入N」），不会覆盖或改动现有项目。'

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,127}$/

function isLoopback(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  const m = IPV4.exec(h)
  return !!m && Number(m[1]) === 127
}

function isPrivate(host) {
  const m = IPV4.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * 地址检查：{ ok, insecure, message }。insecure = http 的本机 / 局域网地址（允许但提示）。
 */
export function checkEndpoint(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: false, insecure: false, message: '请填写对象存储地址' }
  let u
  try { u = new URL(s) } catch (_) { return { ok: false, insecure: false, message: '不是合法的网址' } }
  if (u.username || u.password) return { ok: false, insecure: false, message: '地址里不能带用户名或口令' }
  if (u.search || u.hash) return { ok: false, insecure: false, message: '地址里不能带查询串或锚点' }
  if (u.protocol === 'https:') return { ok: true, insecure: false, message: '' }
  if (u.protocol !== 'http:') return { ok: false, insecure: false, message: '只支持 https:// 或 http://' }
  if (isLoopback(u.hostname) || isPrivate(u.hostname)) return { ok: true, insecure: true, message: 'http:// 未加密，只适合本机或局域网里的 MinIO / NAS' }
  return { ok: false, insecure: false, message: 'http:// 只允许本机或局域网地址（10.x、172.16–31.x、192.168.x），公网地址请用 https://' }
}

/** 服务端设置 -> 表单（secret_key 永远留空；has_secret 单独带着）。 */
export function formFromSettings(s) {
  const src = s && typeof s === 'object' ? s : {}
  return {
    ...DEFAULT_FORM,
    endpoint: src.endpoint ?? '',
    region: src.region || DEFAULT_FORM.region,
    bucket: src.bucket ?? '',
    prefix: src.prefix || DEFAULT_FORM.prefix,
    access_key: src.access_key ?? '',
    secret_key: '',
    auto: AUTO_OPTIONS.some((o) => o.value === src.auto) ? src.auto : 'off',
    keep: Number.isInteger(src.keep) ? src.keep : DEFAULT_FORM.keep,
    path_style: src.path_style !== false,
  }
}

/** 表单校验：返回 { path: message }，空对象表示通过。hasSecret 为 true 时允许 secret_key 留空（沿用已保存的）。 */
export function validateForm(form, { hasSecret = false } = {}) {
  const f = form || {}
  const errors = {}
  const ep = checkEndpoint(f.endpoint)
  if (!ep.ok) errors.endpoint = ep.message
  const region = String(f.region ?? '').trim()
  if (region && !/^[a-z0-9-]{1,32}$/i.test(region)) errors.region = '区域只能是字母、数字和连字符'
  const bucket = String(f.bucket ?? '').trim()
  if (!bucket) errors.bucket = '请填写存储桶名称'
  else if (!BUCKET_RE.test(bucket)) errors.bucket = '存储桶名称只能是 3–63 位小写字母、数字、点或连字符'
  const prefix = String(f.prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (prefix && (!PREFIX_RE.test(prefix) || prefix.includes('..') || prefix.includes('//'))) errors.prefix = '前缀只能用字母、数字、点、下划线、连字符和 /'
  const ak = String(f.access_key ?? '').trim()
  if (!ak) errors.access_key = '请填写 Access Key'
  else if (/\s/.test(ak)) errors.access_key = 'Access Key 不能含空白字符'
  const sk = String(f.secret_key ?? '')
  if (!sk.trim() && !hasSecret) errors.secret_key = '请填写 Secret Key'
  if (!AUTO_OPTIONS.some((o) => o.value === f.auto)) errors.auto = '自动备份方式无效'
  const keep = Number(f.keep)
  if (!Number.isInteger(keep) || keep < 0 || keep > 365) errors.keep = '保留数量必须是 0–365 的整数（0 表示不清理）'
  return errors
}

/** 提交给 PUT /backup/settings 的载荷：secret_key 为空时不带（只写字段，不会覆盖已保存的密钥）。 */
export function settingsPayload(form) {
  const f = form || {}
  const out = {
    endpoint: String(f.endpoint ?? '').trim(),
    region: String(f.region ?? '').trim() || DEFAULT_FORM.region,
    bucket: String(f.bucket ?? '').trim(),
    prefix: String(f.prefix ?? '').trim().replace(/^\/+|\/+$/g, '') || DEFAULT_FORM.prefix,
    access_key: String(f.access_key ?? '').trim(),
    auto: f.auto,
    keep: Number(f.keep),
    path_style: f.path_style !== false,
  }
  const sk = String(f.secret_key ?? '').trim()
  if (sk) out.secret_key = sk
  return out
}

/** 测试连接的载荷：与设置一样，但 secret_key 为空时也不带（服务端用已保存的）。 */
export const testPayload = settingsPayload

/** 字节 -> 人话。 */
export function formatBytes(n) {
  if (n == null || n === '') return '—'
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '—'
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** ISO 时间 -> 本地 "YYYY-MM-DD HH:mm"；空或非法返回占位。 */
export function formatDate(iso, placeholder = '—') {
  if (!iso) return placeholder
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return placeholder
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function shortHash(hash, length = 12) {
  if (typeof hash !== 'string' || !hash) return ''
  return hash.length > length ? `${hash.slice(0, length)}…` : hash
}

export const TRIGGER_LABELS = Object.freeze({ manual: '手动', daily: '每日', after_export: '导出后' })
export const RUN_STATUS_LABELS = Object.freeze({ queued: '排队中', running: '进行中', done: '成功', failed: '失败' })
export const RUN_STATUS_TAG_TYPES = Object.freeze({ queued: 'info', running: 'warning', done: 'success', failed: 'danger' })

export function triggerLabel(t) { return TRIGGER_LABELS[t] || String(t || '—') }
export function runStatusLabel(s) { return RUN_STATUS_LABELS[s] || String(s || '—') }
export function runStatusTagType(s) { return RUN_STATUS_TAG_TYPES[s] || 'info' }
export function runKindLabel(k) { return k === 'restore' ? '恢复' : '备份' }

/** 运行记录 -> 表格行。 */
export function runRow(r) {
  const x = r || {}
  return {
    id: x.id, kind: runKindLabel(x.kind), trigger: triggerLabel(x.trigger), title: x.title || (x.drama_id != null ? `项目 #${x.drama_id}` : '—'),
    status: x.status, status_label: runStatusLabel(x.status), tag: runStatusTagType(x.status),
    size: formatBytes(x.size), started: formatDate(x.started_at), finished: formatDate(x.finished_at), error: x.error || '', key: x.key || '',
  }
}

/**
 * 快照按项目分组：[{ drama_id, title, exists, snapshots: [...] }]，组按最新快照时间倒序。
 * dramas 为当前项目列表（用于标题与「项目已不存在」的提示）；快照标题优先用清单里的。
 */
export function groupSnapshots(snapshots, dramas) {
  const byId = new Map()
  for (const d of Array.isArray(dramas) ? dramas : []) if (d && d.id != null) byId.set(Number(d.id), d)
  const groups = new Map()
  for (const s of Array.isArray(snapshots) ? snapshots : []) {
    if (!s || typeof s.key !== 'string') continue
    const id = Number(s.drama_id)
    if (!groups.has(id)) {
      const d = byId.get(id)
      groups.set(id, { drama_id: id, title: (d && d.title) || s.title || `项目 #${id}`, exists: !!d, snapshots: [] })
    }
    const g = groups.get(id)
    if (!byId.has(id) && s.title && g.title === `项目 #${id}`) g.title = s.title
    g.snapshots.push({ ...s, created: formatDate(s.created_at), size_label: formatBytes(s.size), hash: shortHash(s.sha256), verifiable: !!s.sha256 || !!s.manifest })
  }
  const out = [...groups.values()]
  for (const g of out) g.snapshots.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  out.sort((a, b) => String(b.snapshots[0]?.created_at || '').localeCompare(String(a.snapshots[0]?.created_at || '')))
  return out
}

/** 状态卡文案。 */
export function statusSummary(st) {
  const s = st || {}
  if (!s.configured) return { tone: 'info', text: '尚未配置：填好下面的对象存储信息并保存后，就可以备份了。' }
  if (s.running && s.current) return { tone: 'warning', text: `正在${s.current.kind === 'restore' ? '恢复' : '备份'}「${s.current.title || `项目 #${s.current.drama_id}`}」…` }
  if (s.offline_since) return { tone: 'warning', text: `上次连接对象存储失败（${formatDate(s.offline_since)}），会在下次操作或自动备份时重试。` }
  const parts = []
  if (s.last_run) parts.push(`最近一次备份：${formatDate(s.last_run.finished_at || s.last_run.started_at)} ${runStatusLabel(s.last_run.status)}${s.last_run.title ? `（${s.last_run.title}）` : ''}`)
  else parts.push('还没有备份过任何项目。')
  if (s.auto === 'daily') parts.push(s.next_daily_at ? `下次每日备份不早于 ${formatDate(s.next_daily_at)}。` : '每日备份已开启。')
  else if (s.auto === 'after_export') parts.push('导出成片后会自动备份该项目。')
  return { tone: s.last_run && s.last_run.status === 'failed' ? 'error' : 'success', text: parts.join(' ') }
}

/** 对象键里的快照时间戳；没有清单时的兜底显示。 */
export function snapshotLabel(s) {
  const x = s || {}
  return `${formatDate(x.created_at)} · ${formatBytes(x.size)}${x.sha256 ? '' : '（无校验信息）'}`
}
