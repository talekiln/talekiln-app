// 对话框注册表。各 lane 在 dialogs/<lane>.js 导出 { 'lane.dialogId': () => import('...vue') }，这里合并。
// openDialog(id, props) 返回 Promise，对话框通过 emit('close', result) 关闭并给出结果；DialogHost.vue 渲染当前对话框。
import { shallowRef } from 'vue'
import script from './script.js'
import assets from './assets.js'
import storyboard from './storyboard.js'
import generate from './generate.js'
import exportDialogs from './export.js'
import canvas from './canvas.js'
import home from './home.js'

const table = new Map()
for (const lane of [script, assets, storyboard, generate, exportDialogs, canvas, home]) {
  for (const [id, loader] of Object.entries(lane || {})) table.set(id, loader)
}

/** 当前打开的对话框：{ id, props, resolve } | null（只有 DialogHost 读取） */
export const currentDialog = shallowRef(null)

let notifier = null
export function setDialogNotifier(fn) {
  notifier = fn
}
async function notify(type, key, params) {
  if (notifier) return notifier(type, key, params)
  try {
    const [{ ElMessage }, { t }] = await Promise.all([import('element-plus'), import('../../i18n/index.js')])
    ElMessage({ type, message: t(key, params) })
  } catch (_) {
    // 无 UI 环境时静默
  }
}

/** 补充注册（测试或 lane 在运行期追加）。同 id 覆盖。 */
export function registerDialog(id, loader) {
  if (!id || typeof loader !== 'function') throw new TypeError('registerDialog(id, () => import(...))')
  table.set(id, loader)
}

export function loaderFor(id) {
  return table.get(id) || null
}

export function openDialog(id, props = {}) {
  if (!table.has(id)) {
    notify('info', 'shell.dialog.notReady', { id })
    return Promise.resolve(undefined)
  }
  // 同一时刻只开一个对话框：先结束上一个
  if (currentDialog.value) closeDialog(undefined)
  return new Promise((resolve) => {
    currentDialog.value = { id, props, resolve }
  })
}

// A generate.* dialog that closes with a result has probably queued work. The shell listens, so open pages
// pick up fast jobs (they can finish between two 8 s task ticks) without a reload.
const submitListeners = new Set()
export function onGenerationSubmitted(fn) {
  submitListeners.add(fn)
  return () => submitListeners.delete(fn)
}

export function closeDialog(result) {
  const cur = currentDialog.value
  if (!cur) return
  currentDialog.value = null
  cur.resolve(result)
  if (result && String(cur.id).startsWith('generate.')) {
    for (const fn of submitListeners) { try { fn(result) } catch (_) { /* a listener must not break closing */ } }
  }
}
