// 资产图片生成：开关判断、错误分类、任务轮询。纯函数，不依赖 Vue / 网络。
//
// 决策（见 docs/superpowers/notes/assets.md）：后端队列（POST /episodes/:id/generate）只支持分镜图 / 视频，
// 不支持角色 / 场景 / 道具图，所以资产出图仍走旧的同步路由；只有 generation.legacy_enabled === true 时才允许，
// 否则按钮置灰并说明原因。超出花费上限（402 SPEND_LIMIT）在卡片内联提示，不弹全局错误。

/** 是否允许资产出图。legacyEnabled：true / false / null（未知，状态还没取到或取失败）。 */
export function generationGate(legacyEnabled) {
  if (legacyEnabled === true) return { allowed: true, reasonKey: null }
  if (legacyEnabled === false) return { allowed: false, reasonKey: 'assets.gen.legacyOff' }
  return { allowed: false, reasonKey: 'assets.gen.unknown' }
}

function errText(e) {
  return e && e.message ? String(e.message) : ''
}

/** 把生成失败分类：花费上限（402）→ 内联提示；其它保留原信息。 */
export function classifyGenerationError(e) {
  const status = e?.response?.status
  const code = e?.code || e?.response?.data?.error?.code || e?.response?.data?.code
  if (status === 402 || code === 'SPEND_LIMIT') {
    return { type: 'spendLimit', messageKey: 'assets.gen.spendLimit', message: errText(e) }
  }
  return { type: 'other', messageKey: null, message: errText(e) }
}

/** 各资产的出图路由和请求体（与旧页面一致；scene 走 /scenes/generate-image）。 */
export function buildAssetImageRequest(kind, item, { model, style } = {}) {
  if (kind === 'characters') {
    return { method: 'post', url: `/characters/${item.id}/generate-image`, body: { model, style } }
  }
  if (kind === 'scenes') {
    return { method: 'post', url: '/scenes/generate-image', body: { scene_id: item.id, model, style } }
  }
  return { method: 'post', url: `/props/${item.id}/generate`, body: { model, style } }
}

/** 从出图响应里取 task_id（角色 / 道具直接返回；场景可能嵌在 image_generation 里）。 */
export function taskIdOf(res) {
  return String(res?.task_id ?? res?.image_generation?.task_id ?? '')
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 轮询任务直到完成 / 失败 / 超时 / 取消。getTask() 返回 { status, result, error }。
 * 轮询中的网络错误当作暂时失败继续重试；超时时带上最后一次错误。
 */
export async function waitForTask(getTask, { intervalMs = 2000, maxAttempts = 450, sleep = realSleep, isCancelled = () => false } = {}) {
  let lastError = null
  for (let i = 0; i < maxAttempts; i++) {
    if (isCancelled()) return { status: 'cancelled' }
    try {
      const t = await getTask()
      lastError = null
      if (t?.status === 'completed') return { status: 'completed', result: t.result }
      if (t?.status === 'failed') return { status: 'failed', error: t.error || '' }
    } catch (e) {
      lastError = e
    }
    if (isCancelled()) return { status: 'cancelled' }
    if (i < maxAttempts - 1) await sleep(intervalMs)
  }
  return { status: 'timeout', error: lastError ? errText(lastError) : '' }
}
