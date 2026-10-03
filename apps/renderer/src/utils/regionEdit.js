/**
 * 选镜改片（P3-R）与内核版本列表的纯逻辑（无 Vue / DOM 依赖，可 node --test）：
 * 入出点、画面区域的归一化、费用文案、请求体、内核版本的 V1..Vn 标签与 A/B 对比。
 * 服务端：packages/local/src/regionEdit（POST /shots/:id/edit-region 等）。
 */
import { t } from '../i18n/index.js'

export const FULL_RECT = Object.freeze({ x: 0, y: 0, w: 1, h: 1 })
export const MIN_SEGMENT_MS = 200
export const MIN_RECT_SIDE = 0.02
export const VIDEO_MIN_SEC = 1
export const VIDEO_MAX_SEC = 15
export const MODES = Object.freeze([
  { value: 'region', get label() { return t('storyboard.wb.mode.region') } },
  { value: 'segment', get label() { return t('storyboard.wb.mode.segment') } },
])

const round4 = (n) => Math.round(n * 1e4) / 1e4
const clamp01 = (n) => Math.min(1, Math.max(0, n))
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : NaN)

/** 归一化矩形（0..1，四位小数，裁到画面内）；无效或太小返回 null。 */
export function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null
  const x = clamp01(num(rect.x))
  const y = clamp01(num(rect.y))
  const w = num(rect.w)
  const h = num(rect.h)
  if ([x, y, w, h].some((n) => !Number.isFinite(n))) return null
  const out = { x: round4(x), y: round4(y), w: round4(Math.min(w, 1 - x)), h: round4(Math.min(h, 1 - y)) }
  if (out.w < MIN_RECT_SIDE || out.h < MIN_RECT_SIDE) return null
  return out
}

export const isFullRect = (rect) => !!rect && rect.x === 0 && rect.y === 0 && rect.w === 1 && rect.h === 1

/**
 * 鼠标拖拽（相对播放器左上角的像素坐标，任意方向）-> 归一化矩形。
 * 拖得太小（小于最小边长）返回 null，由调用方视为“点了一下”。
 */
export function rectFromDrag({ x0, y0, x1, y1 }, { width, height }) {
  if (!(width > 0) || !(height > 0)) return null
  const left = Math.min(x0, x1) / width
  const top = Math.min(y0, y1) / height
  const right = Math.max(x0, x1) / width
  const bottom = Math.max(y0, y1) / height
  return normalizeRect({ x: clamp01(left), y: clamp01(top), w: clamp01(right) - clamp01(left), h: clamp01(bottom) - clamp01(top) })
}

/**
 * object-fit: contain 下画面实际占据元素的区域（像素，相对元素左上角）：框选层贴在这块上，
 * 这样黑边不算进归一化坐标。视频尺寸未知时整块元素都算画面。
 */
export function contentBox({ elWidth, elHeight, videoWidth, videoHeight }) {
  if (!(elWidth > 0) || !(elHeight > 0)) return { left: 0, top: 0, width: 0, height: 0 }
  if (!(videoWidth > 0) || !(videoHeight > 0)) return { left: 0, top: 0, width: elWidth, height: elHeight }
  const scale = Math.min(elWidth / videoWidth, elHeight / videoHeight)
  const width = videoWidth * scale
  const height = videoHeight * scale
  return { left: (elWidth - width) / 2, top: (elHeight - height) / 2, width, height }
}

/** 矩形 -> 覆盖层的百分比样式。 */
export function rectStyle(rect) {
  const r = normalizeRect(rect) || FULL_RECT
  const pct = (n) => `${(n * 100).toFixed(2)}%`
  return { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }
}

/** 归一化矩形 -> 位置描述（中文与服务端 regionLabel 同一规则）。 */
export function rectLabel(rect) {
  const r = normalizeRect(rect)
  if (!r || (r.w >= 0.95 && r.h >= 0.95)) return t('region.rect.full')
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const hor = cx < 1 / 3 ? t('region.dir.left') : cx > 2 / 3 ? t('region.dir.right') : ''
  const ver = cy < 1 / 3 ? t('region.dir.top') : cy > 2 / 3 ? t('region.dir.bottom') : ''
  if (!hor && !ver) return t('region.rect.center')
  if (!ver) return t('region.rect.side', { dir: hor })
  if (!hor) return t('region.rect.edge', { dir: ver })
  return t('region.rect.corner', { ver, hor })
}

