import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../src/i18n/index.js'
import { buildIndex } from '../src/utils/projectViews.js'
import { buildAssetRefLayout } from '../src/utils/canvasAssetRefs.js'
import {
  assetOverlayToFlow, editableFieldsT, lineKindLabel, newNodeParams, nodeSummaryT, nodeTypeLabel, paramOps,
  historyTarget, regeneratePlan, sceneTitleCheck, stateLabel, staleOnlyCanvas,
} from '../src/components/canvas/canvasModel.js'

const TYPES = ['script_line', 'shot', 'image', 'video', 'narration', 'compose']

const node = (id, type, extra = {}) => ({
  id, type, params: {}, layout: { x: 0, y: 0 }, layout_auto: false, state: 'fresh', stale: false, legacy_id: null, ...extra,
})
// l1 -> s1 -> (i1, n1) -> v1 ; s2 -> i2 (stale) ; compose c1 <- v1
const sample = () => ({
  nodes: [
    node('l1', 'script_line', { state: 'source', params: { kind: 'dialogue', speaker: 'A', text: 'hi' } }),
    node('s1', 'shot', { state: 'source', legacy_id: 11, params: { title: '一', shot_type: '特写', duration_ms: 3000 } }),
    node('s2', 'shot', { state: 'source', legacy_id: 12, params: { title: '二' } }),
    node('i1', 'image', { params: { model: 'm', seed: 1 } }),
    node('i2', 'image', { state: 'stale', stale: true, params: { model: 'm', seed: 2 } }),
    node('n1', 'narration', { params: { voice: 'v', speed: 1 } }),
    node('v1', 'video', { state: 'none', stale: true, params: { model: 'm', seed: 1 } }),
    node('c1', 'compose', { params: { segments: [], fps: 30, size: '1080x1920' } }),
  ],
  edges: [
    { id: 'e1', from: { node: 'l1' }, to: { node: 's1', port: 'lines' }, type: 'lines' },
    { id: 'e2', from: { node: 's1' }, to: { node: 'i1', port: 'shot' }, type: 'shot' },
    { id: 'e3', from: { node: 's1' }, to: { node: 'n1', port: 'shot' }, type: 'shot' },
    { id: 'e4', from: { node: 'i1' }, to: { node: 'v1', port: 'image' }, type: 'image' },
    { id: 'e5', from: { node: 's2' }, to: { node: 'i2', port: 'shot' }, type: 'shot' },
    { id: 'e6', from: { node: 'v1' }, to: { node: 'c1', port: 'video' }, type: 'video' },
  ],
  groups: [{ id: 'g1', title: 'G', children: ['l1', 's1', 's2'], summary: { lines: 1, shots: 2, stale: 2 } }],
  group_order: ['g1'],
})

test('labels resolve in both languages and never leak a key', () => {
  for (const loc of ['zh-CN', 'en']) {
    setLocale(loc)
    for (const ty of TYPES) {
      assert.ok(!nodeTypeLabel(ty).startsWith('canvas.'), `${loc} nodeType ${ty}`)
      for (const f of editableFieldsT(ty)) {
        assert.ok(!f.label.startsWith('canvas.'), `${loc} field ${ty}.${f.key}`)
        for (const o of f.options || []) assert.ok(!o.label.startsWith('canvas.'))
      }
    }
    for (const s of ['fresh', 'stale', 'none']) assert.ok(!stateLabel(s).startsWith('canvas.'))
    for (const k of ['scene_heading', 'narration', 'dialogue', 'action']) assert.ok(!lineKindLabel(k).startsWith('canvas.'))
  }
  setLocale('zh-CN')
  assert.equal(nodeTypeLabel('shot'), '镜头')
  assert.equal(stateLabel('source'), '')
  setLocale('en')
  assert.equal(nodeTypeLabel('shot'), 'Shot')
  assert.equal(stateLabel('stale'), 'Stale')
  assert.equal(stateLabel('source'), '')
})

