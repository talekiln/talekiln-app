// 资产（角色 / 场景 / 道具）的纯函数：名称、图片、多图补丁、@ / # 引用解析、计数、候选排序、分镜关联。
// 不依赖 Vue / 网络，可直接在 node --test 下运行。

export const KINDS = ['characters', 'scenes', 'props']

const SINGULAR = { characters: 'character', scenes: 'scene', props: 'prop' }
export function singularKind(kind) {
  return SINGULAR[kind] || kind
}

function str(v) {
  return v == null ? '' : String(v)
}

/** 资产显示名：场景为“地点 · 时间”，角色 / 道具为 name。 */
export function assetName(kind, item) {
  if (!item) return ''
  if (kind === 'scenes') {
    const loc = str(item.location).trim()
    const time = str(item.time).trim()
    return loc && time ? `${loc} · ${time}` : loc || time
  }
  return str(item.name).trim()
}

/** 描述文本（卡片副标题）：角色取 appearance / description，场景取 prompt，道具取 description。 */
export function assetDescription(kind, item) {
  if (!item) return ''
  if (kind === 'characters') return str(item.appearance || item.description)
  if (kind === 'scenes') return str(item.prompt || item.description)
  return str(item.description || item.prompt)
}

export function assetImageUrl(item) {
  if (!item) return ''
  if (item.local_path) return `/static/${String(item.local_path).replace(/^\/+/, '')}`
  return str(item.image_url)
}

export function hasAssetImage(item) {
  return !!(item && (item.image_url || item.local_path))
}

/** 把 extra_images（JSON 字符串或数组）解析成本地路径数组；非法值返回 []。 */
export function parseExtraImages(raw) {
  if (!raw) return []
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : []
  } catch (_) {
    return []
  }
}

/** 上传一张图：没有主图时成为主图，否则追加到 extra_images。返回要提交的字段补丁（extra_images 为数组）。 */
export function addExtraImagePatch(item, path) {
  if (!hasAssetImage(item)) return { local_path: path }
  return { extra_images: [...parseExtraImages(item?.extra_images), path] }
}

/** 把某张额外图设为主图，原主图降级到 extra_images 第一位（与旧页面一致）。 */
export function setPrimaryPatch(item, path) {
  if (!path || path === item?.local_path) return {}
  const rest = parseExtraImages(item?.extra_images).filter((p) => p !== path)
  const extra = item?.local_path ? [item.local_path, ...rest] : rest
  return { local_path: path, image_url: '', extra_images: extra }
}

export function removeExtraPatch(item, path) {
  return { extra_images: parseExtraImages(item?.extra_images).filter((p) => p !== path) }
}

/** 补丁里的 extra_images 数组序列化成后端要的 JSON 字符串。 */
export function serializeAssetPatch(patch) {
  const out = { ...patch }
  if (Array.isArray(out.extra_images)) out.extra_images = JSON.stringify(out.extra_images)
  return out
}

// ---- @ / # 引用解析 ----

function norm(s) {
  return str(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·・•]+/g, '')
}

// 一个资产的匹配键：tier 0 = 全名；tier 1 = 括号别名 / 括号前的主名 / 场景只写地点
function matchKeys(kind, item) {
  const keys = []
  const full = norm(assetName(kind, item))
  if (full) keys.push([full, 0])
  const rawName = (kind === 'scenes' ? str(item.location) : str(item.name)).normalize('NFKC')
  const m = rawName.match(/^(.*?)\s*\((.*)\)\s*$/)
  if (m) {
    const base = norm(m[1])
    const alias = norm(m[2])
    if (base) keys.push([base, 1])
    if (alias) keys.push([alias, 1])
  }
  if (kind === 'scenes') {
    const loc = norm(item.location)
    if (loc) keys.push([loc, 1])
  }
  return keys
}

/**
 * 解析 “@角色” / “#场景或道具”。返回 { kind, asset, candidates, ambiguous }；找不到时 asset 为 null。
 * 同一类里全名优先于别名；重名取 id 最小的并标记 ambiguous；# 先找场景再找道具。
 */
export function resolveMentionDetail(token, byKind) {
  const none = { kind: null, asset: null, candidates: [], ambiguous: false }
  const raw = str(token).trim()
  if (raw.length < 2) return none
  const lead = raw[0]
  const kinds = lead === '@' ? ['characters'] : lead === '#' ? ['scenes', 'props'] : null
  if (!kinds) return none
  const want = norm(raw.slice(1))
  if (!want) return none
  for (const kind of kinds) {
    let best = null
    let hits = []
    for (const item of byKind?.[kind] || []) {
      let tier = null
      for (const [key, t] of matchKeys(kind, item)) {
        if (key === want && (tier == null || t < tier)) tier = t
      }
      if (tier == null) continue
      if (best == null || tier < best) {
        best = tier
        hits = [item]
      } else if (tier === best) {
        hits.push(item)
      }
    }
    if (hits.length) {
      const candidates = hits.slice().sort((a, b) => Number(a.id) - Number(b.id))
      return { kind, asset: candidates[0], candidates, ambiguous: candidates.length > 1 }
    }
  }
  return none
}

export function resolveMention(token, byKind) {
  return resolveMentionDetail(token, byKind).asset
}

export function assetCounts(byKind) {
  return {
    characters: (byKind?.characters || []).length,
    scenes: (byKind?.scenes || []).length,
    props: (byKind?.props || []).length,
  }
}

