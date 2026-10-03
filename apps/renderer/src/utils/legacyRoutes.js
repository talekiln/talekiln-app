// 旧地址 -> 新地址（spec §6）。纯函数：不依赖 Vue / DOM，查询通过注入的函数完成，可 node --test。
//
//   deps.episodeToDrama(episodeId): Promise<dramaId|null>   剧集所属项目（GET /episodes/:id）
//   deps.firstEpisode(dramaId): Promise<episodeId|null>      项目的第 1 集（按集号）
//   deps.shotEpisode?(shotId): Promise<episodeId|null>       可选：旧工作台地址里按镜头找剧集
//
// 返回 string = 要重定向到的新地址；null = 不是旧地址（原样放行）。
// 无法解析时（剧集不存在、项目没有剧集）一律落到一个存在的页面，不返回空白页：
//   项目没有剧集 -> /p/:id/assets；剧集查不到所属项目 -> /。

const ID = '(\\d+)'
const RULES = [
  { re: new RegExp(`^/drama/${ID}/?$`), kind: 'drama' },
  { re: /^\/film\/new\/?$/, kind: 'filmNew' },
  { re: new RegExp(`^/film/${ID}/canvas/?$`), kind: 'filmCanvas' },
  { re: new RegExp(`^/film/${ID}/?$`), kind: 'film' },
  { re: new RegExp(`^/episodes/${ID}/(script|canvas|timeline|storyboard|export)/?$`), kind: 'episode' },
  { re: new RegExp(`^/project/${ID}/(storyboard|library|batch)/?$`), kind: 'project' },
  { re: new RegExp(`^/project/${ID}/shot/([^/]+)/?$`), kind: 'projectShot' },
]
// 形似旧地址但 id 不是数字（如 /film/abc）：也当作旧地址，落到首页而不是匹配不到任何路由
const LOOSE = /^\/(drama|film|episodes|project)\/[^/]+/

const asId = (v) => {
  const raw = Array.isArray(v) ? v[0] : v
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function isLegacyPath(path) {
  const p = String(path || '').split(/[?#]/)[0]
  return RULES.some((r) => r.re.test(p)) || LOOSE.test(p)
}

export async function resolveLegacyRoute(to, deps = {}) {
  const path = String(to?.path || '').split(/[?#]/)[0]
  const query = to?.query || {}
  const hit = RULES.map((r) => ({ kind: r.kind, m: path.match(r.re) })).find((x) => x.m)
  if (!hit) return LOOSE.test(path) ? '/' : null
  const { kind, m } = hit
  const safe = async (fn, ...args) => {
    try { return (await fn?.(...args)) ?? null } catch (_) { return null }
  }
  const first = (dramaId) => safe(deps.firstEpisode, dramaId).then(asId)

  if (kind === 'filmNew') return '/new-project'

  if (kind === 'drama') {
    const dramaId = Number(m[1])
    // 有剧集：进外壳根路径，由外壳决定“上次停留的集和视图”；没有剧集：资产页（给出引导）
    return (await first(dramaId)) ? `/p/${dramaId}` : `/p/${dramaId}/assets`
  }

  if (kind === 'film' || kind === 'filmCanvas') {
    const dramaId = Number(m[1])
    const ep = asId(query.episode) || (await first(dramaId))
    if (!ep) return `/p/${dramaId}/assets`
    return `/p/${dramaId}/e/${ep}/${kind === 'film' ? 'storyboard' : 'canvas'}`
  }

  if (kind === 'episode') {
    const episodeId = Number(m[1])
    const view = m[2]
    const dramaId = asId(query.drama) || asId(await safe(deps.episodeToDrama, episodeId))
    if (!dramaId) return '/'
    return `/p/${dramaId}/e/${episodeId}/${view}`
  }

  if (kind === 'project') {
    const dramaId = Number(m[1])
    const what = m[2]
    if (what === 'library') return `/p/${dramaId}/assets`
    if (what === 'batch') return `/p/${dramaId}/batch`
    const ep = asId(query.episode) || (await first(dramaId))
    return ep ? `/p/${dramaId}/e/${ep}/storyboard` : `/p/${dramaId}/assets`
  }

  if (kind === 'projectShot') {
    const dramaId = Number(m[1])
    const shotId = decodeURIComponent(m[2])
    const ep = asId(query.episode) || asId(await safe(deps.shotEpisode, shotId)) || (await first(dramaId))
    return ep ? `/p/${dramaId}/e/${ep}/shot/${encodeURIComponent(shotId)}` : `/p/${dramaId}/assets`
  }

  return null
}
