// 模板市场（P3-T，设计稿 P3-01）的纯函数：分组、「套用后会得到」摘要、估价文案、角色槽位映射校验、请求体。
import { formatMoney } from './spendView.js'

// 内置官方模板的 genre（docs/phase3-templates.md §1）都要有中文名；未知类型原样显示。
export const GENRE_LABEL = {
  guofeng: '国风短剧',
  'urban-sweet': '都市甜宠',
  revenge: '逆袭打脸',
  suspense: '悬疑反转',
  rebirth: '穿越重生',
  campus: '校园青春',
  family: '家庭伦理',
  workplace: '职场逆袭',
  healing: '萌宠治愈',
  ecommerce: '产品种草',
  knowledge: '知识讲解',
  romance: '都市言情',
  comedy: '喜剧',
  vlog: '生活记录',
}
export const genreLabel = (g) => GENRE_LABEL[g] || (g ? String(g) : '其他')

export const TIER_LABEL = {
  free: { label: '免费', type: 'success' },
  pro: { label: '付费', type: 'warning' },
}
export const tierLabel = (t) => TIER_LABEL[t] || { label: t || '—', type: 'info' }

export const SOURCE_LABEL = { builtin: '内置', cloud: '云端', local: '本地导入' }
export const sourceLabel = (s) => SOURCE_LABEL[s] || s || '—'

export const SIGNATURE_LABEL = {
  official: { label: '官方', type: 'primary' },
  unsigned: { label: '未签名', type: 'info' },
  invalid: { label: '签名无效', type: 'danger' },
}
export const signatureLabel = (s) => SIGNATURE_LABEL[s] || { label: s || '—', type: 'info' }

/** 毫秒 -> 「45 秒」「1 分 20 秒」。 */
export function formatDuration(ms) {
  const s = Math.round((Number(ms) || 0) / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m} 分 ${r} 秒` : `${m} 分`
}

/**
 * 按类型分组：组按首次出现顺序，组内按使用次数降序、名字升序。
 * -> [{ genre, label, items }]
 */
export function groupByGenre(items) {
  const groups = new Map()
  for (const it of items || []) {
    const g = it.genre || ''
    if (!groups.has(g)) groups.set(g, { genre: g, label: genreLabel(g), items: [] })
    groups.get(g).items.push(it)
  }
  const byUse = (a, b) => (Number(b.use_count) || 0) - (Number(a.use_count) || 0) || String(a.name).localeCompare(String(b.name), 'zh')
  return [...groups.values()].map((g) => ({ ...g, items: [...g.items].sort(byUse) }))
}

/** 「套用后会得到」：由服务端 summary（或清单推出的同形对象）生成的文案行。 */
export function summaryLines(summary) {
  if (!summary) return []
  const out = []
  const groups = Array.isArray(summary.groups) ? summary.groups : []
  const seg = groups.length ? `，${groups.length} 个段落（${groups.join('、')}）` : ''
  out.push(`${summary.shot_count || 0} 个镜头，总时长 ${formatDuration(summary.total_duration_ms)}${seg}`)
  const slots = Array.isArray(summary.slots) ? summary.slots : []
  out.push(slots.length ? `${slots.length} 个角色槽位：${slots.map((s) => s.name).join('、')}` : '没有角色槽位，不需要映射角色')
  if (summary.style) {
    const extra = [summary.style.preset, summary.style.aspect_ratio].filter(Boolean).join('，')
    out.push(`风格：${summary.style.name}${extra ? `（${extra}）` : ''}`)
  }
  if (summary.line_count) out.push(`${summary.line_count} 条台词 / 旁白行，会直接进入剧本`)
  if (summary.music_hint) out.push(`配乐提示：${summary.music_hint}`)
  if (Array.isArray(summary.cameras) && summary.cameras.length) out.push(`运镜：${summary.cameras.join('、')}`)
  return out
}

/** 估价文案：「预计 ¥6.10，最高 ¥7.32（示例价）」；没有价格时说明。 */
export function estimateText(est) {
  if (!est) return ''
  const cur = est.currency || 'CNY'
  let s = `预计 ${formatMoney(est.total, cur)}，最高 ${formatMoney(est.max, cur)}`
  if (est.known === false) s += '（部分模型没有价格，按 0 计）'
  if (est.sample_prices) s += '（示例价）'
  return s
}

/** 当前账号能否套用该模板。 */
export function canApply(tpl, proAvailable, proReason) {
  if (!tpl) return { ok: false, reason: '' }
  if (tpl.tier === 'pro' && !proAvailable) return { ok: false, reason: proReason || '付费模板需要登录并开通套餐' }
  return { ok: true, reason: '' }
}

/**
 * 项目角色 + 锁定参考图 -> 下拉选项：锁定的排前面并标注。
 * characters: [{ id, name }]；locks: [{ entity_id, image_url, local_path }]
 */
export function characterOptions(characters, locks) {
  const locked = new Set((locks || []).map((l) => Number(l.entity_id)))
  return (characters || [])
    .map((c) => ({ id: Number(c.id), name: c.name, locked: locked.has(Number(c.id)), label: `${c.name}${locked.has(Number(c.id)) ? '（已锁定参考图）' : ''}` }))
    .sort((a, b) => Number(b.locked) - Number(a.locked) || a.name.localeCompare(b.name, 'zh'))
}

/**
 * 校验角色槽位映射。slots: summary.slots；map: { slotId: characterId|null }；options: characterOptions 的结果。
 * -> { ok, errors: [文案], mapped: n, unmapped: [槽位名] }
 * 未映射的槽位允许（套用时按槽位描述新建占位角色），映射到不存在的角色或两个槽位映射同一角色为错误。
 */
export function validateSlotMapping(slots, map, options) {
  const errors = []
  const ids = new Set((options || []).map((o) => Number(o.id)))
  const used = new Map()
  let mapped = 0
  const unmapped = []
  for (const s of slots || []) {
    const v = map ? map[s.id] : null
    if (v === null || v === undefined || v === '') { unmapped.push(s.name); continue }
    const cid = Number(v)
    if (!ids.has(cid)) { errors.push(`「${s.name}」映射的角色不在所选项目里`); continue }
    if (used.has(cid)) errors.push(`「${used.get(cid)}」和「${s.name}」映射了同一个角色`)
    used.set(cid, s.name)
    mapped++
  }
  return { ok: errors.length === 0, errors, mapped, unmapped }
}

/** 套用请求体：空值不带。 */
export function applyBody({ mode, dramaId, title, map }) {
  const body = { mode: mode === 'episode' ? 'episode' : 'new', character_map: {} }
  if (body.mode === 'episode') body.drama_id = Number(dramaId)
  const t = String(title || '').trim()
  if (t) body.title = t
  for (const [slot, v] of Object.entries(map || {})) {
    if (v !== null && v !== undefined && v !== '') body.character_map[slot] = Number(v)
  }
  return body
}

/** 套用成功后跳转：分镜表，定位到新建的那一集。 */
export function applyTarget(result) {
  return { path: `/project/${result.drama_id}/storyboard`, query: { episode: String(result.episode_id) } }
}

/** 云端目录条目相对本地的状态。 */
export function cloudItemState(item) {
  if (!item.installed) return { label: '未安装', type: 'info', action: '安装' }
  if (item.installed_version && item.installed_version !== item.version) return { label: `可更新（本地 ${item.installed_version}）`, type: 'warning', action: '更新' }
  return { label: '已安装', type: 'success', action: '重新安装' }
}
