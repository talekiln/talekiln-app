import request from '@/utils/request'

// 登录页自己展示错误，所以关闭全局错误提示
const quiet = { silentError: true }

export const accountAPI = {
  status(params) {
    return request.get('/account/status', { params, ...quiet })
  },
  login(body) {
    return request.post('/account/login', body, quiet)
  },
  register(body) {
    return request.post('/account/register', body, quiet)
  },
  logout() {
    return request.post('/account/logout', {}, quiet)
  },
  refresh() {
    return request.post('/account/refresh', {}, quiet)
  },

  // P2-C：短信验证码 / 微信扫码（本地服务透传云端）
  smsSend(body) {
    return request.post('/account/sms/send', body, quiet)
  },
  smsLogin(body) {
    return request.post('/account/sms/login', body, quiet)
  },
  wechatQr() {
    return request.post('/account/wechat/qr', {}, quiet)
  },
  wechatQrStatus(ticket) {
    return request.get(`/account/wechat/qr/${encodeURIComponent(ticket)}`, quiet)
  },
  /** 开发 / 模拟适配器专用：模拟扫码确认。 */
  wechatConfirm(ticket, body = {}) {
    return request.post(`/account/wechat/qr/${encodeURIComponent(ticket)}/confirm`, body, quiet)
  },
  wechatLogin(body) {
    return request.post('/account/wechat/login', body, quiet)
  }
}
