/**
 * 合规入口与同意记录（P2-I）。纯逻辑，存储与环境都以依赖注入，可 node --test。
 * - 文本版本号 LEGAL_VERSION：协议或政策有实质修改时递增，旧同意记录随之失效。
 * - 链接地址只来自构建配置（VITE_LEGAL_*_URL），仓库里不写任何真实地址；未配置或不是 https 时显示“待发布”。
 * - 同意记录只写在本机浏览器存储（版本号 + 时间），不上传。
 */

/** 当前协议与隐私政策文本版本。文本上线前保持草案版本号，正式发布时由法务确认后改。 */
export const LEGAL_VERSION = 'draft-0'
export const CONSENT_STORAGE_KEY = 'talekiln.legal.consent'

export const LEGAL_LINKS = [
  { id: 'privacy', label: '隐私政策', envKey: 'VITE_LEGAL_PRIVACY_URL' },
  { id: 'terms', label: '用户协议', envKey: 'VITE_LEGAL_TERMS_URL' },
  { id: 'report', label: '举报与投诉', envKey: 'VITE_LEGAL_REPORT_URL' },
]

export const PENDING_LABEL = '待发布'

/** 只接受 https、无内嵌凭据的地址；否则返回 null。 */
export function normalizeLegalUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'https:' || u.username || u.password) return null
    return u.toString()
  } catch (_) {
    return null
  }
}

/** env 形如 import.meta.env；返回 [{ id, label, url|null, pending }]。 */
export function resolveLegalLinks(env = {}) {
  return LEGAL_LINKS.map((l) => {
    const url = normalizeLegalUrl(env && env[l.envKey])
    return { id: l.id, label: l.label, url, pending: !url }
  })
}

export function buildConsentRecord(now = new Date(), version = LEGAL_VERSION) {
  return { version, acceptedAt: new Date(now).toISOString() }
}

/** 读取同意记录；存储不可用、内容损坏一律当作“未同意”。 */
export function readConsent(storage) {
  try {
    const raw = storage && storage.getItem(CONSENT_STORAGE_KEY)
    if (!raw) return null
    const r = JSON.parse(raw)
    if (!r || typeof r.version !== 'string' || typeof r.acceptedAt !== 'string' || Number.isNaN(Date.parse(r.acceptedAt))) return null
    return { version: r.version, acceptedAt: r.acceptedAt }
  } catch (_) {
    return null
  }
}

/** 写入失败返回 false（调用方应提示并不放行）。 */
export function writeConsent(storage, record) {
  try {
    storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record))
    return true
  } catch (_) {
    return false
  }
}

/** 已同意且版本等于当前文本版本。 */
export function hasCurrentConsent(storage, version = LEGAL_VERSION) {
  const r = readConsent(storage)
  return !!r && r.version === version
}

/** 勾选并确认：写入记录。返回 { ok, record }。 */
export function recordConsent(storage, now = new Date(), version = LEGAL_VERSION) {
  const record = buildConsentRecord(now, version)
  return { ok: writeConsent(storage, record), record }
}

export function safeLocalStorage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch (_) { return null }
}