/** 矩形占画面的百分比（整数，至少 1）。 */
export function rectPercent(rect) {
  const r = normalizeRect(rect) || FULL_RECT
  return Math.max(1, Math.min(100, Math.round(r.w * r.h * 100)))
}

// ---------- 入点 / 出点 ----------

const toMs = (v) => (Number.isFinite(num(v)) ? Math.round(num(v)) : null)

/**
 * 把 { t0, t1 }（毫秒）裁到 [0, total]，并保证 t1 - t0 >= MIN_SEGMENT_MS（片子太短时允许整条）。
 * total 未知（0/null）时只保证 0 <= t0 < t1。
 */
export function clampRange(range, total) {
  const T = Number.isFinite(num(total)) && num(total) > 0 ? Math.round(num(total)) : null
  const min = T != null ? Math.min(MIN_SEGMENT_MS, T) : MIN_SEGMENT_MS
  let t0 = toMs(range?.t0) ?? 0
  let t1 = toMs(range?.t1) ?? (T != null ? T : t0 + min)
  t0 = Math.max(0, t0)
  if (T != null) t0 = Math.min(t0, Math.max(0, T - min))
  t1 = Math.max(t0 + min, t1)
  if (T != null) t1 = Math.min(t1, T)
  return { t0, t1 }
}

/** 默认范围：整条。 */
export const fullRange = (total) => clampRange({ t0: 0, t1: total }, total)

/** 设入点（I）：播放头位置成为 t0；越过出点时把出点一并后推。 */
export function markIn(range, at, total) {
  const t0 = Math.max(0, toMs(at) ?? 0)
  const t1 = Math.max(toMs(range?.t1) ?? 0, t0 + MIN_SEGMENT_MS)
  return clampRange({ t0, t1 }, total)
}

/** 设出点（O）：播放头位置成为 t1；早于入点时把入点一并前拉。 */
export function markOut(range, at, total) {
  const t1 = Math.max(0, toMs(at) ?? 0)
  const t0 = Math.min(toMs(range?.t0) ?? 0, Math.max(0, t1 - MIN_SEGMENT_MS))
  return clampRange({ t0, t1 }, total)
}

/** 片段条上的高亮位置（百分比样式）。 */
export function rangeStyle(range, total) {
  const T = Number.isFinite(num(total)) && num(total) > 0 ? num(total) : 0
  if (!T) return { left: '0%', width: '100%' }
  const r = clampRange(range, T)
  return { left: `${((r.t0 / T) * 100).toFixed(2)}%`, width: `${(((r.t1 - r.t0) / T) * 100).toFixed(2)}%` }
}

/** 片段条上的点击位置（0..1）-> 毫秒。 */
export const msAtFraction = (fraction, total) => Math.round(clamp01(num(fraction) || 0) * (num(total) > 0 ? num(total) : 0))

/** "1.50s" 风格的毫秒显示。 */
export function formatMs(ms) {
  const n = num(ms)
  if (!Number.isFinite(n)) return '--'
  return `${(Math.max(0, n) / 1000).toFixed(2)}s`
}

/** 只重做这一段按整秒向上取整（厂商按整秒出片），1..15 秒。与服务端 segmentSeconds 相同。 */
export function segmentSeconds(t0, t1) {
  const d = (toMs(t1) ?? 0) - (toMs(t0) ?? 0)
  return Math.min(VIDEO_MAX_SEC, Math.max(VIDEO_MIN_SEC, Math.ceil(d / 1000)))
}

// ---------- 费用 ----------

const SYMBOL = { CNY: '¥', USD: '$' }

/** 分 -> "¥0.20"。 */
export function formatCents(cents, currency = 'CNY') {
  const n = num(cents)
  if (!Number.isFinite(n)) return '--'
  const sym = SYMBOL[currency] || `${currency || ''} `
  return `${sym}${(Math.max(0, n) / 100).toFixed(2)}`
}

