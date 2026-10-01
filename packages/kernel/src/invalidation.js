'use strict';
// 依赖失效：cacheKey、过期集合、事务前后差异、场景缓存键。全部为纯函数。
const G = require('./graph');

// 节点类型实现版本：改动某类节点的生成逻辑时递增，会让该类全部缓存失效。
const NODE_TYPE_VERSION = { script_line: 1, shot: 1, image: 1, video: 1, narration: 1, compose: 1 };

/**
 * 全部节点的 cacheKey：sha256(canonical{ type, node_version, params, inputs })。
 * inputs 按端口排序（lines 端口按剧本顺序）；binds 边不参与；narration 的 lines 输入由绑定镜头的行推导。
 * layout、legacy_id 不参与。compose 的 params 含 segments/music，所以裁剪也会改它的 key。
 */
function cacheKeys(g) {
  const lineIdx = G.indexMap(G.lineOrder(g));
  const incoming = {};
  for (const e of g.edges) (incoming[e.to.node] = incoming[e.to.node] || []).push(e);
  const memo = {};
  const cmp = (a, b) => {
    if (a.port !== b.port) return a.port < b.port ? -1 : 1;
    if (a.port === 'lines') return (lineIdx[a.node] ?? 1e9) - (lineIdx[b.node] ?? 1e9) || (a.node < b.node ? -1 : 1);
    return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
  };
  function key(id) {
    if (memo[id]) return memo[id];
    const n = g.nodes[id];
    const ins = [];
    for (const e of incoming[id] || []) {
      if (e.type === 'binds') {
        if (n.type === 'narration') {
          for (const l of G.linesOfShot(g, e.from.node)) ins.push({ port: 'lines', node: l });
        }
        continue;
      }
      ins.push({ port: e.to.port, node: e.from.node });
    }
    const seen = new Set();
    const inputs = ins.sort(cmp)
      .filter((i) => { const k = `${i.port}:${i.node}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((i) => [i.port, key(i.node)]);
    memo[id] = G.sha256(G.canonicalJSON({ type: n.type, node_version: NODE_TYPE_VERSION[n.type], params: n.params, inputs }));
    return memo[id];
  }
  for (const id of Object.keys(g.nodes)) key(id);
  return memo;
}

/** 生成类节点状态：none（没有采用版本）| stale（采用版本的 key 不等于当前 key）| fresh；源节点返回 'source'。 */
function nodeState(g, id, keys = cacheKeys(g)) {
  if (!g.nodes[id] || !G.GENERATED_TYPES.includes(g.nodes[id].type)) return g.nodes[id] ? 'source' : 'none';
  const v = G.adoptedVersion(g, id);
  if (!v) return 'none';
  return v.cache_key === keys[id] ? 'fresh' : 'stale';
}

/** 过期集合（排序后的 id 数组）：生成类节点中状态不是 fresh 的。 */
function staleSet(g, keys = cacheKeys(g)) {
  return Object.keys(g.nodes)
    .filter((id) => G.GENERATED_TYPES.includes(g.nodes[id].type) && nodeState(g, id, keys) !== 'fresh')
    .sort();
}

/**
 * 事务前后差异（只看前后都存在的节点）：
 * invalidated = 之前 fresh、现在过期；revalidated = 之前过期、现在 fresh。
 */
function diffStale(before, after) {
  const b = new Set(before.stale);
  const a = new Set(after.stale);
  const live = (id) => id in before.keys && id in after.keys;
  const generated = (id) => live(id) && G.GENERATED_TYPES.includes(after.types[id]);
  const invalidated = [...a].filter((id) => generated(id) && !b.has(id)).sort();
  const revalidated = [...b].filter((id) => generated(id) && !a.has(id)).sort();
  return { invalidated, revalidated };
}
function snapshotStale(g) {
  const keys = cacheKeys(g);
  return { keys, stale: staleSet(g, keys), types: Object.fromEntries(Object.entries(g.nodes).map(([id, n]) => [id, n.type])) };
}

/**
 * 场景缓存键（对接 G02）：sha256{ 采用的 video 版本资产 hash, 该镜头所有 segments 的 in/out/transition, 旁白采用版本 hash }。
 * 音乐、gap、字幕文字不在其中。
 */
function sceneKey(g, shotId) {
  const parts = G.partsOfShot(g, shotId);
  const hash = (id) => { const v = id && G.adoptedVersion(g, id); return v && v.asset ? v.asset.hash ?? null : null; };
  return G.sha256(G.canonicalJSON({
    video: hash(parts.video),
    segments: G.segmentsOfShot(g, shotId).map((s) => ({ in_ms: s.in_ms, out_ms: s.out_ms, transition: s.transition ?? null })),
    narration: hash(parts.narration),
  }));
}

module.exports = { NODE_TYPE_VERSION, cacheKeys, nodeState, staleSet, diffStale, snapshotStale, sceneKey };
