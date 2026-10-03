// 四视图共享逻辑（纯函数，无 Vue / DOM 依赖，可 node --test）。
// 选择对象：{ kind: 'line' | 'shot' | 'segment' | 'node', id }。
//   line / shot / node 的 id 都是项目图节点 id；segment 的 id 是时间线视频片段 id（= compose.segments[].id）。
// 切换视图时选择保持不变，每个视图用 focusIn() 找到“与选择对应的对象”。

export const VIEWS = [
  { key: 'script', label: '剧本' },
  { key: 'storyboard', label: '分镜' },
  { key: 'timeline', label: '时间线' },
  { key: 'canvas', label: '画布' },
]

/** 与内核 PORTS 对应（packages/kernel/src/graph.js），仅用于画布上画连接点；是否可连由内核裁决。 */
export const PORTS = {
  script_line: {},
  shot: { lines: { from: 'script_line', multi: true } },
  image: { shot: { from: 'shot' } },
  video: { image: { from: 'image' }, shot: { from: 'shot' } },
  narration: { shot: { from: 'shot' } },
  compose: { video: { from: 'video', multi: true }, narration: { from: 'narration', multi: true } },
}

export const NODE_TYPE_LABEL = {
  script_line: '剧本行', shot: '镜头', image: '首帧图', video: '视频', narration: '配音', compose: '合成',
}
export const STATE_LABEL = { fresh: '最新', stale: '已过期', none: '未生成' }
export const LINE_KIND_LABEL = { scene_heading: '场景标题', narration: '旁白', dialogue: '对白', action: '动作' }

