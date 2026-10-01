// 配音面板的纯逻辑：估价文案、结果摘要。

const SKIP_TEXT = { fresh: '已有最新旁白', no_text: '没有台词', no_narration_node: '没有旁白节点' }

/** 估价一行字：例如“3 个镜头 / 86 字，预计 0.02 元（最高 0.02 元，示例价）”。 */
export function estimateText(e) {
  if (!e) return ''
  const unit = e.currency === 'CNY' || !e.currency ? '元' : e.currency
  const parts = [`${e.shots} 个镜头 / ${e.chars} 字，预计 ${e.estimate} ${unit}（最高 ${e.max} ${unit}`]
  if (e.sample_prices) parts[0] += '，示例价'
  parts[0] += '）'
  if (e.price_known === false) parts.push('该模型没有价格条目，按 0 估算')
  return parts.join('；')
}

/** 有事可做才需要确认；全部跳过时直接提示。 */
export function needsConfirm(e) {
  return !!(e && e.confirm_required && e.shots > 0)
}

/** 跳过原因的中文。 */
export function skipText(reason) {
  return SKIP_TEXT[reason] || reason
}

/** 结果摘要：“已生成 2 个镜头的旁白，1 个失败：…，跳过 3 个”。 */
export function resultText(r) {
  if (!r) return ''
  const done = (r.done || []).length
  const failed = r.failed || []
  const skipped = (r.skipped || []).length
  const bits = [`已生成 ${done} 个镜头的旁白`]
  if (failed.length) bits.push(`${failed.length} 个失败：${failed[0].message}`)
  if (skipped) bits.push(`跳过 ${skipped} 个`)
  return bits.join('，')
}

/** 下拉选项：未实测的音色照常可选，label 已带说明。 */
export function voiceOptions(voices) {
  return (voices || []).map((v) => ({ value: v.id, label: v.label }))
}
