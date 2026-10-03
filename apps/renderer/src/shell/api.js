// 外壳使用的真实后端接口（stores/shell.js 默认通过它访问；测试注入假实现，不会加载本文件）。
import request from '@/utils/request'
import { pickProjectCost } from './spend.js'

const quiet = { silentError: true }

export const shellApi = {
  getDrama(id) {
    return request.get(`/dramas/${id}`, quiet)
  },
  /** Task 4 提供；接口不存在时返回 404，由 store 忽略 */
  putQuality(id, quality) {
    return request.put(`/dramas/${id}/quality`, { quality }, quiet)
  },
  /** 渲染核心是否可用：GET /export/options 返回 503 + CORE_UNAVAILABLE 表示不可用；其它失败视为“未知”，按可用处理 */
  async renderCoreOk(episodeId) {
    try {
      await request.get('/export/options', { params: { episode_id: episodeId }, ...quiet })
      return true
    } catch (e) {
      return !(e?.response?.status === 503 && e?.code === 'CORE_UNAVAILABLE')
    }
  },
  /** 进行中的 AI 任务数（与任务中心“进行中”过滤一致） */
  async runningTaskCount() {
    const data = await request.get('/ai-tasks', {
      params: { page: 1, page_size: 1, state: 'queued,submitting,submitted,polling,downloading' },
      ...quiet,
    })
    return data?.pagination?.total ?? (data?.items || []).length
  },

  /** 当前集里草稿档产出的节点数（GET /episodes/:id/quality/draft-nodes，Task 4） */
  async draftCount(episodeId) {
    const d = await request.get(`/episodes/${episodeId}/quality/draft-nodes`, quiet)
    return Number(d?.count) || 0
  },
  /** 本项目累计花费（GET /spend/summary 的 by_project）；取不到时 cost 为 null */
  async projectSpend(dramaId) {
    const s = await request.get('/spend/summary', quiet)
    return { cost: pickProjectCost(s, dramaId), currency: s?.currency || 'CNY' }
  },
  /** 任务抽屉：最近的 AI 任务（最新在前），含进行中与已结束 */
  async recentTasks(limit = 20) {
    const data = await request.get('/ai-tasks', { params: { page: 1, page_size: limit }, ...quiet })
    return data?.items || []
  },

  // ---- 旧地址重定向用（utils/legacyRoutes.js 的 deps） ----

  /** 剧集所属项目：优先 GET /episodes/:id（Task 3），接口未就绪时回退到扫描项目列表 */
  async episodeToDrama(episodeId) {
    try {
      const ep = await request.get(`/episodes/${episodeId}`, quiet)
      if (ep?.drama_id) return ep.drama_id
    } catch (_) { /* 404 / 旧后端：走回退 */ }
    try {
      const res = await request.get('/dramas', { params: { page: 1, page_size: 200 }, ...quiet })
      const items = Array.isArray(res) ? res : res?.items || res?.dramas || []
      const hit = items.find((d) => (d.episodes || []).some((e) => Number(e.id) === Number(episodeId)))
      return hit ? hit.id : null
    } catch (_) {
      return null
    }
  },
  /** 项目的第 1 集（按集号） */
  async firstEpisode(dramaId) {
    const d = await request.get(`/dramas/${dramaId}`, quiet)
    const eps = [...(d?.episodes || [])].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
    return eps[0]?.id ?? null
  },
  /** 镜头所在剧集 */
  async shotEpisode(shotId) {
    const s = await request.get(`/storyboards/${shotId}`, quiet)
    return s?.episode_id ?? null
  },
}
