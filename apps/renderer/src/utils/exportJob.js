// 导出对话框的纯逻辑：表单校验、请求体、编码器选项、状态文案、轮询控制器（计时器可注入，便于测试）。
// 所有给用户看的文案走 i18n（export.* 键）；与后端数据一致的兜底表保留原文并标 i18n-ignore。
import { t } from '../i18n/index.js'

export const FINAL_STATUSES = ['done', 'failed', 'cancelled']
export const isFinal = (status) => FINAL_STATUSES.includes(status)

/** 与后端 RESOLUTIONS 一致，仅在接口取不到时兜底（label 仅作兜底，界面用 resolutionLabel） */
export const FALLBACK_RESOLUTIONS = [
  { key: '1080p', label: '1080p 横屏 (1920×1080)', width: 1920, height: 1080 }, // i18n-ignore
  { key: '720p', label: '720p 横屏 (1280×720)', width: 1280, height: 720 }, // i18n-ignore
  { key: '1080p-v', label: '1080p 竖屏 (1080×1920)', width: 1080, height: 1920 }, // i18n-ignore
  { key: '720p-v', label: '720p 竖屏 (720×1280)', width: 720, height: 1280 }, // i18n-ignore
]

/** 平台预设兜底（与后端 exporters/presets.js 逐字一致，有防漂移测试）；码率仅为建议值 */
export const FALLBACK_PLATFORM_PRESETS = [
  { key: 'douyin-9x16', platform: '抖音', label: '抖音 竖屏 9:16 (1080×1920)', aspect: '9:16', width: 1080, height: 1920, fps: 30, bitrate_kbps: 8000 }, // i18n-ignore
  { key: 'shipinhao-3x4', platform: '视频号', label: '视频号 3:4 (1080×1440)', aspect: '3:4', width: 1080, height: 1440, fps: 30, bitrate_kbps: 8000 }, // i18n-ignore
  { key: 'shipinhao-9x16', platform: '视频号', label: '视频号 竖屏 9:16 (1080×1920)', aspect: '9:16', width: 1080, height: 1920, fps: 30, bitrate_kbps: 8000 }, // i18n-ignore
  { key: 'landscape-16x9', platform: '通用', label: '横屏 16:9 (1920×1080)', aspect: '16:9', width: 1920, height: 1080, fps: 30, bitrate_kbps: 10000 }, // i18n-ignore
]

/** 尺寸 / 预设的显示名：优先用本地化文案（export.size.<key>），没有就用接口给的 label */
export function sizeLabel(item) {
  if (!item) return ''
  const key = `export.size.${item.key}`
  const text = t(key)
  return text === key ? item.label || item.key : text
}

/** 普通分辨率 + 平台预设合成一张表，buildStartRequest 按 key 查宽高 */
export function sizeTable(resolutions, presets) {
  return [...(resolutions || []), ...(presets || [])]
}

/** 取预设（不存在返回 null）；选中预设时界面把帧率一并切过去 */
export function presetOf(presets, key) {
  return (presets || []).find((p) => p.key === key) || null
}

export function presetHint(preset) {
  if (!preset) return ''
  return t('export.preset.hint', { kbps: preset.bitrate_kbps, fps: preset.fps })
}

export const MEDIA_TARGETS = ['jianying', 'xmeml', 'fcpxml'].map((value) => ({
  value,
  labelKey: `export.media.${value}`,
  get label() { return t(this.labelKey) }, // 兼容旧调用：按当前语言取名
}))

export function mediaTargetLabel(value) {
  const hit = MEDIA_TARGETS.find((x) => x.value === value)
  return hit ? t(hit.labelKey) : String(value ?? '')
}

const ABSOLUTE_PATH = /^([a-zA-Z]:[\\/]|\\\\|\/)/

/** 导出到剪映 / Premiere 的表单校验；返回错误文案，通过返回空串 */
export function validateMediaForm(form) {
  if (!form.resolution) return t('export.err.sizeRequired')
  const p = String(form.media_dir || '').trim()
  if (!p) return t('export.err.dirRequired')
  if (!ABSOLUTE_PATH.test(p)) return t('export.err.dirAbsolute')
  return ''
}

/** 请求体与接口：剪映走 /export/jianying；Premiere 与 FCPXML 走 /export/fcpxml（format 区分） */
export function buildMediaRequest(form, sizes, episodeId, target, extra = {}) {
  const r = sizes.find((x) => x.key === form.resolution)
  const body = {
    episode_id: Number(episodeId),
    output_dir: String(form.media_dir).trim(),
    width: r.width,
    height: r.height,
    fps: Number(form.fps),
    ...extra,
  }
  const name = String(form.media_name || '').trim()
  if (name) body.name = name
  if (target === 'jianying') return { kind: 'jianying', body }
  return { kind: 'fcpxml', body: { ...body, format: target === 'fcpxml' ? 'fcpxml' : 'xmeml' } }
}

