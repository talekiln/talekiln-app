import { ref, readonly } from 'vue'
import { desktopBridge, normalizeStatus } from '@/utils/updatesView'

// 主进程推送的「云端更新 / 公告」状态，全局一份；浏览器开发模式下 bridge 为 null，status 保持空状态
const status = ref(normalizeStatus(null))
const isDesktop = ref(false)
let bound = false

function bind() {
  if (bound) return
  bound = true
  const bridge = desktopBridge()
  if (!bridge) return
  isDesktop.value = true
  try { bridge.onCloudStatus((p) => { status.value = normalizeStatus(p) }) } catch (_) { /* 忽略 */ }
  Promise.resolve().then(() => bridge.getCloudStatus()).then((p) => { if (p) status.value = normalizeStatus(p) }).catch(() => {})
}

export function useDesktopCloud() {
  bind()
  async function checkNow() {
    const bridge = desktopBridge()
    if (!bridge) return status.value
    try { const p = await bridge.checkCloudNow(); if (p) status.value = normalizeStatus(p) } catch (_) { /* 忽略 */ }
    return status.value
  }
  async function download() {
    const bridge = desktopBridge()
    if (!bridge) return { ok: false, reason: '不在桌面端' }
    try { return (await bridge.downloadUpdate()) || { ok: false } } catch (e) { return { ok: false, reason: e?.message } }
  }
  return { status: readonly(status), isDesktop: readonly(isDesktop), checkNow, download }
}
