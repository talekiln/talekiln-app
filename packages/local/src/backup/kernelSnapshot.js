'use strict';
// 一集的数据内核快照：项目图 + 撤销/重做栈 + graph_ops 历史 + 旧表绑定表。
// 导出得到纯 JSON（媒体文件由 ZIP 携带，这里只列出引用）；导入到另一集时把旧 id 映射成新 id：
//   镜头 legacy_id / 日志 binds（旧 storyboards.id）、镜头 params.characters（旧 characters.id）、/static/ 媒体引用。
// 不改写：资产 hash、节点 id、版本 id、tx_id。cacheKey 因 characters / 引用进 key 而变化，按“旧 key -> 新 key”整体改写，
// 所以新旧两边的过期集合一致。
const kernel = require('@talekiln/kernel');
const store = require('../kernel/store');

const { KernelError, History, canonicalJSON } = kernel;

const FORMAT = 'talekiln-kernel-snapshot';
const VERSION = 1;
const MAX_OPS = 5000; // 随快照带走的 graph_ops 条数上限（最近的 N 条）

const invalid = (m) => Object.assign(new KernelError('VALIDATION', `kernel snapshot: ${m}`), { code: 'SNAPSHOT_INVALID' });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const plain = (v) => JSON.parse(canonicalJSON(v));

function collectRefs(v, out) {
  if (typeof v === 'string') { if (v.startsWith('/static/')) out.add(v); return; }
  if (Array.isArray(v)) { for (const x of v) collectRefs(x, out); return; }
  if (isObj(v)) for (const x of Object.values(v)) collectRefs(x, out);
}

/** 导出一集的快照；这一集没有项目图返回 null。 */
function exportEpisode(db, episodeId) {
  const ep = Number(episodeId);
  if (!store.hasProject(db, ep)) return null;
  const { history } = store.openProject(db, ep);
  const hist = plain({ graph: history.graph, past: history.past.slice(-store.MAX_UNDO_DEPTH), future: history.future });
  const ops = db.prepare('SELECT tx_id, tx, created_at FROM graph_ops WHERE episode_id = ? ORDER BY seq DESC LIMIT ?')
    .all(ep, MAX_OPS).reverse().map((r) => ({ tx_id: r.tx_id, created_at: r.created_at, tx: JSON.parse(r.tx) }));
  const legacyMap = db.prepare('SELECT node_id, storyboard_id FROM graph_legacy_map WHERE episode_id = ? ORDER BY node_id').all(ep);
  const refs = new Set();
  collectRefs(hist, refs);
  collectRefs(ops, refs);
  return {
    format: FORMAT, version: VERSION, source_episode_id: ep,
    history: hist, ops, legacy_map: legacyMap,
    refs: [...refs].sort(),
    media: {}, // 由 ZIP 导出器填：{ "<引用>": "<zip 内路径>" }
  };
}

// ---------------------------------------------------------------- 映射

const toMap = (m) => {
  if (m === undefined || m === null) return null;
  const entries = m instanceof Map ? [...m] : Object.entries(m);
  return new Map(entries.map(([k, v]) => [String(k), v]));
};

/** 深度改写：characters 数组、legacy_id、binds、/static/ 引用，以及（给了 keys 时）cache_key。返回新对象，不改入参。 */
function remapper({ storyboards, characters, refs, keys }) {
  const mapChars = (arr) => arr.map((c) => characters.get(String(c))).filter((c) => c !== undefined);
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (key === 'cache_key') return keys && keys.has(v) ? keys.get(v) : v;
      return refs && refs.has(v) ? refs.get(v) : v;
    }
    if (Array.isArray(v)) return key === 'characters' && characters ? mapChars(v) : v.map((x) => walk(x));
    if (!isObj(v)) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'legacy_id' && storyboards) {
        if (x === null || x === undefined) out.legacy_id = x;
        else if (storyboards.has(String(x))) out.legacy_id = storyboards.get(String(x));
        continue; // 没有对应新行：丢掉，下一次物化时重建
      }
      if (k === 'binds' && storyboards && isObj(x)) {
        out.binds = {};
        for (const [shot, lid] of Object.entries(x)) if (storyboards.has(String(lid))) out.binds[shot] = storyboards.get(String(lid));
        continue;
      }
      out[k] = walk(x, k);
    }
    // setParam 的整值替换：{ op:'setParam', path:['characters'], value:[...] }
    if (characters && v.op === 'setParam' && Array.isArray(v.path) && v.path.length === 1 && v.path[0] === 'characters' && Array.isArray(v.value)) out.value = mapChars(v.value);
    return out;
  };
  return (v) => walk(v, '');
}