test('editable fields keep keys and types of the kernel inspector, labels follow the language', () => {
  setLocale('en')
  const f = editableFieldsT('shot')
  assert.deepEqual(f.map((x) => x.key), ['title', 'description', 'location', 'time', 'shot_type', 'angle', 'movement', 'image_prompt', 'video_prompt', 'characters', 'duration_ms'])
  assert.equal(f[0].label, 'Title')
  const line = editableFieldsT('script_line')[0]
  assert.equal(line.type, 'select')
  assert.deepEqual(line.options.map((o) => o.value), ['scene_heading', 'narration', 'dialogue', 'action'])
  assert.equal(line.options[2].label, 'Dialogue')
  assert.deepEqual(editableFieldsT('nope'), [])
})

test('node summary is translated', () => {
  setLocale('en')
  assert.deepEqual(nodeSummaryT(node('s', 'shot', { params: { title: 'T', shot_type: '', duration_ms: 2500 } })), ['T', 'Shot size not set · 2.5s'])
  assert.deepEqual(nodeSummaryT(node('c', 'compose', { params: { segments: [1, 2], size: '1080x1920', fps: 30 } })), ['2 segments', '1080x1920 · 30fps'])
  assert.deepEqual(nodeSummaryT(node('i', 'image', { params: { model: 'm', seed: 7 } })), ['Model m', 'Seed 7'])
  setLocale('zh-CN')
  assert.equal(nodeSummaryT(node('s', 'shot', { params: {} }))[0], '（未命名镜头）')
  assert.deepEqual(nodeSummaryT(node('l', 'script_line', { params: { kind: 'dialogue', speaker: '林夏', text: 'x' } })), ['对白 · 林夏', 'x'])
})

test('staleOnlyCanvas keeps stale nodes, their owner shots and the edges between them', () => {
  const c = sample()
  const r = staleOnlyCanvas(c)
  assert.deepEqual(r.nodes.map((n) => n.id).sort(), ['i2', 's1', 's2', 'v1'])
  assert.deepEqual(r.edges.map((e) => e.id).sort(), ['e5'])
  assert.equal(c.nodes.length, 8, 'input untouched')
  assert.deepEqual(r.groups.map((g) => g.id), ['g1'])
})

test('staleOnlyCanvas with nothing stale is empty, with everything stale is the whole graph', () => {
  const none = { ...sample(), nodes: sample().nodes.map((n) => ({ ...n, stale: false, state: n.type === 'script_line' || n.type === 'shot' ? 'source' : 'fresh' })) }
  const r = staleOnlyCanvas(none)
  assert.equal(r.nodes.length, 0)
  assert.equal(r.edges.length, 0)
  assert.deepEqual(staleOnlyCanvas(null), { nodes: [], edges: [], groups: [], group_order: [] })
  const all = { ...sample(), nodes: sample().nodes.map((n) => ({ ...n, stale: true })) }
  const whole = staleOnlyCanvas(all)
  assert.equal(whole.nodes.length, 8)
  assert.equal(whole.edges.length, 6)
})

test('staleOnlyCanvas honours an external stale id set', () => {
  const c = sample()
  const r = staleOnlyCanvas(c, new Set(['n1']))
  assert.ok(r.nodes.some((n) => n.id === 'n1'))
  assert.ok(r.nodes.some((n) => n.id === 's1'))
})

test('regeneratePlan: shot -> both, image/video -> that kind, others -> null', () => {
  const c = sample()
  const idx = buildIndex({ canvas: c })
  assert.deepEqual(regeneratePlan(c.nodes.find((n) => n.id === 's1'), idx), { storyboardId: 11, kind: 'both' })
  assert.deepEqual(regeneratePlan(c.nodes.find((n) => n.id === 'i2'), idx), { storyboardId: 12, kind: 'image' })
  assert.deepEqual(regeneratePlan(c.nodes.find((n) => n.id === 'v1'), idx), { storyboardId: 11, kind: 'video' })
  assert.equal(regeneratePlan(c.nodes.find((n) => n.id === 'n1'), idx), null)
  assert.equal(regeneratePlan(c.nodes.find((n) => n.id === 'c1'), idx), null)
  assert.equal(regeneratePlan(c.nodes.find((n) => n.id === 'l1'), idx), null)
  assert.equal(regeneratePlan(null, idx), null)
  // 镜头没有旧表 id（legacy_id 为空）：无法排队
  const c2 = sample()
  c2.nodes.find((n) => n.id === 's1').legacy_id = null
  assert.equal(regeneratePlan(c2.nodes.find((n) => n.id === 's1'), buildIndex({ canvas: c2 })), null)
})

