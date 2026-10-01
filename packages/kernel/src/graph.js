'use strict';
// 项目图：数据结构、规范化 JSON、校验、只读查询。纯函数，不做 IO。
const { createHash } = require('node:crypto'); // node 内置哈希，纯计算，不算 IO

class KernelError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'KernelError';
    this.code = code; // INVALID_OP | VALIDATION | NOT_FOUND | INTENT
    if (detail !== undefined) this.detail = detail;
  }
}

const NODE_TYPES = ['script_line', 'shot', 'image', 'video', 'narration', 'compose'];
const GENERATED_TYPES = ['image', 'video', 'narration', 'compose']; // 需要“采用版本”的节点
const LINE_KINDS = ['scene_heading', 'narration', 'dialogue', 'action'];
const SPOKEN_KINDS = ['narration', 'dialogue']; // 进入镜头对白/字幕/配音的行
const DEFAULT_SHOT_MS = 5000; // 与 F02 assembleFromStoryboard 一致

// 输入端口：to 节点类型 -> 端口 -> { from 类型, 边类型, 是否多输入 }。输出端口恒为 'out'。
const PORTS = {
  script_line: {},
  shot: { lines: { from: 'script_line', edge: 'derives', multi: true } },
  image: { shot: { from: 'shot', edge: 'derives' } },
  video: { image: { from: 'image', edge: 'derives' }, shot: { from: 'shot', edge: 'derives' } },
  // binds 只表示“这条配音属于哪个镜头”，不进 cacheKey；配音文字从镜头的行推导
  narration: { shot: { from: 'shot', edge: 'binds' } },
  compose: { video: { from: 'video', edge: 'feeds', multi: true }, narration: { from: 'narration', edge: 'feeds', multi: true } },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (n) => Number.isInteger(n);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (isObj(v)) {
    const o = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = canon(v[k]);
    return o;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) throw new KernelError('VALIDATION', 'non-finite number in graph');
  return v;
}
/** 键排序、无空白的规范 JSON：同一数据永远同一字节。 */
const canonicalJSON = (v) => JSON.stringify(canon(v));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function defaultParams(type) {
  switch (type) {
    case 'script_line': return { kind: 'narration', speaker: '', text: '' };
    case 'shot': return {
      title: '', description: '', location: '', time: '', shot_type: '', angle: '', movement: '',
      image_prompt: '', video_prompt: '', characters: [], duration_ms: DEFAULT_SHOT_MS,
    };
    case 'image': return { model: 'default', seed: 0 };
    case 'video': return { model: 'default', seed: 0 };
    case 'narration': return { voice: 'default', speed: 1 };
    case 'compose': return { segments: [], music: [], fps: 30, size: '1080x1920', aigc_label: true, subtitle_overrides: {} };
    default: throw new KernelError('VALIDATION', `unknown node type: ${type}`);
  }
}

/**
 * 各节点类型允许直接改的参数（画布属性面板 / setNodeParam / setShotReferences 的白名单与取值校验）。
 * check(v) 返回错误说明或 null；optional = 允许用 null 清除（参数被删除，cacheKey 与“从未设置”相同）。
 * 生成输入（image.model/reference_hashes、video.model/tail_frame_hash）和 seed、voice 一样是节点自己的参数，所以进 cacheKey。
 */
