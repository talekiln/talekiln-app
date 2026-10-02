import request from '@/utils/request'

// 导演模式 REST（packages/local/src/routes/director.js，P3-D）。silentError：错误由面板内联展示。
const quiet = { silentError: true }

export const directorAPI = {
  /** 生成计划；返回轮次记录（status planned | rejected，拒绝原因在 validation.errors）。 */
  plan(ep, message, provider) { return request.post(`/episodes/${ep}/director/plan`, { message, ...(provider ? { provider } : {}) }, quiet) },
  /** 轮次列表（新在前）。 */
  turns(ep, limit) { return request.get(`/episodes/${ep}/director/turns`, { ...quiet, params: limit ? { limit } : undefined }) },
  /** 执行：合成一个内核事务（tx_id director:<turnId>）。 */
  apply(ep, turnId) { return request.post(`/episodes/${ep}/director/turns/${turnId}/apply`, {}, quiet) },
  /** 撤销：只在该事务位于撤销栈顶时成功。 */
  undo(ep, turnId) { return request.post(`/episodes/${ep}/director/turns/${turnId}/undo`, {}, quiet) },
}
