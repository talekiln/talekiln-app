// 导演模式面板的纯逻辑（无 Vue / DOM 依赖，可 node --test）。
// 数据来自 /episodes/:id/director/*（packages/local/src/director）：轮次记录 turn 带 steps / impact / cost_estimate / validation。
import { t } from '../i18n/index.js'
import { txLabel, formatTime } from './versionHistory.js'
import { formatMoney } from './spendView.js'

export const MESSAGE_MAX = 2000

const STATUS_KEYS = ['planned', 'rejected', 'applied', 'undone']
export const statusLabel = (key) => (STATUS_KEYS.includes(key) ? t(`director.status.${key}`) : key)
const STATUS_TYPE = { planned: 'primary', rejected: 'danger', applied: 'success', undone: 'info' }

const CHANGE_KEYS = ['added', 'removed', 'moved', 'modified', 'unchanged']
const changeLabel = (c) => (CHANGE_KEYS.includes(c) ? t(`director.change.${c}`) : c)
const DETAIL_KEYS = ['content', 'lines', 'generation', 'segments', 'group', 'order', 'added', 'removed']
const sepList = () => t('director.sep.list')
const sepSemi = () => t('director.sep.semi')

const cut = (s, n = 60) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
const r6 = (n) => Math.round(n * 1e6) / 1e6

/** 输入校验：{ ok, value } 或 { ok: false, error }。 */
export function validateMessage(text) {
  const s = String(text ?? '').trim()
  if (!s) return { ok: false, error: t('director.err.empty') }
  if (s.length > MESSAGE_MAX) return { ok: false, error: t('director.err.tooLong', { max: MESSAGE_MAX }) }
  return { ok: true, value: s }
}

/**
 * 轮次的显示状态：{ key, label, type, note }。
 * 记录状态 status 来自 director_turns；history_state 是撤销栈里的实时状态（applied / undone / discarded / null）——
 * 已执行的计划被顶栏撤销或被别的修改覆盖时，记录仍是 applied，但不能再从这里撤销，note 说明原因。
 */
export function turnStatus(turn) {
  const key = turn?.status || 'planned'
  const base = { key, label: statusLabel(key), type: STATUS_TYPE[key] || 'info', note: '' }
  if (key === 'applied' && turn.history_state === 'undone') return { ...base, label: t('director.status.topUndone'), type: 'info', note: t('director.status.topUndoneNote') }
  if (key === 'applied' && turn.history_state === 'discarded') return { ...base, label: t('director.status.discarded'), type: 'info', note: t('director.status.discardedNote') }
  return base
}

/** 能否执行 / 撤销（配合按钮禁用）。ctx.busy：内核操作进行中。 */
export function canApply(turn, ctx = {}) {
  return !!turn && turn.status === 'planned' && !ctx.busy
}
export function canUndo(turn, ctx = {}) {
  return !!turn && turn.status === 'applied' && (turn.history_state == null || turn.history_state === 'applied') && !ctx.busy
}

/** 镜头 id -> 序号（取计划前的编号；新增的镜头只在计划后有号）。 */
export function shotNumberMap(impact) {
  const out = {}
  for (const s of impact?.shots_before || []) out[s.id] = s.no
  for (const s of impact?.shots_after || []) if (!(s.id in out)) out[s.id] = s.no
  return out
}

const ID_ARGS = { shot_id: 'shot', a_id: 'shot', b_id: 'shot', line_id: 'line', group: 'group', group_id: 'group', segment_id: 'segment', node_id: 'node', before_segment_id: 'segment', after_segment_id: 'segment' }

function shotRef(id, nums) {
  return t('director.ref.shot', { v: nums[id] ? nums[id] : id })
}
function idRef(key, v, nums) {
  const kind = ID_ARGS[key]
  if (kind === 'shot') return shotRef(v, nums)
  return t(`director.ref.${kind}`, { v })
}
function valueText(v) {
  if (v === null || v === undefined) return t('director.value.clear')
  if (Array.isArray(v)) return v.join(sepList()) || t('director.value.empty')
  if (typeof v === 'object') return cut(JSON.stringify(v), 60)
  return cut(String(v), 60)
}

/**
 * 一步的展示模型：{ index, title, target, detail, reason, ok, error, cost, costText }。
 *   title  动作显示名（history.tx.*）
 *   target 作用对象（镜头 2 / 行 line_3 / 场景 grp_1 …）
 *   detail 其余参数（patch 展开成 字段：值；顺序类列出镜头号）
 */