let txCounter = 0
export function newTxId(prefix = 'ui') {
  txCounter += 1
  const rnd = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${rnd}-${txCounter}`
}

export const selKey = (s) => (s ? `${s.kind}:${s.id}` : '')
export const sameSelection = (a, b) => selKey(a) === selKey(b)

// ---------- store reducers ----------

export function emptyState() {
  return { graph: null, stale: [], seq: 0, canUndo: false, canRedo: false, views: { script: null, shots: null, timeline: null, canvas: null } }
}

/** 全图响应 -> 状态。 */
export function reduceGraph(state, res) {
  return { ...state, graph: res.graph, stale: Array.isArray(res.stale) ? [...res.stale] : [], seq: res.seq ?? 0, canUndo: !!res.can_undo, canRedo: !!res.can_redo }
}

/** 意图 / 事务 / 撤销 / 重做的返回体（summary）-> 状态；图与视图需随后重新拉取。 */
export function reduceSummary(state, sum) {
  return { ...state, seq: sum.seq ?? state.seq, stale: Array.isArray(sum.stale) ? [...sum.stale] : state.stale, canUndo: !!sum.can_undo, canRedo: !!sum.can_redo }
}

export function reduceViews(state, views) {
  return { ...state, views: { ...state.views, ...views } }
}

// ---------- 选择映射 ----------

/** 由四个视图建立查找表。缺失的视图当作空。 */
export function buildIndex({ script, shots, timeline, canvas } = {}) {
  const lineById = {}
  const shotById = {}
  const shotByLegacy = {}
  const clipById = {}
  const nodeById = {}
  const ownerShot = {}
  for (const g of script?.groups || []) for (const l of g.lines) lineById[l.id] = { ...l, group: g.id }
  for (const g of shots?.groups || []) {
    for (const s of g.shots) {
      shotById[s.id] = { ...s, group: g.id }
      if (s.legacy_id != null) shotByLegacy[s.legacy_id] = s.id
    }
  }
  for (const t of timeline?.tracks || []) for (const c of t.clips) clipById[c.id] = { ...c, track: t.kind }
  for (const n of canvas?.nodes || []) nodeById[n.id] = n
  // 下游节点 -> 所属镜头：沿边向上找 shot（image <- shot, video <- shot/image, narration <- shot）
  const from = {}
  for (const e of canvas?.edges || []) (from[e.to.node] ||= []).push(e.from.node)
  const find = (id, seen = new Set()) => {
    if (seen.has(id)) return null
    seen.add(id)
    const n = nodeById[id]
    if (!n) return null
    if (n.type === 'shot') return id
    if (n.type === 'compose' || n.type === 'script_line') return null
    for (const f of from[id] || []) {
      const r = find(f, seen)
      if (r) return r
    }
    return null
  }
  for (const n of canvas?.nodes || []) if (['image', 'video', 'narration'].includes(n.type)) ownerShot[n.id] = find(n.id)
  return { lineById, shotById, shotByLegacy, clipById, nodeById, ownerShot }
}

/** 选择对应的镜头 id（行取第一个关联镜头）；没有则 null。 */
export function shotIdOf(sel, idx) {
  if (!sel) return null
  if (sel.kind === 'shot') return idx.shotById[sel.id] ? sel.id : null
  if (sel.kind === 'line') return idx.lineById[sel.id]?.shot_ids?.[0] ?? null
  if (sel.kind === 'segment') {
    const c = idx.clipById[sel.id]
    if (!c || c.storyboard_id == null) return null
    return idx.shotByLegacy[c.storyboard_id] ?? null
  }
  if (sel.kind === 'node') {
    const n = idx.nodeById[sel.id]
    if (!n) return null
    if (n.type === 'shot') return n.id
    if (n.type === 'script_line') return idx.lineById[n.id]?.shot_ids?.[0] ?? null
    return idx.ownerShot[n.id] ?? null
  }
  return null
}

/** 该镜头的第一个视频片段（时间线上的对应对象）。 */
export function firstSegmentOfShot(shotId, idx) {
  const s = idx.shotById[shotId]
  if (!s || s.legacy_id == null) return null
  const clips = Object.values(idx.clipById).filter((c) => c.track === 'video' && c.storyboard_id === s.legacy_id)
  clips.sort((a, b) => a.start_ms - b.start_ms)
  return clips[0]?.id ?? null
}

/**
 * 某个视图里与选择对应的焦点对象：
 *   script   -> { kind:'line', id }      选择是行就是它自己，否则取镜头的第一行
 *   shots    -> { kind:'shot', id }
 *   timeline -> { kind:'segment', id }   选择是片段就是它自己，否则取镜头的第一个视频片段
 *   canvas   -> { kind:'node', id }      行 / 镜头 / 节点本身；片段取其镜头节点
 * 对象不存在时返回 null。
 */
export function focusIn(view, sel, idx) {
  if (!sel) return null
  const shot = shotIdOf(sel, idx)
  if (view === 'script') {
    if (sel.kind === 'line' && idx.lineById[sel.id]) return sel
    if (sel.kind === 'node' && idx.lineById[sel.id]) return { kind: 'line', id: sel.id }
    const l = shot && idx.shotById[shot]?.line_ids?.[0]
    return l ? { kind: 'line', id: l } : null
  }
  if (view === 'shots' || view === 'storyboard') return shot ? { kind: 'shot', id: shot } : null
  if (view === 'timeline') {
    if (sel.kind === 'segment' && idx.clipById[sel.id]) return sel
    const seg = shot && firstSegmentOfShot(shot, idx)
    return seg ? { kind: 'segment', id: seg } : null
  }
  if (view === 'canvas') {
    if (sel.kind === 'node' && idx.nodeById[sel.id]) return sel
    if (sel.kind === 'line' && idx.nodeById[sel.id]) return { kind: 'node', id: sel.id }
    return shot && idx.nodeById[shot] ? { kind: 'node', id: shot } : null
  }
  return null
}

/** 选择对应的播放头（毫秒）：镜头第一个视频片段的起点；没有则 null（保持原值）。 */
export function playheadFor(sel, idx) {
  const shot = shotIdOf(sel, idx)
  const seg = shot && firstSegmentOfShot(shot, idx)
  return seg ? idx.clipById[seg].start_ms : null
}

/** 选中的对象被删除后清空。 */
export function normalizeSelection(sel, idx) {
  if (!sel) return null
  const exists = (sel.kind === 'line' && idx.lineById[sel.id])
    || (sel.kind === 'shot' && idx.shotById[sel.id])
    || (sel.kind === 'segment' && idx.clipById[sel.id])
    || (sel.kind === 'node' && idx.nodeById[sel.id])
  return exists ? sel : null
}

// ---------- 画布视图模型 ----------

export const NODE_SIZE = { w: 220, h: 96 }

const cut = (s, n = 28) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t }

/** 节点卡片上的关键参数（最多 2-3 行）。 */
export function nodeSummary(node) {
  const p = node.params || {}
  switch (node.type) {
    case 'script_line': return [`${LINE_KIND_LABEL[p.kind] || p.kind}${p.speaker ? ` · ${p.speaker}` : ''}`, cut(p.text, 40)]
    case 'shot': return [cut(p.title || p.description || '（未命名镜头）', 30), `${p.shot_type || '景别未设'} · ${((p.duration_ms ?? 0) / 1000).toFixed(1)}s`]
    case 'image': case 'video': return [`模型 ${p.model}`, `种子 ${p.seed}`]
    case 'narration': return [`音色 ${p.voice}`, `语速 ${p.speed}`]
    case 'compose': return [`${(p.segments || []).length} 个片段`, `${p.size} · ${p.fps}fps`]
    default: return []
  }
}

/** 侧栏可编辑字段：{ key, label, type: 'text'|'textarea'|'number'|'select'|'bool'|'list', options? } */
export function editableFields(type) {
  switch (type) {
    case 'script_line': return [
      { key: 'kind', label: '类型', type: 'select', options: Object.entries(LINE_KIND_LABEL).map(([value, label]) => ({ value, label })) },
      { key: 'speaker', label: '说话人', type: 'text' },
      { key: 'text', label: '文字', type: 'textarea' },
    ]
    case 'shot': return [
      { key: 'title', label: '标题', type: 'text' }, { key: 'description', label: '画面描述', type: 'textarea' },
      { key: 'location', label: '地点', type: 'text' }, { key: 'time', label: '时间', type: 'text' },
      { key: 'shot_type', label: '景别', type: 'text' }, { key: 'angle', label: '角度', type: 'text' }, { key: 'movement', label: '运镜', type: 'text' },
      { key: 'image_prompt', label: '首帧提示词', type: 'textarea' }, { key: 'video_prompt', label: '视频提示词', type: 'textarea' },
      { key: 'characters', label: '角色（逗号分隔）', type: 'list' }, { key: 'duration_ms', label: '时长（毫秒）', type: 'number' },
    ]
    case 'image': case 'video': return [{ key: 'model', label: '模型', type: 'text' }, { key: 'seed', label: '种子', type: 'number' }]
    case 'narration': return [{ key: 'voice', label: '音色', type: 'text' }, { key: 'speed', label: '语速', type: 'number' }]
    case 'compose': return [{ key: 'fps', label: '帧率', type: 'number' }, { key: 'size', label: '尺寸', type: 'text' }, { key: 'aigc_label', label: 'AIGC 标识', type: 'bool' }]
    default: return []
  }
}

/** 表单值 -> 参数值（非法数字返回 undefined 表示不提交）。 */
export function coerceField(field, raw) {
  if (field.type === 'number') {
    const n = Number(raw)
    return raw === '' || raw === null || !Number.isFinite(n) ? undefined : n
  }
  if (field.type === 'list') return String(raw ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  if (field.type === 'bool') return !!raw
  return raw ?? ''
}

export function fieldValue(field, params) {
  const v = params?.[field.key]
  if (field.type === 'list') return Array.isArray(v) ? v.join('，') : ''
  return v ?? (field.type === 'bool' ? false : field.type === 'number' ? 0 : '')
}

/** 只提交确实变了的字段：返回 { patch, changed }。 */
export function diffParams(fields, params, form) {
  const patch = {}
  for (const f of fields) {
    if (!(f.key in form)) continue
    const v = coerceField(f, form[f.key])
    if (v === undefined) continue
    const cur = params?.[f.key] ?? (f.type === 'list' ? [] : undefined)
    if (JSON.stringify(v) !== JSON.stringify(cur)) patch[f.key] = v
  }
  return { patch, changed: Object.keys(patch).length > 0 }
}

/** 场景组边框：成员 = 组内行 / 镜头 + 其下游 image/video/narration。 */
export function groupBoxes(canvas, pad = 24) {
  const byId = Object.fromEntries(canvas.nodes.map((n) => [n.id, n]))
  const idx = buildIndex({ canvas })
  const boxes = []
  for (const g of canvas.groups) {
    const members = new Set(g.children)
    for (const n of canvas.nodes) if (idx.ownerShot[n.id] && members.has(idx.ownerShot[n.id])) members.add(n.id)
    const list = [...members].map((id) => byId[id]).filter(Boolean).map((n) => ({ ...n, layout: displayPos(n) }))
    if (!list.length) continue
    const minX = Math.min(...list.map((n) => n.layout.x)) - pad
    const minY = Math.min(...list.map((n) => n.layout.y)) - pad - 24
    const maxX = Math.max(...list.map((n) => n.layout.x)) + NODE_SIZE.w + pad
    const maxY = Math.max(...list.map((n) => n.layout.y)) + NODE_SIZE.h + pad
    boxes.push({
      id: `group:${g.id}`, type: 'sceneGroup', position: { x: minX, y: minY }, draggable: false, selectable: false, connectable: false, focusable: false,
      zIndex: 0, style: { width: `${maxX - minX}px`, height: `${maxY - minY}px` },
      data: { title: g.title, stale: g.summary?.stale ?? 0, shots: g.summary?.shots ?? 0, lines: g.summary?.lines ?? 0 },
    })
  }
  return boxes
}

/**
 * 节点在画布上的显示位置。保存过 layout 的原样使用；没存过的（layout_auto，内核给的分栏布局）按节点卡片尺寸
 * 拉开行距并把配音往下错开，避免卡片互相压住。只用于显示，不写回图。
 */
export function displayPos(n) {
  if (!n.layout_auto) return { x: n.layout.x, y: n.layout.y }
  return { x: n.layout.x, y: Math.round(n.layout.y * 1.6 + (n.type === 'narration' ? 14 : 0)) }
}

/** 画布“新增节点”可选类型（合成节点每集唯一，不在此列）。 */
export const ADD_NODE_TYPES = ['shot', 'script_line', 'image', 'video', 'narration'].map((value) => ({ value, label: NODE_TYPE_LABEL[value] }))

/** 新节点的落点：放到现有节点最右侧一列，纵向对齐同类型节点（没有同类型就对齐首个节点）；空画布放原点。 */
export function newNodePos(canvas, type) {
  const nodes = (canvas && canvas.nodes) || []
  if (!nodes.length) return { x: 0, y: 0 }
  const pos = nodes.map((n) => ({ type: n.type, ...displayPos(n) }))
  const x = Math.max(...pos.map((p) => p.x)) + NODE_SIZE.w + 60
  const same = pos.filter((p) => p.type === type)
  const y = same.length ? Math.max(...same.map((p) => p.y)) + NODE_SIZE.h + 40 : pos[0].y
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * canvas.addNodeAt 的参数：镜头 / 剧本行要落在一个场景组里（缺省第一个），并给可读的默认参数；
 * 图 / 视频 / 配音节点只需类型和位置，之后用连线挂到镜头下。
 */
export function addNodeArgs(canvas, type, { group = null } = {}) {
  const { x, y } = newNodePos(canvas, type)
  const args = { type, x, y }
  if (type === 'shot' || type === 'script_line') {
    const gid = group || (canvas && canvas.groups && canvas.groups[0] ? canvas.groups[0].id : null)
    if (gid) args.group = gid
    args.params = type === 'shot' ? { title: '新镜头' } : { kind: 'action', text: '（新剧本行）' }
  }
  return args
}

/** 侧栏“场景”列表：{ id, title, lines, shots, stale }。 */
export function sceneRows(canvas) {
  return ((canvas && canvas.groups) || []).map((g) => ({
    id: g.id, title: g.title || '', lines: g.summary?.lines ?? 0, shots: g.summary?.shots ?? 0, stale: g.summary?.stale ?? 0,
  }))
}

/** 场景标题校验（与内核 renameGroup 同规则）：去首尾空白，非空，≤ 200 字；返回 { value } 或 { error }。 */
export function sceneTitleInput(raw) {
  const t = String(raw ?? '').trim()
  if (!t) return { error: '场景标题不能为空' }
  if (t.length > 200) return { error: '场景标题最多 200 字' }
  return { value: t }
}

/** 画布视图 -> Vue Flow 节点 / 边（分组框在最底层）。 */
export function canvasToFlow(canvas, selectedId = null) {
  if (!canvas) return { nodes: [], edges: [] }
  const nodes = canvas.nodes.map((n) => ({
    id: n.id, type: 'card', position: displayPos(n),
    data: { node: n, summary: nodeSummary(n), ports: Object.keys(PORTS[n.type] || {}) },
    selected: n.id === selectedId, zIndex: 1,
  }))
  const edges = canvas.edges.map((e) => ({
    id: e.id, source: e.from.node, target: e.to.node, sourceHandle: 'out', targetHandle: e.to.port, data: { type: e.type },
  }))
  return { nodes: [...groupBoxes(canvas), ...nodes], edges }
}

// ---------- 剧本视图辅助 ----------

/** 把 id 上移（-1）/ 下移（+1）后的新顺序；越界返回 null。 */
export function reorderedIds(ids, id, delta) {
  const i = ids.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= ids.length) return null
  const out = [...ids]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/** 拆分位置有效：内核要求 0 < at < len。 */
export function validSplitAt(text, at) {
  return Number.isInteger(at) && at > 0 && at < String(text ?? '').length
}

/** 行的过期标记：任一关联镜头本身或其下游（图 / 视频 / 配音）没有最新产物。shots: shotView 的镜头 id -> 镜头。 */
export function lineStaleInfo(line, shots, staleSet) {
  const staleShots = []
  for (const sid of line.shot_ids || []) {
    const s = shots[sid]
    if (!s) continue
    if (s.image !== 'fresh' || s.video !== 'fresh' || s.narration === 'stale' || staleSet.has(sid)) staleShots.push(sid)
  }
  return { stale: staleShots.length > 0, shots: staleShots }
}

/** 全局镜号：按场景组与组内顺序，从 1 开始。 */
export function shotNumbers(shotsView) {
  const out = {}
  let n = 0
  for (const g of shotsView?.groups || []) for (const s of g.shots) out[s.id] = ++n
  return out
}

export function staleCount(stale) { return Array.isArray(stale) ? stale.length : 0 }

/**
 * 保持 episode / drama 切到另一个视图的路由位置：具名路由 `episode-<view>`（/p/:dramaId/e/:episodeId/...）。
 * 不知道 dramaId 时才退回按剧集 id 的旧地址，由 router.beforeEach 经 utils/legacyRoutes 查出所属项目后重定向。
 */
export function viewLocation(view, episodeId, dramaId, query = {}) {
  if (dramaId) return { name: `episode-${view}`, params: { dramaId, episodeId }, query: { ...query } }
  return { path: `/episodes/${episodeId}/${view}`, query: { ...query } }
}

/** 路由名属于哪个视图（用于高亮）。 */
export function viewOfRoute(name) {
  return { 'episode-script': 'script', 'episode-storyboard': 'storyboard', 'episode-timeline': 'timeline', 'episode-canvas': 'canvas' }[name] || null
}

// ---------- 时间线片段 id ----------

/** 旧时间线表里内核片段 id 带 `e<episode>_` 前缀（避免全库主键冲突）；共享选择里用内核 id。 */
export function toKernelClipId(id, episodeId) {
  const p = `e${episodeId}_`
  return String(id).startsWith(p) ? String(id).slice(p.length) : String(id)
}

/** 内核片段 id -> 旧时间线里的片段 id（hasClip 判断哪个存在）；都没有返回 null。 */
export function fromKernelClipId(id, episodeId, hasClip) {
  const prefixed = `e${episodeId}_${id}`
  if (hasClip(prefixed)) return prefixed
  return hasClip(id) ? id : null
}
