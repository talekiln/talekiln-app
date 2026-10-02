// 导演模式面板的纯逻辑（无 Vue / DOM 依赖，可 node --test）。
// 数据来自 /episodes/:id/director/*（packages/local/src/director）：轮次记录 turn 带 steps / impact / cost_estimate / validation。
import { txLabel, formatTime } from './versionHistory.js'
import { formatMoney } from './spendView.js'

export const MESSAGE_MAX = 2000

export const STATUS_LABEL = { planned: '待执行', rejected: '已拒绝', applied: '已执行', undone: '已撤销' }
const STATUS_TYPE = { planned: 'primary', rejected: 'danger', applied: 'success', undone: 'info' }

const CHANGE_LABEL = { added: '新增', removed: '删除', moved: '调序', modified: '修改', unchanged: '不变' }
const DETAIL_LABEL = { content: '画面', lines: '台词', generation: '生成参数', segments: '片段', group: '场景', order: '顺序', added: '新增', removed: '删除' }

const cut = (s, n = 60) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
const r6 = (n) => Math.round(n * 1e6) / 1e6

/** 输入校验：{ ok, value } 或 { ok: false, error }。 */
export function validateMessage(text) {
  const t = String(text ?? '').trim()
  if (!t) return { ok: false, error: '请先说要改什么' }
  if (t.length > MESSAGE_MAX) return { ok: false, error: `要求太长（最多 ${MESSAGE_MAX} 字）` }
  return { ok: true, value: t }
}

/**
 * 轮次的显示状态：{ key, label, type, note }。
 * 记录状态 status 来自 director_turns；history_state 是撤销栈里的实时状态（applied / undone / discarded / null）——
 * 已执行的计划被顶栏撤销或被别的修改覆盖时，记录仍是 applied，但不能再从这里撤销，note 说明原因。
 */
