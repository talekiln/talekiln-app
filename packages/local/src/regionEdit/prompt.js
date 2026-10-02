'use strict';
/**
 * P3-R 选镜改片的纯逻辑（无 IO）：时长换算、策略选择、降级路径的提示词拼接、价格比较。
 * 与生成服务一致：视频按整秒计费，1..15 秒。
 */
const VIDEO_MIN_SEC = 1;
const VIDEO_MAX_SEC = 15;
const STRATEGIES = Object.freeze(['provider_mask', 'segment_splice']);

const clampSec = (s) => Math.min(VIDEO_MAX_SEC, Math.max(VIDEO_MIN_SEC, s));

/** 只重做的那一段按整秒向上取整（厂商按整秒出片；拼回去时再按时长缩放）。 */
function segmentSeconds(t0_ms, t1_ms) {
  return clampSec(Math.ceil((Number(t1_ms) - Number(t0_ms)) / 1000));
}
/** 整镜重做的秒数（与 generation/service.js 的算法相同），用来对比“比整镜便宜”。 */
function fullSeconds(total_ms) {
  return clampSec(Math.round((Number(total_ms) || 0) / 1000));
}

/** 厂商有带遮罩的视频编辑能力 -> 直接调用；否则走“首尾帧生视频 + ffmpeg 拼接”的降级路径。 */
const pickStrategy = (hasVideoEdit) => (hasVideoEdit ? 'provider_mask' : 'segment_splice');

/** 归一化矩形 -> 中文位置描述；接近整幅画面时返回“整幅画面”。 */
function regionLabel(rect) {
  if (!rect || typeof rect !== 'object') return '整幅画面';
  const { x = 0, y = 0, w = 1, h = 1 } = rect;
  if (w >= 0.95 && h >= 0.95) return '整幅画面';
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hor = cx < 1 / 3 ? '左' : cx > 2 / 3 ? '右' : '中';
  const ver = cy < 1 / 3 ? '上' : cy > 2 / 3 ? '下' : '中';
  if (hor === '中' && ver === '中') return '画面中央';
  if (ver === '中') return `画面${hor}侧`;
  if (hor === '中') return `画面${ver}方`;
  return `画面${ver}${hor}`;
}

/** 矩形占画面的百分比（整数）。 */
function regionPercent(rect) {
  if (!rect || typeof rect !== 'object') return 100;
  return Math.max(1, Math.min(100, Math.round((Number(rect.w) || 0) * (Number(rect.h) || 0) * 100)));
}

/**
 * 降级路径的提示词：首尾帧生视频没有遮罩，只能把“改哪里、改成什么”写进文字，并要求其余画面保持不变。
 * shotPrompt 为镜头原提示词（可空）。
 */
function fallbackPrompt(edit, shotPrompt = '') {
  const base = String(shotPrompt || '').trim();
  const change = String(edit.prompt || '').trim();
  const parts = [];
  if (base) parts.push(base.replace(/[。.\s]+$/, ''));
  if (edit.mode === 'region') {
    parts.push(`只修改${regionLabel(edit.rect)}（约占画面 ${regionPercent(edit.rect)}%）：${change}`);
    parts.push('画面其余部分、人物与构图保持不变，动作与前后画面连贯');
  } else {
    parts.push(change);
    parts.push('保持与前后画面的人物、场景和构图连贯');
  }
  return `${parts.join('。')}。`;
}

/** 金额（元）-> 分（整数）。 */
const toCents = (amount) => Math.round((Number(amount) || 0) * 100);

/** 拼接时把生成片段缩放到目标时长的比例（setpts 的乘数）：目标 / 实际。 */
function retimeRatio(targetMs, actualMs) {
  const t = Number(targetMs);
  const a = Number(actualMs);
  if (!(t > 0) || !(a > 0)) return 1;
  return t / a;
}

module.exports = { VIDEO_MIN_SEC, VIDEO_MAX_SEC, STRATEGIES, segmentSeconds, fullSeconds, pickStrategy, regionLabel, regionPercent, fallbackPrompt, toCents, retimeRatio };
