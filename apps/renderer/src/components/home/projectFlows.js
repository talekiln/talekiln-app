// 首页的异步流程（删除前快照、完整备份下载、建项目加剧集）。所有外部依赖由参数注入，
// 因此可以在 node --test 下直接运行；真正的接口调用在 homeApi.js。

/** 接口不存在（旧后端 / 后端任务还没合并）与真正失败要区分：前者给"功能暂不可用"，后者给错误。 */
export function classifyFailure(err) {
  const status = err?.response?.status ?? err?.status
  if (status === 404 || status === 405 || status === 501) return 'unavailable'
  return 'failed'
}

/**
 * 删除项目：确认 -> 本机快照 -> 删除 -> 记入"最近删除"。
 * 快照不可用或失败时再确认一次（用户可坚持删除，也可放弃）。
 * deps: confirmDelete(): Promise<boolean>、confirmWithoutSnapshot(reason): Promise<boolean>、
 *       snapshot(id): Promise<{ok:true,id}|{ok:false,reason}>、remove(id)、remember(rec)、now()
 * 返回 { status: 'deleted'|'cancelled'|'failed', snapshot?, error? }
 */
export async function runDeleteFlow(drama, deps) {
  if (!(await deps.confirmDelete())) return { status: 'cancelled' }
  let snap
  try {
    snap = await deps.snapshot(drama.id)
  } catch (e) {
    snap = { ok: false, reason: classifyFailure(e) }
  }
  if (!snap || !snap.ok) {
    if (!(await deps.confirmWithoutSnapshot(snap?.reason || 'failed'))) return { status: 'cancelled' }
  }
  try {
    await deps.remove(drama.id)
  } catch (error) {
    return { status: 'failed', error }
  }
  if (snap && snap.ok) {
    const at = typeof deps.now === 'function' ? deps.now() : Date.now()
    deps.remember({ dramaId: drama.id, title: drama.title || '', snapshotId: snap.id, at })
    return { status: 'deleted', snapshot: snap }
  }
  return { status: 'deleted', snapshot: null }
}

/**
 * POST /dramas/:id/backup/full，返回 Blob。失败抛带 reason('unavailable'|'failed') 与 code 的错误。
 * 用 fetch 而不是 axios：避免经 dev proxy 的 blob 包装，且不触发全局错误弹窗。
 */
export async function fetchFullBackup(dramaId, fetchImpl) {
  let res
  try {
    res = await fetchImpl(`/api/v1/dramas/${dramaId}/backup/full`, { method: 'POST' })
  } catch (cause) {
    const e = new Error(cause?.message || 'network')
    e.reason = 'failed'
    throw e
  }
  if (!res.ok) {
    let body = null
    try { body = await res.json() } catch (_) { /* 非 JSON 响应 */ }
    const e = new Error(body?.error?.message || body?.message || `HTTP ${res.status}`)
    e.reason = classifyFailure({ status: res.status })
    e.code = body?.error?.code || body?.code || ''
    throw e
  }
  return res.blob()
}

/**
 * 建项目并写入剧集，返回 { dramaId, episodeId }（episodeId 是集号最小的那一集）。
 * 写入剧集失败时删除刚建的空项目，避免留下半成品。
 * api: { create(body), saveEpisodes(id, eps), get(id), remove(id) }
 */
export async function createProjectWithEpisodes(api, meta, episodes) {
  const title = String(meta?.title || '').trim()
  const description = String(meta?.description || '').trim()
  const body = { title, metadata: { aspect_ratio: meta?.aspect_ratio || '16:9' } }
  if (description) body.description = description
  const drama = await api.create(body)
  const dramaId = drama?.id ?? drama?.drama_id
  try {
    await api.saveEpisodes(
      dramaId,
      episodes.map((e) => ({
        episode_number: e.episode_number,
        title: e.title || '',
        script_content: e.script_content || '',
        description: null,
        duration: 0,
      })),
    )
    const full = await api.get(dramaId)
    const eps = [...(full?.episodes || [])].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
    return { dramaId, episodeId: eps[0]?.id ?? null }
  } catch (err) {
    try { await api.remove(dramaId) } catch (_) { /* 清理失败不覆盖原错误 */ }
    throw err
  }
}
