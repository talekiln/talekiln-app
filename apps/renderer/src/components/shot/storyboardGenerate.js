// "Generate / regenerate the storyboard from the script" (used by the storyboard page and the storyboard.* actions).
// Backend: POST /episodes/:id/storyboards is ONE undoable kernel transaction (response task_id, tx_id, can_undo),
// so regenerating can be undone with the shared undo (POST /episodes/:id/undo).
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { t } from '@/i18n'
import { dramaAPI } from '@/api/drama'
import { storyboardsAPI } from '@/api/storyboards'
import { taskAPI } from '@/api/task'
import { useProjectViewsStore } from '@/stores/projectViews'
import { buildStoryboardOptions } from './storyboardOptions.js'
import { buildRegeneratePlan, undoNoticeKind } from './shotInspectorModel.js'
import { pollTaskResult } from './framePrompt.js'

/** True while a storyboard generation is running in this window (the page disables its buttons). */
export const storyboardBusy = ref(false)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {{ episodeId: number, dramaId?: number, store: object }} ctx action context (store = shell store)
 * @param {{ regenerate?: boolean }} opts
 * @returns {Promise<{ ok: boolean, cancelled?: boolean, count?: number, notice?: string }>}
 */
export async function runStoryboardGenerate(ctx, { regenerate = false } = {}) {
  const episodeId = ctx && ctx.episodeId
  if (!episodeId) {
    ElMessage.warning(t('storyboard.regen.noEpisode'))
    return { ok: false }
  }
  if (storyboardBusy.value) {
    ElMessage.info(t('storyboard.regen.busy'))
    return { ok: false }
  }
  const drama = ctx.store && ctx.store.drama
  const episode = ((ctx.store && ctx.store.episodes) || []).find((e) => Number(e.id) === Number(episodeId))

  let existing = 0
  try {
    const data = await dramaAPI.getStoryboards(episodeId)
    existing = ((data && data.storyboards) || []).length
  } catch (_) {
    return { ok: false }
  }
  // The backend keeps the old version in undo history (Task 3), so the confirm promises "you can undo this".
  const plan = buildRegeneratePlan({ shotCount: existing, undoable: true })
  if (plan.confirm || (regenerate && existing)) {
    try {
      await ElMessageBox.confirm(t('storyboard.regen.confirmUndoable', { n: existing }), t('storyboard.regen.confirmTitle'), {
        type: 'warning',
        confirmButtonText: t('storyboard.regen.confirmOk'),
        cancelButtonText: t('storyboard.common.cancel'),
      })
    } catch (_) {
      return { ok: false, cancelled: true }
    }
  }

  storyboardBusy.value = true
  const progress = ElMessage({ message: t('storyboard.regen.running'), type: 'info', duration: 0, showClose: false })
  try {
    const body = buildStoryboardOptions(drama, ((episode && episode.script_content) || '').trim().length)
    const res = await dramaAPI.generateStoryboard(episodeId, body)
    const taskId = res && (res.task_id ?? (typeof res === 'string' ? res : null))
    let notice = undoNoticeKind(res)
    if (taskId) {
      const out = await pollTaskResult({ get: (id) => taskAPI.get(id), sleep }, taskId, { intervalMs: 2000, maxTries: 900 })
      if (!out.ok) throw new Error(out.error === 'timeout' ? t('storyboard.regen.timeout') : out.error || t('storyboard.regen.failed'))
      if (out.task && out.task.result && out.task.result.truncated) ElMessage.warning(t('storyboard.regen.truncated'))
      if (notice === 'plain') notice = undoNoticeKind(out.task)
    }
    const views = useProjectViewsStore()
    if (views.episodeId === Number(episodeId)) await views.refresh()
    else await views.load(episodeId, { drama: ctx.dramaId })
    await storyboardsAPI.batchInferParams(episodeId, false).catch(() => {})
    if (views.episodeId === Number(episodeId)) await views.refresh()
    const count = ((views.views.shots && views.views.shots.groups) || []).reduce((n, g) => n + (g.shots || []).length, 0)
    if (notice === 'undo') ElMessage.success(t('storyboard.regen.doneUndo', { n: count }))
    else if (notice === 'cleared') ElMessage.warning(t('storyboard.regen.doneCleared', { n: count }))
    else ElMessage.success(t('storyboard.regen.done', { n: count }))
    return { ok: true, count, notice }
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.regen.failed'))
    return { ok: false }
  } finally {
    progress.close()
    storyboardBusy.value = false
  }
}
