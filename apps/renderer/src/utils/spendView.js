// 花费页的纯函数：金额格式、日期范围、月度进度、上限输入解析、条形图比例、价目说明、用量文案。

const pad = (n) => String(n).padStart(2, '0')

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 预设范围，返回 { from, to }（含首尾，本地日期） */
export function rangeFor(preset, now = new Date()) {
  const today = ymd(now)
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today }
  if (preset === 'last30') {
    const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)
    return { from: ymd(s), to: today }
  }
  if (preset === 'lastMonth') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const last = new Date(now.getFullYear(), now.getMonth(), 0)
    return { from: ymd(first), to: ymd(last) }
  }
  return { from: undefined, to: undefined }
}

export const RANGE_PRESETS = [
  { key: 'month', label: '本月' },
  { key: 'last30', label: '近 30 天' },
  { key: 'lastMonth', label: '上月' },
  { key: 'all', label: '全部' },
]

export function formatMoney(v, currency = 'CNY') {
  const n = Number(v)
  if (!Number.isFinite(n)) return '-'
  const sym = currency === 'CNY' ? '¥' : `${currency} `
  // 小额保留到 4 位，避免 0.0008 显示成 0.00
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2
  return sym + n.toFixed(digits)
}

/** 月度上限进度：{ percent(0-100), level: 'none'|'ok'|'warn'|'danger', text } */
export function monthProgress(month) {
  if (!month || month.monthly_cap == null) return { percent: 0, level: 'none', text: '未设置月度上限' }
  const cap = Number(month.monthly_cap)
  const used = Number(month.spent) + Number(month.in_flight_max || 0)
  if (cap <= 0) return { percent: 100, level: 'danger', text: '月度上限为 0，所有付费任务都会被拒绝' }
  const percent = Math.min(100, Math.round((used / cap) * 100))
  const level = used >= cap ? 'danger' : used >= cap * 0.8 ? 'warn' : 'ok'
  return { percent, level, text: `已用及在途 ${percent}%` }
}

/** 输入框文本 → 上限值：空串 = null（不限制）；非法返回 { error } */
export function parseCapInput(text) {
  const t = String(text ?? '').trim()
  if (t === '') return { value: null }
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return { error: '请输入大于等于 0 的数字，留空表示不限制' }
  return { value: n }
}

/** 为一组 { cost } 行计算条形图宽度百分比（最大值 = 100） */
export function withBarPercent(rows) {
  const max = Math.max(0, ...rows.map((r) => Number(r.cost) || 0))
  return rows.map((r) => ({ ...r, bar: max > 0 ? Math.round(((Number(r.cost) || 0) / max) * 100) : 0 }))
}

export function kindLabel(kind) {
  return { image: '图片', video: '视频', tts: '配音', text: '文本' }[kind] || kind || '-'
}

export function csvFileName(range) {
  return `spend-${range.from || 'all'}_${range.to || 'now'}.csv`
}

/** 价目来源说明（summary.prices）：{ text, warn }；旧接口没有 prices 时退回 sample_prices 标记。 */
export function priceNote(summary) {
  if (!summary) return { text: '', warn: false }
  const p = summary.prices
  if (!p) return summary.sample_prices ? { text: '当前价格表为示例价，费用仅为估算，不代表服务商实际账单。', warn: true } : { text: '', warn: false }
  const bits = [`费用按百炼公开价目计算${p.date ? `（${p.date} 版）` : ''}`]
  if (p.sample) bits.push('价格表含示例价，仅供估算')
  bits.push('实际账单以服务商控制台为准')
  return { text: bits.join('；'), warn: !!p.sample }
}

/** 预估/实际合计卡片的副标题：“实际 ¥1.20（已回传 3/5）” */
export function actualSubtitle(total, currency = 'CNY') {
  if (!total) return ''
  const n = Number(total.actual_count) || 0
  if (!n) return '尚无服务商回传的实际用量'
  return `实际 ${formatMoney(total.actual, currency)}（已回传 ${n}/${total.count} 个任务）`
}

const UNIT_LABEL = { second: '秒', char: '字符', image: '张' }

/** 逐任务表“实际”列的说明：按回传用量，如“5 秒 × ¥1.00（1080P）”“120 字符 × ¥0.0002”。 */
export function usageText(usage) {
  if (!usage || usage.units == null) return ''
  const unit = UNIT_LABEL[usage.unit] || usage.unit || ''
  let t = `${usage.units} ${unit} × ${formatMoney(usage.unit_price)}`
  if (usage.resolution) t += `（${usage.resolution}）`
  return t
}
