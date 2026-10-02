import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { accountAPI } from '@/api/account'
import { statusSummary } from '@/utils/account'

const POLL_MS = 5 * 60 * 1000

export const useAccountStore = defineStore('account', () => {
  const status = ref(null)
  const loaded = ref(false)
  const lastAt = ref(0)
  let timer = null

  const summary = computed(() => statusSummary(status.value))
  const loggedIn = computed(() => !!status.value?.logged_in)

  /** 读本地状态；sync=true 时本地服务会在许可证过半时联网续期（访问令牌过期由本地自动刷新）。 */
  async function fetch({ sync = false } = {}) {
    try {
      status.value = await accountAPI.status(sync ? { sync: 1 } : undefined)
    } catch (_) {
      // 本地服务异常时保留旧状态，不触发门禁
    } finally {
      loaded.value = true
      lastAt.value = Date.now()
    }
    return status.value
  }

  async function login(form) {
    status.value = await accountAPI.login({ email: form.email.trim(), password: form.password })
    lastAt.value = Date.now()
    return status.value
  }

  async function register(form) {
    status.value = await accountAPI.register({
      invite_code: form.inviteCode.trim(),
      email: form.email.trim(),
      password: form.password
    })
    lastAt.value = Date.now()
    return status.value
  }

  async function logout() {
    status.value = await accountAPI.logout()
    lastAt.value = Date.now()
    return status.value
  }

  // P2-C：短信验证码 / 微信扫码。两者登录成功后返回的都是与 login 相同的状态视图
  async function loginBySms(form) {
    status.value = await accountAPI.smsLogin({
      phone: String(form.phone || '').replace(/[\s-]/g, ''),
      code: String(form.code || '').trim(),
      invite_code: String(form.inviteCode || '').trim() || undefined
    })
    lastAt.value = Date.now()
    return status.value
  }

  async function loginByWechat(ticket, inviteCode) {
    status.value = await accountAPI.wechatLogin({ ticket, invite_code: String(inviteCode || '').trim() || undefined })
    lastAt.value = Date.now()
    return status.value
  }

  /** 周期同步；会话在后台失效（刷新令牌被拒）或授权过期时，门禁开启则跳转登录页。 */
  function startWatcher(router, routeDecision) {
    if (timer) return
    timer = setInterval(async () => {
      await fetch({ sync: true })
      const cur = router.currentRoute.value
      const d = routeDecision(status.value, cur)
      if (d !== true) router.push(d)
    }, POLL_MS)
  }

  function stopWatcher() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { status, loaded, lastAt, summary, loggedIn, fetch, login, register, logout, loginBySms, loginByWechat, startWatcher, stopWatcher }
})
