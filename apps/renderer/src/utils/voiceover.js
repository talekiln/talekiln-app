// 配音面板的纯逻辑：估价文案、提交结果摘要、队列状态文案。

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

/**
 * 提交结果摘要（配音走任务队列，确认后只建任务）：
 * “已提交 2 个配音任务到任务中心，1 个已在队列中，跳过 3 个”。兼容旧的 { done, failed } 形状。
 */
export function resultText(r) {
  if (!r) return ''
  const skipped = (r.skipped || []).length
  if (Array.isArray(r.tasks)) {
    const made = r.tasks.filter((t) => t.outcome === 'created' || t.outcome === 'retried').length
    const reused = r.tasks.length - made
    const bits = []
    if (made) bits.push(`已提交 ${made} 个配音任务到任务中心`)
    if (reused) bits.push(`${reused} 个已在队列中`)
    if (!r.tasks.length) bits.push('没有需要生成的镜头')
    if (skipped) bits.push(`跳过 ${skipped} 个`)
    return bits.join('，')
  }
  const done = (r.done || []).length
  const failed = r.failed || []
  const bits = [`已生成 ${done} 个镜头的旁白`]
  if (failed.length) bits.push(`${failed.length} 个失败：${failed[0].message}`)
  if (skipped) bits.push(`跳过 ${skipped} 个`)
  return bits.join('，')
}

/** 状态接口里还有没有在跑的配音任务（排队或执行中）。 */
export function voStatusBusy(st) {
  const c = (st && st.counts) || {}
  return (c.queued || 0) + (c.running || 0) > 0
}

/** 状态一行字：“配音中：2 个排队，1 个生成中”“配音完成：5 个最新，1 个失败（原因）”。 */
export function voStatusText(st) {
  if (!st || !st.counts) return ''
  const c = st.counts
  const parts = []
  if (voStatusBusy(st)) {
    if (c.queued) parts.push(`${c.queued} 个排队`)
    if (c.running) parts.push(`${c.running} 个生成中`)
    return `配音中：${parts.join('，')}`
  }
  if (c.fresh) parts.push(`${c.fresh} 个最新`)
  if (c.stale) parts.push(`${c.stale} 个过期`)
  if (c.failed) {
    const bad = (st.shots || []).find((s) => s.state === 'failed' && s.error_message)
    parts.push(`${c.failed} 个失败${bad ? `（${bad.error_message}）` : ''}`)
  }
  return parts.length ? `配音完成：${parts.join('，')}` : ''
}

/** 下拉选项：未实测的音色照常可选，label 已带说明。 */
export function voiceOptions(voices) {
  return (voices || []).map((v) => ({ value: v.id, label: v.label }))
}
