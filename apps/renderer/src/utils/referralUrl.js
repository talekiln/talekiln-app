/** 本地服务返回的密钥页地址只接受 https，且不含内嵌凭据；其余一律不打开。 */
export function pickOpenableUrl(result) {
  const raw = result && result.url
  if (typeof raw !== 'string') return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.username || u.password) return null
    return u.toString()
  } catch (_) {
    return null
  }
}
