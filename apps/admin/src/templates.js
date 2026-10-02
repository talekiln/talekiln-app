// 模板市场（P3-T）后台页用到的纯函数：表单校验、清单解析与摘要、版本状态。有单元测试。

export const TIER_OPTIONS = [
  { value: 'free', label: '免费' },
  { value: 'pro', label: '付费' },
]
export const tierLabel = (t) => (TIER_OPTIONS.find((x) => x.value === t) || { label: t || '—' }).label

export const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/

/** 新建模板表单 -> 错误文案或 null。 */
export function validateTemplate(f) {
  if (!TEMPLATE_ID_RE.test(String(f.id || '').trim())) return '模板 id 须为 2–64 位小写字母、数字、点、下划线或连字符'
  if (!String(f.name || '').trim()) return '名称必填'
  if (String(f.name || '').trim().length > 100) return '名称不能超过 100 字'
  if (!String(f.genre || '').trim()) return '类型必填'
  if (!TIER_OPTIONS.some((t) => t.value === f.tier)) return '档位须为免费或付费'
  if (String(f.description || '').length > 2000) return '简介不能超过 2000 字'
  return null
}

export function templateBody(f) {
  return { id: String(f.id).trim(), name: String(f.name).trim(), genre: String(f.genre).trim(), tier: f.tier, description: String(f.description || '') }
}

/**
 * 解析粘贴的清单文本。只做能在浏览器里做的检查（JSON、必填字段、镜头非空、id 一致）；
 * 完整校验与签名由云端完成。-> { manifest } 或 { error }
 */
export function parseManifestText(text, expectedId) {
  let m
  try {
    m = JSON.parse(String(text || ''))
  } catch (e) {
    return { error: `不是合法的 JSON：${e.message}` }
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: '清单必须是 JSON 对象' }
  for (const k of ['id', 'name', 'version', 'genre', 'tier', 'style', 'character_slots', 'shots']) {
    if (m[k] === undefined) return { error: `缺少字段 ${k}` }
  }
  if (!Array.isArray(m.shots) || !m.shots.length) return { error: 'shots 至少一个镜头' }
  if (!Array.isArray(m.character_slots)) return { error: 'character_slots 须为数组' }
  if (expectedId && m.id !== expectedId) return { error: `清单 id（${m.id}）与模板 id（${expectedId}）不一致` }
  if (m.signature !== undefined) return { error: '清单不要带 signature 字段，签名由云端生成' }
  return { manifest: m }
}

/** 「8 个镜头 · 3 个角色槽位 · 45 秒」 */
export function manifestSummary(m) {
  if (!m || !Array.isArray(m.shots)) return '—'
  const ms = m.shots.reduce((a, s) => a + (Number(s.duration_ms) || 0), 0)
  const sec = Math.round(ms / 1000)
  const slots = Array.isArray(m.character_slots) ? m.character_slots.length : 0
  return `${m.shots.length} 个镜头 · ${slots} 个角色槽位 · ${sec} 秒`
}

export function versionBody(form) {
  const url = String(form.packageUrl || '').trim()
  return { manifest: form.manifest, packageUrl: url || null }
}

export const versionState = (v) => (v && v.published ? { label: '已发布', type: 'success' } : { label: '未发布', type: 'info' })

/** 目录里实际下发的版本：最近发布的那个（publishedAt 最新）。 */
export function latestPublished(versions) {
  const pub = (versions || []).filter((v) => v.published && v.publishedAt)
  if (!pub.length) return null
  return pub.reduce((a, b) => (new Date(b.publishedAt) > new Date(a.publishedAt) ? b : a))
}

/** 列表行：模板 + 目录状态。 */
export function templateRow(t) {
  const live = latestPublished(t.versions)
  return {
    ...t,
    versionCount: (t.versions || []).length,
    liveVersion: live ? live.version : null,
    state: live ? { label: `目录中：v${live.version}`, type: 'success' } : { label: '未发布', type: 'info' },
  }
}
