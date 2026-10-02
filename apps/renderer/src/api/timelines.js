import request from '@/utils/request'

export const timelinesAPI = {
  /** 按剧集获取时间线；尚未组装时后端返回 404，这是正常状态：不弹全局错误，由时间线页展示“去组装”空态（非 404 也由页面自己提示） */
  getByEpisode(episodeId) {
    return request.get(`/timelines/episode/${episodeId}`, { silentError: true })
  },
  /** 从分镜组装时间线；body: { replace?: boolean } */
  assemble(episodeId, body) {
    return request.post(`/timelines/episode/${episodeId}/assemble`, body || {})
  },
  /** 整体保存（带 version 做乐观锁），body: { episode_id, version, tracks } */
  save(id, body) {
    return request.put(`/timelines/${id}`, body)
  },
  addClip(id, body) {
    return request.post(`/timelines/${id}/clips`, body)
  },
  /** body: { op: 'move' | 'trim' | 'split' | 'delete', ... } */
  patchClip(id, clipId, body) {
    return request.patch(`/timelines/${id}/clips/${clipId}`, body)
  },
}
