// 首页对话框结束后的去向。依赖都由参数注入，node --test 可直接运行。
import { cardNextStop, viewLocation } from '../../utils/homeModel.js'

/**
 * 对话框的 result -> 要跳转的具名路由位置（不跳转返回 null）。
 * - { dramaId, episodeId }：新建 / 导入剧本，直接进第 1 集剧本
 * - { dramaId } 或 { drama_id }：导入 / 恢复的项目包，按"上次停留 -> 第 1 集 -> project-home"落点
 * deps: getDrama(id) -> drama（含 episodes）、lastView(id) -> { episodeId, view } | null
 */
export async function locationAfterDialog(result, deps) {
  if (!result) return null
  const dramaId = result.dramaId ?? result.drama_id
  if (dramaId == null) return null
  if (result.episodeId != null) return viewLocation('script', dramaId, result.episodeId)
  let drama = null
  try {
    drama = await deps.getDrama(dramaId)
  } catch (_) {
    drama = null
  }
  if (!drama) return { name: 'project-home', params: { dramaId } }
  const last = typeof deps.lastView === 'function' ? deps.lastView(dramaId) : null
  return cardNextStop({ ...drama, id: drama.id ?? dramaId }, last).location
}

/** 内置示例项目载入结果 { drama_id, episode_id } -> 分镜视图位置（示例本来就是带分镜的）。 */
export function sampleLocation(res) {
  if (!res || res.drama_id == null) return null
  if (res.episode_id == null) return { name: 'project-home', params: { dramaId: res.drama_id } }
  return viewLocation('storyboard', res.drama_id, res.episode_id)
}
