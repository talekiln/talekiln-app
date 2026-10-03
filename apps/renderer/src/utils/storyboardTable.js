/** 分镜列表（P1-06）与新建项目表单（P1-05）的纯逻辑，无 Vue / 网络依赖，便于单测。 */

export const SHOT_MIN_SEC = 2
export const SHOT_MAX_SEC = 10
export const CHARS_PER_SEC = 5

export const ASPECT_RATIOS = ['9:16', '16:9', '1:1']
export const DURATION_RANGE = { min: 30, max: 60 }
export const STORY_MAX_CHARS = 8000

const STATUS_KEYS = ['pending', 'processing', 'generating', 'completed', 'failed']

/** i18n key for a legacy shot status (unknown -> pending). */
export function statusKey(status) {
  return `storyboard.status.${STATUS_KEYS.includes(status) ? status : 'pending'}`
}

/** 「添加镜头」的创建参数：追加到末尾，描述留空（用占位提示引导填写，不预填需要手动清掉的文字）。 */
export function newShotPayload(episodeId, rows) {
  return { episode_id: episodeId, storyboard_number: rows.length + 1, description: '', duration: 3 }
}

/** 后端行 -> 表格行。thumb 为首帧缩略图地址（local_path 优先）。 */
export function rowFromApi(sb) {
  const lp = sb.local_path && String(sb.local_path).trim()
  return {
    id: sb.id,
    no: Number(sb.storyboard_number) || 0,
    description: sb.description || '',
    dialogue: sb.dialogue || '',
    duration: Number(sb.duration) || 0,
    thumb: lp ? '/static/' + lp.replace(/^\//, '') : sb.image_url || '',
    status: sb.status || 'pending',
  }
}

/** 按 no、id 排序后返回新数组。 */
export function sortRows(rows) {
  return [...rows].sort((a, b) => a.no - b.no || a.id - b.id)
}

/** 重新编号为 1..n（不改变顺序）。 */
export function renumber(rows) {
  return rows.map((r, i) => ({ ...r, no: i + 1 }))
}

/** 把 from 位置的行移到 to 位置，返回已重新编号的新数组；越界则原样返回。 */
export function moveRow(rows, from, to) {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows
  const next = [...rows]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return renumber(next)
}

export function removeRow(rows, id) {
  return renumber(rows.filter((r) => r.id !== id))
}

export function totalDuration(rows) {
  return rows.reduce((s, r) => s + (Number(r.duration) || 0), 0)
}

/** 台词字数（汉字/字母/数字，标点空格不算）。 */
export function spokenLength(text) {
  const m = String(text || '').match(/[\p{Script=Han}\p{L}\p{N}]/gu)
  return m ? m.length : 0
}

/** 单行校验：返回提示数组（空 = 正常），每项 { key, params }（i18n key）。仅提示，不阻止保存。 */
export function rowWarnings(row) {
  const out = []
  const d = Number(row.duration)
  if (!Number.isFinite(d) || d < SHOT_MIN_SEC || d > SHOT_MAX_SEC) out.push({ key: 'storyboard.warn.duration', params: { min: SHOT_MIN_SEC, max: SHOT_MAX_SEC } })
  else if (spokenLength(row.dialogue) > Math.ceil(d * CHARS_PER_SEC)) out.push({ key: 'storyboard.warn.dialogueLong', params: {} })
  if (!String(row.description || '').trim()) out.push({ key: 'storyboard.warn.noDescription', params: {} })
  return out
}

/** 可编辑字段 -> 后端 PUT 字段。 */
export function patchFromRow(row) {
  return {
    description: row.description,
    dialogue: row.dialogue,
    duration: Math.round((Number(row.duration) || 0) * 10) / 10,
  }
}

/**
 * 防抖自动保存器。任务按 key 去重（同一 key 只保留最新任务，任务内部应读取最新数据）。
 * 状态：saved | dirty | saving | error。保存失败时任务保留，下次 flush / 重试再执行。
 */
// 浏览器里 window.setTimeout 必须以 window 为 this 调用，直接塞进对象再调用会抛 "Illegal invocation"，所以包一层。
const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t) => globalThis.clearTimeout(t),
}

export function createAutosaver({ delay = 800, onState = () => {}, timers = defaultTimers } = {}) {
  const tasks = new Map()
  let timer = null
  let running = null
  let state = 'saved'
  let lastError = null

  const set = (s) => {
    if (s === state) return
    state = s
    onState(s, lastError)
  }

  async function run() {
    timer = null
    if (running) return running
    running = (async () => {
      set('saving')
      try {
        while (tasks.size) {
          const [key, fn] = tasks.entries().next().value
          await fn()
          // 执行期间若同 key 被重新安排，则保留新任务
          if (tasks.get(key) === fn) tasks.delete(key)
        }
        lastError = null
        set(timer ? 'dirty' : 'saved')
      } catch (e) {
        lastError = e
        set('error')
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    get state() { return state },
    get error() { return lastError },
    get pending() { return tasks.size },
    schedule(key, fn) {
      tasks.set(key, fn)
      if (timer) timers.clearTimeout(timer)
      timer = timers.setTimeout(run, delay)
      if (!running) set('dirty')
    },
    cancel(key) {
      tasks.delete(key)
      if (!tasks.size && !running) {
        if (timer) { timers.clearTimeout(timer); timer = null }
        set('saved')
      }
    },
    /** 立即保存所有待处理任务（离开页面前 / 点击重试）。 */
    async flush() {
      if (timer) { timers.clearTimeout(timer); timer = null }
      if (running) await running
      if (tasks.size) await run()
      return state === 'saved'
    },
  }
}

/** 保存状态的 i18n key（未知状态返回空串）。 */
export function saveStateKey(state) {
  return ['saved', 'dirty', 'saving', 'error'].includes(state) ? `storyboard.save.${state}` : ''
}

/** 新建项目表单校验：返回 { ok, errors, body }。errors 是 { key, params } 列表；body 对应 POST /scriptgen/projects。 */
export function buildProjectRequest(form) {
  const errors = []
  const story = String(form.story || '').trim()
  if (!story) errors.push({ key: 'storyboard.form.noStory', params: {} })
  else if (story.length > STORY_MAX_CHARS) errors.push({ key: 'storyboard.form.storyTooLong', params: { max: STORY_MAX_CHARS } })
  if (!form.templateId) errors.push({ key: 'storyboard.form.noTemplate', params: {} })
  if (!ASPECT_RATIOS.includes(form.aspectRatio)) errors.push({ key: 'storyboard.form.noRatio', params: {} })
  const durationSec = Number(form.durationSec)
  if (!Number.isFinite(durationSec) || durationSec < DURATION_RANGE.min || durationSec > DURATION_RANGE.max) {
    errors.push({ key: 'storyboard.form.durationRange', params: { min: DURATION_RANGE.min, max: DURATION_RANGE.max } })
  }
  const body = {
    story,
    templateId: form.templateId,
    aspectRatio: form.aspectRatio,
    durationSec,
  }
  const title = String(form.title || '').trim()
  if (title) body.title = title
  if (form.style) body.style = form.style
  return { ok: errors.length === 0, errors, body }
}
