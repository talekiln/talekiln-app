import request from '@/utils/request'

/** P3-P 插件页：已安装插件、开关、从文件夹安装、删除、开发者模式（本地服务 /plugins）。 */
export const pluginsAPI = {
  /** { items: [插件视图...], developer_mode, plugins_dir } */
  list() {
    return request.get('/plugins')
  },
  get(id) {
    return request.get(`/plugins/${encodeURIComponent(id)}`)
  },
  enable(id) {
    return request.post(`/plugins/${encodeURIComponent(id)}/enable`)
  },
  disable(id) {
    return request.post(`/plugins/${encodeURIComponent(id)}/disable`)
  },
  /** 把本机文件夹复制进插件目录并加载；未签名/签名无效的包需先开开发者模式。调用方自己展示错误。 */
  install(dir) {
    return request.post('/plugins/install', { dir }, { silentError: true })
  },
  remove(id) {
    return request.delete(`/plugins/${encodeURIComponent(id)}`)
  },
  getDeveloperMode() {
    return request.get('/settings/developer-mode')
  },
  /** 返回与 list() 同形的汇总（开关一变，哪些插件在跑也跟着变）。 */
  setDeveloperMode(on) {
    return request.put('/settings/developer-mode', { developer_mode: !!on })
  },
}
