// 剧本/分集的纯函数：拆分小说、请求体构造、分集列表变换、剧本文字与内核剧本行互转。
// 只用相对路径导入（node --test 不认 @ 别名），不碰 DOM / 网络。
import { parseScriptIntoEpisodes } from './scriptEpisodes.js'
import { stylePromptMetadataForSave, CUSTOM_STYLE_VALUE } from '../constants/styleOptions.js'

// ---------------------------------------------------------------- 小说 / 长文拆分

/** 默认章节标题：第N章/回/节/集（中文数字、阿拉伯数字、全角数字）或 Chapter N。 */
export const DEFAULT_CHAPTER_PATTERN =
  '^[ \\t\\u3000]*(第[0-9０-９零一二三四五六七八九十百千万]+[章回节集][^\\n\\r]*|(?:Chapter|CHAPTER|chapter)[ \\t]+\\d+[^\\n\\r]*)'

export const DEFAULT_SIZE_PER_EPISODE = 3000

const toInt = (v, fallback) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 1 ? n : fallback
}
const normalizeNewlines = (s) => String(s ?? '').replace(/\r\n?/g, '\n')

function findChapters(text, pattern) {
  let re
  try {
    re = new RegExp(pattern, 'gm')
  } catch (_) {
    return { error: 'bad_pattern', chapters: [], preamble: '' }
  }
  const marks = []
  for (const m of text.matchAll(re)) {
    if (!m[0] || !m[0].trim()) continue
    const group = m.slice(1).find((g) => typeof g === 'string' && g.trim())
    marks.push({ index: m.index, end: m.index + m[0].length, title: (group || m[0]).trim() })
  }
  if (!marks.length) return { error: 'no_match', chapters: [], preamble: '' }
  const chapters = marks.map((mk, i) => ({
    title: mk.title,
    content: text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].index : text.length).trim(),
  }))
  return { error: null, chapters, preamble: text.slice(0, marks[0].index).trim() }
}

