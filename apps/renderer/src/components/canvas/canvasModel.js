// 画布视图的纯逻辑（可 node --test）：译文标签、只看过期的过滤、“应用并重新生成”的计划、覆盖层 -> Vue Flow。
// 标签全部走 t()，语言切换后在模板里重新求值即可更新；项目里共享的中文标签表（utils/projectViews.js）不再被画布使用。
import { t } from '../../i18n/index.js'
import { buildIndex, editableFields } from '../../utils/projectViews.js'

const LINE_KINDS = ['scene_heading', 'narration', 'dialogue', 'action']

export const nodeTypeLabel = (type) => t(`canvas.nodeType.${type}`)
export const lineKindLabel = (kind) => (LINE_KINDS.includes(kind) ? t(`canvas.lineKind.${kind}`) : String(kind ?? ''))
/** fresh / stale / none 有标签；源节点（剧本行、镜头）的 'source' 返回空串，界面不显示状态标签。 */
export const stateLabel = (state) => (['fresh', 'stale', 'none'].includes(state) ? t(`canvas.state.${state}`) : '')

/** 侧栏字段：与 utils/projectViews.editableFields 同 key / type，label 与选项走译文。 */
export function editableFieldsT(type) {
  return editableFields(type).map((f) => {
    const out = { ...f, label: t(`canvas.field.${f.key}`) }
    if (f.type === 'select') out.options = f.options.map((o) => ({ value: o.value, label: lineKindLabel(o.value) }))
    return out
  })
}

const cut = (s, n = 28) => { const x = String(s ?? ''); return x.length > n ? `${x.slice(0, n)}…` : x }

/** 节点卡片上的关键参数（最多 2 行）。 */
export function nodeSummaryT(node) {
  const p = node.params || {}
  switch (node.type) {
    case 'script_line': return [`${lineKindLabel(p.kind)}${p.speaker ? ` · ${p.speaker}` : ''}`, cut(p.text, 40)]
    case 'shot': return [
      cut(p.title || p.description || t('canvas.summary.untitledShot'), 30),
      t('canvas.summary.shotMeta', { type: p.shot_type || t('canvas.summary.shotTypeUnset'), seconds: ((p.duration_ms ?? 0) / 1000).toFixed(1) }),
    ]
    case 'image': case 'video': return [t('canvas.summary.model', { value: p.model }), t('canvas.summary.seed', { value: p.seed })]
    case 'narration': return [t('canvas.summary.voice', { value: p.voice }), t('canvas.summary.speed', { value: p.speed })]
    case 'compose': return [t('canvas.summary.segments', { n: (p.segments || []).length }), t('canvas.summary.sizeFps', { size: p.size, fps: p.fps })]
    default: return []
  }
}

/** “新增节点”时镜头 / 剧本行的默认参数（会写进项目，所以跟随当前语言）。 */
export function newNodeParams(type) {
  if (type === 'shot') return { title: t('canvas.msg.newShotTitle') }
  if (type === 'script_line') return { kind: 'action', text: t('canvas.msg.newLineText') }
  return undefined
}

/** 场景标题校验（与内核 renameGroup 同规则）：{ value } 或 { error }。 */
export function sceneTitleCheck(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return { error: t('canvas.msg.sceneTitleEmpty') }
  if (v.length > 200) return { error: t('canvas.msg.sceneTitleTooLong') }
  return { value: v }
}

/** 画布节点参数补丁 -> setParam 操作（一个事务 = 一步撤销）。 */
export function paramOps(nodeId, patch) {
  return Object.entries(patch || {}).map(([k, v]) => ({ op: 'setParam', node: nodeId, path: [k], value: v }))
}

/**
 * “只看过期”：保留过期（含从未生成）的节点、它们所属的镜头，以及两端都保留的连线。
 * extraStale：外部的过期 id 集合（项目图的过期列表）；节点自带的 stale 标记同样算。返回与输入同形的新对象，不改输入。
 */
export function staleOnlyCanvas(canvas, extraStale = null) {
  if (!canvas || !Array.isArray(canvas.nodes)) return { nodes: [], edges: [], groups: [], group_order: [] }
  const idx = buildIndex({ canvas })
  const keep = new Set()
  for (const n of canvas.nodes) {
    if (!(n.stale || (extraStale && extraStale.has(n.id)))) continue
    keep.add(n.id)
    const owner = idx.ownerShot[n.id]
    if (owner) keep.add(owner)
  }
  return {
    ...canvas,
    nodes: canvas.nodes.filter((n) => keep.has(n.id)),
    edges: (canvas.edges || []).filter((e) => keep.has(e.from.node) && keep.has(e.to.node)),
    groups: (canvas.groups || []).filter((g) => g.children.some((c) => keep.has(c))),
  }
}

/**
 * “应用并重新生成”走哪个队列任务：镜头 -> 首帧图 + 视频；首帧图 / 视频节点 -> 对应种类（所属镜头）。
 * 返回 { storyboardId, kind }；配音 / 合成 / 剧本行不走出图队列，镜头没有旧表 id 时也无法排队，返回 null。
 */
export function regeneratePlan(node, idx) {
  if (!node) return null
  let shot = null
  let kind = null
  if (node.type === 'shot') { shot = node; kind = 'both' } else if (node.type === 'image' || node.type === 'video') {
    shot = idx?.nodeById?.[idx?.ownerShot?.[node.id]] || null
    kind = node.type
  }
  const sid = shot && shot.legacy_id
  if (!kind || sid == null) return null
  return { storyboardId: Number(sid), kind }
}

/**
 * “版本历史”要定位到哪个节点：首帧图 / 视频 / 配音节点就是它自己；镜头取它名下第一个有产物类型的节点（视频 > 首帧图 > 配音）；
 * 剧本行与合成节点没有版本，返回 null。
 */
export function historyTarget(node, canvas) {
  if (!node) return null
  if (node.type === 'image' || node.type === 'video' || node.type === 'narration') return node.id
  if (node.type !== 'shot' || !canvas) return null
  const idx = buildIndex({ canvas })
  for (const type of ['video', 'image', 'narration']) {
    const hit = canvas.nodes.find((n) => n.type === type && idx.ownerShot[n.id] === node.id)
    if (hit) return hit.id
  }
  return null
}

/** 覆盖层 -> Vue Flow：只读节点（不可拖动、不可连线）和不可选的虚线边。 */
export function assetOverlayToFlow(layout) {
  if (!layout || !Array.isArray(layout.nodes)) return { nodes: [], edges: [] }
  return {
    nodes: layout.nodes.map((n) => ({
      id: n.id, type: 'assetRef', position: { x: n.x, y: n.y }, draggable: false, connectable: false, deletable: false, zIndex: 2,
      data: { kind: n.kind, assetId: n.assetId, name: n.name, missing: n.missing, shots: n.shots },
    })),
    edges: layout.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, sourceHandle: 'out', selectable: false, focusable: false, deletable: false,
      class: 'asset-ref-edge', style: { strokeDasharray: '5 4' },
    })),
  }
}
