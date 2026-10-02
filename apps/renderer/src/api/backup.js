import request from '@/utils/request'

/** P3-K 云备份页：设置（Secret Key 只写）、测试连接、立即备份、快照列表 / 恢复 / 删除、状态与运行历史（本地服务 /backup）。 */
export const backupAPI = {
  /** { provider, endpoint, region, bucket, prefix, access_key, auto, keep, path_style, has_secret, configured, secret_store_available } */
  getSettings() {
    return request.get('/backup/settings')
  },
  /** patch 里 secret_key：非空写入；null 删除；缺省不动。调用方自己展示错误。 */
  putSettings(patch) {
    return request.put('/backup/settings', patch, { silentError: true })
  },
  /** 可带表单里尚未保存的值。调用方自己展示错误。 */
  test(overrides) {
    return request.post('/backup/test', overrides || {}, { silentError: true })
  },
  /** -> { run, snapshot } */
  backupDrama(dramaId) {
    return request.post(`/backup/dramas/${encodeURIComponent(dramaId)}`, {}, { silentError: true })
  },
  /** -> { items, source: 's3' | 'local', offline, configured } */
  snapshots(dramaId) {
    return request.get('/backup/snapshots', { params: dramaId ? { drama_id: dramaId } : {} })
  },
  /** -> { drama_id, title, … }（恢复为新项目，从不覆盖）。调用方自己展示错误。 */
  restore(key) {
    return request.post('/backup/restore', { key, mode: 'new' }, { silentError: true })
  },
  deleteSnapshot(key) {
    return request.delete('/backup/snapshots', { data: { key } })
  },
  status() {
    return request.get('/backup/status')
  },
  /** -> { items: [run…] } */
  runs(params) {
    return request.get('/backup/runs', { params: params || {} })
  },
}
