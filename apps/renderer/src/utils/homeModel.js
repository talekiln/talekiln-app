// 首页（项目列表）的纯函数：卡片落点、卡片摘要、搜索、小说分章、备份文件名、"最近删除"记录。
// 不依赖 Vue / 路由 / 网络，可直接在 node --test 下运行。

import { ASPECT_RATIOS, DURATION_RANGE, STORY_MAX_CHARS } from './storyboardTable.js'

export const HOME_VIEWS = ['script', 'storyboard', 'timeline', 'canvas']

function asList(v) {
  return Array.isArray(v) ? v : []
}

/** 按集号排序的剧集（不修改入参）。 */
export function sortedEpisodes(project) {
  return [...asList(project?.episodes)].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
}

/**
 * 点击项目卡片后的落点。
 * lastVisited = shell store 的 lastView(dramaId)：{ episodeId, view } | null。
 * - 记录里的集仍存在且视图合法 -> 'last'：那一集的那个视图
 * - 否则有剧集 -> 'first'：第 1 集（按集号）的剧本
 * - 没有剧集 -> 'empty'：project-home（外壳决定落点，没有剧集时是资产页 / 剧本空状态）
 * 返回的 location 是具名路由，永远不是 /film/ 或 /drama/ 这类旧路径。
 */
export function cardNextStop(project, lastVisited) {
  if (!project || project.id == null) return { kind: 'none', location: { name: 'list' }, episodeId: null, episodeNumber: null, view: null }
  const dramaId = project.id
  const eps = sortedEpisodes(project)
  if (!eps.length) {
    return { kind: 'empty', location: { name: 'project-home', params: { dramaId } }, episodeId: null, episodeNumber: null, view: null }
  }
  const lastId = Number(lastVisited?.episodeId)
  const lastEp = Number.isFinite(lastId) ? eps.find((e) => Number(e.id) === lastId) : null
  if (lastEp && HOME_VIEWS.includes(lastVisited?.view)) {
    const view = lastVisited.view
    return {
      kind: 'last',
      location: { name: `episode-${view}`, params: { dramaId, episodeId: lastEp.id } },
      episodeId: lastEp.id,
      episodeNumber: lastEp.episode_number ?? null,
      view,
    }
  }
  const first = eps[0]
  return {
    kind: 'first',
    location: { name: 'episode-script', params: { dramaId, episodeId: first.id } },
    episodeId: first.id,
    episodeNumber: first.episode_number ?? null,
    view: 'script',
  }
}

function staticUrl(p) {
  const s = String(p || '').trim()
  if (!s) return ''
  if (/^(https?:|data:|blob:|\/)/i.test(s)) return s
  return '/static/' + s.replace(/^\//, '')
}

function shotCover(sb) {
  if (!sb) return ''
  if (sb.local_path && String(sb.local_path).trim()) return staticUrl(sb.local_path)
  if (sb.image_url && String(sb.image_url).trim()) return staticUrl(sb.image_url)
  return ''
}

/** 卡片摘要：集数、镜头数、画幅、更新时间、封面（项目缩略图，否则第一个有图的镜头）。 */
export function projectCardInfo(project) {
  const eps = sortedEpisodes(project)
  let shotCount = 0
  let cover = staticUrl(project?.thumbnail)
  for (const ep of eps) {
    for (const sb of asList(ep.storyboards)) {
      shotCount++
      if (!cover) cover = shotCover(sb)
    }
  }
  return {
    title: project?.title || '',
    episodeCount: eps.length,
    shotCount,
    aspect: project?.metadata?.aspect_ratio || '',
    updatedAt: project?.updated_at || '',
    cover,
  }
}

/** 本地搜索：标题或描述包含关键字（不区分大小写，两端空白忽略）。 */
export function filterProjects(projects, keyword) {
  const list = asList(projects)
  const k = String(keyword || '').trim().toLowerCase()
  if (!k) return list
  return list.filter((p) => `${p.title || ''}\n${p.description || ''}`.toLowerCase().includes(k))
}

/** 日期显示（跟随界面语言）；无法解析时返回空串。 */
export function formatUpdated(value, locale = 'zh-CN') {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch (_) {
    return d.toISOString().slice(0, 16).replace('T', ' ')
  }
}

function codedError(code, message) {
  const e = new Error(message || code)
  e.code = code
  return e
}

/**
 * 按章节标题的正则把文本切成章节。pattern 的第 1 个捕获组是标题。
 * 失败抛带 code 的错误（界面按 code 翻译）：EMPTY_TEXT / BAD_PATTERN / NO_MATCH。
 * pattern 为空：整篇作为 1 章（没有章节标题的剧本）。
 */
export function splitNovelChapters(text, pattern) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!normalized) throw codedError('EMPTY_TEXT')
  const source = String(pattern || '').trim()
  if (!source) return [{ title: '', content: normalized }]
  let regex
  try {
    regex = new RegExp(source, 'gm')
  } catch (_) {
    throw codedError('BAD_PATTERN')
  }
  const matches = [...normalized.matchAll(regex)]
  if (!matches.length) throw codedError('NO_MATCH')
  return matches
    .map((m, i) => {
      const title = String(m[1] || m[0] || '').trim()
      const contentStart = (m.index ?? 0) + String(m[0] || '').length
      const nextStart = i + 1 < matches.length ? (matches[i + 1].index ?? normalized.length) : normalized.length
      return { title, content: normalized.slice(contentStart, nextStart).trim() }
    })
    .filter((c) => c.title || c.content)
}

