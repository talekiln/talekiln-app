// 一键成片对话框的展示逻辑（纯函数，t 由调用方传入，方便在 node 下测试）。
// snap = usePipeline 的 snapshot；plan = buildPlan 的结果。

/** 每个步骤一行：名称 / 是否收费 / 状态 / 右侧说明 */
export function pipelineRows(snap, plan, t) {
  const planSteps = (plan && plan.steps) || []
  const byId = Object.fromEntries(planSteps.map((s) => [s.id, s]))
  const steps = snap && snap.steps && snap.steps.length ? snap.steps : planSteps.map((s) => ({
    id: s.id, phase: s.phase, billable: s.billable, status: s.skip ? 'skipped' : 'pending', done: 0, total: s.count,
  }))
  return steps.map((s) => {
    const p = byId[s.id] || {}
    let info = ''
    if (s.status === 'skipped') {
      info = p.reason ? t(`generate.pipeline.reason.${p.reason}`) : t('generate.pipeline.state.skipped')
      if (p.reason === 'locked' && p.lockedCount) info = t('generate.pipeline.reason.lockedN', { n: p.lockedCount })
    } else if (s.status === 'pending') {
      info = s.total == null ? t('generate.pipeline.countLater') : t('generate.pipeline.count', { n: s.total })
    } else if (s.status === 'running') {
      info = s.total ? `${s.done}/${s.total}` : t('generate.pipeline.state.running')
    } else if (s.status === 'done') {
      info = s.total ? t('generate.pipeline.doneN', { done: s.done, total: s.total }) : t('generate.pipeline.state.done')
    } else if (s.status === 'failed') {
      info = s.total ? t('generate.pipeline.failedN', { done: s.done, total: s.total }) : t('generate.pipeline.state.failed')
    }
    return { id: s.id, name: t(`generate.pipeline.step.${s.id}`), billable: !!s.billable && s.status !== 'skipped', status: s.status, info }
  })
}

const NOT_IN_ESTIMATE = new Set(['characterImages', 'sceneImages', 'propImages'])

/** 预估费用行和提示：{ line, warnings } */
export function pipelineEstimate(estimate, plan, t, formatMoney) {
  const runnable = (plan && plan.runnable) || []
  const billable = runnable.filter((s) => s.billable)
  if (!estimate || !billable.length) return { line: '', warnings: [] }
  const warnings = []
  let line
  if (estimate.pending) {
    line = t('generate.pipeline.estimatePending')
  } else {
    line = t('generate.pipeline.estimate', {
      total: formatMoney(estimate.total, estimate.currency),
      max: formatMoney(estimate.max, estimate.currency),
    })
  }
  if (billable.some((s) => NOT_IN_ESTIMATE.has(s.id))) warnings.push(t('generate.pipeline.estimateExcludes'))
  if (estimate.sample) warnings.push(t('generate.warn.samplePrices'))
  if (estimate.known === false) warnings.push(t('generate.warn.unknownPrice'))
  if (estimate.providerReady === false) warnings.push(t('generate.warn.noProvider'))
  if (estimate.allowed === false) warnings.push(estimate.blockedText || t('generate.blocked.default'))
  return { line, warnings }
}

function errorText(err, t) {
  if (!err) return ''
  if (err.code === 'no_script') return t('generate.pipeline.blocked.no_script')
  if (err.code === 'no_provider') return t('generate.warn.noProvider')
  if (err.code === 'blocked') return err.message || err.blockedText || t('generate.blocked.default')
  return err.message || t('generate.pipeline.err.generic')
}

/** 失败项列表（逐条） */
export function pipelineErrorLines(snap, t) {
  if (!snap) return []
  return (snap.errors || []).map((e) => {
    const step = e.stepId ? t(`generate.pipeline.step.${e.stepId}`) : ''
    const msg = errorText(e, t)
    return e.item != null ? t('generate.pipeline.errLineItem', { step, item: e.item, message: msg }) : t('generate.pipeline.errLine', { step, message: msg })
  })
}

/** 顶部状态条：{ text, type } */
export function pipelineStatus(snap, stage, t) {
  if (!snap) return { text: '', type: 'info' }
  if (snap.state === 'paused') {
    return {
      text: snap.pausedAfter ? t('generate.pipeline.pausedAfter', { step: t(`generate.pipeline.step.${snap.pausedAfter}`) }) : t('generate.pipeline.paused'),
      type: 'info',
    }
  }
  if (snap.state === 'done') {
    return { text: (snap.errors || []).length ? t('generate.pipeline.finishedWithErrors', { n: snap.errors.length }) : t('generate.pipeline.finished'), type: (snap.errors || []).length ? 'warning' : 'success' }
  }
  if (snap.state === 'cancelled') return { text: t('generate.pipeline.cancelled'), type: 'warning' }
  if (snap.state === 'failed') {
    const base = errorText(snap.error, t)
    const step = snap.error && snap.error.stepId ? t(`generate.pipeline.step.${snap.error.stepId}`) : ''
    return { text: step ? t('generate.pipeline.failedAt', { step, message: base }) : base || t('generate.pipeline.err.generic'), type: 'error' }
  }
  return { text: '', type: 'info' }
}
