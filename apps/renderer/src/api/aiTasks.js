import request from '@/utils/request'

export const aiTasksAPI = {
  list(params) {
    return request.get('/ai-tasks', { params })
  },
  get(id) {
    return request.get(`/ai-tasks/${id}`)
  },
  retry(id, body) {
    return request.post(`/ai-tasks/${id}/retry`, body || {})
  },
  cancel(id) {
    return request.post(`/ai-tasks/${id}/cancel`, {})
  }
}
