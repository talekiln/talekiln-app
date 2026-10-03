import { t } from '../i18n/index.js'

export function parseModelList(models, defaultModel = '') {
  if (Array.isArray(models)) {
    return models.map((m) => String(m).trim()).filter(Boolean)
  }
  if (typeof models === 'string') {
    return models.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean)
  }
  return defaultModel ? [String(defaultModel).trim()].filter(Boolean) : []
}

export function getSelectableModels(configs, serviceType, configId) {
  const list = Array.isArray(configs) ? configs : []
  const selectedConfig = configId
    ? list.find((c) => c.id === configId)
    : null
  const config = selectedConfig
    || list.find((c) => c.service_type === serviceType && c.is_active && c.is_default)
    || list.find((c) => c.service_type === serviceType && c.is_active)

  if (!config) return []
  return parseModelList(config.model, config.default_model)
}

/**
 * 云端目录（GET /catalog）里某类服务的模型选项；价格取自目录价格表，仅作展示提示。
 * serviceType 用本地的 text/image/video/tts；provider 可选，用于只看某个平台。
 */
export function getCatalogModels(catalog, serviceType, provider = '') {
  const models = Array.isArray(catalog?.models) ? catalog.models : []
  const prices = catalog?.prices?.providers || {}
  return models
    .filter((m) => m && m.service_type === serviceType && (!provider || m.provider === provider))
    .map((m) => {
      const entry = prices[m.provider]?.[m.service_type]?.[m.id]
      return {
        id: m.id,
        label: m.label || m.id,
        provider: m.provider,
        priceHint: entry ? formatPriceHint(entry, catalog?.prices?.currency) : ''
      }
    })
}

const PER_KEY = { image: 'model.unit.image', second: 'model.unit.second', char: 'model.unit.char' }
export function formatPriceHint(entry, currency = 'CNY') {
  if (!entry || !Number.isFinite(Number(entry.price))) return ''
  const unit = Object.hasOwn(PER_KEY, entry.per) ? t(PER_KEY[entry.per]) : undefined
  const sym = currency === 'CNY' ? '¥' : `${currency} `
  return unit ? `${sym}${entry.price}/${unit}` : `${sym}${entry.price}`
}

/** 已配置的模型在前，云端目录里本地没有的模型追加在后（去重）。 */
export function mergeModelOptions(localModels, catalogModels) {
  const seen = new Set()
  const out = []
  for (const id of localModels || []) {
    if (!seen.has(id)) {
      seen.add(id)
      out.push({ id, label: id, fromCatalog: false, priceHint: '' })
    }
  }
  for (const m of catalogModels || []) {
    if (seen.has(m.id)) {
      const hit = out.find((o) => o.id === m.id)
      if (hit && !hit.priceHint) {
        hit.priceHint = m.priceHint
        hit.label = m.label || hit.label
      }
      continue
    }
    seen.add(m.id)
    out.push({ id: m.id, label: m.label || m.id, fromCatalog: true, priceHint: m.priceHint || '' })
  }
  return out
}