export function describeStep(step, nums = {}) {
  const args = step.args && typeof step.args === 'object' ? step.args : {}
  const targets = []
  const details = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue
    if (ID_ARGS[k] && typeof v === 'string') { targets.push(idRef(k, v, nums)); continue }
    if (k === 'ids' && Array.isArray(v)) {
      details.push(t('director.step.newOrder', { list: v.map((id) => (nums[id] ? `${nums[id]}` : id)).join(t('director.sep.arrow')) }))
      continue
    }
    if ((k === 'patch' || k === 'params') && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [f, fv] of Object.entries(v)) details.push(t('director.kv', { k: fieldLabel(f), v: valueText(fv) }))
      continue
    }
    if (k === 'shot_ids' || k === 'lines') { details.push(t(k === 'lines' ? 'director.step.attachedLines' : 'director.step.attachedShots', { list: (v || []).map((id) => (nums[id] ? `${nums[id]}` : id)).join(sepList()) })); continue }
    details.push(t('director.kv', { k: fieldLabel(k), v: valueText(v) }))
  }
  const cost = Number(step.cost) || 0
  return {
    index: step.index, title: txLabel(step.name), target: targets.join(sepList()), detail: details.join(sepSemi()), reason: step.reason || '',
    ok: step.ok !== false, error: step.error || '', cost, costText: cost > 0 ? formatMoney(cost) : t('director.free'),
  }
}
const FIELD_KEYS = [
  'title', 'description', 'location', 'time', 'shot_type', 'angle', 'movement', 'image_prompt', 'video_prompt', 'atmosphere', 'characters', 'duration_ms',
  'text', 'speaker', 'kind', 'index', 'at', 'at_line_index', 'sep', 'seed', 'targets', 'in_ms', 'out_ms', 'gap_before_ms', 'at_ms', 'transition', 'path', 'value',
]
function fieldLabel(f) {
  return FIELD_KEYS.includes(f) ? t(`director.field.${f}`) : f
}

/** 影响范围的展示模型。 */
export function impactSummary(impact, untouched = []) {
  if (!impact) return null
  const changed = (impact.changed_shots || []).map((c) => ({
    id: c.id, no: c.no, title: c.title || '', change: c.change,
    changeText: c.change === 'modified'
      ? t('director.modifiedWith', { list: (c.changes || []).filter((x) => DETAIL_KEYS.includes(x)).map((x) => t(`director.detail.${x}`)).join(sepList()) || t('director.detail.fallback') })
      : changeLabel(c.change),
  }))
  const unchanged = impact.unchanged_shots || []
  const d = impact.duration || { before_ms: 0, after_ms: 0 }
  return {
    changed,
    unchanged,
    unchangedText: unchanged.length ? `${t('director.unchangedCount', { n: unchanged.length })}${changed.length ? '' : t('director.unchangedAll')}` : t('director.allChange'),
    untouched: Array.isArray(untouched) ? untouched : [],
    durationText: durationText(d.before_ms, d.after_ms),
    staleCount: (impact.stale_nodes || []).length,
  }
}

/** "16.0 秒 → 17.5 秒（+1.5 秒）"；不变时 "16.0 秒（不变）"。 */
export function durationText(beforeMs, afterMs) {
  const b = Number(beforeMs) || 0
  const a = Number(afterMs) || 0
  if (a === b) return t('director.durationSame', { v: formatSeconds(b) })
  const delta = (a - b) / 1000
  return t('director.durationDelta', { b: formatSeconds(b), a: formatSeconds(a), sign: delta > 0 ? '+' : '−', delta: Math.abs(delta).toFixed(1) })
}

export function formatSeconds(ms) {
  return t('director.seconds', { n: ((Number(ms) || 0) / 1000).toFixed(1) })
}

/**
 * 节奏条：计划前 / 后各一行，每个镜头一段，宽度按时长占两者较大的总时长的百分比（两行同一比例尺）。
 * 返回 { before: [...], after: [...], scale_ms }，每段 { id, no, title, change, width, seconds }。
 */
