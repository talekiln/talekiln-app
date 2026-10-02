'use strict';
// 独立预言机：不调用内核的 cacheKeys/staleSet/projections，只读图的原始数据（nodes/edges/groups/versions/adopted），
// 用自己的代码重新推导“哪些生成节点应当过期”。刻意用不同的写法（嵌套签名 + sha1），不抄 invalidation.js。
//
// 原则（来自设计文档 §4，而不是来自内核代码）：
//   一个生成类节点“新鲜”当且仅当它有采用版本，且采用版本记录的“产出所依据的内容签名”等于现在的签名。
//   签名 = 该节点自己的类型与参数 + 所有上游（按端口）的签名；layout / legacy_id 不算；
//   配音（narration）的“输入”是它所属镜头的台词行，不是镜头的画面参数；
//   合成（compose）的输出还取决于镜头在时间线上的先后顺序，所以顺序也进签名。
// 测试里“生成”一个节点时，把这个签名当作产出内容的 hash 写进 asset.hash，因此预言机无需读内核的 cache_key。
const { createHash } = require('node:crypto');

const GENERATED = ['image', 'video', 'narration', 'compose'];
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

/** 键排序的稳定字符串化（自己的实现）。 */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// ---------- 只读的“原始结构”访问（自己遍历 edges/groups） ----------

function order(g, type) {
  const out = [];
  for (const gid of g.group_order) for (const c of g.groups[gid].children) if (g.nodes[c].type === type) out.push(c);
  return out;
}
const shotsInOrder = (g) => order(g, 'shot');
const linesInOrder = (g) => order(g, 'script_line');

/** 镜头的行（按剧本顺序）：所有 line -> shot 的 derives 边。 */
function linesOf(g, shotId) {
  const attached = new Set(g.edges.filter((e) => e.to.node === shotId && g.nodes[e.from.node].type === 'script_line').map((e) => e.from.node));
  return linesInOrder(g).filter((l) => attached.has(l));
}
/** 一行挂到的镜头（按镜头顺序）。 */
function shotsOfLine(g, lineId) {
  const att = new Set(g.edges.filter((e) => e.from.node === lineId && g.nodes[e.to.node].type === 'shot').map((e) => e.to.node));
  return shotsInOrder(g).filter((s) => att.has(s));
}
/** 镜头下游的 image / video / narration（沿边找；多个时取 id 最小，同内核约定）。 */
function chain(g, shotId) {
  const pick = (type) => g.edges.filter((e) => e.from.node === shotId && g.nodes[e.to.node].type === type).map((e) => e.to.node).sort()[0] || null;
  return { image: pick('image'), video: pick('video'), narration: pick('narration') };
}
/** 镜头的生成节点 id 列表（只含存在的）。 */
const chainIds = (g, shotId) => Object.values(chain(g, shotId)).filter(Boolean).sort();
const composeNode = (g) => Object.keys(g.nodes).filter((id) => g.nodes[id].type === 'compose').sort()[0] || null;
const SPOKEN = ['narration', 'dialogue'];

// ---------- 签名 ----------

/** 返回 id -> 签名字符串（sha1）。 */
function signatures(g) {
  const memo = {};
  const lineRank = Object.fromEntries(linesInOrder(g).map((l, i) => [l, i]));
  function upstream(id) {
    const n = g.nodes[id];
    const list = [];
    for (const e of g.edges) {
      if (e.to.node !== id) continue;
      if (e.type === 'binds') {
        // 配音：台词来自所属镜头的行（而不是镜头的画面参数）
        if (n.type === 'narration') for (const l of linesOf(g, e.from.node)) list.push(['lines', l]);
        continue;
      }
      list.push([e.to.port, e.from.node]);
    }
    const seen = new Set();
    return list
      .filter(([p, u]) => { const k = `${p}|${u}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[0] === 'lines' ? lineRank[a[1]] - lineRank[b[1]] : a[1] < b[1] ? -1 : 1));
  }
  function sig(id) {
    if (memo[id]) return memo[id];
    const n = g.nodes[id];
    const body = { t: n.type, p: n.params, in: upstream(id).map(([port, u]) => ({ port, sig: sig(u) })) };
    if (n.type === 'compose') body.shot_order = shotsInOrder(g);
    memo[id] = sha1(stable(body));
    return memo[id];
  }
  for (const id of Object.keys(g.nodes)) sig(id);
  return memo;
}

/** 预言机：给节点“生成”一个版本时应写进 asset.hash 的值。 */
const contentHash = (g, id) => signatures(g)[id];

function isFresh(g, id, sigs = signatures(g)) {
  const vid = g.adopted[id];
  if (!vid) return false;
  const v = (g.versions[id] || []).find((x) => x.id === vid);
  return !!(v && v.asset && v.asset.hash === sigs[id]);
}

/** 预言机的过期集合（排序）。 */
function expectedStale(g) {
  const sigs = signatures(g);
  return Object.keys(g.nodes).filter((id) => GENERATED.includes(g.nodes[id].type) && !isFresh(g, id, sigs)).sort();
}

/** 预言机的事务前后差异：只看前后都存在的生成类节点。 */
function expectedDiff(before, after) {
  const sb = new Set(expectedStale(before));
  const sa = new Set(expectedStale(after));
  const both = (id) => before.nodes[id] && after.nodes[id] && GENERATED.includes(after.nodes[id].type);
  return {
    invalidated: Object.keys(after.nodes).filter((id) => both(id) && !sb.has(id) && sa.has(id)).sort(),
    revalidated: Object.keys(after.nodes).filter((id) => both(id) && sb.has(id) && !sa.has(id)).sort(),
  };
}

// ---------- 写路径差异（证明一个视图的编辑没有改动它不该碰的数据） ----------

/** 把图拍平成 路径 -> JSON 字符串；对象逐层展开，数组整体算一个值。 */
function flatten(g) {
  const out = {};
  const walk = (prefix, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) for (const k of Object.keys(v)) walk(`${prefix}.${k}`, v[k]);
    else out[prefix] = stable(v);
  };
  out.project_id = stable(g.project_id);
  for (const [id, n] of Object.entries(g.nodes)) {
    out[`nodes.${id}.type`] = stable(n.type);
    out[`nodes.${id}.legacy_id`] = stable(n.legacy_id ?? null);
    walk(`nodes.${id}.params`, n.params);
  }
  for (const e of g.edges) out[`edges.${e.id}`] = stable(e);
  out['edges#order'] = stable(g.edges.map((e) => e.id));
  for (const [id, grp] of Object.entries(g.groups)) {
    out[`groups.${id}.title`] = stable(grp.title);
    out[`groups.${id}.children`] = stable(grp.children);
  }
  out.group_order = stable(g.group_order);
  for (const [id, p] of Object.entries(g.layout)) out[`layout.${id}`] = stable(p);
  for (const [id, v] of Object.entries(g.versions)) out[`versions.${id}`] = stable(v);
  for (const [id, v] of Object.entries(g.adopted)) out[`adopted.${id}`] = stable(v);
  return out;
}
/** 两张图之间变化的路径（新增、删除、值变化）。 */
function changedPaths(a, b) {
  const fa = flatten(a);
  const fb = flatten(b);
  const paths = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  return [...paths].filter((p) => fa[p] !== fb[p]).sort();
}

module.exports = {
  GENERATED, SPOKEN, stable, signatures, contentHash, isFresh, expectedStale, expectedDiff,
  shotsInOrder, linesInOrder, linesOf, shotsOfLine, chain, chainIds, composeNode, flatten, changedPaths,
};
