/**
 * 插件页（P3-02）的纯逻辑：把 GET /providers 的内置服务商与 GET /plugins 的已安装插件合成一张表，
 * 算每行的签名标签、开关状态、能力与权限文案、详情行。没有 Vue / DOM 依赖，可 node --test。
 *
 * 信任模型（与 docs/phase3-plugins.md 一致）：
 *   builtin   随应用发布的内置服务商：不可卸载，开关由安装包（config.yaml）决定
 *   official  官方签名的插件：验签通过，开关可用
 *   unsigned / invalid  未签名或签名无效：只有开发者模式打开时才能启用，列表里用警示色标出
 */
import { normalizeProviders } from './providerEnablement.js'

export const SIGNATURE_LABELS = Object.freeze({
  builtin: '官方内置',
  official: '官方签名',
  unsigned: '未签名',
  invalid: '签名无效',
})

/** Element Plus 的 tag 颜色。 */
export const SIGNATURE_TAG_TYPES = Object.freeze({
  builtin: 'success',
  official: 'success',
  unsigned: 'warning',
  invalid: 'danger',
})

export const CAPABILITY_LABELS = Object.freeze({
  'text.stream': '文本生成',
  'llm.chat': '文本生成',
  'image.generate': '图片生成',
  'video.submit': '视频生成',
  'video.poll': '视频生成',
  'tts.synthesize': '配音合成',
})

export const PERMISSION_LABELS = Object.freeze({
  'secret:apiKey': '使用你保存的 API Key',
})

/** 页脚：社区插件的维护责任说明。 */
export const COMMUNITY_NOTE = '社区插件由各自的维护者开发和维护。官方签名只说明插件包来自登记的作者且未被改动，不代表官方审核过其全部行为；'
  + '插件会使用你为它保存的 API Key，并只能访问它声明的主机。遇到问题请联系插件主页列出的维护者。'

export const DEVELOPER_MODE_NOTE = '开发者模式会允许加载未签名或签名无效的插件。这些插件和内置代码拥有同样的权限，只安装你自己写的或完全信任的插件。'

/** SDK 文档地址：构建配置 VITE_PLUGIN_SDK_DOCS_URL 优先，否则指向公开仓库里的 SDK 说明。 */
export const DEFAULT_SDK_DOCS_URL = 'https://github.com/talekiln/talekiln-app/tree/main/packages/plugin-sdk#readme'

export function sdkDocsUrl(env = {}) {
  const raw = env && env.VITE_PLUGIN_SDK_DOCS_URL
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const u = new URL(raw.trim())
      if (u.protocol === 'https:' && !u.username && !u.password) return u.toString()
    } catch (_) { /* 非法地址回落默认 */ }
  }
  return DEFAULT_SDK_DOCS_URL
}

export function signatureLabel(status) {
  return SIGNATURE_LABELS[status] || SIGNATURE_LABELS.invalid
}

export function signatureTagType(status) {
  return SIGNATURE_TAG_TYPES[status] || 'danger'
}

/** 能力列表 -> 去重后的中文标签（video.submit 与 video.poll 合并为“视频生成”）。 */
export function capabilityLabels(capabilities) {
  const out = []
  for (const c of Array.isArray(capabilities) ? capabilities : []) {
    const label = CAPABILITY_LABELS[c] || String(c)
    if (!out.includes(label)) out.push(label)
  }
  return out
}

/** 权限文案：network:<host> 合并成一条“访问 a.example、b.example”，其余按表翻译。 */
export function permissionLabels(permissions) {
  const list = Array.isArray(permissions) ? permissions.filter((p) => typeof p === 'string') : []
  const hosts = list.filter((p) => p.startsWith('network:')).map((p) => p.slice(8))
  const out = []
  if (hosts.length) out.push(`访问 ${hosts.join('、')}`)
  for (const p of list) {
    if (p.startsWith('network:')) continue
    out.push(PERMISSION_LABELS[p] || p)
  }
  return out
}

export function shortHash(hash, length = 12) {
  if (typeof hash !== 'string' || !hash) return ''
  return hash.length > length ? `${hash.slice(0, length)}…` : hash
}

