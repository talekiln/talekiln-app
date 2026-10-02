import request from '@/utils/request'

/** P3-C 角色一致性：评分报告 / 重评 / 参考图自动挑选 */
export const consistencyAPI = {
  /** -> { episode_id, enabled, available, min_score, shots: [{ storyboard_id, scored, best, worst, suggestion, entity, regenerate, image, video }], counts } */
  episodeReport(episodeId) {
    return request.get(`/episodes/${episodeId}/consistency`)
  },
  /** id：旧表 storyboard id（或镜头节点 id + episode_id）。-> 该镜头的报告项 + { rescored, reasons } */
  rescore(id, body = {}) {
    return request.post(`/shots/${id}/consistency/rescore`, body)
  },
  /** -> { character_id, anchor, ranked: [{ local_path, image_url, source_image_id, source, score, ... }], skipped, picked, locked, lock } */
  autoPick(characterId, { lock = false } = {}) {
    return request.post(`/characters/${characterId}/references/auto-pick`, { lock: lock === true })
  },
}
