/**
 * 命令面板的注册表与模糊搜索（纯逻辑，无 Vue / DOM 依赖，可 node --test）。
 *
 * 命令：{ id, title, group?, keywords?: string[], hint?, run(ctx), when?(ctx) => boolean, enabled?(ctx) => boolean }
 *   - when 为假：不出现在列表里（如没有打开剧集时的“切到画布”）。
 *   - enabled 为假：显示但置灰、不可执行（如没有可撤销的步骤）。
 * 动态来源（provider）：provider(query, ctx) => 命令[]，用来按输入搜镜头、台词行等大量对象，
 * 不必逐条注册。插件以后用 register / registerProvider 扩展，返回的函数用于卸载。
 */

const RECENT_KEY = 'talekiln.palette.recent.v1'
const MAX_RECENT = 8

// ---------- 模糊匹配 ----------

const norm = (s) => String(s ?? '').toLowerCase()

/**
 * 在 text 里模糊匹配 query（大小写不敏感，空白分词，每个词都要命中）。
 * 返回 null（不匹配）或分数（越大越好）：
 *   连续子串 > 词首 / 前缀命中 > 子序列（相邻字符加分，间隔扣分）。
 */
export function fuzzyScore(query, text) {
  const q = norm(query).trim()
  const t = norm(text)
  if (!q) return 0
  let total = 0
  for (const term of q.split(/\s+/)) {
    const s = scoreTerm(term, t)
    if (s === null) return null
    total += s
  }
  return total
}

function scoreTerm(term, t) {
  const at = t.indexOf(term)
  if (at >= 0) {
    let s = 1000 + term.length * 10
    if (at === 0) s += 300
    else if (/[\s\-_/·:：、，,.]/.test(t[at - 1])) s += 150
    s -= Math.min(at, 100) // 越靠前越好
    s -= Math.min(t.length - term.length, 100) * 0.5 // 越短越贴近
    return s
  }
  // 子序列
  let ti = 0
  let s = 0
  let prev = -2
  for (const ch of term) {
    const j = t.indexOf(ch, ti)
    if (j < 0) return null
    s += j === prev + 1 ? 15 : 3
    if (j === 0 || /[\s\-_/·:：、，,.]/.test(t[j - 1])) s += 8
    s -= Math.min(j - ti, 20) * 0.5
    prev = j
    ti = j + 1
  }
  return s
}

/** 命令对 query 的综合得分：标题全权重，关键词 0.6，分组 0.3；都不命中返回 null。 */
export function scoreCommand(query, cmd) {
  const q = String(query ?? '').trim()
  if (!q) return 0
  const cands = [fuzzyScore(q, cmd.title)]
  const kw = (cmd.keywords || []).map((k) => fuzzyScore(q, k)).filter((x) => x !== null)
  if (kw.length) cands.push(Math.max(...kw) * 0.6)
  if (cmd.group) { const g = fuzzyScore(q, cmd.group); if (g !== null) cands.push(g * 0.3) }
  const hit = cands.filter((x) => x !== null)
  return hit.length ? Math.max(...hit) : null
}

// ---------- 注册表 ----------

