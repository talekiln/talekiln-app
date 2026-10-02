// 插件审核（P3-P）后台页用到的纯函数：状态文案、--inspect JSON 的解析与登记体、动作门禁、签名状态、签名清单导出。有单元测试。
// 签名私钥只在云端服务器上，这里只决定"显示什么、能点什么"，真正的鉴权与签名都在云端。

export const PLUGIN_STATUS = {
  pending: { label: '待审核', type: 'warning' },
  approved: { label: '已通过', type: 'success' },
  rejected: { label: '已驳回', type: 'danger' },
}
export const STATUS_OPTIONS = [{ value: '', label: '全部状态' }, ...Object.entries(PLUGIN_STATUS).map(([value, v]) => ({ value, label: v.label }))]
export const statusTag = (s) => PLUGIN_STATUS[s] || { label: s || '—', type: 'info' }

export const REVIEW_ACTION_LABEL = { submit: '登记', approve: '通过', reject: '驳回', sign: '签名' }
export const reviewActionLabel = (a) => REVIEW_ACTION_LABEL[a] || a || '—'

export const SHA256_RE = /^[0-9a-f]{64}$/
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/

/** 签名状态：未签名 / 当前密钥已签 / 旧密钥签过（可用当前密钥重签）。activeKid 未知（非 ADMIN 看不到密钥信息）时只分已签/未签。 */
export function signState(v, activeKid) {
  const sig = v && v.signature
  if (!sig) return { label: '未签名', type: 'info', kid: null, stale: false }
  const stale = !!activeKid && sig.kid !== activeKid
  return { label: stale ? `旧密钥 ${sig.kid}` : `已签名 ${sig.kid}`, type: stale ? 'warning' : 'success', kid: sig.kid, stale }
}

/**
 * 解析粘贴的 `sign-plugin.mjs --inspect` 输出（或裸 `{ manifest, fileHashes }`）。只做浏览器里能做的检查；
 * 完整校验在云端。-> { manifest, fileHashes, hash } 或 { error }
 */
export function parseInspectText(text) {
  let r
  try {
    r = JSON.parse(String(text || ''))
  } catch (e) {
    return { error: `不是合法的 JSON：${e.message}` }
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { error: '须为 JSON 对象（--inspect 的输出）' }
  const m = r.manifest
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: '缺少 manifest 对象；请粘贴 sign-plugin.mjs --inspect 的完整输出' }
  for (const k of ['name', 'version', 'sdkVersion', 'capabilities', 'permissions', 'entry', 'files']) {
    if (m[k] === undefined) return { error: `manifest 缺少字段 ${k}` }
  }
  if (!Array.isArray(m.files) || !m.files.length) return { error: 'manifest.files 须为非空数组（--inspect 会自动填好）' }
  if (!m.files.includes(m.entry)) return { error: `manifest.files 必须包含 entry（${m.entry}）` }
  if (m.signature !== undefined) return { error: 'manifest 不要带 signature 字段，官方签名由云端生成' }
  const fh = r.fileHashes
  if (!fh || typeof fh !== 'object' || Array.isArray(fh)) return { error: '缺少 fileHashes 对象' }
  const keys = Object.keys(fh).sort()
  const files = [...m.files].sort()
  if (keys.length !== files.length || keys.some((k, i) => k !== files[i])) return { error: 'fileHashes 的键必须与 manifest.files 一一对应' }
  for (const k of keys) if (!SHA256_RE.test(String(fh[k]))) return { error: `${k} 的哈希不是 64 位十六进制 sha256` }
  return { manifest: m, fileHashes: fh, hash: typeof r.hash === 'string' ? r.hash : null }
}

/** 登记表单 -> 错误文案或 null。form.parsed 为 parseInspectText 的成功结果。 */
export function validateSubmission(f) {
  if (!f || !f.parsed || !f.parsed.manifest) return f && f.error ? f.error : '请先粘贴 --inspect 输出'
  const url = String(f.packageUrl || '').trim()
  if (!/^https:\/\/\S+$/.test(url)) return '包下载地址必须是 https:// 开头的完整地址'
  if (!SHA256_RE.test(String(f.sha256 || '').trim().toLowerCase())) return '包文件 sha256 须为 64 位十六进制（小写）'
  if (String(f.notes || '').length > 2000) return '备注不能超过 2000 字'
  return null
}

