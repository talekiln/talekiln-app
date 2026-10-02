import request from '@/utils/request'

export const episodeGenerationAPI = {
  /**
   * 估算（confirm=false，不建任务）或提交（confirm=true）。
   * body: { shots: [storyboard id...] | 'all', kind: 'image'|'video'|'both', confirm: boolean, regenerate?: boolean }
   */
  generate(episodeId, body) {
    return request.post(`/episodes/${episodeId}/generate`, body)
  },
  /** 每镜头状态：{ shots: [{ storyboard_id, state, image, video }], counts, cap, legacy_enabled } */
  status(episodeId) {
    return request.get(`/episodes/${episodeId}/generation/status`)
  },
}
