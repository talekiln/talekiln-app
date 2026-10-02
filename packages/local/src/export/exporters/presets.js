'use strict';
// 平台尺寸预设。码率为“建议值”（kbps），不是平台官方硬性要求；各平台规则会变，发布前以平台后台说明为准。
// 注意：目前 lycore 渲染只用 CRF（libx264 crf 20），不接受码率参数，所以码率仅用于界面提示与文档，
// 并没有真正控制导出码率（见 docs/phase2-export.md「已知限制」）。

const PLATFORM_PRESETS = [
  { key: 'douyin-9x16', platform: '抖音', label: '抖音 竖屏 9:16 (1080×1920)', aspect: '9:16', width: 1080, height: 1920, fps: 30, bitrate_kbps: 8000 },
  { key: 'shipinhao-3x4', platform: '视频号', label: '视频号 3:4 (1080×1440)', aspect: '3:4', width: 1080, height: 1440, fps: 30, bitrate_kbps: 8000 },
  { key: 'shipinhao-9x16', platform: '视频号', label: '视频号 竖屏 9:16 (1080×1920)', aspect: '9:16', width: 1080, height: 1920, fps: 30, bitrate_kbps: 8000 },
  { key: 'landscape-16x9', platform: '通用', label: '横屏 16:9 (1920×1080)', aspect: '16:9', width: 1920, height: 1080, fps: 30, bitrate_kbps: 10000 },
];

function findPreset(key) {
  return PLATFORM_PRESETS.find((p) => p.key === key) || null;
}

module.exports = { PLATFORM_PRESETS, findPreset };