const isStr = (v) => typeof v === 'string';
const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const NODE_PARAM_RULES = {
  script_line: {
    kind: { check: (v) => (LINE_KINDS.includes(v) ? null : `must be one of ${LINE_KINDS.join('/')}`) },
    speaker: { check: (v) => (isStr(v) ? null : 'must be a string') },
    text: { check: (v) => (isStr(v) ? null : 'must be a string') },
  },
  shot: Object.fromEntries([
    ...['title', 'description', 'location', 'time', 'shot_type', 'angle', 'movement', 'image_prompt', 'video_prompt'].map((k) => [k, { check: (v) => (isStr(v) ? null : 'must be a string') }]),
    ['atmosphere', { optional: true, check: (v) => (isStr(v) ? null : 'must be a string') }],
    ['characters', { check: (v) => (Array.isArray(v) ? null : 'must be an array') }],
    ['duration_ms', { check: (v) => (isInt(v) && v > 0 ? null : 'must be a positive integer') }],
  ]),
  image: {
    model: { check: (v) => (isStr(v) && v ? null : 'must be a non-empty string') },
    seed: { check: (v) => (isInt(v) ? null : 'must be an integer') },
    reference_hashes: { optional: true, check: (v) => (Array.isArray(v) && v.every((x) => isStr(x) && x) ? null : 'must be an array of non-empty strings') },
  },
  video: {
    model: { check: (v) => (isStr(v) && v ? null : 'must be a non-empty string') },
    seed: { check: (v) => (isInt(v) ? null : 'must be an integer') },
    tail_frame_hash: { optional: true, check: (v) => (isStr(v) && v ? null : 'must be a non-empty string') },
  },
  narration: {
    voice: { check: (v) => (isStr(v) && v ? null : 'must be a non-empty string') },
    speed: { check: (v) => (posNum(v) ? null : 'must be a positive number') },
  },
  compose: {
    fps: { check: (v) => (isInt(v) && v > 0 ? null : 'must be a positive integer') },
    size: { check: (v) => (isStr(v) && /^\d+x\d+$/.test(v) ? null : 'must look like 1080x1920') },
    aigc_label: { check: (v) => (typeof v === 'boolean' ? null : 'must be a boolean') },
  },
};

function emptyGraph(projectId = null) {
  return { version: 1, project_id: projectId, nodes: {}, edges: [], groups: {}, group_order: [], layout: {}, versions: {}, adopted: {} };
}
const cloneGraph = (g) => structuredClone(g);
const toJSON = (g) => canonicalJSON(g);
function fromJSON(text) {
  const g = JSON.parse(text);
  validateGraph(g);
  return g;
}
const graphEquals = (a, b) => canonicalJSON(a) === canonicalJSON(b);

// ---------- 只读查询 ----------

const nodesOfType = (g, type) => Object.keys(g.nodes).filter((id) => g.nodes[id].type === type).sort();
const composeId = (g) => nodesOfType(g, 'compose')[0] || null;
function groupOf(g, nodeId) {
  for (const gid of g.group_order) if (g.groups[gid].children.includes(nodeId)) return gid;
  return null;
}
/** 全项目一份顺序：按 group_order、再按 children 过滤出某类型节点。 */
function orderOf(g, type) {
  const out = [];
  for (const gid of g.group_order) for (const c of g.groups[gid].children) if (g.nodes[c] && g.nodes[c].type === type) out.push(c);
  return out;
}
const shotOrder = (g) => orderOf(g, 'shot');
const lineOrder = (g) => orderOf(g, 'script_line');
const edgesTo = (g, id) => g.edges.filter((e) => e.to.node === id);
const edgesFrom = (g, id) => g.edges.filter((e) => e.from.node === id);
const indexMap = (arr) => Object.fromEntries(arr.map((id, i) => [id, i]));

function linesOfShot(g, shotId) {
  const idx = indexMap(lineOrder(g));
  return [...new Set(edgesTo(g, shotId).filter((e) => e.to.port === 'lines').map((e) => e.from.node))]
    .sort((a, b) => (idx[a] ?? 1e9) - (idx[b] ?? 1e9) || (a < b ? -1 : 1));
}
function shotsOfLine(g, lineId) {
  const idx = indexMap(shotOrder(g));
  return [...new Set(edgesFrom(g, lineId).filter((e) => g.nodes[e.to.node].type === 'shot').map((e) => e.to.node))]
    .sort((a, b) => (idx[a] ?? 1e9) - (idx[b] ?? 1e9) || (a < b ? -1 : 1));
}
/** 镜头的 image/video/narration 节点（经 shot 出边找，多个时取 id 最小）。 */
function partsOfShot(g, shotId) {
  const pick = (type) => edgesFrom(g, shotId).map((e) => e.to.node).filter((id) => g.nodes[id].type === type).sort()[0] || null;
  return { image: pick('image'), video: pick('video'), narration: pick('narration') };
}
const spokenLines = (g, shotId) => linesOfShot(g, shotId).filter((id) => SPOKEN_KINDS.includes(g.nodes[id].params.kind));
/** 镜头对白 = 关联的旁白/对白行文字拼接（不另存）。 */
const shotDialogue = (g, shotId) => spokenLines(g, shotId).map((id) => g.nodes[id].params.text).join('\n');
function segmentsOfShot(g, shotId) {
  const c = composeId(g);
  return c ? (g.nodes[c].params.segments || []).filter((s) => s.shot_id === shotId) : [];
}
function adoptedVersion(g, nodeId) {
  const vid = g.adopted[nodeId];
  return vid ? (g.versions[nodeId] || []).find((v) => v.id === vid) || null : null;
}