/** 候选参考图排序：已锁定 > 已完成（评分高优先，其后 id 新优先）> 进行中 > 等待 > 失败。不修改入参。 */
export function candidateOrder(list, lockedIds) {
  const locked = lockedIds instanceof Set ? lockedIds : new Set(lockedIds == null ? [] : Array.isArray(lockedIds) ? lockedIds : [lockedIds])
  const rank = (c) => {
    if (locked.has(c.id)) return 0
    if (c.status === 'completed') return 1
    if (c.status === 'processing') return 2
    if (c.status === 'failed') return 4
    return 3
  }
  const score = (c) => (typeof c.score === 'number' && Number.isFinite(c.score) ? c.score : -Infinity)
  return [...(list || [])].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra === 1) {
      const sa = score(a)
      const sb = score(b)
      if (sa !== sb) return sb > sa ? 1 : -1
    }
    return Number(b.id) - Number(a.id)
  })
}

/** 关键字搜索（名称 / 描述），可限定一种资产。返回 [{ kind, asset }]，顺序为 角色 > 场景 > 道具。 */
export function searchAssets(byKind, keyword, onlyKind) {
  const q = norm(keyword)
  const out = []
  for (const kind of onlyKind ? [onlyKind] : KINDS) {
    for (const asset of byKind?.[kind] || []) {
      if (!q) {
        out.push({ kind, asset })
        continue
      }
      const hay = [...matchKeys(kind, asset).map((k) => k[0]), norm(assetDescription(kind, asset))]
      if (hay.some((h) => h.includes(q))) out.push({ kind, asset })
    }
  }
  return out
}

function idList(v) {
  if (v == null || v === '') return []
  let arr = v
  if (typeof v === 'string') {
    try { arr = JSON.parse(v) } catch (_) { return [] }
  }
  if (!Array.isArray(arr)) return []
  return arr.map((x) => Number(x && typeof x === 'object' ? x.id : x)).filter((n) => Number.isFinite(n))
}

function shotIds(shot, kind) {
  if (!shot) return []
  if (kind === 'characters') return [...idList(shot.characters), ...idList(shot.character_ids)]
  if (kind === 'scenes') return shot.scene_id != null && shot.scene_id !== '' ? [Number(shot.scene_id)] : []
  return [...idList(shot.prop_ids), ...idList(shot.props)]
}

/** 一个分镜引用了哪些资产（按 id 在 byKind 里查找，缺失的忽略）。 */
export function refsForShot(shot, byKind) {
  const out = { characters: [], scenes: [], props: [] }
  if (!shot) return out
  for (const kind of KINDS) {
    const ids = new Set(shotIds(shot, kind))
    out[kind] = (byKind?.[kind] || []).filter((a) => ids.has(Number(a.id)))
  }
  return out
}

/** 引用了某资产的分镜（同镜号多行只保留 id 最大的一条；按镜号排序）。 */
export function affectedShots(kind, assetId, shots) {
  const matched = (shots || []).filter((s) => shotIds(s, kind).includes(Number(assetId)))
  const byNum = new Map()
  const extras = []
  for (const s of matched) {
    const n = Number(s.storyboard_number)
    if (Number.isFinite(n) && n > 0) {
      const prev = byNum.get(n)
      if (!prev || Number(s.id) > Number(prev.id)) byNum.set(n, s)
    } else {
      extras.push(s)
    }
  }
  return [...byNum.values(), ...extras].sort((a, b) => (Number(a.storyboard_number) || 0) - (Number(b.storyboard_number) || 0))
}

/** 创建场景 / 道具时关联的分集：路由里的分集 > 最近打开的分集（须仍存在）> 第一集；都没有返回 null。 */
export function pickEpisodeId({ routeEpisodeId, lastEpisodeId, episodes } = {}) {
  const r = Number(routeEpisodeId)
  if (Number.isFinite(r) && r > 0) return r
  const l = Number(lastEpisodeId)
  if (Number.isFinite(l) && l > 0 && (episodes || []).some((e) => Number(e.id) === l)) return l
  const first = (episodes || [])[0]
  return first ? Number(first.id) : null
}

/** 插入提示词的引用文本：角色 `@名字`，场景 / 道具 `#名字`（场景为“地点·时间”，空白去掉；resolveMention 能还原）。 */
export function mentionToken(kind, item) {
  const name = assetName(kind, item).replace(/\s+/g, '')
  if (!name) return ''
  return `${kind === 'characters' ? '@' : '#'}${name}`
}

/** 资料库条目 -> 项目资产的创建参数（导入用）。 */
export function libraryItemToAsset(kind, item, { episodeId } = {}) {
  const img = {}
  if (item?.image_url) img.image_url = item.image_url
  if (item?.local_path) img.local_path = item.local_path
  if (kind === 'characters') {
    return { name: str(item.name), description: str(item.description), appearance: str(item.appearance || item.description), ...img }
  }
  const ep = episodeId != null ? { episode_id: episodeId } : {}
  if (kind === 'scenes') {
    return { location: str(item.location), time: str(item.time), prompt: str(item.prompt || item.description), ...ep, ...img }
  }
  return { name: str(item.name), type: str(item.type), description: str(item.description), prompt: str(item.prompt), ...ep, ...img }
}
