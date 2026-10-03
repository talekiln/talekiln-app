import { h } from 'vue'
import { ElMessageBox } from 'element-plus'
import { episodeGenerationAPI } from '@/api/episodeGeneration'
import { aiTasksAPI } from '@/api/aiTasks'
import { buildGenerateBody, confirmSummary } from '@/utils/generationView'
import { makeQueuedId } from '@/utils/queuedTask'
import { t } from '@/i18n'

// 已在批量确认里看过估价的 (集, 分镜, 类型)；单个调用命中则不再弹窗。
const approved = new Set()
const key = (ep, sb, kind) => `${ep}:${sb}:${kind}`

async function confirmDialog(summary) {
  const body = h('div', [
    h('ul', { style: 'margin:0;padding-left:20px;line-height:1.8' }, summary.lines.map((l) => h('li', l))),
    ...summary.warnings.map((w) => h('p', { style: 'margin:8px 0 0;color:#e6a23c' }, w)),
    h('p', { style: 'margin:12px 0 0;font-size:12px;color:#909399' }, t('generation.queue.hint')),
  ])
  await ElMessageBox({
    title: summary.title,
    message: body,
    showCancelButton: true,
    closeOnClickModal: false,
    confirmButtonText: summary.free ? t('common.ok') : t('generation.queue.confirm'),
    cancelButtonText: t('common.cancel'),
  })
}

async function previewChecked(episodeId, shots, kind, regenerate) {
  const preview = await episodeGenerationAPI.generate(episodeId, buildGenerateBody({ shots, kind, confirm: false, regenerate }))
  const summary = confirmSummary(preview)
  if (summary.blocked) throw new Error(summary.blockedText)
  if (preview.provider_ready === false) throw new Error(t('generate.warn.noProvider'))
  return summary
}

async function askUser(summary) {
  if (!summary.canConfirm || summary.free) return
  try { await confirmDialog(summary) } catch (_) { throw new Error(t('generation.cancelled')) }
}

/** 批量开始前弹一次确认（总估价）；之后对这些镜头的 queueShot 不再逐个弹窗。取消或超额度抛错。 */
export async function approveBatch(episodeId, storyboardIds, kind) {
  await askUser(await previewChecked(episodeId, storyboardIds, kind, false))
  for (const id of storyboardIds) approved.add(key(episodeId, id, kind))
}

/**
 * 旧 imagesAPI.create / videosAPI.create 的替代：把一个镜头的首帧图或视频放进队列（估价 -> 确认 -> 提交）。
 * 返回 { task_id }（合成 id，旧轮询经 taskAPI.get 取状态）。
 */
export async function queueShot(episodeId, storyboardId, kind, { regenerate = false } = {}) {
  if (!episodeId) throw new Error(t('generation.queue.noEpisode'))
  const k = key(episodeId, storyboardId, kind)
  const skipDialog = approved.has(k)
  approved.delete(k)
  const shots = [Number(storyboardId)]
  const summary = await previewChecked(episodeId, shots, kind, regenerate)
  if (!skipDialog) await askUser(summary)
  const result = await episodeGenerationAPI.generate(episodeId, buildGenerateBody({ shots, kind, confirm: true, regenerate }))
  const task = (result.tasks || []).find((x) => x.kind === kind && Number(x.storyboard_id) === Number(storyboardId))
  return { task_id: makeQueuedId({ taskId: task && task.task_id, episodeId, storyboardId, kind }) }
}

/** taskAPI.get 对合成 id 的实现：读队列任务与该镜头的节点状态。 */
export async function readQueued({ taskId, episodeId, storyboardId, kind }) {
  const [aiTask, status] = await Promise.all([
    taskId ? aiTasksAPI.get(taskId).catch(() => null) : null,
    episodeGenerationAPI.status(episodeId).catch(() => null),
  ])
  const shot = status && (status.shots || []).find((s) => Number(s.storyboard_id) === Number(storyboardId))
  return { aiTask, shotState: shot ? shot[kind] : null }
}

export async function cancelQueued({ taskId }) {
  if (taskId) await aiTasksAPI.cancel(taskId)
}