export function rhythmBars(impact) {
  if (!impact) return { before: [], after: [], scale_ms: 0 }
  const sum = (list) => list.reduce((a, s) => a + (Number(s.used_ms) || 0), 0)
  const before = impact.shots_before || []
  const after = impact.shots_after || []
  const scale = Math.max(sum(before), sum(after), 1)
  const bar = (s) => ({ id: s.id, no: s.no, title: s.title || '', change: s.change || 'unchanged', width: r6(((Number(s.used_ms) || 0) / scale) * 100), seconds: formatSeconds(s.used_ms) })
  return { before: before.map(bar), after: after.map(bar), scale_ms: scale }
}

/** 「计划后」镜头预览：变化的镜头用虚线框（dashed）。 */
export function previewShots(impact) {
  return (impact?.shots_after || []).map((s) => ({
    id: s.id, no: s.no, title: s.title || t('director.unnamedShot'), change: s.change || 'unchanged', dashed: (s.change || 'unchanged') !== 'unchanged',
    changeText: CHANGE_KEYS.includes(s.change) ? t(`director.change.${s.change}`) : '', seconds: formatSeconds(s.used_ms),
  }))
}

/** 估价的展示模型：{ total, max, text, note, refusal, items, zero }。 */
export function costSummary(cost) {
  if (!cost) return { total: 0, max: 0, text: t('director.cost.unknown'), note: '', refusal: '', items: [], zero: true }
  const cur = cost.currency || 'CNY'
  const total = Number(cost.total) || 0
  const max = Number(cost.max) || 0
  const zero = total <= 0
  const items = (cost.items || []).map((i) => ({
    node: i.node, kind: i.kind, shotNo: i.shot_no, step: i.step, estimate: Number(i.estimate) || 0, known: i.known !== false, basis: i.basis || '',
    text: t('director.cost.item', {
      shot: i.shot_no ? t('director.cost.itemShot', { no: i.shot_no }) : '',
      kind: KIND_KEYS.includes(i.kind) ? t(`director.kind.${i.kind}`) : i.kind,
      model: i.model ? t('director.cost.itemModel', { model: i.model }) : '',
      amount: Number(i.estimate) > 0 ? formatMoney(i.estimate, cur) : t('director.free'),
    }),
  }))
  const notes = []
  if (cost.sample_prices) notes.push(t('director.cost.sample'))
  if (cost.known === false) notes.push(t('director.cost.partial'))
  if (cost.error) notes.push(t('director.cost.failed'))
  return {
    total, max, zero, items,
    text: zero ? t('director.free') : `${t('director.cost.estimated', { total: formatMoney(total, cur) })}${max > total ? t('director.cost.max', { max: formatMoney(max, cur) }) : ''}`,
    note: notes.join(t('director.sep.dot')),
    refusal: cost.allowed === false && cost.refusal ? t('director.cost.refusal', { why: cost.refusal.message || cost.refusal.reason }) : '',
  }
}
const KIND_KEYS = ['image', 'video', 'tts']

/** 整个轮次的卡片模型。ctx：{ busy }。 */
export function describeTurn(turn, ctx = {}) {
  const nums = shotNumberMap(turn.impact)
  const status = turnStatus(turn)
  const errors = turn.validation?.errors || []
  return {
    id: turn.id,
    message: turn.message,
    summary: turn.summary || '',
    time: formatTime(turn.created_at),
    model: turn.model ? `${turn.provider ? `${turn.provider} · ` : ''}${turn.model}` : '',
    status,
    rejected: turn.status === 'rejected',
    errors,
    raw: Array.isArray(turn.raw) ? turn.raw.join('\n\n----\n\n') : '',
    steps: (turn.steps || []).map((s) => describeStep(s, nums)),
    impact: impactSummary(turn.impact, turn.untouched),
    bars: rhythmBars(turn.impact),
    preview: previewShots(turn.impact),
    cost: costSummary(turn.cost_estimate),
    canApply: canApply(turn, ctx),
    canUndo: canUndo(turn, ctx),
    attempts: turn.validation?.attempts || 0,
  }
}

/** 轮次列表：新在前（服务端已排序，这里兜底）。 */
export function sortTurns(turns) {
  return [...(turns || [])].sort((a, b) => b.id - a.id)
}

/** 把执行 / 撤销 / 生成计划返回的记录合并进列表（同 id 替换，新 id 置顶）。 */
export function upsertTurn(turns, turn) {
  if (!turn) return turns
  const rest = (turns || []).filter((t) => t.id !== turn.id)
  return sortTurns([...rest, turn])
}
