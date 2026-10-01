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
  }
}
