import request from '@/utils/request'

export const catalogAPI = {
  /** 模型/价格/公告目录：云端缓存优先，否则内置价格表 */
  get() {
    return request.get('/catalog', { silentError: true })
  },
  refresh() {
    return request.post('/catalog/refresh', {}, { silentError: true })
  },
  /** 平台密钥页地址：{ url, via: 'referral' | 'direct' } */
  referral(provider) {
    return request.get(`/referral/${encodeURIComponent(provider)}`, { silentError: true })
  }
}
