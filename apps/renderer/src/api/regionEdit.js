import request from '@/utils/request'

// P3-R 选镜改片（packages/local/src/routes/regionEdit.js）。shotId 为 storyboards.id。
export const regionEditAPI = {
  /** confirm=false：只估算（只重做这一段的价格 + 整镜重做对比），不建任务。 */
  estimate(shotId, body) { return request.post(`/shots/${shotId}/edit-region`, { ...body, confirm: false }, { silentError: true }) },
  /** confirm=true：记录改片并建队列任务。 */
  submit(shotId, body) { return request.post(`/shots/${shotId}/edit-region`, { ...body, confirm: true }) },
  /** 该镜头的改片记录 + 视频节点的内核版本列表。 */
  list(shotId) { return request.get(`/shots/${shotId}/edit-regions`, { silentError: true }) },
  /** 采用某个视频版本（节点参数跟随版本配方：采用改片结果 / 切回原版本都保持“最新”）。 */
  adopt(shotId, versionId) { return request.post(`/shots/${shotId}/adopt-version`, { version_id: versionId }) },
}
