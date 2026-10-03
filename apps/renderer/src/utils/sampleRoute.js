export const SAMPLE_ID = 'talekiln-sample-v1'

/** 路由位置：示例项目的分镜表（具名路由 episode-storyboard）。 */
export function storyboardLocation(res) {
  return { name: 'episode-storyboard', params: { dramaId: res.drama_id, episodeId: res.episode_id } }
}

/** 载入内置示例（本地生成，离线，不调用任何 AI 服务）并返回要跳转的路由位置。api 须提供 seedSample(id)。 */
export async function seedAndLocate(api) {
  return storyboardLocation(await api.seedSample(SAMPLE_ID))
}
