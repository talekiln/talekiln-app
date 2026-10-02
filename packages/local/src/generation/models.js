'use strict';
// 生成用的服务商与模型选择：只看“已启用的服务商（含已加载的插件）+ 已保存的配置 + 目录里的模型”，不联网。
const { availableProviders: getEnabled } = require('../providers/enablement');
const { pickConfig, pickSharedKeyConfig, modelFitsRequest } = require('../queue/providerAdapter');

/**
 * 内置偏好（均为百炼已真实验证过的模型名，见 docs/bailian-flow-coverage.md）：
 * 有参考图的出图走 wan2.6-image，否则 wan2.6-t2i；有首帧的视频走 wan2.2-kf2v-flash，否则 wan2.6-t2v。
 * 方舟没有内置偏好，交给适配器按请求形态挑。
 */
const PREFS = Object.freeze({
  bailian: Object.freeze({ image: 'wan2.6-t2i', imageRef: 'wan2.6-image', video: 'wan2.6-t2v', videoFrame: 'wan2.2-kf2v-flash' }),
});

function defaultModelOf(config) {
  if (!config) return undefined;
  if (config.default_model) return config.default_model;
  return Array.isArray(config.model) && config.model.length ? config.model[0] : undefined;
}

/**
 * 第一个“有可用 Key”的已启用服务商。都没有时返回 { provider: 第一个已启用的, ready: false }，
 * 由调用方决定是否拒绝（估算仍然可以给出）。
 */
function chooseProvider(listConfigs, kind) {
  const enabled = getEnabled();
  for (const p of enabled) {
    const own = pickConfig(listConfigs, p, kind);
    if ((own && own.api_key) || pickSharedKeyConfig(listConfigs, p, kind)) return { provider: p, ready: true };
  }
  return { provider: enabled[0], ready: false };
}

/**
 * 选模型。顺序：显式指定 > 已保存配置的默认模型（若适合这次请求形态）> 内置偏好 > 目录里该服务商该类型的第一个。
 * catalogModels: [{ provider, service_type, id }]，目录里有该类型的模型时，偏好必须在目录内。
 * 返回 undefined 表示交给适配器按请求形态自己挑。
 */
function pickModel({ provider, kind, hasFrame = false, hasRefs = false, listConfigs, catalogModels = [], explicit }) {
  if (explicit) return explicit;
  const listed = (catalogModels || []).filter((m) => m.provider === provider && m.service_type === kind).map((m) => m.id);
  const allowed = (m) => !!m && (!listed.length || listed.includes(m));
  const own = listConfigs ? pickConfig(listConfigs, provider, kind) : null;
  const shape = { referenceImages: hasRefs ? ['x'] : [], firstFrameUrl: hasFrame ? 'x' : undefined };
  const saved = modelFitsRequest(provider, kind, defaultModelOf(own), shape);
  if (allowed(saved)) return saved;
  const prefs = PREFS[provider];
  if (prefs) {
    const pref = kind === 'image' ? (hasRefs ? prefs.imageRef : prefs.image) : (hasFrame ? prefs.videoFrame : prefs.video);
    if (allowed(pref)) return pref;
  }
  return listed.length ? listed[0] : undefined;
}

module.exports = { PREFS, chooseProvider, pickModel, defaultModelOf };