/** 相比整镜重做省多少（整数百分比，0..100）。 */
export function savingPercent(cents, fullCents) {
  const a = num(cents)
  const b = num(fullCents)
  if (!(b > 0) || !Number.isFinite(a)) return 0
  return Math.max(0, Math.min(100, Math.round((1 - a / b) * 100)))
}

/**
 * 估算结果（POST /shots/:id/edit-region, confirm=false 的 data）-> 一行费用文案。
 * 没有价格条目（known=false）时说明是样例价。
 */
export function costLine(est) {
  if (!est || !est.estimate) return ''
  const e = est.estimate
  const cur = e.currency || 'CNY'
  const seconds = est.segment?.seconds ?? segmentSeconds(est.edit?.t0_ms, est.edit?.t1_ms)
  let line = t('region.cost.segment', { sec: seconds, price: formatCents(e.cents, cur) })
  const notes = []
  if (e.full && e.full.cents > 0) {
    const s = savingPercent(e.cents, e.full.cents)
    notes.push(t(s > 0 ? 'region.cost.fullSave' : 'region.cost.full', { price: formatCents(e.full.cents, cur), pct: s }))
  }
  if (e.sample_prices || e.known === false) notes.push(t('region.cost.sample'))
  if (notes.length) line = t('region.cost.withNotes', { base: line, notes: notes.join(t('region.cost.sep')) })
  return line
}

/** 策略 -> 给用户看的一句话。 */
export function strategyText(strategy) {
  if (strategy === 'provider_mask') return t('region.strategy.mask')
  if (strategy === 'segment_splice') return t('region.strategy.splice')
  return ''
}

/** 估算响应 -> 不能提交的原因（可提交返回 ''）。 */
export function refusalText(est) {
  if (!est) return ''
  if (est.allowed === false) return est.refusal?.message || t('region.refusal.cap')
  if (est.provider_ready === false) return t('region.refusal.provider', { provider: est.provider || '' })
  return ''
}

// ---------- 请求体 ----------

/** 表单 -> POST /shots/:id/edit-region 请求体（confirm 由调用方加）。无效返回 null。 */
export function editRequestBody({ range, rect, prompt, mode = 'region', total }) {
  const r = clampRange(range, total)
  const text = String(prompt || '').trim()
  if (!text) return null
  if (!['region', 'segment'].includes(mode)) return null
  const body = { t0_ms: r.t0, t1_ms: r.t1, prompt: text, mode }
  const nr = mode === 'segment' ? (normalizeRect(rect) || FULL_RECT) : normalizeRect(rect)
  if (!nr) return null
  body.rect = nr
  return body
}

/** 表单是否可提交（有视频、有提示词、范围有效）。 */
export function canSubmitEdit({ total, prompt, range, rect, mode = 'region', busy = false }) {
  if (busy || !(num(total) > 0)) return false
  return !!editRequestBody({ range, rect, prompt, mode, total })
}

// ---------- 改片记录 ----------

export const REGION_STATUS = {
  get queued() { return t('region.status.queued') },
  get running() { return t('region.status.running') },
  get done() { return t('region.status.done') },
  get failed() { return t('region.status.failed') },
}
export const regionStatusText = (s) => (Object.hasOwn(REGION_STATUS, s) ? REGION_STATUS[s] : String(s || ''))
export const regionStatusType = (s) => (s === 'done' ? 'success' : s === 'failed' ? 'danger' : s === 'running' ? 'warning' : 'info')
export const isRegionPending = (s) => s === 'queued' || s === 'running'

/** 一条改片记录的摘要："1.00s–2.50s · 画面上方 · 把伞换成红色"。 */
export function regionLine(item) {
  if (!item) return ''
  const where = item.mode === 'segment' ? t('storyboard.wb.mode.segmentShort') : rectLabel(item.rect)
  return `${formatMs(item.t0_ms)}–${formatMs(item.t1_ms)} · ${where} · ${item.prompt || ''}`
}