function loadRecent(storage) {
  try {
    const v = JSON.parse(storage?.getItem(RECENT_KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_RECENT) : []
  } catch (_) {
    return []
  }
}

function saveRecent(storage, ids) {
  try { storage?.setItem(RECENT_KEY, JSON.stringify(ids)) } catch (_) { /* 忽略 */ }
}

const safeStorage = () => { try { return globalThis.localStorage } catch (_) { return null } }

/**
 * 创建注册表。storage 可注入（测试用内存实现；默认 localStorage，缺失时最近使用只保留在内存）。
 */
export function createRegistry({ storage = safeStorage() } = {}) {
  const commands = new Map() // id -> cmd（保持注册顺序）
  const providers = new Set()
  let recent = loadRecent(storage)

  function register(cmd) {
    if (!cmd || typeof cmd.id !== 'string' || !cmd.id) throw new Error('command.id required')
    if (typeof cmd.title !== 'string' || !cmd.title) throw new Error(`command ${cmd.id}: title required`)
    if (typeof cmd.run !== 'function') throw new Error(`command ${cmd.id}: run must be a function`)
    commands.set(cmd.id, cmd) // 同 id 覆盖：插件可替换内置命令
    return () => { if (commands.get(cmd.id) === cmd) commands.delete(cmd.id) }
  }

  function registerAll(list) {
    const offs = list.map(register)
    return () => offs.forEach((f) => f())
  }

  function registerProvider(fn) {
    if (typeof fn !== 'function') throw new Error('provider must be a function')
    providers.add(fn)
    return () => providers.delete(fn)
  }

  const visible = (c, ctx) => {
    try { return c.when ? !!c.when(ctx) : true } catch (_) { return false }
  }
  const isEnabled = (c, ctx) => {
    try { return c.enabled ? !!c.enabled(ctx) : true } catch (_) { return false }
  }

  /** 静态命令 + 各 provider 在当前 query 下给出的命令（provider 抛错只忽略该来源）。 */
  function collect(query, ctx) {
    const out = [...commands.values()].filter((c) => visible(c, ctx))
    for (const p of providers) {
      try {
        for (const c of p(query, ctx) || []) if (c && c.id && c.title && typeof c.run === 'function' && visible(c, ctx)) out.push(c)
      } catch (_) { /* 忽略 */ }
    }
    return out
  }

  const recentRank = (id) => { const i = recent.indexOf(id); return i < 0 ? -1 : MAX_RECENT - i }

  /**
   * 搜索。query 为空：最近使用在前（按最近顺序），其余按注册顺序；
   * 有 query：按分数降序，同分最近使用优先，再同分按注册顺序；不匹配的丢弃。
   * 返回 [{ cmd, score, enabled, recent }]。
   */
  function search(query, ctx = {}, { limit = 50 } = {}) {
    const q = String(query ?? '').trim()
    const all = collect(q, ctx)
    const rows = []
    all.forEach((cmd, order) => {
      const score = scoreCommand(q, cmd)
      if (score === null) return
      rows.push({ cmd, score, order, enabled: isEnabled(cmd, ctx), recent: recentRank(cmd.id) >= 0 })
    })
    rows.sort((a, b) => {
      if (!q) {
        const ra = recentRank(a.cmd.id)
        const rb = recentRank(b.cmd.id)
        if (ra !== rb) return rb - ra
        return a.order - b.order
      }
      if (b.score !== a.score) return b.score - a.score
      const d = recentRank(b.cmd.id) - recentRank(a.cmd.id)
      return d || a.order - b.order
    })
    return rows.slice(0, limit).map(({ cmd, score, enabled, recent: r }) => ({ cmd, score, enabled, recent: r }))
  }

  /** 最近使用的命令（只返回当前仍可见的）。 */
  function recentCommands(ctx = {}) {
    const byId = new Map(collect('', ctx).map((c) => [c.id, c]))
    return recent.map((id) => byId.get(id)).filter(Boolean)
  }

  function markUsed(id) {
    recent = [id, ...recent.filter((x) => x !== id)].slice(0, MAX_RECENT)
    saveRecent(storage, recent)
  }

  /**
   * 执行命令（id 或命令对象，后者用于 provider 给出的动态命令）。
   * 不存在 / 不可见 / 不可用抛错；成功记入最近使用并返回 run 的结果（支持异步）。
   */
  async function execute(target, ctx = {}) {
    const cmd = typeof target === 'string' ? commands.get(target) : target
    if (!cmd) throw new Error(`unknown command: ${target}`)
    if (!visible(cmd, ctx)) throw new Error(`command not available here: ${cmd.id}`)
    if (!isEnabled(cmd, ctx)) throw new Error(`command disabled: ${cmd.id}`)
    const result = await cmd.run(ctx)
    markUsed(cmd.id)
    return result
  }

  return {
    register, registerAll, registerProvider, search, execute, recentCommands,
    get: (id) => commands.get(id), has: (id) => commands.has(id), list: (ctx = {}) => collect('', ctx),
    recentIds: () => [...recent], clearRecent: () => { recent = []; saveRecent(storage, recent) },
  }
}

export const RECENT_STORAGE_KEY = RECENT_KEY
