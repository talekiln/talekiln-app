import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSET_NODE_PREFIX, ASSET_NODE_SIZE, buildAssetRefLayout, isAssetRefId, shotAssetRefs,
} from '../src/utils/canvasAssetRefs.js'

const shotNode = (id, params = {}, y = 0, x = 280) => ({
  id, type: 'shot', params: { title: id, characters: [], ...params }, layout: { x, y }, layout_auto: false,
})
const canvasOf = (nodes, edges = []) => ({ nodes, edges, groups: [], group_order: [] })
const assets = () => ({
  characters: [{ id: 1, name: '林夏' }, { id: 2, name: '老周' }],
  scenes: [{ id: 10, name: '旧书店', location: '旧书店内' }, { id: 11, name: '雨夜街头' }],
  props: [{ id: 20, name: '信封' }],
})
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) } return o }

test('no references gives an empty overlay and never throws on missing input', () => {
  const empty = { nodes: [], edges: [], stats: { assets: 0, missing: 0, edges: 0 } }
  assert.deepEqual(buildAssetRefLayout(canvasOf([shotNode('s1')]), assets()), empty)
  assert.deepEqual(buildAssetRefLayout(null, null), empty)
  assert.deepEqual(buildAssetRefLayout(undefined, undefined), empty)
  assert.deepEqual(buildAssetRefLayout({}, {}), empty)
  assert.deepEqual(buildAssetRefLayout(canvasOf([{ id: 'x', type: 'shot' }]), assets()), empty)
  assert.deepEqual(buildAssetRefLayout(canvasOf([shotNode('s1', { characters: 'not-an-array' })]), assets()), empty)
})

test('shotAssetRefs reads characters by id, name, @name and object; scene by id or location; props by ids', () => {
  const refs = shotAssetRefs(
    { characters: [1, '老周', '@林夏', { id: 2, name: '老周' }, '路人甲'], scene_id: 10, prop_ids: [20, 99] },
    assets(),
  )
  const find = (kind) => refs.filter((r) => r.kind === kind)
  // 1 -> 林夏, 老周 -> 2, @林夏 and {id:2} are duplicates, 路人甲 is unknown; duplicates collapse
  assert.deepEqual(find('character').map((r) => [r.assetId, r.missing]), [[1, false], [2, false], [null, true]])
  assert.deepEqual(find('scene').map((r) => [r.assetId, r.missing]), [[10, false]])
  assert.deepEqual(find('prop').map((r) => [r.assetId, r.missing]).sort(), [[20, false], [99, true]].sort())
})

test('scene is matched by location text when there is no scene_id; free text that matches nothing is not a missing reference', () => {
  const a = shotAssetRefs({ location: '旧书店内' }, assets()).filter((r) => r.kind === 'scene')
  assert.deepEqual(a.map((r) => r.assetId), [10])
  const b = shotAssetRefs({ location: '旧书店' }, assets()).filter((r) => r.kind === 'scene')
  assert.deepEqual(b.map((r) => r.assetId), [10])
  assert.deepEqual(shotAssetRefs({ location: '某个没登记的地方' }, assets()), [])
})

test('builds one read-only node per referenced asset with an edge to every referencing shot', () => {
  const c = canvasOf([
    shotNode('s1', { characters: ['林夏'] }, 0),
    shotNode('s2', { characters: ['林夏', '老周'], scene_id: 10 }, 140),
  ])
  const r = buildAssetRefLayout(c, assets())
  assert.equal(r.nodes.length, 3)
  assert.equal(r.edges.length, 4)
  assert.deepEqual(r.stats, { assets: 3, missing: 0, edges: 4 })
  const lin = r.nodes.find((n) => n.assetId === 1)
  assert.equal(lin.kind, 'character')
  assert.equal(lin.name, '林夏')
  assert.equal(lin.id, `${ASSET_NODE_PREFIX}character:1`)
  assert.deepEqual(lin.shots, ['s1', 's2'])
  assert.ok(isAssetRefId(lin.id))
  assert.ok(!isAssetRefId('s1'))
  for (const e of r.edges) {
    assert.ok(isAssetRefId(e.source))
    assert.ok(['s1', 's2'].includes(e.target))
    assert.ok(e.id.startsWith('assetref:'))
  }
})