function chunkBySize(text, size) {
  const sentences = (p) => p.match(/[^。！？!?；;.\n]*[。！？!?；;.]+["”’』」)）]*|[^。！？!?；;.\n]+$/g) || [p]
  const pieces = []
  for (const para of text.split('\n')) {
    if (!para.trim()) continue
    if (para.length <= size) { pieces.push(para); continue }
    for (const s of sentences(para)) {
      if (s.length <= size) pieces.push(s)
      else for (let i = 0; i < s.length; i += size) pieces.push(s.slice(i, i + size))
    }
  }
  // 句子级切片直接拼接会丢掉换行，所以只在“段落之间”用 \n；同段的句子相邻拼接
  const chunks = []
  let cur = []
  let len = 0
  for (const p of pieces) {
    const add = cur.length ? p.length + 1 : p.length
    if (cur.length && len + add > size) { chunks.push(cur.join('\n')); cur = []; len = 0 }
    cur.push(p)
    len += cur.length > 1 ? p.length + 1 : p.length
  }
  if (cur.length) chunks.push(cur.join('\n'))
  return chunks
}

/**
 * 把长文拆成分集。by: 'chapter'（正则章节，默认）| 'marker'（第N集/章/节标记）| 'size'（按字数）。
 * 返回 { episodes:[{episode_number,title,script_content,chapter_titles}], chapters, error }。
 * error: null | empty | bad_pattern | no_pattern | no_match | bad_size
 */
export function splitNovelIntoEpisodes(rawText, opts = {}) {
  const { by = 'chapter', pattern, chaptersPerEpisode, startNumber, size } = opts
  const text = normalizeNewlines(rawText).trim()
  const fail = (error) => ({ episodes: [], chapters: [], error })
  if (!text) return fail('empty')
  const start = toInt(startNumber, 1)

  if (by === 'marker') {
    const parsed = parseScriptIntoEpisodes(text)
    const list = parsed.split && parsed.episodes.length ? parsed.episodes : [{ title: '', script_content: text }]
    const episodes = list.map((e, i) => ({
      episode_number: start + i, title: e.title || '', script_content: e.script_content, chapter_titles: e.title ? [e.title] : [],
    }))
    return { episodes, chapters: list.map((e) => ({ title: e.title || '', content: e.script_content })), error: null }
  }

  if (by === 'size') {
    const n = Number(size === undefined ? DEFAULT_SIZE_PER_EPISODE : size)
    if (!Number.isFinite(n) || n < 1) return fail('bad_size')
    const chunks = chunkBySize(text, Math.floor(n))
    const episodes = chunks.map((c, i) => ({ episode_number: start + i, title: '', script_content: c, chapter_titles: [] }))
    return { episodes, chapters: chunks.map((c) => ({ title: '', content: c })), error: null }
  }

  let pat = DEFAULT_CHAPTER_PATTERN
  if (pattern !== undefined && pattern !== null) {
    pat = String(pattern).trim()
    if (!pat) return fail('no_pattern')
  }
  const found = findChapters(text, pat)
  if (found.error) return fail(found.error)
  const per = toInt(chaptersPerEpisode, 1)
  const { chapters, preamble } = found
  const episodes = []
  for (let i = 0; i < chapters.length; i += per) {
    const group = chapters.slice(i, i + per)
    const first = group[0].title
    const last = group[group.length - 1].title
    let body = group.map((c) => (c.content ? `${c.title}\n${c.content}` : c.title)).join('\n\n')
    if (i === 0 && preamble) body = `${preamble}\n\n${body}`
    episodes.push({
      episode_number: start + episodes.length,
      title: first === last ? first : `${first} - ${last}`,
      script_content: body,
      chapter_titles: group.map((c) => c.title),
    })
  }
  return { episodes, chapters, error: null }
}

// ---------------------------------------------------------------- AI 写剧本

export const STORY_EPISODE_MAX = 20

/** 把对话框表单变成 POST /generation/story 的请求体（不带 drama_id = 同步返回，不会覆盖已有分集）。 */
export function buildStoryRequest(form = {}) {
  const premise = String(form.premise ?? '').trim()
  if (!premise) return { ok: false, error: 'empty_premise' }
  const gen = String(form.generationStyle ?? '').trim()
  if (gen === CUSTOM_STYLE_VALUE && !String(form.customStylePrompt ?? '').trim()) return { ok: false, error: 'custom_style_prompt' }
  const n = Math.floor(Number(form.episodeCount))
  // 服务端没有语言参数：英文剧本靠在提示里明确要求
  const body = {
    premise: form.language === 'en' ? `${premise}\n\nWrite the script in English.` : premise,
    summary: premise,
    episode_count: Number.isFinite(n) ? Math.min(STORY_EPISODE_MAX, Math.max(1, n)) : 1,
  }
  const storyStyle = String(form.storyStyle ?? '').trim()
  const storyType = String(form.storyType ?? '').trim()
  const title = String(form.title ?? '').trim()
  if (storyStyle) body.style = storyStyle
  if (storyType) { body.type = storyType; body.genre = storyType }
  if (title) body.title = title
  if (gen) body.drama_style = gen
  const metadata = { aspect_ratio: String(form.aspectRatio ?? '').trim() || '16:9' }
  if (storyStyle) metadata.story_style = storyStyle
  if (gen) Object.assign(metadata, stylePromptMetadataForSave(gen, form.customStylePrompt))
  body.metadata = metadata
  if (form.dramaId !== undefined && form.dramaId !== null && form.dramaId !== '') body.drama_id = form.dramaId
  return { ok: true, body }
}

/** 同步响应 {episodes:[{episode,title,content}]} -> [{title, script_content}]，按集号排序，丢掉空正文。 */
export function storyResultToEpisodes(result) {
  const list = Array.isArray(result?.episodes) ? result.episodes : []
  return list
    .map((e, i) => ({ n: Number.isFinite(Number(e?.episode)) ? Number(e.episode) : i + 1, i, title: String(e?.title ?? '').trim(), body: String(e?.content ?? '').trim() }))
    .filter((e) => e.body)
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((e) => ({ title: e.title, script_content: e.body }))
}

// ---------------------------------------------------------------- 全文编辑门槛

/** 没有任何镜头时才允许整篇编辑（整篇替换会让行与镜头脱钩）。 */
export function canEditFullText(arg) {
  return !(arg && arg.hasShots)
}

export function shotCountOfView(shotsView) {
  const groups = Array.isArray(shotsView?.groups) ? shotsView.groups : []
  return groups.reduce((n, g) => n + (Array.isArray(g?.shots) ? g.shots.length : 0), 0)
}

// ---------------------------------------------------------------- 分集列表

const numOf = (e) => {
  const n = Number(e?.episode_number)
  return Number.isFinite(n) && n > 0 ? n : null
}

function sortedEpisodes(eps) {
  return (Array.isArray(eps) ? eps : [])
    .map((e, i) => ({ e, i, n: numOf(e) }))
    .sort((a, b) => (a.n ?? a.i + 1) - (b.n ?? b.i + 1) || a.i - b.i)
    .map((x) => x.e)
}

/** PUT /dramas/:id/episodes 的行：保留集号（服务端按集号 upsert，缺席的集号会被软删除，所以必须带全量）。 */
export function episodesPayload(eps) {
  const list = Array.isArray(eps) ? eps : []
  const withNo = list.map((e, i) => ({ e, i, n: numOf(e) ?? i + 1 })).sort((a, b) => a.n - b.n || a.i - b.i)
  return withNo.map(({ e, n }) => ({
    episode_number: n,
    title: e.title ?? '',
    script_content: e.script_content ?? '',
    description: e.description ?? null,
    duration: Number.isFinite(Number(e.duration)) ? Number(e.duration) : 0,
  }))
}

export function nextEpisodeNumber(eps) {
  let max = 0
  for (const e of Array.isArray(eps) ? eps : []) max = Math.max(max, numOf(e) || 0)
  return max + 1
}

/** 追加分集：集号接在当前最大集号之后，忽略 items 自带的集号。 */
export function withAppended(eps, items) {
  const base = episodesPayload(eps)
  let n = nextEpisodeNumber(eps)
  const added = (items || []).map((it) => ({
    episode_number: n++,
    title: it?.title ?? '',
    script_content: it?.script_content ?? '',
    description: it?.description ?? null,
    duration: Number.isFinite(Number(it?.duration)) ? Number(it.duration) : 0,
  }))
  return [...base, ...added]
}

function mapOne(eps, id, fn) {
  const list = Array.isArray(eps) ? eps : []
  if (!list.some((e) => String(e?.id) === String(id))) return null
  return episodesPayload(list.map((e) => (String(e?.id) === String(id) ? fn(e) : e)))
}

export const withRenamed = (eps, id, title) => mapOne(eps, id, (e) => ({ ...e, title }))

export function withContent(eps, id, patch = {}) {
  return mapOne(eps, id, (e) => ({
    ...e,
    script_content: patch.script_content ?? e.script_content,
    title: patch.title !== undefined ? patch.title : e.title,
  }))
}

/** 删除一集：其余集号不动（不重排）。 */
export function withoutEpisode(eps, id) {
  const list = Array.isArray(eps) ? eps : []
  if (!list.some((e) => String(e?.id) === String(id))) return null
  return episodesPayload(list.filter((e) => String(e?.id) !== String(id)))
}

/** 按集号顺序把第 from 个挪到第 to 个位置，返回新的 id 顺序；无效/无变化为 null。 */
export function episodeOrderAfterMove(eps, from, to) {
  const list = sortedEpisodes(eps)
  const ok = (i) => Number.isInteger(i) && i >= 0 && i < list.length
  if (!ok(from) || !ok(to) || from === to) return null
  const ids = list.map((e) => e.id)
  const [moved] = ids.splice(from, 1)
  ids.splice(to, 0, moved)
  return ids
}

/** 移动会触及的那几集（from 与 to 之间，含两端），按集号顺序。 */
export function affectedEpisodeIds(eps, from, to) {
  const list = sortedEpisodes(eps)
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.min(list.length - 1, Math.max(from, to))
  return list.slice(lo, hi + 1).map((e) => e.id)
}

/**
 * 按新的 id 顺序重排：集号槽位不变，标题/正文/简介/时长跟着内容走。
 * （后端按集号 upsert，id 钉在集号上，所以“换位”只能换内容。）
 */
export function reorderRows(eps, orderIds) {
  const list = sortedEpisodes(eps)
  if (!Array.isArray(orderIds) || orderIds.length !== list.length) return null
  const byId = new Map(list.map((e) => [String(e.id), e]))
  const picked = orderIds.map((id) => byId.get(String(id)))
  if (picked.some((e) => !e) || new Set(orderIds.map(String)).size !== list.length) return null
  const slots = episodesPayload(list).map((r) => r.episode_number)
  return picked.map((e, i) => ({
    episode_number: slots[i],
    title: e.title ?? '',
    script_content: e.script_content ?? '',
    description: e.description ?? null,
    duration: Number.isFinite(Number(e.duration)) ? Number(e.duration) : 0,
  }))
}

// ---------------------------------------------------------------- 项目设置

export const CLIP_DURATION_DEFAULT = 5

/** 表单 -> { update: PUT /dramas/:id, outline: PUT /dramas/:id/outline }（outline 的 metadata 由服务端合并）。 */
export function buildProjectSettingsRequests(form = {}) {
  const title = String(form.title ?? '').trim()
  if (!title) return { ok: false, error: 'empty_title' }
  const style = String(form.style ?? '').trim()
  if (style === CUSTOM_STYLE_VALUE && !String(form.customStylePrompt ?? '').trim()) return { ok: false, error: 'custom_style_prompt' }
  const dur = Math.round(Number(form.clipDuration))
  const metadata = {
    aspect_ratio: String(form.aspectRatio ?? '').trim() || '16:9',
    video_clip_duration: Number.isFinite(dur) && dur > 0 ? dur : CLIP_DURATION_DEFAULT,
    script_language: form.language === 'en' ? 'en' : 'zh',
    ...stylePromptMetadataForSave(style, form.customStylePrompt),
  }
  const storyStyle = String(form.storyStyle ?? '').trim()
  if (storyStyle) metadata.story_style = storyStyle
  return {
    ok: true,
    update: { title, description: String(form.description ?? '').trim() },
    outline: { genre: String(form.genre ?? '').trim(), style, metadata },
  }
}

// ---------------------------------------------------------------- 剧本文字 <-> 内核剧本行

const SPEAKER_RE = /^([^：:（()#]{1,20})[：:]\s*(.+)$/

/** 内核 parseScript 的同语法移植（有对拍测试）：[{title, lines:[{kind,speaker,text}]}]。 */
export function parseScriptLines(text) {
  const scenes = []
  let cur = null
  const scene = (title) => { cur = { title, lines: [] }; scenes.push(cur); return cur }
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const title = line.replace(/^#+\s*/, '')
      scene(title).lines.push({ kind: 'scene_heading', speaker: '', text: title })
      continue
    }
    if (!cur) scene('')
    let m
    if (/^[△▲]/.test(line)) cur.lines.push({ kind: 'action', speaker: '', text: line.replace(/^[△▲]\s*/, '') })
    else if (/^[（(].*[）)]$/.test(line)) cur.lines.push({ kind: 'action', speaker: '', text: line.slice(1, -1) })
    else if ((m = SPEAKER_RE.exec(line))) cur.lines.push({ kind: 'dialogue', speaker: m[1].trim(), text: m[2].trim() })
    else cur.lines.push({ kind: 'narration', speaker: '', text: line })
  }
  return scenes
}

/** 内核剧本视图 -> 与 parseScriptLines 互逆的纯文字（用于同步回 episodes.script_content 与全文编辑）。 */
export function scriptTextOfView(view) {
  const out = []
  for (const g of Array.isArray(view?.groups) ? view.groups : []) {
    const lines = Array.isArray(g.lines) ? g.lines : []
    if (g.title && !(lines[0] && lines[0].kind === 'scene_heading')) out.push(`# ${g.title}`)
    for (const l of lines) {
      const text = String(l.text ?? '').trim()
      if (!text) continue
      if (l.kind === 'scene_heading') out.push(`# ${text}`)
      else if (l.kind === 'action') out.push(`△${text}`)
      else if (l.kind === 'dialogue') {
        const sp = String(l.speaker ?? '').trim()
        if (!sp || (text.startsWith(sp) && /^[：:]/.test(text.slice(sp.length)))) out.push(text)
        else out.push(`${sp}：${text}`)
      } else out.push(text)
    }
  }
  return out.join('\n')
}

/**
 * 用新文字整体替换内核图里的剧本行（只在没有镜头时可用）。
 * 返回 { ok:true, ops } 或 { ok:false, error:'has_shots' }；ops 交给 views.tx / kernel tx。
 */
export function scriptReplaceOps(graph, text) {
  const nodes = graph?.nodes || {}
  const groups = graph?.groups || {}
  if (Object.values(nodes).some((n) => n.type === 'shot')) return { ok: false, error: 'has_shots' }
  const maxOf = (ids, prefix) => {
    let max = 0
    for (const id of ids) {
      const m = new RegExp(`^${prefix}_(\\d+)$`).exec(String(id))
      if (m) max = Math.max(max, Number(m[1]))
    }
    return max
  }
  // 从“历史最大”之后分配（含即将被删的），撤销/重做时不会撞 id
  let nextLine = maxOf(Object.keys(nodes), 'line')
  let nextGrp = maxOf(Object.keys(groups), 'grp')

  const lineIds = Object.keys(nodes).filter((id) => nodes[id].type === 'script_line')
  const gone = new Set(lineIds)
  const ops = lineIds.map((id) => ({ op: 'removeNode', id }))
  for (const gid of graph?.group_order || []) {
    const rest = (groups[gid]?.children || []).filter((c) => !gone.has(c))
    if (!rest.length) ops.push({ op: 'removeGroup', id: gid })
  }
  const adds = []
  for (const scene of parseScriptLines(text)) {
    const children = []
    for (const l of scene.lines) {
      const id = `line_${++nextLine}`
      children.push(id)
      ops.push({ op: 'addNode', node: { id, type: 'script_line', params: { kind: l.kind, speaker: l.speaker || '', text: l.text || '' } } })
    }
    adds.push({ op: 'addGroup', group: { id: `grp_${++nextGrp}`, title: scene.title || '', children } })
  }
  return { ok: true, ops: [...ops, ...adds] }
}

// ---------------------------------------------------------------- 检查器：出场资产

const MENTION_RE = /[@#][^\s@#，。、；：！？,.;:!?"'“”‘’()（）【】[\]「」<>《》]+/g

/** 文本里的 @角色 / #场景·道具 记号，按出现顺序去重（记号后面可能紧跟着正文，所以只是候选）。 */
export function extractMentions(...texts) {
  const out = []
  const seen = new Set()
  for (const text of texts) {
    for (const m of String(text ?? '').match(MENTION_RE) || []) {
      if (!seen.has(m)) { seen.add(m); out.push(m) }
    }
  }
  return out
}

/** 记号解析：中文里 “@林夏走进旧书店” 没有分隔符，所以从最长前缀往短试，名字至少 2 个字（整个记号只有 2 个字符时除外）。 */
export function mentionAssets(texts, resolve) {
  const out = []
  const seen = new Set()
  for (const tok of extractMentions(...(Array.isArray(texts) ? texts : [texts]))) {
    const min = tok.length <= 3 ? 2 : 3
    for (let len = tok.length; len >= min; len--) {
      const a = resolve(tok.slice(0, len))
      if (a) {
        if (!seen.has(a)) { seen.add(a); out.push(a) }
        break
      }
    }
  }
  return out
}

/**
 * 一行出场的资产：挂的镜头绑定的角色 / 场景 / 道具 + 行文字、镜头描述里的 @ # 记号。
 * refsFor(params) -> {characters, scenes, props}（来自资产 store 的 refs）；resolve(token) -> 资产 | null。
 * 资产没加载（byKind 为空）时返回三个空数组，由界面决定是否隐藏。
 */
export function appearingAssets({ shots = [], texts = [], byKind = {}, refsFor = null, resolve = null } = {}) {
  const out = { characters: [], scenes: [], props: [] }
  const seen = { characters: new Set(), scenes: new Set(), props: new Set() }
  const add = (kind, a) => {
    if (!a || !out[kind]) return
    const id = Number(a.id)
    if (seen[kind].has(id)) return
    seen[kind].add(id)
    out[kind].push(a)
  }
  const kindOf = (a) => ['characters', 'scenes', 'props'].find((k) => (byKind[k] || []).some((x) => x === a || Number(x.id) === Number(a.id))) || null
  for (const s of shots) {
    const params = s?.params || {}
    if (refsFor) {
      const r = refsFor(params) || {}
      for (const k of ['characters', 'scenes', 'props']) for (const a of r[k] || []) add(k, a)
    }
    // 角色字段里直接存名字的旧数据
    if (resolve && Array.isArray(params.characters)) {
      for (const c of params.characters) if (typeof c === 'string' && c.trim() && !/^\d+$/.test(c.trim())) add('characters', resolve(`@${c.trim()}`))
    }
  }
  if (resolve) {
    const own = shots.map((s) => s?.params?.description)
    for (const a of mentionAssets([...texts, ...own], resolve)) {
      const k = kindOf(a)
      if (k) add(k, a)
    }
  }
  return out
}
