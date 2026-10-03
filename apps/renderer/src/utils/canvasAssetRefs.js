// 画布“显示资产引用”：把镜头引用的角色 / 场景 / 道具算成只读的覆盖层节点和连线。
// 纯函数，无 Vue / DOM 依赖。结果只用于显示，永远不写进内核（覆盖层节点 id 以 `asset:` 开头，与内核节点 id 不会冲突）。
import { NODE_SIZE, displayPos } from './projectViews.js'

export const ASSET_NODE_PREFIX = 'asset:'
export const ASSET_EDGE_PREFIX = 'assetref:'
export const ASSET_NODE_SIZE = { w: 180, h: 56 }
export const ASSET_KINDS = ['character', 'scene', 'prop']

const ROW_GAP = 16 // 同一列里资产节点之间的最小空隙
const GRAPH_GAP = 80 // 资产列与内核图最左侧节点的距离
const COL_GAP = 40 // 资产列之间的距离

export const isAssetRefId = (id) => typeof id === 'string' && id.startsWith(ASSET_NODE_PREFIX)

const normName = (v) => String(v ?? '').trim().replace(/^[@#]/, '').trim().toLowerCase()
const isIdLike = (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^\d+$/.test(v.trim()))
const sameId = (a, b) => a != null && b != null && String(a) === String(b)
const list = (v) => (Array.isArray(v) ? v : [])

/** 在一类资产里按 id 找，找不到再按名字（可带前导 @ / #）找。 */
function lookup(items, id, name) {
  let hit = id != null ? items.find((a) => a && sameId(a.id, id)) : null
  if (!hit && name) {
    const n = normName(name)
    if (n) hit = items.find((a) => a && normName(a.name) === n)
  }
  return hit || null
}

/**
 * 一个引用条目（id 数字 / 名字字符串 / { id, name } 对象）-> { assetId, name, missing }。
 * 找不到资产时 missing = true：id 引用保留 id，名字引用保留名字。
 */
function resolveEntry(items, entry) {
  let id = null
  let name = ''
  if (entry && typeof entry === 'object') {
    id = isIdLike(entry.id) ? Number(entry.id) : null
    name = typeof entry.name === 'string' ? entry.name : ''
  } else if (isIdLike(entry)) {
    id = Number(entry)
    name = ''
  } else if (typeof entry === 'string') {
    name = entry
  } else {
    return null
  }
  if (id == null && !normName(name)) return null
  let hit = lookup(items, id, '')
  // 纯数字字符串也可能是名字（如“007”）：按 id 找不到再按名字找
  if (!hit && !(entry && typeof entry === 'object')) hit = lookup(items, null, typeof entry === 'string' ? entry : '')
  if (!hit && name) hit = lookup(items, null, name)
  if (hit) return { assetId: hit.id, name: hit.name ?? '', missing: false }
  return { assetId: id, name: name.trim().replace(/^[@#]/, '').trim(), missing: true }
}

/**
 * 一个镜头参数里引用的资产：[{ kind, assetId, name, missing }]（同一资产只出现一次）。
 * 角色：params.characters；场景：params.scene_id，或 params.location 与场景名 / 场景地点完全相同；
 * 道具：params.prop_ids / params.props。location 是自由文本，对不上任何场景时不算“引用了已删除的资产”。
 */
export function shotAssetRefs(params, assets) {
  const p = params && typeof params === 'object' ? params : {}
  const a = assets && typeof assets === 'object' ? assets : {}
  const out = []
  const seen = new Set()
  const push = (kind, r) => {
    if (!r) return
    const key = `${kind}:${r.assetId != null && !r.missing ? r.assetId : r.assetId != null ? `x${r.assetId}` : `n:${normName(r.name)}`}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, ...r })
  }

  const characters = list(a.characters)
  for (const e of list(p.characters)) push('character', resolveEntry(characters, e))

  const scenes = list(a.scenes)
  if (p.scene_id != null && p.scene_id !== '') {
    push('scene', resolveEntry(scenes, isIdLike(p.scene_id) ? Number(p.scene_id) : p.scene_id))
  } else if (typeof p.location === 'string' && normName(p.location)) {
    const loc = normName(p.location)
    const hit = scenes.find((s) => s && (normName(s.name) === loc || normName(s.location) === loc))
    if (hit) push('scene', { assetId: hit.id, name: hit.name ?? '', missing: false })
  }

  const props = list(a.props)
  for (const e of [...list(p.prop_ids), ...list(p.props)]) push('prop', resolveEntry(props, e))
  return out
}

const assetNodeId = (kind, r) => `${ASSET_NODE_PREFIX}${kind}:${r.assetId != null ? r.assetId : `n:${normName(r.name)}`}`

/**
 * 覆盖层布局。
 *   canvas: 画布视图 { nodes, edges, ... }；assets: { characters, scenes, props }（任何一项可缺）。
 * 返回 { nodes, edges, stats }：
 *   nodes: [{ id, kind, assetId, name, missing, x, y, shots: [镜头节点 id] }]
 *   edges: [{ id, source: 资产节点 id, target: 镜头节点 id }]
 *   stats: { assets, missing, edges }
 * 资产节点按类别（角色 / 场景 / 道具）排成列，放在内核图最左侧之外；纵向取其引用镜头的中心平均值，再向下推开避免重叠。
 * 引用了已删除的资产时仍画一个标记 missing 的节点；同一资产被很多镜头引用时仍是一个节点、多条边。
 */
export function buildAssetRefLayout(canvas, assets) {
  const nodes = (canvas && Array.isArray(canvas.nodes) ? canvas.nodes : []).filter((n) => n && typeof n === 'object')
  const byAsset = new Map()
  for (const n of nodes) {
    if (n.type !== 'shot') continue
    for (const r of shotAssetRefs(n.params, assets)) {
      const id = assetNodeId(r.kind, r)
      let rec = byAsset.get(id)
      if (!rec) { rec = { id, kind: r.kind, assetId: r.assetId, name: r.name, missing: r.missing, shots: [], sum: 0, count: 0 }; byAsset.set(id, rec) }
      rec.shots.push(n.id)
      const pos = n.layout && Number.isFinite(n.layout.x) && Number.isFinite(n.layout.y) ? displayPos(n) : { x: 0, y: 0 }
      rec.sum += pos.y + NODE_SIZE.h / 2
      rec.count += 1
    }
  }
  if (!byAsset.size) return { nodes: [], edges: [], stats: { assets: 0, missing: 0, edges: 0 } }

  const xs = nodes.filter((n) => n.layout && Number.isFinite(n.layout.x) && Number.isFinite(n.layout.y)).map((n) => displayPos(n).x)
  const minX = xs.length ? Math.min(...xs) : 0
  const kinds = ASSET_KINDS.filter((k) => [...byAsset.values()].some((r) => r.kind === k))

  const outNodes = []
  for (const kind of kinds) {
    const col = kinds.indexOf(kind)
    const x = Math.round(minX - GRAPH_GAP - ASSET_NODE_SIZE.w - col * (ASSET_NODE_SIZE.w + COL_GAP))
    const recs = [...byAsset.values()]
      .filter((r) => r.kind === kind)
      .map((r) => ({ r, y: r.sum / r.count - ASSET_NODE_SIZE.h / 2 }))
      .sort((a, b) => a.y - b.y || (a.r.id < b.r.id ? -1 : 1))
    let floor = -Infinity
    for (const item of recs) {
      const y = Math.round(Math.max(item.y, floor))
      floor = y + ASSET_NODE_SIZE.h + ROW_GAP
      const { r } = item
      outNodes.push({ id: r.id, kind: r.kind, assetId: r.assetId, name: r.name, missing: r.missing, x, y, shots: r.shots })
    }
  }

  const edges = []
  for (const n of outNodes) for (const shotId of n.shots) edges.push({ id: `${ASSET_EDGE_PREFIX}${n.id}>${shotId}`, source: n.id, target: shotId })
  return {
    nodes: outNodes,
    edges,
    stats: { assets: outNodes.length, missing: outNodes.filter((n) => n.missing).length, edges: edges.length },
  }
}
