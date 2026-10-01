// 管理后台 API 客户端：纯函数式，依赖（fetch、令牌读取、401 回调）均可注入，便于测试。

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code)
    this.status = status
    this.code = code
  }
}

const ERROR_TEXT = {
  invalid_credentials: '邮箱或密码错误',
  invalid_token: '登录已失效，请重新登录',
  forbidden: '没有权限执行该操作',
  account_disabled: '账号已被禁用',
  rate_limited: '操作过于频繁，请稍后再试',
  not_found: '记录不存在',
  bad_request: '提交的内容不合法',
  payload_too_large: '内容过大',
  network: '无法连接服务器',
}

export function errorText(e) {
  if (!e) return '未知错误'
  if (e.code === 'bad_request' && e.message && e.message !== 'bad_request') return e.message
  return ERROR_TEXT[e.code] || e.message || '请求失败'
}

export function createApi({ base = '/api', fetchImpl, getToken = () => null, onUnauthorized = () => {} } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a))

  async function raw(method, path, body) {
    const headers = {}
    const token = getToken()
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res
    try {
      res = await doFetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch {
      throw new ApiError(0, 'network')
    }
    if (!res.ok) {
      let j = null
      try { j = await res.json() } catch { /* 非 JSON 错误页 */ }
      const code = (j && j.error) || `http_${res.status}`
      // 登录接口自身的 401 是“密码错误”，不触发登出回调
      if (res.status === 401 && path !== '/admin/auth/login') onUnauthorized()
      throw new ApiError(res.status, code, j && j.message)
    }
    return res
  }

  async function json(method, path, body) {
    const res = await raw(method, path, body)
    if (res.status === 204) return null
    return res.json()
  }

  return {
    login: (email, password) => json('POST', '/admin/auth/login', { email, password }),
    me: () => json('GET', '/admin/me'),
    createInvites: (opts) => json('POST', '/admin/invites', opts),
    listInvites: (status) => json('GET', '/admin/invites' + (status ? `?status=${encodeURIComponent(status)}` : '')),
    revokeInvite: (id) => json('POST', `/admin/invites/${encodeURIComponent(id)}/revoke`),
    listUsers: () => json('GET', '/admin/users'),
    getUser: (id) => json('GET', `/admin/users/${encodeURIComponent(id)}`),
    setUserDisabled: (id, disabled) => json('POST', `/admin/users/${encodeURIComponent(id)}/${disabled ? 'disable' : 'enable'}`),
    getAnnouncements: () => json('GET', '/admin/announcements'),
    saveAnnouncements: (list) => json('PUT', '/admin/announcements', list),
    getCatalog: () => json('GET', '/admin/catalog'),
    saveCatalog: (list) => json('PUT', '/admin/catalog', list),
    overview: (days = 14) => json('GET', `/admin/stats/overview?days=${days}`),
    listFeedback: () => json('GET', '/admin/feedback'),
    downloadDiagnostic: async (id) => (await raw('GET', `/admin/feedback/${encodeURIComponent(id)}/diagnostic`)).blob(),
  }
}

// ---- 令牌存放：sessionStorage（关闭标签页即失效）。存储不可用时退化为内存。 ----
const KEY = 'talekiln-admin-token'
let memToken = null
export const auth = {
  get() {
    try { return sessionStorage.getItem(KEY) || memToken } catch { return memToken }
  },
  set(t) {
    memToken = t
    try { sessionStorage.setItem(KEY, t) } catch { /* 忽略 */ }
  },
  clear() {
    memToken = null
    try { sessionStorage.removeItem(KEY) } catch { /* 忽略 */ }
  },
}

export const api = createApi({
  base: import.meta.env?.VITE_API_BASE || '/api',
  getToken: () => auth.get(),
  onUnauthorized: () => {
    auth.clear()
    if (typeof location !== 'undefined' && !location.hash.startsWith('#/login')) location.hash = '#/login'
  },
})
