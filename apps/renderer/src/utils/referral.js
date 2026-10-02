import { catalogAPI } from '@/api/catalog'
import { pickOpenableUrl } from './referralUrl.js'

/**
 * 「添加 Key」向导里打开平台密钥页：地址由本地服务决定（云端跳转或官方页），
 * 页面里的 href 仅作兜底，点击时统一走这里。返回是否已打开。
 */
export async function openKeyPage(provider, { open = (u) => window.open(u, '_blank', 'noopener,noreferrer') } = {}) {
  try {
    const url = pickOpenableUrl(await catalogAPI.referral(provider))
    if (url) {
      open(url)
      return true
    }
  } catch (_) {
    // 本地服务不可用时静默回退
  }
  return false
}
