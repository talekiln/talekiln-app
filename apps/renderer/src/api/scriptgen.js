import request from '@/utils/request'

export const scriptgenAPI = {
  /** { templates: [{id,name,description,defaultStyle}], aspect_ratios } */
  templates() {
    return request.get('/scriptgen/templates')
  },
  /** 创建项目并生成分镜（同步，可能需要数十秒）。返回 { drama_id, episode_id } */
  createProject(body) {
    return request.post('/scriptgen/projects', body, { timeout: 300000 })
  },
  /** 按给定 id 顺序重排分镜（须包含该剧集全部分镜） */
  reorder(episodeId, ids) {
    return request.put(`/episodes/${episodeId}/storyboards/order`, { ids })
  },
}
