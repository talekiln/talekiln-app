import request from '@/utils/request'

export const spendAPI = {
  /** 汇总：total / by_day / by_provider / by_model / by_project / month / limits；params: { from, to } (YYYY-MM-DD) */
  summary(params) {
    return request.get('/spend/summary', { params })
  },
  /** 逐任务费用：{ items, total, limit, offset, currency }；params: { from, to, project_id, limit, offset } */
  tasks(params) {
    return request.get('/spend/tasks', { params })
  },
  getLimits() {
    return request.get('/spend/limits')
  },
  /** body: { monthly_cap?: number|null, per_run_cap?: number|null }，null 表示不限制 */
  putLimits(body) {
    return request.put('/spend/limits', body)
  },
  /** CSV 文件（Blob） */
  exportCsv(params) {
    return request.get('/spend/export', { params, responseType: 'blob' })
  },
}