/** 每 size 章合成一集；返回 PUT /dramas/:id/episodes 需要的字段加 chapter_titles（仅预览用）。 */
export function buildEpisodesFromChapters(chapters, size, startNumber = 1) {
  const per = Math.max(1, Number(size) || 1)
  const groups = []
  asList(chapters).forEach((ch, i) => {
    const gi = Math.floor(i / per)
    if (!groups[gi]) groups[gi] = []
    groups[gi].push(ch)
  })
  return groups.map((g, i) => {
    const titles = g.map((c) => c.title).filter(Boolean)
    const title = !titles.length ? '' : titles.length === 1 ? titles[0] : `${titles[0]} - ${titles[titles.length - 1]}`
    return {
      episode_number: startNumber + i,
      title,
      script_content: g.map((c) => [c.title, c.content].filter(Boolean).join('\n')).join('\n\n'),
      chapter_titles: titles,
    }
  })
}

/** 完整备份的下载文件名：<安全标题>-YYYYMMDD.talekiln.zip */
export function backupFileName(title, now = new Date()) {
  const safe = String(title || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60) || 'project'
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${safe}-${y}${m}${d}.talekiln.zip`
}

export function isBackupFileName(name) {
  return /\.talekiln\.zip$/i.test(String(name || ''))
}

// ---- "最近删除"记录：删除前做了本机快照的项目，保留最近 5 条，供从快照恢复 ----

export const DELETED_LOG_MAX = 5
export const DELETED_LOG_KEY = 'talekiln.home.deleted'

export function parseDeletedLog(raw) {
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((r) => r && r.dramaId != null && r.snapshotId != null).slice(0, DELETED_LOG_MAX)
  } catch (_) {
    return []
  }
}

/** 新记录放最前；同一项目只留最新一条；超过 5 条丢弃最旧的。缺 dramaId 时原样返回。 */
export function rememberDeleted(log, rec) {
  const list = asList(log)
  if (!rec || rec.dramaId == null) return list
  return [rec, ...list.filter((r) => String(r.dramaId) !== String(rec.dramaId))].slice(0, DELETED_LOG_MAX)
}

export function forgetDeleted(log, dramaId) {
  return asList(log).filter((r) => String(r.dramaId) !== String(dramaId))
}

/** 具名路由位置：某集的某个视图（视图不合法时落到剧本）。 */
export function viewLocation(view, dramaId, episodeId) {
  const v = HOME_VIEWS.includes(view) ? view : 'script'
  return { name: `episode-${v}`, params: { dramaId, episodeId } }
}

// ---- 任务中心：把任务映射到翻译 key（文字本身在 messages/home.js） ----

const KNOWN_TASK_ERRORS = [
  'INVALID_API_KEY', 'MODEL_NOT_ENABLED', 'INSUFFICIENT_BALANCE', 'RATE_LIMITED', 'INVALID_PARAMS',
  'TASK_FAILED', 'NETWORK', 'BAD_RESPONSE', 'PROVIDER_NOT_AVAILABLE', 'CAPABILITY_NOT_SUPPORTED',
]

/** 失败原因的翻译 key；没有错误码返回 ''；不认识的错误码回退到服务端给的可读文字（readable）。 */
export function taskErrorKey(task) {
  if (!task || !task.error_code) return ''
  if (task.uncertain || String(task.error_message || '').startsWith('SUBMIT_UNCERTAIN')) return 'home.tasks.err.UNCERTAIN'
  if (KNOWN_TASK_ERRORS.includes(task.error_code)) return `home.tasks.err.${task.error_code}`
  return 'home.tasks.err.UNKNOWN'
}

const TASK_STATES = ['queued', 'submitting', 'submitted', 'polling', 'downloading', 'succeeded', 'failed', 'cancelled']
export function taskStateKey(state) {
  return TASK_STATES.includes(state) ? `home.tasks.state.${state}` : 'home.tasks.state.unknown'
}

/** "对象"列：{ key, shot } 或 null。 */
export function taskTargetInfo(task) {
  const p = task && task.params
  if (!p) return null
  if (p._vo) return { key: 'home.tasks.target.voice', shot: p._vo.legacy_id ?? '?' }
  const g = p._gen
  if (!g) return null
  return { key: g.kind === 'video' ? 'home.tasks.target.video' : 'home.tasks.target.frame', shot: g.storyboard_id ?? '?' }
}

/** 「一句话写剧本」表单校验：返回错误码数组（界面按 code 翻译）；空数组表示通过。 */
export function validateOneLine(form) {
  const f = form || {}
  const errors = []
  const story = String(f.story || '').trim()
  if (!story) errors.push('STORY_EMPTY')
  else if (story.length > STORY_MAX_CHARS) errors.push('STORY_TOO_LONG')
  if (!f.templateId) errors.push('TEMPLATE')
  if (!ASPECT_RATIOS.includes(f.aspectRatio)) errors.push('RATIO')
  const d = Number(f.durationSec)
  if (!Number.isFinite(d) || d < DURATION_RANGE.min || d > DURATION_RANGE.max) errors.push('DURATION')
  return errors
}

// 小说 / 剧本分章的预设正则（第 1 个捕获组是章节标题）。中文字符用 \u 转义写，保持本文件没有中文字面量。
export const CHAPTER_PATTERNS = {
  zh: '^\\s*(\\u7b2c[0-9\\u96f6\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341\\u767e\\u5343\\u4e24]+[\\u7ae0\\u56de\\u8282\\u96c6][^\\n]*)',
  en: '^\\s*((?:Chapter|CHAPTER|Episode|EPISODE)\\s+\\d+[^\\n]*)',
  none: '',
}
