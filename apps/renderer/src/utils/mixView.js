// 音乐/混音设置的纯函数。取值范围与后端 normalizeMix 一致（packages/local/src/timeline/service.js）。
import { t } from '../i18n/index.js'

export const DEFAULT_MIX = { ducking: { enabled: true, gain: 0.25, rampMs: 200 }, loudnorm: true }

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d)

/** 合并补丁并规整为合法值；任何非法输入回落到默认或被夹到范围内 */
export function mergeMix(base, patch) {
  const b = base || {}
  const p = patch || {}
  const bd = b.ducking || {}
  const pd = p.ducking || {}
  const pick = (k, fallback) => (pd[k] !== undefined ? pd[k] : bd[k] !== undefined ? bd[k] : fallback)
  return {
    ducking: {
      enabled: typeof pick('enabled', true) === 'boolean' ? pick('enabled', true) : DEFAULT_MIX.ducking.enabled,
      gain: clamp(num(pick('gain'), DEFAULT_MIX.ducking.gain), 0, 1),
      rampMs: Math.round(clamp(num(pick('rampMs'), DEFAULT_MIX.ducking.rampMs), 0, 5000)),
    },
    loudnorm: typeof (p.loudnorm !== undefined ? p.loudnorm : b.loudnorm) === 'boolean'
      ? (p.loudnorm !== undefined ? p.loudnorm : b.loudnorm)
      : DEFAULT_MIX.loudnorm,
  }
}

/** 0..1 小数 ↔ 百分数（滑块用） */
export const toPercent = (v) => Math.round(num(v, 0) * 100)
export const fromPercent = (p) => clamp(num(p, 0), 0, 400) / 100

/** 音乐轨音量滑块范围：0%–200% */
export const MUSIC_VOLUME_MAX_PERCENT = 200

export function formatDuration(ms) {
  const s = Math.round(num(ms, 0) / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatSize(bytes) {
  const b = num(bytes, 0)
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/** 添加到音乐轨前的提示：曲目比视频短且未选择循环时，结尾会静音 */
export function shortTrackHint(trackMs, videoMs, loop) {
  if (loop || !videoMs || trackMs >= videoMs) return ''
  return t('timeline.music.shortTrack', { track: formatDuration(trackMs), video: formatDuration(videoMs) })
}

/** 本地选择的文件是否可上传（与后端白名单一致） */
export const MUSIC_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']
export const MUSIC_MAX_BYTES = 50 * 1024 * 1024

export function checkMusicFile(file) {
  const ext = String(file?.name || '').split('.').pop().toLowerCase()
  if (!MUSIC_EXTENSIONS.includes(ext)) return t('timeline.music.badExt')
  if (file.size > MUSIC_MAX_BYTES) return t('timeline.music.tooBig')
  if (file.size === 0) return t('timeline.music.emptyFile')
  return ''
}