/** 导出结果 -> 一句话 */
export function mediaResultText(r) {
  if (!r) return ''
  const st = r.stats || {}
  const parts = [t(r.written ? 'export.media.written' : 'export.media.checked', { dir: r.output_dir })]
  const n = st.video_segments ?? st.video_clips
  if (n != null) parts.push(t('export.media.videoCount', { n }))
  if (st.subtitle_segments != null || st.subtitle_cues != null) parts.push(t('export.media.subtitleCount', { n: st.subtitle_segments ?? st.subtitle_cues }))
  return parts.join(' · ')
}

const ENCODER_NAMES = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264', 'libopenh264']
const encoderText = (name) => (ENCODER_NAMES.includes(name) ? t(`export.encoder.${name}`) : name)

/** 编码器下拉：自动 + 每个检测到的编码器；不可用的禁用并带原因 */
export function encoderOptions(encoders, best) {
  const list = (encoders || []).filter((e) => e.listed !== false)
  const opts = [{
    value: 'auto',
    label: best ? t('export.encoder.autoBest', { name: encoderText(best) }) : t('export.encoder.auto'),
    disabled: !best,
    reason: best ? '' : t('export.encoder.none'),
  }]
  for (const e of list) {
    opts.push({
      value: e.name,
      label: encoderText(e.name),
      disabled: !e.available,
      reason: e.available ? '' : e.reason || t('export.encoder.unavailable'),
    })
  }
  return opts
}

/** 校验表单，返回错误文案；通过返回空串。导出位置只做前端能判断的部分，其余由后端校验 */
export function validateForm(form) {
  if (!form.resolution) return t('export.err.resolutionRequired')
  if (!(Number(form.fps) >= 1)) return t('export.err.fpsRequired')
  const p = String(form.output_path || '').trim()
  if (!p) return t('export.err.pathRequired')
  if (!ABSOLUTE_PATH.test(p)) return t('export.err.pathAbsolute')
  if (!/\.mp4$/i.test(p)) return t('export.err.pathMp4')
  return ''
}

export function buildStartRequest(form, resolutions, episodeId) {
  const r = resolutions.find((x) => x.key === form.resolution)
  return {
    episode_id: Number(episodeId),
    width: r.width,
    height: r.height,
    fps: Number(form.fps),
    encoder: form.encoder || 'auto',
    output_path: String(form.output_path).trim(),
  }
}

export function stageLabel(status, stage) {
  if (status === 'queued') return t('export.stage.queued')
  if (status === 'done') return t('export.stage.done')
  if (status === 'cancelled') return t('export.stage.cancelled')
  if (status === 'failed') return t('export.stage.failed')
  const m = /^segment (\d+)\/(\d+)$/.exec(stage || '')
  if (m) return t('export.stage.segment', { i: m[1], n: m[2] })
  if (stage === 'final') return t('export.stage.final')
  if (stage === 'segments') return t('export.stage.segments')
  return stage || t('export.stage.working')
}

export function progressStatus(status) {
  if (status === 'done') return 'success'
  if (status === 'failed') return 'exception'
  if (status === 'cancelled') return 'warning'
  return undefined
}

const CORE_ERROR_KEYS = {
  '-32020': 'export.coreError.ffmpegMissing',
  '-32030': 'export.coreError.noLibass',
  '-32031': 'export.coreError.missingAssets',
  '-32032': 'export.coreError.allEncodersFailed',
}

/** 任务失败信息 -> 给用户看的文案 */
export function errorText(error) {
  if (!error) return t('export.err.failed')
  const key = CORE_ERROR_KEYS[String(error.code)]
  if (key) return t(key)
  return error.message || t('export.err.failed')
}

export function formatElapsed(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  return t('export.elapsed', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') })
}

export function formatPercent(p) {
  const n = Number(p)
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n * 10) / 10)) : 0
}

/**
 * 轮询 render.status（经本地服务 /export/:id/status）。
 * - 每 intervalMs 请求一次，直到进入终态（done / failed / cancelled）；
 * - 单次请求失败不中断，连续失败 maxErrors 次后调用 onError 并停止；
 * - 请求未返回时不会重叠发起下一次。
 */
export function createJobPoller({ getStatus, onUpdate, onError, intervalMs = 1000, maxErrors = 3, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null
  let active = false
  let generation = 0

  async function tick(gen, jobId, errors) {
    if (!active || gen !== generation) return
    let next = errors
    try {
      const s = await getStatus(jobId)
      if (!active || gen !== generation) return
      next = 0
      onUpdate(s)
      if (isFinal(s.status)) { active = false; return }
    } catch (e) {
      if (!active || gen !== generation) return
      next = errors + 1
      if (next >= maxErrors) { active = false; onError(e); return }
    }
    timer = setTimer(() => tick(gen, jobId, next), intervalMs)
  }

  return {
    start(jobId) {
      this.stop()
      active = true
      generation += 1
      return tick(generation, jobId, 0)
    },
    stop() {
      active = false
      generation += 1
      if (timer != null) { clearTimer(timer); timer = null }
    },
    get active() { return active },
  }
}