// timeline_clips.id 是全库主键：UUID 形状的片段 id（旧时间线导入时沿用的 clip id）在新集里必须换掉，否则与原项目撞主键。
// 非 UUID 的确定性 id 物化时会自动加 e<集 id>_ 前缀，不用管。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function collectSegmentIds(v, out, key) {
  if (Array.isArray(v)) {
    for (const x of v) {
      if ((key === 'segments' || key === 'music') && isObj(x) && typeof x.id === 'string' && UUID_RE.test(x.id)) out.add(x.id);
      collectSegmentIds(x, out);
    }
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) collectSegmentIds(x, out, k);
  }
}

function transform(snapshot, idMap, episodeId) {
  const maps = { storyboards: toMap(idMap.storyboards), characters: toMap(idMap.characters), refs: toMap(idMap.refs) || new Map() };
  const { graph, past = [], future = [] } = snapshot.history;
  const segIds = new Set();
  collectSegmentIds([graph, past, future, snapshot.ops || []], segIds);
  for (const id of segIds) if (!maps.refs.has(id)) maps.refs.set(id, `seg${id.replace(/-/g, '')}`);
  // 第一遍：只改写图，算出新 cacheKey，建立“旧 key -> 新 key”
  const probe = remapper(maps)(graph);
  const oldKeys = kernel.cacheKeys(graph);
  const newKeys = kernel.cacheKeys(probe);
  const keys = new Map(Object.keys(oldKeys).map((id) => [oldKeys[id], newKeys[id]]));
  const rm = remapper({ ...maps, keys });
  const out = {
    graph: rm(graph), past: rm(past), future: rm(future),
    ops: (snapshot.ops || []).map((o) => ({ tx_id: o.tx_id, created_at: o.created_at, tx: rm(o.tx) })),
    legacy_map: (snapshot.legacy_map || []).map((m) => ({
      node_id: m.node_id,
      storyboard_id: maps.storyboards ? maps.storyboards.get(String(m.storyboard_id)) : m.storyboard_id,
    })).filter((m) => m.storyboard_id !== undefined),
  };
  out.graph.project_id = String(episodeId);
  return out;
}

// ---------------------------------------------------------------- 导入

/** 撤销栈能在映射后的图上走一圈：重做到头、撤销到底、重做到头，再退回原来的深度，图必须回到起点。 */
// legacy_id 不是日志的一部分：重做 addShot 会得到没有 legacy_id 的镜头，物化时再重新绑定。比较时忽略它，
// 否则任何用“添加镜头”建过镜头的项目，恢复时都会被误判为撤销栈对不上而降级成只还原图。
const sameShape = (g) => {
  const c = structuredClone(g);
  for (const n of Object.values(c.nodes || {})) delete n.legacy_id;
  return canonicalJSON(c);
};

function verifyHistory(graph, past, future) {
  const h = new History(structuredClone(graph));
  h.past = structuredClone(past);
  h.future = structuredClone(future);
  const before = sameShape(h.graph);
  const nFuture = h.future.length;
  h.redoAll();
  h.undoAll();
  h.redoAll();
  for (let i = 0; i < nFuture; i++) h.undo();
  if (sameShape(h.graph) !== before) throw invalid('undo history does not round-trip after id remapping');
}

