// 导出页的纯逻辑：表单校验、请求体、编码器选项、状态文案、轮询控制器（计时器可注入，便于测试）。

export const FINAL_STATUSES = ['done', 'failed', 'cancelled']
export const isFinal = (status) => FINAL_STATUSES.includes(status)

/** 与后端 RESOLUTIONS 一致，仅在接口取不到时兜底 */
export const FALLBACK_RESOLUTIONS = [
  { key: '1080p', label: '1080p 横屏 (1920×1080)', width: 1920, height: 1080 },
  { key: '720p', label: '720p 横屏 (1280×720)', width: 1280, height: 720 },
  { key: '1080p-v', label: '1080p 竖屏 (1080×1920)', width: 1080, height: 1920 },
  { key: '720p-v', label: '720p 竖屏 (720×1280)', width: 720, height: 1280 },
]

/** 平台预设兜底（与后端 exporters/presets.js 一致）；码率仅为建议值 */
export const FALLBACK_PLATFORM_PRESETS = [
  { key: 'douyin-9x16', platform: '抖音', label: '抖音 竖屏 9:16 (1080×1920)', aspect: '9:16', width: 1080, height: 1920, fps: 30, bitrate_kbps: 8000 },
  { key: 'shipinhao-3x4', platform: '视频号', label: '视频号 3:4 (1080×1440)', aspect: '3:4', width: 1080, height: 1440, fps: 30, bitrate_kbps: 8000 },
  { key: 'shipinhao-9x16', platform: '视频号', label: '视频号 竖屏 9:16 (1080×1920)', aspect: '9:16', width: 1080, height: 1920, fps: 30, bitrate_kbps: 8000 },
  { key: 'landscape-16x9', platform: '通用', label: '横屏 16:9 (1920×1080)', aspect: '16:9', width: 1920, height: 1080, fps: 30, bitrate_kbps: 10000 },
]

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
  return `建议码率 ${preset.bitrate_kbps} kbps、${preset.fps} fps。码率只是建议值，当前渲染按质量模式导出，尚未按码率控制；发布前请以平台后台要求为准。`
}

export const MEDIA_TARGETS = [
  { value: 'jianying', label: '剪映草稿' },
  { value: 'xmeml', label: 'Premiere（xmeml）' },
  { value: 'fcpxml', label: 'FCPXML（Final Cut / 达芬奇）' },
]

/** 导出到剪映 / Premiere 的表单校验；返回错误文案，通过返回空串 */
export function validateMediaForm(form) {
  if (!form.resolution) return '请选择尺寸'
  const p = String(form.media_dir || '').trim()
  if (!p) return '请填写导出文件夹'
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p)) return '导出文件夹必须是绝对路径，例如 D:\\导出'
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
  const parts = [`${r.written ? '已导出' : '检查通过（未写文件）'}：${r.output_dir}`]
  const n = st.video_segments ?? st.video_clips
  if (n != null) parts.push(`视频 ${n} 段`)
  if (st.subtitle_segments != null || st.subtitle_cues != null) parts.push(`字幕 ${st.subtitle_segments ?? st.subtitle_cues} 条`)
  return parts.join(' · ')
}

const ENCODER_TEXT = {
  h264_nvenc: 'NVIDIA 显卡 (h264_nvenc)',
  h264_qsv: 'Intel 核显 (h264_qsv)',
  h264_amf: 'AMD 显卡 (h264_amf)',
  h264_mf: 'Windows 媒体基础 (h264_mf)',
  libx264: '软件编码 (libx264)',
  libopenh264: '软件编码 (libopenh264)',
}

/** 编码器下拉：自动 + 每个检测到的编码器；不可用的禁用并带原因 */
export function encoderOptions(encoders, best) {
  const list = (encoders || []).filter((e) => e.listed !== false)
  const opts = [{ value: 'auto', label: best ? `自动（推荐：${ENCODER_TEXT[best] || best}）` : '自动', disabled: !best, reason: best ? '' : '没有可用编码器' }]
  for (const e of list) {
    opts.push({
      value: e.name,
      label: ENCODER_TEXT[e.name] || e.name,
      disabled: !e.available,
      reason: e.available ? '' : e.reason || '不可用',
    })
  }
  return opts
}

/** 校验表单，返回错误文案；通过返回空串。导出位置只做前端能判断的部分，其余由后端校验 */
export function validateForm(form) {
  if (!form.resolution) return '请选择分辨率'
  if (!(Number(form.fps) >= 1)) return '请选择帧率'
  const p = String(form.output_path || '').trim()
  if (!p) return '请填写导出位置'
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p)) return '导出位置必须是绝对路径，例如 D:\\导出\\第1集.mp4'
  if (!/\.mp4$/i.test(p)) return '导出文件名必须以 .mp4 结尾'
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
  if (status === 'queued') return '排队中'
  if (status === 'done') return '已完成'
  if (status === 'cancelled') return '已取消'
  if (status === 'failed') return '失败'
  const m = /^segment (\d+)\/(\d+)$/.exec(stage || '')
  if (m) return `渲染分镜 ${m[1]}/${m[2]}`
  if (stage === 'final') return '合成音视频'
  if (stage === 'segments') return '渲染分镜'
  return stage || '处理中'
}

export function progressStatus(status) {
  if (status === 'done') return 'success'
  if (status === 'failed') return 'exception'
  if (status === 'cancelled') return 'warning'
  return undefined
}

const CORE_ERRORS = {
  '-32020': '找不到 ffmpeg，请重新安装或把 ffmpeg 放到 tools/ffmpeg 目录',
  '-32030': '当前 ffmpeg 不支持字幕渲染（缺少 libass），请重新安装自带的 ffmpeg',
  '-32031': '部分素材文件不存在，请检查时间线素材',
  '-32032': '所有编码器都未能完成导出，请换一个编码器或降低分辨率后重试',
}

/** 任务失败信息 → 给用户看的文案 */
export function errorText(error) {
  if (!error) return '导出失败'
  const mapped = CORE_ERRORS[String(error.code)]
  if (mapped) return mapped
  return error.message || '导出失败'
}

export function formatElapsed(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`
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
