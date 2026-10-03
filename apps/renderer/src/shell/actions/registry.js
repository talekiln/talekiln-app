// action 注册表：菜单、左栏按钮等只通过 id 触发行为，由各 lane 注册处理函数。
// 不静态依赖 element-plus（保持可在 node --test 下加载）：提示通过可替换的 notifier 输出。

const handlers = new Map()

let notifier = null

export function setActionNotifier(fn) {
  notifier = fn
}

async function notify(type, key, params) {
  if (notifier) return notifier(type, key, params)
  try {
    const [{ ElMessage }, { t }] = await Promise.all([import('element-plus'), import('../../i18n/index.js')])
    ElMessage({ type, message: t(key, params) })
  } catch (_) {
    // 没有 DOM / UI 环境时静默
  }
}

export function registerAction(id, fn) {
  if (!id || typeof id !== 'string') throw new TypeError('registerAction: id must be a non-empty string')
  if (typeof fn !== 'function') throw new TypeError('registerAction: handler must be a function')
  handlers.set(id, fn)
}

export function unregisterAction(id) {
  handlers.delete(id)
}

export function hasAction(id) {
  return handlers.has(id)
}

/**
 * ctx: { router, route, dramaId, episodeId, openDialog, store }
 * 未注册 -> 提示 shell.action.notReady 后返回；处理函数抛错 -> 提示 shell.action.failed，不向外抛。
 */
export async function runAction(id, ctx) {
  const fn = handlers.get(id)
  if (!fn) {
    await notify('info', 'shell.action.notReady', { id })
    return
  }
  try {
    await fn(ctx)
  } catch (e) {
    await notify('error', 'shell.action.failed', { id, message: e?.message || String(e) })
  }
}
