/**
 * 服务商开关（渲染端）。后端 config.yaml `providers.enabled` 是唯一来源，通过 GET /providers 下发：
 * [{ id, label, aliases: [AI 配置里 provider 字段的取值...] }]。拉取失败时按默认只开放百炼。
 * 引导向导、AI 配置页、模型目录下拉都只认这里，不再各自写死服务商列表。
 */

import { t } from '../i18n/index.js'

export const DEFAULT_PROVIDERS = [
  { id: 'bailian', get label() { return t('model.provider.bailian') }, aliases: ['bailian', 'dashscope', 'aliyun', 'qwen_image', 'qwen'] },
]

/** 规范化服务端返回；空或异常时回退默认。 */
export function normalizeProviders(list) {
  const out = (Array.isArray(list) ? list : [])
    .filter((p) => p && typeof p.id === 'string' && p.id)
    .map((p) => ({ id: p.id, label: p.label || p.id, aliases: Array.isArray(p.aliases) ? p.aliases.map((a) => String(a).toLowerCase()) : [p.id] }))
  return out.length ? out : DEFAULT_PROVIDERS
}

/** AI 配置里的 provider 值（如 dashscope）对应的开放服务商 id；不属于任何已开放服务商返回 null。 */
export function providerIdForConfig(providers, configProvider) {
  const n = String(configProvider || '').toLowerCase()
  const hit = normalizeProviders(providers).find((p) => p.aliases.includes(n))
  return hit ? hit.id : null
}

/** 预设厂商下拉：只保留已开放服务商的预设；自定义入口、编辑中的当前值不受影响（调用方追加）。 */
export function filterPresetProviders(presets, providers) {
  return (presets || []).filter((p) => providerIdForConfig(providers, p.id) !== null)
}

/** 一键配置按钮是否显示：按钮对应的服务商 id 已开放。 */
export function oneKeyVisible(providers, providerId) {
  return normalizeProviders(providers).some((p) => p.id === providerId)
}

/** 开放服务商的名称串，用于提示语，如“阿里云百炼”或“阿里云百炼、火山方舟”。 */
export function providerLabels(providers) {
  return normalizeProviders(providers).map((p) => p.label).join(t('model.listSep'))
}
