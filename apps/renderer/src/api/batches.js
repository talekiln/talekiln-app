import request from '@/utils/request'

/** P3-B 批量生成。金额字段一律是分（整数）。 */
export const batchesAPI = {
  /** { items, provider_limits, providers, currency } */
  list(dramaId) {
    return request.get('/batches', { params: dramaId ? { drama_id: dramaId } : {} })
  },
  /** body 见 utils/batchView.buildCreateBody；返回批次视图 */
  create(body) {
    return request.post('/batches', body)
  },
  /** 只估算不建：{ dry_run, allowed, refusal, totals, per_episode, warnings } */
  estimate(body) {
    return request.post('/batches', { ...body, dry_run: true }, { silentError: true })
  },
  get(id) {
    return request.get(`/batches/${id}`)
  },
  /** episodeIds 为空 = 全部失败的集 */
  retryFailed(id, episodeIds) {
    return request.post(`/batches/${id}/retry-failed`, episodeIds && episodeIds.length ? { episode_ids: episodeIds } : {})
  },
  cancel(id) {
    return request.post(`/batches/${id}/cancel`, {})
  },
  pause(id) {
    return request.post(`/batches/${id}/pause`, {})
  },
  /** budgetCapCents 给了就同时提高预算 */
  resume(id, budgetCapCents) {
    return request.post(`/batches/${id}/resume`, budgetCapCents == null ? {} : { budget_cap_cents: budgetCapCents })
  },
}
