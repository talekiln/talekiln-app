// 版本历史界面的纯逻辑（无 Vue / DOM 依赖，可 node --test）。
// 数据来自两个只读接口：GET /episodes/:id/versions（节点版本）与 GET /episodes/:id/history（graph_ops 日志）。

const TYPE_LABEL = { image: '首帧图', video: '视频', narration: '配音', compose: '合成' }

/** 事务标签（意图名 / 内核 op 名）-> 中文。未知标签原样显示。 */
export const TX_LABEL = {
  rewriteLine: '改写台词', insertLine: '插入台词', deleteLine: '删除台词', splitLine: '拆分台词', mergeLines: '合并台词', reorderLines: '台词排序',
  setShotField: '修改镜头', splitShot: '拆分镜头', mergeShots: '合并镜头', reorderShots: '镜头排序', moveShotToGroup: '镜头换场景', addShot: '新增镜头',
  deleteShot: '删除镜头', regenerateShot: '重新生成（换种子）', setVoice: '换音色', setShotReferences: '改参考图 / 模型',
  trimSegment: '裁剪片段', moveSegment: '移动片段', splitSegment: '拆分片段', deleteSegment: '删除片段', setTransition: '改转场', addMusic: '添加音乐',
  moveNode: '移动节点', setNodeParam: '改节点参数', connectNodes: '连线', disconnectNodes: '断开连线', addNodeAt: '新增节点', deleteNode: '删除节点',
  recordGeneration: '记录生成结果', adoptVersion: '采用版本', tx: '修改', moveNodes: '移动节点', assemble: '装配时间线', 'generation inputs': '同步生成输入', 'reference inputs': '同步参考图', 'generation cache hit': '命中缓存（沿用旧素材）',
  'import assets': '导入素材', 'import timeline': '导入时间线', 'reassemble timeline': '重新装配时间线', regenerate: '重新生成',
}

const OP_LABEL = {
  addVersion: '新增版本', adoptVersion: '采用版本', removeVersion: '移除版本', setParam: '改参数', addNode: '新增节点', removeNode: '删除节点',
  connect: '连线', disconnect: '断开', setLayout: '改布局', setChildren: '改顺序', setGroupOrder: '改场景顺序', setComposeSegments: '改片段',
  addGroup: '新增场景', removeGroup: '删除场景',
}

const SOURCE_LABEL = { 'legacy-import': '导入', 'legacy-sync': '同步旧素材', rebase: '改记（沿用旧素材）' }

export const STATE_TEXT = { applied: '已生效', undone: '已撤销', discarded: '已被覆盖', event: '' }

export const txLabel = (label) => TX_LABEL[label] || (label ? String(label) : '修改')

export function sourceLabel(source) {
  if (!source) return '未知来源'
  if (SOURCE_LABEL[source]) return SOURCE_LABEL[source]
  if (String(source).startsWith('ai-task:')) return 'AI 生成'
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
  const t = TYPE_LABEL[info.type] || info.type
  return info.shot_id ? `${nums[info.shot_id] ? `镜头 ${nums[info.shot_id]}` : '镜头'} · ${t}` : t
}

/** 版本卡片的展示模型。info 为 /versions 里的节点项，v 为其中一个版本。 */
export function describeVersion(info, v) {
  const meta = v.metadata || {}
  const bits = []
  if (meta.model) bits.push(`模型 ${meta.model}`)
  if (meta.voice) bits.push(`音色 ${meta.voice}`)
  if (meta.duration_ms) bits.push(`${(meta.duration_ms / 1000).toFixed(1)} 秒`)
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
    return { seq: e.seq, title: e.kind === 'undo' ? '撤销' : '重做', detail: `目标事务 ${e.target}`, state: 'event', stateText: '', time: formatTime(e.created_at), jump: null, tx_id: e.tx_id, kind: e.kind }
  }
  const kinds = Object.entries(e.op_kinds || {}).map(([k, n]) => `${OP_LABEL[k] || k}${n > 1 ? ` ×${n}` : ''}`).join('、')
  return {
    seq: e.seq, tx_id: e.tx_id, kind: e.kind, title: txLabel(e.label), detail: kinds, state: e.state, stateText: STATE_TEXT[e.state] || '',
    time: formatTime(e.created_at), jump: jumpPlan(e),
  }
}

/**
 * 回到某一步：applied -> 撤销 undo_steps 步（0 = 已经在这一步，不需要动作）；undone -> 重做 redo_steps 步；其余不可跳。
 * 返回 { type: 'undo'|'redo', steps, label } 或 null。
 */
export function jumpPlan(e) {
  if (e.state === 'applied' && e.undo_steps > 0) return { type: 'undo', steps: e.undo_steps, label: `回到此步（撤销 ${e.undo_steps} 步）` }
  if (e.state === 'undone' && e.redo_steps > 0) return { type: 'redo', steps: e.redo_steps, label: `恢复到此步（重做 ${e.redo_steps} 步）` }
  return null
}