test('paramOps builds one setParam op per field, labelled for the history list', () => {
  assert.deepEqual(paramOps('i1', { model: 'x', seed: 3 }), [
    { op: 'setParam', node: 'i1', path: ['model'], value: 'x' },
    { op: 'setParam', node: 'i1', path: ['seed'], value: 3 },
  ])
  assert.deepEqual(paramOps('i1', {}), [])
})

test('default params for new nodes follow the language', () => {
  setLocale('en')
  assert.deepEqual(newNodeParams('shot'), { title: 'New shot' })
  assert.deepEqual(newNodeParams('script_line'), { kind: 'action', text: '(New script line)' })
  assert.equal(newNodeParams('image'), undefined)
  setLocale('zh-CN')
  assert.deepEqual(newNodeParams('shot'), { title: '新镜头' })
})

test('sceneTitleCheck trims, rejects empty and over-long titles with translated messages', () => {
  setLocale('en')
  assert.deepEqual(sceneTitleCheck('  Rain  '), { value: 'Rain' })
  assert.equal(sceneTitleCheck('  ').error, 'Scene title cannot be empty')
  assert.equal(sceneTitleCheck('x'.repeat(201)).error, 'Scene title is limited to 200 characters')
  assert.deepEqual(sceneTitleCheck('x'.repeat(200)), { value: 'x'.repeat(200) })
  setLocale('zh-CN')
  assert.equal(sceneTitleCheck('').error, '场景标题不能为空')
})

test('assetOverlayToFlow makes inert display-only Vue Flow nodes and edges', () => {
  const c = {
    nodes: [node('s1', 'shot', { params: { characters: ['林夏'] }, layout: { x: 280, y: 0 } })],
    edges: [], groups: [], group_order: [],
  }
  const layout = buildAssetRefLayout(c, { characters: [{ id: 1, name: '林夏' }] })
  const flow = assetOverlayToFlow(layout)
  assert.equal(flow.nodes.length, 1)
  const n = flow.nodes[0]
  assert.equal(n.id, layout.nodes[0].id)
  assert.equal(n.type, 'assetRef')
  assert.equal(n.draggable, false)
  assert.equal(n.connectable, false)
  assert.deepEqual(n.position, { x: layout.nodes[0].x, y: layout.nodes[0].y })
  assert.equal(n.data.name, '林夏')
  assert.equal(flow.edges.length, 1)
  assert.equal(flow.edges[0].source, n.id)
  assert.equal(flow.edges[0].target, 's1')
  assert.equal(flow.edges[0].selectable, false)
  assert.equal(flow.edges[0].focusable, false)
  assert.deepEqual(assetOverlayToFlow(null), { nodes: [], edges: [] })
})

test('historyTarget: generated nodes are themselves; a shot points at its video, then image, then narration', () => {
  const c = sample()
  const by = (id) => c.nodes.find((n) => n.id === id)
  assert.equal(historyTarget(by('i1'), c), 'i1')
  assert.equal(historyTarget(by('n1'), c), 'n1')
  assert.equal(historyTarget(by('s1'), c), 'v1')
  assert.equal(historyTarget(by('s2'), c), 'i2')
  assert.equal(historyTarget(by('l1'), c), null)
  assert.equal(historyTarget(by('c1'), c), null)
  assert.equal(historyTarget(null, c), null)
})
