// 版本历史界面的纯逻辑（无 Vue / DOM 依赖，可 node --test）。
// 数据来自两个只读接口：GET /episodes/:id/versions（节点版本）与 GET /episodes/:id/history（graph_ops 日志）。

import { t } from '../i18n/index.js'

const TYPE_IDS = ['image', 'video', 'narration', 'compose']
const typeLabel = (type) => (TYPE_IDS.includes(type) ? t(`history.type.${type}`) : type)

/** 事务标签（意图名 / 内核 op 名）-> history.tx.* 的 id。未知标签原样显示。 */
const TX_IDS = {
  rewriteLine: 'rewriteLine', insertLine: 'insertLine', deleteLine: 'deleteLine', splitLine: 'splitLine', mergeLines: 'mergeLines', reorderLines: 'reorderLines',
  setShotField: 'setShotField', splitShot: 'splitShot', mergeShots: 'mergeShots', reorderShots: 'reorderShots', moveShotToGroup: 'moveShotToGroup', addShot: 'addShot',
  deleteShot: 'deleteShot', regenerateShot: 'regenerateShot', setVoice: 'setVoice', setShotReferences: 'setShotReferences',
  trimSegment: 'trimSegment', moveSegment: 'moveSegment', splitSegment: 'splitSegment', deleteSegment: 'deleteSegment', setTransition: 'setTransition', addMusic: 'addMusic',
  moveNode: 'moveNode', setNodeParam: 'setNodeParam', connectNodes: 'connectNodes', disconnectNodes: 'disconnectNodes', addNodeAt: 'addNodeAt', deleteNode: 'deleteNode',
  recordGeneration: 'recordGeneration', adoptVersion: 'adoptVersion', tx: 'default', moveNodes: 'moveNodes', assemble: 'assemble', 'generation inputs': 'generationInputs',
  'reference inputs': 'referenceInputs', 'generation cache hit': 'generationCacheHit', 'import assets': 'importAssets', 'import timeline': 'importTimeline',
  'reassemble timeline': 'reassembleTimeline', regenerate: 'regenerate',
  // P3-R 选镜改片
  editShotRegion: 'editShotRegion', adoptShotVersion: 'adoptShotVersion', 'region edit': 'regionEdit',
}

const OP_IDS = [
  'addVersion', 'adoptVersion', 'removeVersion', 'setParam', 'addNode', 'removeNode', 'connect', 'disconnect', 'setLayout', 'setChildren', 'setGroupOrder',
  'setComposeSegments', 'addGroup', 'removeGroup',
]
const opLabel = (op) => (OP_IDS.includes(op) ? t(`history.op.${op}`) : op)

const SOURCE_IDS = ['legacy-import', 'legacy-sync', 'rebase']

const STATE_IDS = ['applied', 'undone', 'discarded']
/** 记录状态的显示名（event 与未知状态为空）。 */
export const stateText = (state) => (STATE_IDS.includes(state) ? t(`history.state.${state}`) : '')

export const txLabel = (label) => (Object.hasOwn(TX_IDS, label) ? t(`history.tx.${TX_IDS[label]}`) : label ? String(label) : t('history.tx.default'))

export function sourceLabel(source) {
  if (!source) return t('history.source.unknown')
  if (SOURCE_IDS.includes(source)) return t(`history.source.${source}`)
  if (String(source).startsWith('ai-task:')) return t('history.source.ai')
  if (String(source).startsWith('region-edit:')) return t('history.source.regionEdit') // P3-R
  return String(source)
}

/** "12-31 09:05"（本地时间）；无效返回 ''。 */
export function formatTime(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 镜头 id -> 序号（1 起），按镜头视图顺序。 */
export function shotNumberMap(shotsView) {
  const out = {}
  let n = 0
  for (const g of shotsView?.groups || []) for (const s of g.shots) out[s.id] = ++n
  return out
}

/** 节点的显示名："镜头 3 · 首帧图" / "合成"。 */
export function nodeLabel(info, nums = {}) {
  const label = typeLabel(info.type)
  return info.shot_id ? `${nums[info.shot_id] ? t('history.node.shot', { n: nums[info.shot_id] }) : t('history.node.shotPlain')} · ${label}` : label
}

/** 版本卡片的展示模型。info 为 /versions 里的节点项，v 为其中一个版本。 */
export function describeVersion(info, v) {
  const meta = v.metadata || {}
  const bits = []
  if (meta.model) bits.push(t('history.meta.model', { v: meta.model }))
  if (meta.voice) bits.push(t('history.meta.voice', { v: meta.voice }))
  if (meta.duration_ms) bits.push(t('history.meta.seconds', { v: (meta.duration_ms / 1000).toFixed(1) }))
  if (meta.aspect_ratio) bits.push(String(meta.aspect_ratio))
  return {
    id: v.id,
    adopted: !!v.adopted,
    current: !!v.current,
    source: sourceLabel(v.source),
    kind: v.asset?.kind || null,
    ref: v.asset?.ref || null,
    hash: v.asset?.hash || null,
    meta: bits.join(' · '),
    time: v.created_at ? formatTime(v.created_at) : '',
    canAdopt: !v.adopted,
    // 采用后是否仍是“最新”：版本记录的 key 等于节点当前 key
    freshIfAdopted: !!v.current,
    nodeType: info.type,
  }
}

/** 采用版本的内核事务（走 POST /tx，内核已有 adoptVersion op，一步可撤销）。 */
export function adoptOps(nodeId, versionId) {
  return [{ op: 'adoptVersion', node: nodeId, version_id: versionId }]
}

/** 缩略图地址：只有图片版本、且资产是相对路径时才有（交给本地静态服务）。 */
export function thumbUrl(ref, kind) {
  if (kind !== 'image' || !ref || typeof ref !== 'string') return ''
  if (/^https?:\/\//i.test(ref)) return ref
  return `/static/${ref.replace(/^\/+/, '')}`
}

/** 历史条目的展示模型。 */
export function describeEntry(e) {
  if (e.kind === 'undo' || e.kind === 'redo') {
    return { seq: e.seq, title: e.kind === 'undo' ? t('history.entry.undo') : t('history.entry.redo'), detail: t('history.entry.target', { id: e.target }), state: 'event', stateText: '', time: formatTime(e.created_at), jump: null, tx_id: e.tx_id, kind: e.kind }
  }
  const kinds = Object.entries(e.op_kinds || {}).map(([k, n]) => `${opLabel(k)}${n > 1 ? ` ×${n}` : ''}`).join(t('history.sep.list'))
  return {
    seq: e.seq, tx_id: e.tx_id, kind: e.kind, title: txLabel(e.label), detail: kinds, state: e.state, stateText: stateText(e.state),
    time: formatTime(e.created_at), jump: jumpPlan(e),
  }
}

/**
 * 回到某一步：applied -> 撤销 undo_steps 步（0 = 已经在这一步，不需要动作）；undone -> 重做 redo_steps 步；其余不可跳。
 * 返回 { type: 'undo'|'redo', steps, label } 或 null。
 */
export function jumpPlan(e) {
  if (e.state === 'applied' && e.undo_steps > 0) return { type: 'undo', steps: e.undo_steps, label: t('history.jump.undo', { n: e.undo_steps }) }
  if (e.state === 'undone' && e.redo_steps > 0) return { type: 'redo', steps: e.redo_steps, label: t('history.jump.redo', { n: e.redo_steps }) }
  return null
}
