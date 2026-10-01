import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  buildIndex, canvasToFlow, coerceField, diffParams, displayPos, editableFields, emptyState, firstSegmentOfShot, focusIn,
  fromKernelClipId, groupBoxes, lineStaleInfo, newTxId, normalizeSelection, nodeSummary, playheadFor, reduceGraph, reduceSummary,
  reduceViews, reorderedIds, sameSelection, selKey, shotIdOf, shotNumbers, staleCount, toKernelClipId, validSplitAt, viewLocation, viewOfRoute,
} from '../src/utils/projectViews.js'

// 用真实的内核投影做夹具（与 REST 返回的 views 同形）
const K = createRequire(import.meta.url)('../../../packages/kernel/src/index.js')

function fixture() {
  const g = K.buildGraph({
    project_id: 'p',
    scenes: [
      {
        title: '雨夜',
        lines: [
          { kind: 'scene_heading', text: '雨夜街角' },
          { kind: 'narration', text: '雨下了一整夜。' },
          { kind: 'dialogue', speaker: '阿宁', text: '你还是来了。' },
        ],
        shots: [
          { title: '全景', duration_ms: 4000, legacy_id: 101, lines: [0, 1] },
          { title: '近景', duration_ms: 6000, legacy_id: 102, lines: [2] },
        ],
      },
      { title: '清晨', lines: [{ kind: 'narration', text: '天亮了。' }], shots: [{ title: '远景', duration_ms: 3000, legacy_id: 103, lines: [0] }] },
    ],
  })
  const views = { script: K.scriptView(g), shots: K.shotView(g), timeline: K.timelineView(g), canvas: K.canvasView(g) }
  return { g, views, idx: buildIndex(views) }
}

test('reducers: graph / summary / views patches', () => {
  const s0 = emptyState()
  const s1 = reduceGraph(s0, { graph: { nodes: {} }, stale: ['a', 'b'], seq: 4, can_undo: true, can_redo: false })
  assert.deepEqual([s1.stale, s1.seq, s1.canUndo, s1.canRedo], [['a', 'b'], 4, true, false])
  assert.equal(s0.seq, 0, 'input state untouched')
  const s2 = reduceSummary(s1, { seq: 5, stale: ['a'], can_undo: true, can_redo: true })
  assert.deepEqual([s2.seq, s2.stale, s2.canRedo], [5, ['a'], true])
  assert.equal(reduceSummary(s1, { can_undo: false }).seq, 4, 'missing seq keeps the old one')
  assert.equal(reduceSummary(s1, {}).stale, s1.stale)
  const s3 = reduceViews(s2, { script: { groups: [] } })
  assert.deepEqual(s3.views.script, { groups: [] })
  assert.equal(s3.views.canvas, null)
  assert.equal(staleCount(['x', 'y']), 2)
  assert.equal(staleCount(undefined), 0)
})

test('selection keys and tx ids', () => {
  assert.equal(selKey({ kind: 'line', id: 'line_1' }), 'line:line_1')
  assert.equal(selKey(null), '')
  assert.ok(sameSelection({ kind: 'shot', id: 's' }, { kind: 'shot', id: 's' }))
  assert.ok(!sameSelection({ kind: 'shot', id: 's' }, { kind: 'line', id: 's' }))
  assert.notEqual(newTxId('a'), newTxId('a'))
})

test('selection mapping: line <-> shot <-> segment <-> node', () => {
  const { idx } = fixture()
  // 行 -> 镜头
  assert.equal(shotIdOf({ kind: 'line', id: 'line_2' }, idx), 'shot_1')
  assert.equal(shotIdOf({ kind: 'line', id: 'line_1' }, idx), 'shot_1')
  assert.equal(shotIdOf({ kind: 'line', id: 'line_3' }, idx), 'shot_2')
  assert.equal(shotIdOf({ kind: 'line', id: 'line_4' }, idx), 'shot_3')
  // 节点：镜头自己、剧本行、下游生成节点都映射到所属镜头；compose 没有镜头
  assert.equal(shotIdOf({ kind: 'node', id: 'shot_2' }, idx), 'shot_2')
  assert.equal(shotIdOf({ kind: 'node', id: 'line_3' }, idx), 'shot_2')
  const parts = K.partsOfShot(fixture().g, 'shot_2')
  assert.equal(shotIdOf({ kind: 'node', id: parts.image }, idx), 'shot_2')
  assert.equal(shotIdOf({ kind: 'node', id: parts.video }, idx), 'shot_2')
  assert.equal(shotIdOf({ kind: 'node', id: parts.narration }, idx), 'shot_2')
  const compose = Object.values(idx.nodeById).find((n) => n.type === 'compose')
  assert.equal(shotIdOf({ kind: 'node', id: compose.id }, idx), null)
  // 片段 -> 镜头（经 legacy_id）
  const seg = firstSegmentOfShot('shot_2', idx)
  assert.ok(seg)
  assert.equal(shotIdOf({ kind: 'segment', id: seg }, idx), 'shot_2')
  assert.equal(shotIdOf({ kind: 'segment', id: 'nope' }, idx), null)
  assert.equal(shotIdOf(null, idx), null)
})

