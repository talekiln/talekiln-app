import request from '@/utils/request'
import { parseQueuedId, toLegacyTask } from '@/utils/queuedTask'

export const taskAPI = {
  async get(taskId) {
    const q = parseQueuedId(taskId)
    if (q) {
      const { readQueued } = await import('@/api/queuedGeneration')
      const { aiTask, shotState } = await readQueued(q)
      return { id: taskId, ...toLegacyTask(aiTask, shotState) }
    }
    return request.get(`/tasks/${taskId}`)
  },
  async cancel(taskId, body) {
    const q = parseQueuedId(taskId)
    if (q) {
      const { cancelQueued } = await import('@/api/queuedGeneration')
      return cancelQueued(q)
    }
    return request.post(`/tasks/${taskId}/cancel`, body || {})
  },
  listByResource(resourceId) {
    return request.get('/tasks', { params: { resource_id: String(resourceId) } })
  },
}
