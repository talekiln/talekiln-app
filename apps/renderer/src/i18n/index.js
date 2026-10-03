import { ref } from 'vue'
import catalog from './catalog.js'

export const LOCALES = ['zh-CN', 'en']
const STORE_KEY = 'talekiln.locale'

function initial() {
  try {
    const saved = globalThis.localStorage?.getItem(STORE_KEY)
    if (LOCALES.includes(saved)) return saved
  } catch (_) { /* 私有窗口等情况读不到，用默认 */ }
  const nav = globalThis.navigator?.language || ''
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export const locale = ref(initial())

export function createTranslator(messages, getLocale) {
  return function t(key, params) {
    const loc = getLocale()
    const raw = messages[loc]?.[key] ?? messages['zh-CN']?.[key] ?? key
    if (!params) return raw
    return raw.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
  }
}

export const t = createTranslator(catalog, () => locale.value)

export function setLocale(l) {
  if (!LOCALES.includes(l)) return
  locale.value = l
  try { globalThis.localStorage?.setItem(STORE_KEY, l) } catch (_) { /* 忽略 */ }
  if (globalThis.document) globalThis.document.documentElement.lang = l
}

export function useI18n() {
  return { t, locale, setLocale, LOCALES }
}
