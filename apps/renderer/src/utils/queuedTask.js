// 旧页面按“task_id + 轮询 /tasks/:id”写成；出图/出视频改走持久队列后，用一个带前缀的合成 id 让旧轮询逻辑原样可用。
// 合成 id：q:<ai 任务 id>:<剧集 id>:<分镜 id>:<image|video>。没有真实任务（已最新 / 命中旧结果）时 ai 任务 id 为 "-"。

import { t } from '../i18n/index.js'

const PREFIX = 'q:'

export function makeQueuedId({ taskId, episodeId, storyboardId, kind }) {
  return `${PREFIX}${taskId || '-'}:${episodeId}:${storyboardId}:${kind}`
}

export function parseQueuedId(id) {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) return null
  const [taskId, episodeId, storyboardId, kind] = id.slice(PREFIX.length).split(':')
  if (!episodeId || !storyboardId || !['image', 'video'].includes(kind)) return null
  return { taskId: taskId === '-' ? null : taskId, episodeId, storyboardId, kind }
}

/**
 * 把队列状态折成旧 /tasks/:id 的形状 { status: 'processing'|'completed'|'failed', error? }。
 * aiTask: GET /ai-tasks/:id（可为 null）；shotState: 状态接口里该镜头该产物的节点状态（可为 null）。
 */
export function toLegacyTask(aiTask, shotState) {
  if (aiTask) {
    if (aiTask.state === 'failed' || aiTask.state === 'cancelled') {
      return { status: 'failed', error: aiTask.error_message || aiTask.error_code || (aiTask.state === 'cancelled' ? t('generation.cancelled') : t('generation.failed')) }
    }
    if (aiTask.state === 'succeeded') {
      // 结果写进内核之前仍算进行中
      return shotState && shotState.state === 'fresh' ? { status: 'completed' } : { status: 'processing' }
    }
    return { status: 'processing' }
  }
  if (shotState && shotState.state === 'failed') return { status: 'failed', error: shotState.error_message || shotState.error_code || t('generation.failed') }
  if (shotState && shotState.state === 'fresh') return { status: 'completed' }
  return { status: 'processing' }
}