// ---------- 内核版本 ----------

/** GET /episodes/:id/versions 的列表里找某镜头的视频节点项。 */
export function findVideoVersions(list, { node, shotId } = {}) {
  const arr = Array.isArray(list) ? list : []
  return arr.find((v) => v && v.type === 'video' && ((node && v.node === node) || (shotId && v.shot_id === shotId))) || null
}

/** 资产引用 -> 可播放地址。 */
export function versionVideoSrc(ref) {
  if (!ref || typeof ref !== 'string') return ''
  if (/^(https?:|data:|blob:)/i.test(ref)) return ref
  if (ref.startsWith('/static/')) return ref
  return `/static/${ref.replace(/^\/+/, '')}`
}

const SOURCE_KEYS = { 'legacy-import': 'storyboard.wb.source.import', 'legacy-sync': 'region.source.sync', rebase: 'region.source.rebase' }
function sourceText(source) {
  if (!source) return ''
  if (Object.hasOwn(SOURCE_KEYS, source)) return t(SOURCE_KEYS[source])
  if (String(source).startsWith('ai-task:')) return t('storyboard.wb.source.ai')
  if (String(source).startsWith('region-edit:')) return t('storyboard.wb.source.regionEdit')
  return String(source)
}

/**
 * 视频节点的版本列表（/versions 里的节点项）+ 改片记录 -> 工作台卡片：V1..Vn（按加入顺序，旧的在前）。
 * 改片结果（来源 region-edit:<id>）带上对应记录的入出点 / 区域 / 提示词。
 */
export function versionItems(info, regions = []) {
  const list = Array.isArray(info?.versions) ? info.versions : []
  const byResult = new Map()
  const byId = new Map()
  for (const r of Array.isArray(regions) ? regions : []) {
    if (r?.result_version_id) byResult.set(r.result_version_id, r)
    if (r?.id != null) byId.set(String(r.id), r)
  }
  return list.map((v, i) => {
    const src = String(v.source || '')
    const regionId = src.startsWith('region-edit:') ? src.slice('region-edit:'.length) : null
    const region = byResult.get(v.id) || (regionId ? byId.get(regionId) : null) || null
    const meta = v.metadata || {}
    const bits = []
    if (meta.model) bits.push(t('storyboard.wb.meta.model', { model: meta.model }))
    if (meta.duration_ms) bits.push(t('storyboard.wb.meta.seconds', { sec: (meta.duration_ms / 1000).toFixed(1) }))
    return {
      id: v.id,
      no: i + 1,
      label: `V${i + 1}`,
      adopted: !!v.adopted,
      current: !!v.current,
      playable: !!(v.asset && v.asset.ref),
      src: versionVideoSrc(v.asset?.ref),
      source: sourceText(v.source),
      isEdit: !!region || !!regionId,
      region,
      regionText: region ? regionLine(region) : '',
      meta: bits.join(' · '),
      created_at: v.created_at || null,
    }
  })
}

/** 第 n 个版本（1 起）可采用时返回它；不存在 / 不可播放返回 null。 */
export function versionAt(items, n) {
  const it = Array.isArray(items) ? items[n - 1] : null
  return it && it.playable ? it : null
}

/** 默认 A/B：A = 已采用（否则第一个可播放），B = 最新的另一个可播放版本（改片结果通常在最后）。 */
export function defaultVersionCompare(items) {
  const playable = (Array.isArray(items) ? items : []).filter((it) => it && it.playable)
  const a = playable.find((it) => it.adopted) || playable[0] || null
  const others = playable.filter((it) => it !== a)
  const b = others.length ? others[others.length - 1] : null
  return { a: a ? a.no : null, b: b ? b.no : null, showing: 'a' }
}

/** 采用版本的提示（服务端会让节点参数跟随版本配方，所以采用后都是“最新”）。 */
export function adoptHint(item) {
  if (!item) return ''
  if (item.adopted) return t('storyboard.wb.adopt.current')
  return t(item.isEdit ? 'storyboard.wb.adopt.edit' : 'storyboard.wb.adopt.plain')
}
