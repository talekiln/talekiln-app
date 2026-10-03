// 导出对话框的纯逻辑（无 Vue / 网络依赖，可在 node 下测试）。
import { FALLBACK_RESOLUTIONS, FALLBACK_PLATFORM_PRESETS, encoderOptions } from '../../utils/exportJob.js'
import { t } from '../../i18n/index.js'

const DEFAULT_FPS = [24, 25, 30, 60]

/**
 * GET /export/options 的响应 -> 对话框需要的状态。
 * refresh（重新检测编码器）时只更新编码器 / 选项列表，不覆盖用户已选的值。
 */
export function applyOptions(o, current = {}, { refresh = false } = {}) {
  const src = o || {}
  const resolutions = src.resolutions && src.resolutions.length ? src.resolutions : FALLBACK_RESOLUTIONS
  const presets = src.platform_presets && src.platform_presets.length ? src.platform_presets : FALLBACK_PLATFORM_PRESETS
  const fpsOptions = src.fps_options && src.fps_options.length ? src.fps_options : current.fpsOptions || DEFAULT_FPS
  const encoders = encoderOptions(src.encoders, src.best_encoder)
  const out = { resolutions, presets, fpsOptions, encoders }
  if (!refresh) {
    out.resolution = src.default_resolution || current.resolution || '1080p'
    out.fps = src.default_fps || current.fps || 30
    out.outputPath = src.output_path || ''
    out.aigc = src.aigc || null
  } else if (current.encoder && !encoders.some((x) => x.value === current.encoder && !x.disabled)) {
    out.encoder = 'auto'
  }
  return out
}

/** 由默认视频路径推出默认导出文件夹（D:\导出\第1集.mp4 -> D:\导出）；推不出返回空串 */
export function dirOfPath(p) {
  const s = String(p || '').trim()
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  if (i <= 0) return ''
  const dir = s.slice(0, i)
  return /^[a-zA-Z]:$/.test(dir) ? dir + s[i] : dir
}

/** 草稿档提示：本集还有草稿档产物时，导出前提醒；没有返回空串 */
export function draftHint(count) {
  const n = Number(count) || 0
  return n > 0 ? t('export.dialog.draftHint', { n }) : ''
}