export function submitBody(f) {
  return {
    manifest: f.parsed.manifest,
    fileHashes: f.parsed.fileHashes,
    packageUrl: String(f.packageUrl).trim(),
    sha256: String(f.sha256).trim().toLowerCase(),
    notes: String(f.notes || ''),
  }
}

/**
 * 动作门禁（与云端状态机一致，云端仍会再查）：
 * 通过：非 approved 且有 plugins:review；驳回：非 rejected 且有 plugins:review；
 * 签名：有 plugins:sign、approved、且未用当前 kid 签过。-> { approve|reject|sign: { ok, reason } }
 */
export function actionGate(v, { canReview = false, canSign = false, activeKid = null } = {}) {
  const no = (reason) => ({ ok: false, reason })
  const ok = { ok: true, reason: '' }
  if (!v) return { approve: no('未选择版本'), reject: no('未选择版本'), sign: no('未选择版本') }
  const approve = !canReview ? no('需要运营及以上角色') : v.reviewStatus === 'approved' ? no('已通过') : ok
  const reject = !canReview ? no('需要运营及以上角色') : v.reviewStatus === 'rejected' ? no('已驳回') : ok
  let sign = ok
  if (!canSign) sign = no('只有管理员能用官方密钥签名')
  else if (v.reviewStatus !== 'approved') sign = no('只能给已通过审核的版本签名')
  else if (v.signature && activeKid && v.signature.kid === activeKid) sign = no(`已用当前密钥 ${activeKid} 签过`)
  else if (v.signature && !activeKid) sign = no('已签名；密钥信息未加载')
  return { approve, reject, sign }
}

/** 列表行：补状态标签、签名标签、文件数、能力摘要、短指纹。 */
export function versionRow(v, activeKid) {
  const m = (v && v.manifest) || {}
  return {
    ...v,
    status: statusTag(v.reviewStatus),
    sign: signState(v, activeKid),
    fileCount: Object.keys((v && v.fileHashes) || {}).length,
    caps: Array.isArray(m.capabilities) ? m.capabilities.join(', ') : '—',
    hashShort: v && v.hash ? `${v.hash.slice(0, 16)}…` : '—',
  }
}

export const prettyJson = (v) => (v === undefined || v === null ? '' : JSON.stringify(v, null, 2))

/** 文件哈希 -> 按路径排序的行。 */
export function fileHashRows(fileHashes) {
  return Object.entries(fileHashes || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, sha256]) => ({ path, sha256 }))
}

/** 作者要原样写回包里的 manifest.json 文本（末尾带换行）；未签名返回 null。 */
export function signedManifestText(v) {
  return v && v.signedManifest ? `${JSON.stringify(v.signedManifest, null, 2)}\n` : null
}

/** 下载文件名固定为 manifest.json：作者直接覆盖包里的同名文件（签名不覆盖 manifest.json 本身，所以不会失效）。 */
export const manifestFileName = () => 'manifest.json'

/** 页头密钥横幅文案（GET /admin/plugins/signing-key 的返回）。 */
export function keySummary(info) {
  if (!info || !info.kid) return { text: '签名密钥信息未加载', type: 'info' }
  if (!KID_RE.test(info.kid)) return { text: '签名密钥 kid 不合法', type: 'error' }
  const retired = Array.isArray(info.retiredKids) && info.retiredKids.length ? `；退役仍可验签：${info.retiredKids.join('、')}` : ''
  if (info.dedicated) return { text: `当前官方签名密钥 ${info.kid}（独立的插件签名密钥，只在云端服务器上）${retired}`, type: 'success' }
  return { text: `当前官方签名密钥 ${info.kid}（暂用许可证密钥；请按 docs/tencent-deploy.md 在服务器上配置独立的 PLUGIN_SIGNING_PRIVATE_KEY_PEM）${retired}`, type: 'warning' }
}