test('a reference to a deleted asset still draws a flagged ghost node (never crashes)', () => {
  const c = canvasOf([
    shotNode('s1', { characters: [99, '无名氏'], prop_ids: [77] }, 0),
    shotNode('s2', { characters: [99] }, 140),
  ])
  const r = buildAssetRefLayout(c, assets())
  const ghosts = r.nodes.filter((n) => n.missing)
  assert.equal(ghosts.length, 3)
  assert.equal(r.stats.missing, 3)
  const ghost99 = ghosts.find((n) => n.assetId === 99)
  assert.deepEqual(ghost99.shots, ['s1', 's2'])
  assert.equal(ghosts.find((n) => n.name === '无名氏').assetId, null)
  assert.equal(r.edges.length, 4)
})

test('works when the project has no assets at all', () => {
  const c = canvasOf([shotNode('s1', { characters: ['林夏'] })])
  const r = buildAssetRefLayout(c, null)
  assert.equal(r.nodes.length, 1)
  assert.equal(r.nodes[0].missing, true)
})

test('one asset referenced by 100 shots is one node with 100 edges and a finite layout', () => {
  const nodes = []
  for (let i = 0; i < 100; i += 1) nodes.push(shotNode(`s${i}`, { characters: ['林夏'] }, i * 140))
  const t0 = Date.now()
  const r = buildAssetRefLayout(canvasOf(nodes), assets())
  assert.ok(Date.now() - t0 < 500)
  assert.equal(r.nodes.length, 1)
  assert.equal(r.edges.length, 100)
  assert.equal(r.nodes[0].shots.length, 100)
  assert.ok(Number.isFinite(r.nodes[0].x) && Number.isFinite(r.nodes[0].y))
  // 在所有引用镜头的纵向中间
  assert.ok(r.nodes[0].y > 0 && r.nodes[0].y < 99 * 140 * 1.6)
})

test('many distinct assets in one column never overlap and sit left of every kernel node', () => {
  const chars = []
  const nodes = []
  for (let i = 1; i <= 40; i += 1) {
    chars.push({ id: i, name: `角色${i}` })
    nodes.push(shotNode(`s${i}`, { characters: [i] }, 0)) // 全在同一高度，必须被推开
  }
  nodes.push({ id: 'l1', type: 'script_line', params: { text: 'x' }, layout: { x: 0, y: 0 }, layout_auto: false })
  const r = buildAssetRefLayout(canvasOf(nodes), { characters: chars })
  assert.equal(r.nodes.length, 40)
  const ys = r.nodes.map((n) => n.y).sort((a, b) => a - b)
  for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i] - ys[i - 1] >= ASSET_NODE_SIZE.h, 'no vertical overlap')
  const leftEdge = Math.min(...nodes.map((n) => n.layout.x))
  for (const n of r.nodes) assert.ok(n.x + ASSET_NODE_SIZE.w <= leftEdge, 'asset nodes are left of the graph')
})

test('each asset kind gets its own column', () => {
  const c = canvasOf([shotNode('s1', { characters: [1], scene_id: 10, prop_ids: [20] }, 0)])
  const r = buildAssetRefLayout(c, assets())
  const xs = new Set(r.nodes.map((n) => n.x))
  assert.equal(xs.size, 3)
})

test('does not mutate its inputs and is deterministic', () => {
  const c = deepFreeze(canvasOf([shotNode('s1', { characters: ['林夏', '路人'] }, 0), shotNode('s2', { characters: ['老周'] }, 140)]))
  const a = deepFreeze(assets())
  const r1 = buildAssetRefLayout(c, a)
  const r2 = buildAssetRefLayout(c, a)
  assert.deepEqual(r1, r2)
})

test('uses the same display position as the canvas for auto-laid-out shots', () => {
  const auto = { id: 's1', type: 'shot', params: { characters: [1] }, layout: { x: 280, y: 100 }, layout_auto: true }
  const r = buildAssetRefLayout(canvasOf([auto]), assets())
  // displayPos(auto) => y = round(100 * 1.6) = 160
  assert.equal(r.nodes[0].y + ASSET_NODE_SIZE.h / 2, 160 + 96 / 2)
})