test('focusIn: each view finds the object that matches the selection', () => {
  const { idx } = fixture()
  const seg2 = firstSegmentOfShot('shot_2', idx)
  // 选中一行
  const line = { kind: 'line', id: 'line_3' }
  assert.deepEqual(focusIn('script', line, idx), line)
  assert.deepEqual(focusIn('shots', line, idx), { kind: 'shot', id: 'shot_2' })
  assert.deepEqual(focusIn('storyboard', line, idx), { kind: 'shot', id: 'shot_2' })
  assert.deepEqual(focusIn('timeline', line, idx), { kind: 'segment', id: seg2 })
  assert.deepEqual(focusIn('canvas', line, idx), { kind: 'node', id: 'line_3' })
  // 选中镜头：剧本里落在它的第一行
  const shot = { kind: 'shot', id: 'shot_1' }
  assert.deepEqual(focusIn('script', shot, idx), { kind: 'line', id: 'line_1' })
  assert.deepEqual(focusIn('canvas', shot, idx), { kind: 'node', id: 'shot_1' })
  // 选中片段：画布是镜头节点，剧本是镜头的第一行
  const segSel = { kind: 'segment', id: seg2 }
  assert.deepEqual(focusIn('canvas', segSel, idx), { kind: 'node', id: 'shot_2' })
  assert.deepEqual(focusIn('script', segSel, idx), { kind: 'line', id: 'line_3' })
  assert.deepEqual(focusIn('timeline', segSel, idx), segSel)
  // 选中下游节点（视频）：其余视图聚焦镜头
  const vid = K.partsOfShot(fixture().g, 'shot_3').video
  assert.deepEqual(focusIn('shots', { kind: 'node', id: vid }, idx), { kind: 'shot', id: 'shot_3' })
  assert.deepEqual(focusIn('timeline', { kind: 'node', id: vid }, idx), { kind: 'segment', id: firstSegmentOfShot('shot_3', idx) })
  // 往返：行 -> 镜头 -> 回到剧本，选择本身不变（选择不被切换改写）
  assert.deepEqual(focusIn('script', line, idx), line)
  // 空选择与不存在的对象
  assert.equal(focusIn('canvas', null, idx), null)
  assert.equal(focusIn('canvas', { kind: 'node', id: 'ghost' }, idx), null)
  assert.equal(focusIn('timeline', { kind: 'line', id: 'ghost' }, idx), null)
})

test('line with no shot has no shot / segment focus; scene line maps only itself', () => {
  const g = K.buildGraph({ project_id: 'p', scenes: [{ title: 's', lines: [{ kind: 'narration', text: 'a' }, { kind: 'narration', text: 'b' }], shots: [{ title: 'x', lines: [0] }] }] })
  const idx = buildIndex({ script: K.scriptView(g), shots: K.shotView(g), timeline: K.timelineView(g), canvas: K.canvasView(g) })
  const orphan = { kind: 'line', id: 'line_2' }
  assert.equal(shotIdOf(orphan, idx), null)
  assert.equal(focusIn('shots', orphan, idx), null)
  assert.equal(focusIn('timeline', orphan, idx), null)
  assert.deepEqual(focusIn('canvas', orphan, idx), { kind: 'node', id: 'line_2' })
  assert.equal(playheadFor(orphan, idx), null)
})

test('playheadFor: start of the shot first video segment', () => {
  const { idx } = fixture()
  assert.equal(playheadFor({ kind: 'shot', id: 'shot_1' }, idx), 0)
  assert.equal(playheadFor({ kind: 'line', id: 'line_3' }, idx), 4000)
  assert.equal(playheadFor({ kind: 'shot', id: 'shot_3' }, idx), 10000)
})

