'use strict';
/**
 * 草稿 / 成片质量档（spec §10.2）。数据表在这里，可调；只放“已核实”的取值，依据见 docs/superpowers/notes/backend-quality.md。
 *
 *   final = null  不改任何东西：沿用 generation/models.js 原有的选择顺序（显式 > 已保存配置 > 内置偏好 > 目录第一个）。
 *   draft         每个服务商、每种请求形态一条：{ model?, resolution?, size? }，null = 这个形态没有已核实的更便宜选项，照成片档走。
 *
 * 请求形态（slot）：
 *   image      不带参考图的文生图          imageRef   带 1-4 张参考图的图生图
 *   video      带首帧的视频                videoText  纯文生视频
 *
 * 质量档只影响“这一次发给服务商的请求”，不是节点参数，所以不进 cacheKey：切档位不会让任何产物过期。
 * 档位记在新产物的版本元数据里（metadata.quality）。
 */

const QUALITIES = Object.freeze(['draft', 'final']);
const DEFAULT_QUALITY = 'final';

const PROFILES = Object.freeze({
  draft: Object.freeze({
    bailian: Object.freeze({
      // z-image-turbo：真 Key 跑通过（live_image_zimage），价目表里 0.1 元/张（占位价，verified:false），wan2.6-t2i 是 0.2 元/张（verified:true）；只做文生图，所以带参考图时不用。
      image: Object.freeze({ model: 'z-image-turbo' }),
      // wan2.6-image 是唯一验证过的带参考图出图模型，没有更便宜的已验证选项。
      imageRef: null,
      // wan2.2-kf2v-flash 480P：真 Key 跑通过（live_video_kf2v），已验证的最便宜视频档（0.1 元/秒）。
      video: Object.freeze({ model: 'wan2.2-kf2v-flash', resolution: '480P' }),
      // 文生视频只验证过 wan2.6-t2v 720P；480P 文生视频尺寸没验证，不猜。
      videoText: null,
    }),
    ark: Object.freeze({
      // 方舟的适配器没有任何一项经真 Key 验证（见 providers/ark/index.js 头注释），所以不换模型，也不改图片尺寸；
      // 只用适配器已支持的 `--rs 480p` 视频分辨率标志（价目表里 480p 是最低档）。
      image: null,
      imageRef: null,
      video: Object.freeze({ resolution: '480p' }),
      videoText: Object.freeze({ resolution: '480p' }),
    }),
  }),
  final: null,
});

// 适配器自己的默认分辨率：档位要的分辨率等于它时不用再显式带上（请求与成片档完全一致 = 这一档对该请求没有节省）
const KNOWN_DEFAULT_RESOLUTION = Object.freeze({ 'wan2.2-kf2v-flash': '480P' });

function normalizeQuality(q) {
  return q === 'draft' ? 'draft' : DEFAULT_QUALITY;
}

function isQuality(q) {
  return QUALITIES.includes(q);
}

/** (kind, 请求形态) -> 档位表里的 slot 名。 */
function slotOf(kind, shape = {}) {
  if (kind === 'image') return shape.hasRefs ? 'imageRef' : 'image';
  if (kind === 'video') return shape.hasFrame ? 'video' : 'videoText';
  return null;
}

/** 某档位下某服务商某种请求的覆盖项：{ model?, resolution?, size? } | null（null = 不覆盖）。 */
function profileFor(quality, provider, kind, shape = {}) {
  const tier = PROFILES[normalizeQuality(quality)];
  if (!tier) return null;
  const slot = slotOf(kind, shape);
  const p = slot && tier[provider] ? tier[provider][slot] : null;
  return p ? { ...p } : null;
}

/**
 * 在“成片档的选择结果”之上套质量档。
 *   model          成片档下本来会用的模型（节点已存的所选模型，或自动挑的）
 *   autoModel      成片档下自动挑的模型（用来判断节点上的模型是不是用户显式选的：与自动挑的不同 = 显式）
 *   allowed(m)     目录里是否允许这个模型（目录列了该类型的模型时，档位模型必须在其中）
 * 返回 { model, resolution, size, applied }；用户显式选的模型优先，只套分辨率 / 尺寸。
 */
function applyQuality({ quality, provider, kind, shape = {}, model, autoModel, allowed = () => true }) {
  const out = { model: model || undefined, resolution: undefined, size: undefined, applied: false };
  const p = profileFor(quality, provider, kind, shape);
  if (!p) return out;
  const explicit = !!model && model !== 'default' && model !== autoModel;
  if (p.model && !explicit && allowed(p.model)) out.model = p.model;
  if (p.resolution && p.resolution !== KNOWN_DEFAULT_RESOLUTION[out.model]) out.resolution = p.resolution;
  if (p.size) out.size = p.size;
  out.applied = out.model !== (model || undefined) || !!out.resolution || !!out.size;
  return out;
}

module.exports = { QUALITIES, DEFAULT_QUALITY, PROFILES, normalizeQuality, isQuality, slotOf, profileFor, applyQuality };
