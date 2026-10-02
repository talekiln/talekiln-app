/**
 * 桌面端「云端更新 / 公告」的页面纯逻辑：状态来自主进程（preload 暴露的 window.talekilnDesktop），
 * 这里只负责文案、公告关闭记录（localStorage，按公告 id）与可见性过滤。浏览器开发模式下没有桥接对象，一律降级为「无」。
 */

export const DISMISS_KEY = 'talekiln.announcements.dismissed'
const MAX_DISMISSED = 200

/** 主进程桥接对象；不在 Electron 里（或 preload 未加载）返回 null。 */
export function desktopBridge(win = typeof window === 'undefined' ? null : window) {
  const b = win && win.talekilnDesktop
  return b && typeof b.getCloudStatus === 'function' ? b : null
}

/** 规范化主进程推来的状态；null / 结构不对 -> 空状态。 */
export function normalizeStatus(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const u = s.update && typeof s.update === 'object' && s.update.available === true && typeof s.update.version === 'string'
    ? { available: true, version: s.update.version, forced: s.update.forced === true, notes: typeof s.update.notes === 'string' ? s.update.notes : '', minVersion: s.update.minVersion ?? null }
    : { available: false }
  return {
    currentVersion: typeof s.currentVersion === 'string' ? s.currentVersion : '',
    channel: s.channel === 'beta' ? 'beta' : 'stable',
    update: u,
    announcements: Array.isArray(s.announcements) ? s.announcements.filter((a) => a && typeof a === 'object' && a.id != null && a.title) : [],
    checkedAt: typeof s.checkedAt === 'string' ? s.checkedAt : null,
    error: typeof s.error === 'string' ? s.error : null,
  }
}

/**
 * 关于页的更新提示：{ kind: 'update'|'latest'|'unknown'|'none', text, button }
 *  - update：有新版本 x.y.z（强制更新时加说明），按钮「去下载」
 *  - latest：检查过且没有更新
 *  - unknown：有桥接但还没检查过 / 检查失败
 *  - none：不在桌面端
 */
export function updateNotice(status, { desktop = true } = {}) {
  if (!desktop) return { kind: 'none', text: '', button: '' }
  const s = normalizeStatus(status)
  if (s.update.available) {
    const forced = s.update.forced ? '（此版本为必要更新，请尽快升级）' : ''
    return { kind: 'update', text: `有新版本 ${s.update.version}${forced}`, button: '去下载', version: s.update.version, notes: s.update.notes }
  }
  if (s.checkedAt && !s.error) return { kind: 'latest', text: `当前已是最新版本${s.currentVersion ? `（${s.currentVersion}）` : ''}`, button: '重新检查' }
  if (s.error === 'cloud_not_configured') return { kind: 'unknown', text: '未配置云端地址，无法检查更新', button: '' }
  if (s.error) return { kind: 'unknown', text: '上次检查更新失败（离线或云端不可达），稍后会自动重试', button: '重新检查' }
  return { kind: 'unknown', text: '尚未检查更新（启动约 30 秒后自动检查）', button: '立即检查' }
}

/** 「去下载」结果的提示文案；ok 时返回空串（electron-updater 自己弹窗 / 浏览器已打开）。 */
export function downloadResultText(r) {
  if (r && r.ok) return r.mode === 'browser' ? '已在浏览器打开下载页' : ''
  const reason = r && r.reason ? `：${r.reason}` : ''
  return `暂时无法下载${reason}。请到官网下载页获取新版本。`
}

export function readDismissed(storage) {
  try {
    const raw = storage && storage.getItem(DISMISS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : []
  } catch (_) { return [] }
}

/** 记一条已关闭的公告 id；返回新列表。写入失败（隐私模式 / 配额）不抛。 */
export function dismissAnnouncement(storage, id, current = readDismissed(storage)) {
  const key = String(id ?? '').trim()
  if (!key) return current
  const next = [...current.filter((x) => x !== key), key].slice(-MAX_DISMISSED)
  try { storage && storage.setItem(DISMISS_KEY, JSON.stringify(next)) } catch (_) { /* 忽略 */ }
  return next
}

/** 过滤掉已关闭的公告（按 id）。 */
export function visibleAnnouncements(list, dismissed) {
  const set = new Set((dismissed || []).map(String))
  return (Array.isArray(list) ? list : []).filter((a) => a && a.id != null && a.title && !set.has(String(a.id)))
}

/** 公告级别 -> Element Plus 的 el-alert type。 */
export function announcementAlertType(level) {
  if (level === 'critical') return 'error'
  if (level === 'warn') return 'warning'
  return 'info'
}