test('normalizeSelection drops deleted objects', () => {
  const { idx } = fixture()
  assert.deepEqual(normalizeSelection({ kind: 'line', id: 'line_1' }, idx), { kind: 'line', id: 'line_1' })
  assert.equal(normalizeSelection({ kind: 'line', id: 'gone' }, idx), null)
  assert.equal(normalizeSelection({ kind: 'segment', id: 'gone' }, idx), null)
  assert.equal(normalizeSelection(null, idx), null)
})

test('canvasToFlow: nodes, edges, state, scene group boxes', () => {
  const { views, g } = fixture()
  const flow = canvasToFlow(views.canvas, 'shot_2')
  const cards = flow.nodes.filter((n) => n.type === 'card')
  assert.equal(cards.length, Object.keys(g.nodes).length)
  assert.equal(flow.edges.length, g.edges.length)
  const shot2 = cards.find((n) => n.id === 'shot_2')
  assert.equal(shot2.selected, true)
  assert.equal(cards.filter((n) => n.selected).length, 1)
  assert.deepEqual(shot2.data.ports, ['lines'])
  assert.deepEqual(cards.find((n) => n.data.node.type === 'video').data.ports, ['image', 'shot'])
  assert.deepEqual(flow.edges.every((e) => e.sourceHandle === 'out' && typeof e.targetHandle === 'string'), true)
  const boxes = flow.nodes.filter((n) => n.type === 'sceneGroup')
  assert.equal(boxes.length, 2)
  assert.ok(boxes.every((b) => b.draggable === false && b.selectable === false))
  // 框要包住成员：镜头 / 行 / 下游节点都在框内
  for (const b of boxes) {
    const w = parseFloat(b.style.width)
    const h = parseFloat(b.style.height)
    const gid = b.id.slice('group:'.length)
    const members = new Set(views.canvas.groups.find((x) => x.id === gid).children)
    for (const n of cards.filter((c) => members.has(c.id))) {
      assert.ok(n.position.x >= b.position.x && n.position.x + 220 <= b.position.x + w + 1, `${n.id} x inside ${b.id}`)
      assert.ok(n.position.y >= b.position.y && n.position.y + 96 <= b.position.y + h + 1, `${n.id} y inside ${b.id}`)
    }
  }
  assert.equal(canvasToFlow(null).nodes.length, 0)
  assert.ok(groupBoxes(views.canvas).every((b) => b.data.shots >= 0))
})

test('displayPos: stored layout is used as is; auto layout is spread so cards do not overlap', () => {
  assert.deepEqual(displayPos({ type: 'shot', layout_auto: false, layout: { x: 10, y: 20 } }), { x: 10, y: 20 })
  const { views } = fixture()
  const byType = (t, shot) => views.canvas.nodes.find((n) => n.type === t && (!shot || n.id.endsWith(shot)))
  // 同一镜头的 image 与 narration 在同一栏：显示位置至少相隔一个卡片高度
  const img = displayPos(byType('image'))
  const nar = displayPos(byType('narration'))
  assert.equal(img.x, nar.x)
  assert.ok(Math.abs(nar.y - img.y) >= 96)
  // 例如：被拖动过（有 layout）的节点优先用保存的位置
  const moved = { ...byType('image'), layout_auto: false, layout: { x: 1, y: 2 } }
  assert.deepEqual(displayPos(moved), { x: 1, y: 2 })
})

test('nodeSummary / editable fields / diffParams', () => {
  const { views } = fixture()
  const n = (t) => views.canvas.nodes.find((x) => x.type === t)
  assert.match(nodeSummary(n('shot'))[1], /3\.0s|4\.0s|6\.0s/)
  assert.deepEqual(nodeSummary(n('image')), ['模型 default', '种子 0'])
  assert.match(nodeSummary(n('compose'))[0], /^3 个片段/)
  assert.ok(editableFields('shot').some((f) => f.key === 'duration_ms' && f.type === 'number'))
  assert.deepEqual(editableFields('script_line').find((f) => f.key === 'kind').options.map((o) => o.value), ['scene_heading', 'narration', 'dialogue', 'action'])
  assert.deepEqual(editableFields('unknown'), [])
  const f = editableFields('image')
  // 只提交改过的字段；数字转换；非法数字不提交
  assert.deepEqual(diffParams(f, { model: 'default', seed: 0 }, { model: 'default', seed: '7' }), { patch: { seed: 7 }, changed: true })
  assert.deepEqual(diffParams(f, { model: 'default', seed: 0 }, { model: 'default', seed: '0' }), { patch: {}, changed: false })
  assert.equal(diffParams(f, { model: 'm', seed: 1 }, { model: 'm', seed: 'abc' }).changed, false)
  assert.equal(diffParams(f, { model: 'm', seed: 1 }, { model: 'm', seed: '' }).changed, false)
  const shotFields = editableFields('shot')
  assert.deepEqual(diffParams(shotFields, { characters: ['阿宁'] }, { characters: '阿宁，老周' }).patch, { characters: ['阿宁', '老周'] })
  assert.equal(diffParams(shotFields, { characters: ['阿宁'] }, { characters: '阿宁' }).changed, false)
  assert.equal(coerceField({ type: 'bool' }, 1), true)
})

