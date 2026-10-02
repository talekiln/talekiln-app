import request from '@/utils/request'

/** P1-07 锁定参考图；P1-08 分镜候选视频 / 采用 */
export const referenceLocksAPI = {
  /** type: 'character' | 'scene'；ids: number[] */
  list(type, ids) {
    return request.get('/reference-locks', { params: { type, ids: (ids || []).join(',') } })
  },
  lock(type, id, body) {
    return request.put(`/reference-locks/${type}/${id}`, body)
  },
  unlock(type, id) {
    return request.delete(`/reference-locks/${type}/${id}`)
  },
}

export const shotCandidatesAPI = {
  /** -> { adopted_video_id, items: [{ slot, label, adopted, ... }] } */
  list(storyboardId) {
    return request.get(`/storyboards/${storyboardId}/video-candidates`)
  },
  adopt(storyboardId, videoId) {
    return request.post(`/storyboards/${storyboardId}/adopt-video`, { video_id: videoId })
  },
}