// ---------- 校验 ----------

function validateSegments(g, segments) {
  const fail = (m) => { throw new KernelError('VALIDATION', `compose.segments: ${m}`); };
  if (!Array.isArray(segments)) fail('must be an array');
  const ids = new Set();
  for (const s of segments) {
    if (!isObj(s) || typeof s.id !== 'string' || !s.id) fail('segment needs string id');
    if (ids.has(s.id)) fail(`duplicate segment id ${s.id}`);
    ids.add(s.id);
    const shot = g.nodes[s.shot_id];
    if (!shot || shot.type !== 'shot') fail(`segment ${s.id} references missing shot ${s.shot_id}`);
    if (!isInt(s.in_ms) || !isInt(s.out_ms) || s.in_ms < 0 || s.out_ms <= s.in_ms) fail(`segment ${s.id} has invalid range`);
    if (isInt(shot.params.duration_ms) && s.out_ms > shot.params.duration_ms) fail(`segment ${s.id} exceeds shot duration`);
    if (!isInt(s.gap_before_ms) || s.gap_before_ms < 0) fail(`segment ${s.id} has invalid gap_before_ms`);
    if (s.transition != null && typeof s.transition !== 'string') fail(`segment ${s.id} has invalid transition`);
  }
}

function validateGraph(g) {
  const fail = (m) => { throw new KernelError('VALIDATION', m); };
  if (!isObj(g) || g.version !== 1) fail('graph.version must be 1');
  for (const k of ['nodes', 'groups', 'layout', 'versions', 'adopted']) if (!isObj(g[k])) fail(`graph.${k} must be an object`);
  for (const k of ['edges', 'group_order']) if (!Array.isArray(g[k])) fail(`graph.${k} must be an array`);

  for (const [id, n] of Object.entries(g.nodes)) {
    if (!isObj(n) || n.id !== id) fail(`node key/id mismatch: ${id}`);
    if (!NODE_TYPES.includes(n.type)) fail(`node ${id}: unknown type ${n.type}`);
    if (!isObj(n.params)) fail(`node ${id}: params must be an object`);
    if (n.type === 'script_line') {
      if (!LINE_KINDS.includes(n.params.kind)) fail(`script_line ${id}: bad kind`);
      if (typeof n.params.text !== 'string') fail(`script_line ${id}: text must be a string`);
    }
    if (n.type === 'shot') {
      if (n.params.duration_ms !== undefined && (!isInt(n.params.duration_ms) || n.params.duration_ms <= 0)) fail(`shot ${id}: duration_ms must be a positive integer`);
      if (n.params.characters !== undefined && !Array.isArray(n.params.characters)) fail(`shot ${id}: characters must be an array`);
    }
  }

  const edgeIds = new Set();
  const conn = new Set();
  for (const e of g.edges) {
    if (!isObj(e) || typeof e.id !== 'string' || !isObj(e.from) || !isObj(e.to)) fail('malformed edge');
    if (edgeIds.has(e.id)) fail(`duplicate edge id ${e.id}`);
    edgeIds.add(e.id);
    const a = g.nodes[e.from.node];
    const b = g.nodes[e.to.node];
    if (!a || !b) fail(`edge ${e.id}: endpoint node missing`);
    if (e.from.port !== 'out') fail(`edge ${e.id}: output port must be 'out'`);
    const spec = PORTS[b.type][e.to.port];
    if (!spec) fail(`edge ${e.id}: ${b.type} has no input port ${e.to.port}`);
    if (spec.from !== a.type) fail(`edge ${e.id}: port ${b.type}.${e.to.port} accepts ${spec.from}, got ${a.type}`);
    if (spec.edge !== e.type) fail(`edge ${e.id}: type must be ${spec.edge}`);
    const dup = `${e.from.node}>${e.to.node}.${e.to.port}`;
    if (conn.has(dup)) fail(`duplicate connection ${dup}`);
    conn.add(dup);
  }
  const used = {};
  for (const e of g.edges) {
    const spec = PORTS[g.nodes[e.to.node].type][e.to.port];
    if (!spec.multi) {
      const k = `${e.to.node}.${e.to.port}`;
      if (used[k]) fail(`port ${k} accepts a single connection`);
      used[k] = true;
    }
  }
  // 环检测（Kahn）
  const indeg = Object.fromEntries(Object.keys(g.nodes).map((id) => [id, 0]));
  for (const e of g.edges) indeg[e.to.node]++;
  const queue = Object.keys(indeg).filter((id) => indeg[id] === 0);
  let seen = 0;
  while (queue.length) {
    const id = queue.pop();
    seen++;
    for (const e of g.edges) if (e.from.node === id && --indeg[e.to.node] === 0) queue.push(e.to.node);
  }
  if (seen !== Object.keys(g.nodes).length) fail('graph has a cycle');

  const gids = Object.keys(g.groups);
  if (g.group_order.length !== gids.length || new Set(g.group_order).size !== gids.length || !g.group_order.every((id) => g.groups[id])) {
    fail('group_order must be a permutation of groups');
  }
  const membership = {};
  for (const [gid, grp] of Object.entries(g.groups)) {
    if (grp.id !== gid || !Array.isArray(grp.children)) fail(`group ${gid} malformed`);
    if (new Set(grp.children).size !== grp.children.length) fail(`group ${gid}: duplicate children`);
    for (const c of grp.children) {
      const n = g.nodes[c];
      if (!n) fail(`group ${gid}: child ${c} missing`);
      if (n.type !== 'shot' && n.type !== 'script_line') fail(`group ${gid}: child ${c} must be script_line or shot`);
      membership[c] = (membership[c] || 0) + 1;
    }
  }
  for (const [id, n] of Object.entries(g.nodes)) {
    if ((n.type === 'shot' || n.type === 'script_line') && membership[id] !== 1) fail(`${n.type} ${id} must be in exactly one group`);
  }
  for (const id of Object.keys(g.layout)) {
    const p = g.layout[id];
    if (!g.nodes[id]) fail(`layout for missing node ${id}`);
    if (!isObj(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) fail(`layout ${id} malformed`); // 有限数：NaN/Infinity 会让规范 JSON（落盘）抛错
  }
  for (const [id, list] of Object.entries(g.versions)) {
    if (!g.nodes[id]) fail(`versions for missing node ${id}`);
    if (!Array.isArray(list) || !list.length) fail(`versions ${id} must be a non-empty array`);
    if (new Set(list.map((v) => v.id)).size !== list.length) fail(`versions ${id}: duplicate version id`);
  }
  for (const [id, vid] of Object.entries(g.adopted)) {
    if (!(g.versions[id] || []).some((v) => v.id === vid)) fail(`adopted ${id} points at missing version`);
  }
  const composes = nodesOfType(g, 'compose');
  if (composes.length > 1) fail('at most one compose node');
  if (composes.length === 1) {
    const segs = g.nodes[composes[0]].params.segments || [];
    validateSegments(g, segs);
    const have = new Set(segs.map((s) => s.shot_id));
    for (const sid of nodesOfType(g, 'shot')) if (!have.has(sid)) fail(`shot ${sid} has no segment in compose`);
  }
  return true;
}

module.exports = {
  KernelError, NODE_TYPES, NODE_PARAM_RULES, GENERATED_TYPES, LINE_KINDS, SPOKEN_KINDS, DEFAULT_SHOT_MS, PORTS,
  isObj, isInt, clone, canonicalJSON, sha256, defaultParams, emptyGraph, cloneGraph, toJSON, fromJSON, graphEquals,
  nodesOfType, composeId, groupOf, orderOf, shotOrder, lineOrder, edgesTo, edgesFrom, indexMap,
  linesOfShot, shotsOfLine, partsOfShot, spokenLines, shotDialogue, segmentsOfShot, adoptedVersion, validateGraph,
};