function write(db, ep, t, mode) {
  const legacy = require('../kernel/legacy');
  const full = mode === 'full';
  const history = new History(t.graph);
  if (full) { history.past = t.past; history.future = t.future; verifyHistory(t.graph, t.past, t.future); }
  kernel.validateGraph(t.graph);

  db.prepare('DELETE FROM graph_legacy_map WHERE episode_id = ?').run(ep);
  const mapSet = db.prepare('INSERT OR REPLACE INTO graph_legacy_map (episode_id, node_id, storyboard_id) VALUES (?, ?, ?)');
  for (const m of t.legacy_map) if (t.graph.nodes[m.node_id]) mapSet.run(ep, m.node_id, m.storyboard_id);

  // 物化到旧表（建立时间线；目标集旧表已由导入器建好）；新绑定的镜头 id 写回图
  const { binds } = legacy.materialize(db, ep, t.graph);
  for (const [shotId, lid] of Object.entries(binds || {})) if (t.graph.nodes[shotId]) t.graph.nodes[shotId].legacy_id = lid;

  let lastSeq = 0;
  if (full) {
    const ins = db.prepare('INSERT INTO graph_ops (episode_id, tx_id, tx, created_at) VALUES (?, ?, ?, ?)');
    for (const o of t.ops) lastSeq = Number(ins.run(ep, o.tx_id, canonicalJSON(o.tx), o.created_at || new Date().toISOString()).lastInsertRowid);
  }
  const text = canonicalJSON({ graph: history.graph, past: history.past.slice(-store.MAX_UNDO_DEPTH), future: history.future });
  db.prepare('INSERT INTO project_graphs (episode_id, snapshot, snapshot_seq, updated_at) VALUES (?, ?, ?, ?)')
    .run(ep, text, lastSeq, new Date().toISOString());
  return { shots: kernel.shotOrder(t.graph).length, ops: full ? t.ops.length : 0 };
}

/**
 * 把快照导入新集 newEpisodeId（该集必须已建好旧表行、且还没有项目图）。
 * idMap：{ storyboards, characters, refs }，各为 旧值 -> 新值（Map 或普通对象）。
 * 先完整还原（含撤销栈与 graph_ops）；撤销栈在新 id 下对不上时退化为只还原图与采用版本（清空历史）。
 * 返回 { applied: true, mode: 'full' | 'graph', shots, ops }；两种都失败则抛 SNAPSHOT_INVALID，库保持原样。
 */
function importEpisode(db, newEpisodeId, snapshot, idMap = {}) {
  if (!isObj(snapshot) || snapshot.format !== FORMAT) throw invalid('unknown format');
  if (!Number.isInteger(snapshot.version) || snapshot.version > VERSION) throw invalid(`unsupported snapshot version ${snapshot.version}`);
  if (!isObj(snapshot.history) || !isObj(snapshot.history.graph)) throw invalid('missing history.graph');
  const ep = Number(newEpisodeId);
  if (!db.prepare('SELECT 1 FROM episodes WHERE id = ? AND deleted_at IS NULL').get(ep)) throw invalid(`episode ${newEpisodeId} not found`);
  if (store.hasProject(db, ep)) throw invalid(`episode ${newEpisodeId} already has a project graph`);

  let t;
  try { t = transform(snapshot, idMap || {}, ep); } catch (e) { throw invalid(`cannot remap: ${e.message}`); }

  const attempt = (mode) => db.transaction(() => write(db, ep, structuredClone(t), mode))();
  try {
    return { applied: true, mode: 'full', ...attempt('full') };
  } catch (fullErr) {
    try {
      return { applied: true, mode: 'graph', degraded_reason: fullErr.message, ...attempt('graph') };
    } catch (graphErr) {
      throw invalid(`cannot restore project graph: ${graphErr.message}`);
    }
  }
}

module.exports = { exportEpisode, importEpisode, FORMAT, VERSION, MAX_OPS };
