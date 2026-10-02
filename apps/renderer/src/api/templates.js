import request from '@/utils/request'

const enc = encodeURIComponent

/** P3-T 模板市场：本地服务 /templates 系列接口（见 docs/phase3-templates.md）。 */
export const templatesAPI = {
  /** -> { items: [...], pro_available, pro_reason } */
  list() {
    return request.get('/templates')
  },
  /** -> 模板详情（含 manifest 与「套用后会得到」摘要） */
  get(id) {
    return request.get(`/templates/${enc(id)}`)
  },
  /** -> { items: [逐镜估价], total, max, currency, known, sample_prices, provider_ready, check } */
  estimate(id) {
    return request.post(`/templates/${enc(id)}/estimate`)
  },
  /** body: { mode: 'new'|'episode', drama_id?, title?, character_map: { slotId: characterId } } */
  apply(id, body) {
    return request.post(`/templates/${enc(id)}/apply`, body)
  },
  /** body: { path } 或 { manifest, source } */
  install(body) {
    return request.post('/templates/install', body)
  },
  remove(id) {
    return request.delete(`/templates/${enc(id)}`)
  },
  /** 云端目录（未配置云端 / 离线时报错，由调用方处理） */
  cloud() {
    return request.get('/templates/cloud', { silentError: true })
  }
}