test('script helpers: reorder, split position, stale marker, numbering', () => {
  assert.deepEqual(reorderedIds(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'])
  assert.deepEqual(reorderedIds(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b'])
  assert.equal(reorderedIds(['a', 'b'], 'a', -1), null)
  assert.equal(reorderedIds(['a', 'b'], 'b', 1), null)
  assert.equal(reorderedIds(['a'], 'zz', 1), null)
  assert.ok(validSplitAt('你好世界', 2))
  assert.ok(!validSplitAt('你好世界', 0))
  assert.ok(!validSplitAt('你好世界', 4))
  assert.ok(!validSplitAt('你好世界', undefined))

  const { views } = fixture()
  const shots = Object.fromEntries(views.shots.groups.flatMap((x) => x.shots).map((s) => [s.id, s]))
  const lines = views.script.groups.flatMap((x) => x.lines)
  // 新建图里生成类节点都是“未生成”：行都带过期标记
  assert.ok(lines.filter((l) => l.shot_ids.length).every((l) => lineStaleInfo(l, shots, new Set()).stale))
  assert.equal(lineStaleInfo({ id: 'x', shot_ids: [] }, shots, new Set()).stale, false)
  const fresh = { ...shots.shot_1, image: 'fresh', video: 'fresh', narration: 'fresh' }
  assert.equal(lineStaleInfo({ shot_ids: ['shot_1'] }, { shot_1: fresh }, new Set()).stale, false)
  assert.equal(lineStaleInfo({ shot_ids: ['shot_1'] }, { shot_1: fresh }, new Set(['shot_1'])).stale, true)
  assert.deepEqual(shotNumbers(views.shots), { shot_1: 1, shot_2: 2, shot_3: 3 })
})

test('routes: view locations keep episode and drama; route name -> view', () => {
  assert.deepEqual(viewLocation('script', 7, 3), { path: '/episodes/7/script', query: { drama: '3' } })
  assert.deepEqual(viewLocation('canvas', 7, null), { path: '/episodes/7/canvas', query: {} })
  assert.deepEqual(viewLocation('timeline', 7, 3, { x: '1' }), { path: '/episodes/7/timeline', query: { x: '1', drama: '3' } })
  assert.deepEqual(viewLocation('storyboard', 7, 3), { path: '/project/3/storyboard', query: { drama: '3', episode: '7' } })
  assert.deepEqual(viewLocation('storyboard', 7, null), { path: '/episodes/7/storyboard', query: {} })
  assert.equal(viewOfRoute('episode-script'), 'script')
  assert.equal(viewOfRoute('storyboard'), 'storyboard')
  assert.equal(viewOfRoute('episode-timeline'), 'timeline')
  assert.equal(viewOfRoute('episode-canvas'), 'canvas')
  assert.equal(viewOfRoute('list'), null)
})

test('timeline clip ids: kernel ids <-> legacy table ids with the e<episode>_ prefix', () => {
  assert.equal(toKernelClipId('e12_seg_3', 12), 'seg_3')
  assert.equal(toKernelClipId('seg_3', 12), 'seg_3')
  assert.equal(toKernelClipId('e13_seg_3', 12), 'e13_seg_3')
  assert.equal(toKernelClipId('3f2a-uuid', 12), '3f2a-uuid')
  const have = new Set(['e12_seg_3', 'plain'])
  assert.equal(fromKernelClipId('seg_3', 12, (id) => have.has(id)), 'e12_seg_3')
  assert.equal(fromKernelClipId('plain', 12, (id) => have.has(id)), 'plain')
  assert.equal(fromKernelClipId('zzz', 12, (id) => have.has(id)), null)
})
