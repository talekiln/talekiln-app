import { ref } from 'vue'
import { api, auth } from './api.js'

// 当前管理员（GET /admin/me：角色与权限清单）。按令牌缓存，换账号登录会自动重新拉取。
export const me = ref(null)
let loadedFor = null

export async function ensureMe(force = false) {
  const token = auth.get()
  if (!token) {
    me.value = null
    loadedFor = null
    return null
  }
  if (!force && me.value && loadedFor === token) return me.value
  me.value = await api.me()
  loadedFor = token
  return me.value
}

export function clearMe() {
  me.value = null
  loadedFor = null
}
