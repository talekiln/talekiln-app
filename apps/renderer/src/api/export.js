import request from '@/utils/request'

export const exportAPI = {
  /** 导出选项：分辨率预设、帧率、默认路径、AIGC 设置、检测到的编码器 { encoders, best_encoder, ... } */
  options(episodeId, refresh = false) {
    return request.get('/export/options', { params: { episode_id: episodeId, refresh: refresh ? '1' : undefined } })
  },
  /** body: { episode_id, width, height, fps, encoder, output_path } → { job_id, output_path, encoder, aigc } */
  start(body) {
    return request.post('/export/start', body)
  },
  /** { status: queued|running|done|failed|cancelled, percent, stage, encoder, error, result, output_path } */
  status(jobId) {
    return request.get(`/export/${jobId}/status`)
  },
  cancel(jobId) {
    return request.post(`/export/${jobId}/cancel`, {})
  },
  openFolder(jobId) {
    return request.post(`/export/${jobId}/open-folder`, {})
  },
  getAigc() {
    return request.get('/settings/aigc')
  },
  /** body: { watermark?, metadata?, producer? } */
  putAigc(body) {
    return request.put('/settings/aigc', body)
  },
}