/** ISO 时间 -> 本地 "YYYY-MM-DD HH:mm"；空或非法返回占位。 */
export function formatDate(iso, placeholder = '—') {
  if (!iso) return placeholder
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return placeholder
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 内置服务商（GET /providers 只下发已开放的；隐藏的一期服务商不会出现）。 */
export function builtinItem(p) {
  return {
    id: p.id, label: p.label || p.id, source: 'builtin', version: null, description: '', homepage: null,
    capabilities: [], permissions: [], hosts: [], needs_api_key: true,
    signature: { status: 'builtin', kid: null, hash: null, reason: null },
    enabled: true, active: true, locked: true, blocked_reason: null, load_error: null,
    installed_at: null, updated_at: null, reviewed_at: null, dir: null, sdk_version: null,
  }
}

/** 已安装插件（GET /plugins 的 items 元素），补齐缺省字段。 */
export function pluginItem(p) {
  const sig = p && p.signature && typeof p.signature === 'object' ? p.signature : {}
  const status = ['official', 'unsigned', 'invalid'].includes(sig.status) ? sig.status : 'invalid'
  const permissions = Array.isArray(p.permissions) ? p.permissions : []
  return {
    id: p.id, label: p.label || p.name || p.id, name: p.name || p.id, source: 'plugin', version: p.version || null,
    description: p.description || '', homepage: p.homepage || null,
    capabilities: Array.isArray(p.capabilities) ? p.capabilities : [], permissions,
    hosts: Array.isArray(p.hosts) ? p.hosts : permissions.filter((x) => typeof x === 'string' && x.startsWith('network:')).map((x) => x.slice(8)),
    needs_api_key: p.needs_api_key !== undefined ? !!p.needs_api_key : permissions.includes('secret:apiKey'),
    signature: { status, kid: sig.kid || null, hash: sig.hash || null, reason: sig.reason || null },
    enabled: !!p.enabled, active: !!p.active, locked: false,
    blocked_reason: p.blocked_reason || null, load_error: p.load_error || null,
    installed_at: p.installed_at || null, updated_at: p.updated_at || null, reviewed_at: p.reviewed_at || null,
    dir: p.dir || null, sdk_version: p.sdk_version || null,
  }
}

/**
 * 一张表：内置在前（按服务端顺序），插件在后（按名称）。与内置同名的插件丢弃（服务端本就拒绝，这里兜底）。
 * providers 缺失时按 providerEnablement 的默认（只开放百炼）。
 */
export function mergeProviderList(providers, plugins) {
  const builtins = normalizeProviders(providers).map(builtinItem)
  const taken = new Set(builtins.map((b) => b.id))
  const items = (Array.isArray(plugins) ? plugins : [])
    .filter((p) => p && typeof p.id === 'string' && p.id && !taken.has(p.id))
    .map(pluginItem)
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
  return [...builtins, ...items]
}

/** 开关的状态：checked / disabled / 为什么不能动。 */
export function switchState(item, developerMode) {
  if (item.source === 'builtin') return { checked: true, disabled: true, hint: '内置服务商随应用发布，开关由安装包决定' }
  const trusted = item.signature.status === 'official'
  if (!trusted && !developerMode) {
    return { checked: item.enabled, disabled: true, hint: `${signatureLabel(item.signature.status)}的插件需要先打开开发者模式才能启用` }
  }
  return { checked: item.enabled, disabled: false, hint: null }
}

/** 行上的状态文案：在跑 / 已关闭 / 被拦下的原因。 */
export function statusText(item, developerMode) {
  if (item.source === 'builtin') return '可用'
  if (!item.enabled) return '已关闭'
  if (item.active) return developerMode && item.signature.status !== 'official' ? '运行中（开发者模式）' : '运行中'
  if (item.load_error) return `加载失败：${item.load_error}`
  if (item.signature.status !== 'official') return '未启用：需开启开发者模式'
  return item.blocked_reason || '未启用'
}

/** 详情抽屉的行。 */
export function detailRows(item) {
  const sig = item.signature || {}
  const rows = [
    { key: 'source', label: '来源', value: item.source === 'builtin' ? '随应用内置' : '安装的插件' },
    { key: 'version', label: '版本', value: item.version || '—' },
    { key: 'capabilities', label: '能力', value: capabilityLabels(item.capabilities).join('、') || (item.source === 'builtin' ? '见 AI 配置' : '—') },
    { key: 'hosts', label: '允许访问的主机', value: item.hosts && item.hosts.length ? item.hosts.join('、') : (item.source === 'builtin' ? '服务商官方接口' : '—') },
    { key: 'permissions', label: '权限', value: permissionLabels(item.permissions).join('；') || (item.source === 'builtin' ? '使用你保存的 API Key' : '—') },
    { key: 'signature', label: '签名状态', value: signatureLabel(sig.status) + (sig.reason && sig.status === 'invalid' ? `（${sig.reason}）` : '') },
  ]
  if (item.source !== 'builtin') {
    rows.push(
      { key: 'kid', label: '签名密钥', value: sig.kid || '—' },
      { key: 'hash', label: '包指纹', value: sig.hash || '—' },
      { key: 'reviewed', label: '审核日期', value: formatDate(item.reviewed_at, '未知') },
      { key: 'installed', label: '安装时间', value: formatDate(item.installed_at) },
      { key: 'sdk', label: 'SDK 版本', value: item.sdk_version || '—' },
      { key: 'dir', label: '安装目录', value: item.dir || '—' },
      { key: 'homepage', label: '主页', value: item.homepage || '—', link: item.homepage && /^https:\/\//.test(item.homepage) ? item.homepage : null },
    )
  }
  return rows
}

/** 安装对话框输入的路径：去空白与包裹引号；空返回 null。 */
export function normalizeInstallPath(raw) {
  const s = String(raw ?? '').trim().replace(/^["']|["']$/g, '').trim()
  return s || null
}