export function turnStatus(turn) {
  const key = turn?.status || 'planned'
  const base = { key, label: STATUS_LABEL[key] || key, type: STATUS_TYPE[key] || 'info', note: '' }
  if (key === 'applied' && turn.history_state === 'undone') return { ...base, label: '已在顶栏撤销', type: 'info', note: '这次执行已被顶栏的撤销回退；重做后可再从这里撤销' }
  if (key === 'applied' && turn.history_state === 'discarded') return { ...base, label: '已被覆盖', type: 'info', note: '这次执行已被后来的修改覆盖，不能再撤销' }
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

const ID_ARGS = { shot_id: '镜头', a_id: '镜头', b_id: '镜头', line_id: '行', group: '场景', group_id: '场景', segment_id: '片段', node_id: '节点', before_segment_id: '片段', after_segment_id: '片段' }

function shotRef(id, nums) {
  return nums[id] ? `镜头 ${nums[id]}` : `镜头 ${id}`
}
function idRef(key, v, nums) {
  const kind = ID_ARGS[key]
  if (kind === '镜头') return shotRef(v, nums)
  return `${kind} ${v}`
}
function valueText(v) {
  if (v === null || v === undefined) return '清除'
  if (Array.isArray(v)) return v.join('、') || '（空）'
  if (typeof v === 'object') return cut(JSON.stringify(v), 60)
  return cut(String(v), 60)
}

/**
 * 一步的展示模型：{ index, title, target, detail, reason, ok, error, cost, costText }。
 *   title  动作中文名（TX_LABEL）
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
      details.push(`新顺序：${v.map((id) => (nums[id] ? `${nums[id]}` : id)).join(' → ')}`)
      continue
    }
    if ((k === 'patch' || k === 'params') && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [f, fv] of Object.entries(v)) details.push(`${FIELD_LABEL[f] || f}：${valueText(fv)}`)
      continue
    }
    if (k === 'shot_ids' || k === 'lines') { details.push(`${k === 'lines' ? '挂上的行' : '挂到镜头'}：${(v || []).map((id) => (nums[id] ? `${nums[id]}` : id)).join('、')}`); continue }
    details.push(`${FIELD_LABEL[k] || k}：${valueText(v)}`)
  }
  const cost = Number(step.cost) || 0
  return {
    index: step.index, title: txLabel(step.name), target: targets.join('、'), detail: details.join('；'), reason: step.reason || '',
    ok: step.ok !== false, error: step.error || '', cost, costText: cost > 0 ? formatMoney(cost) : '不花钱',
  }
}
const FIELD_LABEL = {
  title: '标题', description: '画面描述', location: '地点', time: '时间', shot_type: '景别', angle: '角度', movement: '运镜', image_prompt: '首帧提示词',
  video_prompt: '视频提示词', atmosphere: '氛围', characters: '角色', duration_ms: '时长（毫秒）', text: '文字', speaker: '说话人', kind: '类型',
  index: '位置', at: '拆分位置', at_line_index: '留在原镜头的行数', sep: '分隔符', seed: '种子', targets: '目标', in_ms: '入点', out_ms: '出点',
  gap_before_ms: '前空隙', at_ms: '切分位置', transition: '转场', path: '参数', value: '值',
}

/** 影响范围的展示模型。 */
export function impactSummary(impact, untouched = []) {
  if (!impact) return null
  const changed = (impact.changed_shots || []).map((c) => ({
    id: c.id, no: c.no, title: c.title || '', change: c.change,
    changeText: c.change === 'modified'
      ? `修改（${(c.changes || []).filter((x) => DETAIL_LABEL[x]).map((x) => DETAIL_LABEL[x]).join('、') || '内容'}）`
      : CHANGE_LABEL[c.change] || c.change,
  }))
  const unchanged = impact.unchanged_shots || []
  const d = impact.duration || { before_ms: 0, after_ms: 0 }
  return {
    changed,
    unchanged,
    unchangedText: unchanged.length ? `${unchanged.length} 个镜头不受影响${changed.length ? '' : '（全部）'}` : '每个镜头都会有变化',
    untouched: Array.isArray(untouched) ? untouched : [],
    durationText: durationText(d.before_ms, d.after_ms),
    staleCount: (impact.stale_nodes || []).length,
  }
}

/** "16.0 秒 → 17.5 秒（+1.5 秒）"；不变时 "16.0 秒（不变）"。 */
export function durationText(beforeMs, afterMs) {
  const b = Number(beforeMs) || 0
  const a = Number(afterMs) || 0
  if (a === b) return `${formatSeconds(b)}（不变）`
  const delta = (a - b) / 1000
  return `${formatSeconds(b)} → ${formatSeconds(a)}（${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} 秒）`
}

export function formatSeconds(ms) {
  return `${((Number(ms) || 0) / 1000).toFixed(1)} 秒`
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
    id: s.id, no: s.no, title: s.title || '（未命名镜头）', change: s.change || 'unchanged', dashed: (s.change || 'unchanged') !== 'unchanged',
    changeText: CHANGE_LABEL[s.change] || '', seconds: formatSeconds(s.used_ms),
  }))
}

/** 估价的展示模型：{ total, max, text, note, refusal, items, zero }。 */
export function costSummary(cost) {
  if (!cost) return { total: 0, max: 0, text: '花费未估算', note: '', refusal: '', items: [], zero: true }
  const cur = cost.currency || 'CNY'
  const total = Number(cost.total) || 0
  const max = Number(cost.max) || 0
  const zero = total <= 0
  const items = (cost.items || []).map((i) => ({
    node: i.node, kind: i.kind, shotNo: i.shot_no, step: i.step, estimate: Number(i.estimate) || 0, known: i.known !== false, basis: i.basis || '',
    text: `${i.shot_no ? `镜头 ${i.shot_no} ` : ''}${KIND_LABEL[i.kind] || i.kind}${i.model ? `（${i.model}）` : ''}：${Number(i.estimate) > 0 ? formatMoney(i.estimate, cur) : '不花钱'}`,
  }))
  const notes = []
  if (cost.sample_prices) notes.push('示例价目')
  if (cost.known === false) notes.push('部分价格未知')
  if (cost.error) notes.push('估价失败')
  return {
    total, max, zero, items,
    text: zero ? '不花钱' : `预计 ${formatMoney(total, cur)}${max > total ? `（最高 ${formatMoney(max, cur)}）` : ''}`,
    note: notes.join(' · '),
    refusal: cost.allowed === false && cost.refusal ? `超出花费上限：${cost.refusal.message || cost.refusal.reason}（执行计划不花钱；之后点“生成”时会被拒绝）` : '',
  }
}
const KIND_LABEL = { image: '首帧图', video: '视频', tts: '配音' }

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
