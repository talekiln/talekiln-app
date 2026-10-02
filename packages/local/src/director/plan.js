'use strict';
/**
 * 导演模式的计划处理（纯函数，不碰数据库，不联网）：
 *   parsePlan      模型文本 -> JSON（容忍代码块、闲聊、尾逗号）-> 规范化的 { summary, steps, untouched }
 *   checkPlan      结构与参数表检查（动作在清单里、参数类型正确、没有编造的参数）
 *   dryRun         在克隆图上按顺序试跑每一步（kernel.applyTx），记下每步的 op 数与它新造成过期的节点
 *   compileOps     执行时在最新图上重跑一遍得到一个事务的 ops（与干跑同样的确定性分配）
 *   computeImpact  干跑前后对比：会改 / 不会改的镜头、时长、过期节点
 *   estimateCost   过期节点的重新生成估价（图 / 视频走生成服务的计划；配音按字数）
 *   structureHash  图的结构摘要（节点 / 边 / 组 / 顺序，不含版本与布局），执行前核对计划仍然适用
 */
const kernel = require('@talekiln/kernel');
const { extractJson } = require('../scriptgen/generate');
const { lookupIntent } = require('../kernel/intentTable');
const { SCHEMAS, EXCLUDED, checkArgs } = require('./intentSchemas');

const MAX_STEPS = 40;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cut = (s, n = 30) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

// ---------- 解析 ----------

/** 去掉 Markdown 代码块围栏后取最外层 JSON 对象。返回 { value, error, repaired }。 */
function parsePlan(text) {
  const stripped = String(text || '').replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  const r = extractJson(stripped);
  if (!r.value) return { value: null, error: `模型输出不是 JSON：${r.error || '无法解析'}` };
  if (!isObj(r.value)) return { value: null, error: '模型输出的 JSON 不是对象' };
  return { value: r.value, repaired: !!r.repaired };
}

/** 规范化：补默认值、裁掉多余字段；不做合法性判断（交给 checkPlan）。 */
function normalizePlan(obj) {
  const o = isObj(obj) ? obj : {};
  const steps = Array.isArray(o.steps) ? o.steps.map((s) => (isObj(s) ? {
    view: typeof s.view === 'string' ? s.view : String(s.view ?? ''),
    name: typeof s.name === 'string' ? s.name : String(s.name ?? ''),
    args: isObj(s.args) ? s.args : s.args,
    reason: typeof s.reason === 'string' ? s.reason : '',
  } : s)) : (o.steps === undefined ? [] : o.steps);
  const untouched = Array.isArray(o.untouched) ? o.untouched.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
  return { summary: typeof o.summary === 'string' ? o.summary.trim() : '', steps, untouched };
}

// ---------- 结构与参数检查 ----------

const stepName = (s) => `${s && s.view}.${s && s.name}`;

/** 返回中文错误列表（空 = 通过）。 */
function checkPlan(plan) {
  const errors = [];
  if (!Array.isArray(plan.steps)) return ['steps 必须是数组'];
  if (!plan.steps.length) return [`steps 为空：模型没有给出可执行的步骤${plan.summary ? `（${plan.summary}）` : ''}`];
  if (plan.steps.length > MAX_STEPS) errors.push(`步骤太多（${plan.steps.length} > ${MAX_STEPS}），请把要求拆开`);
  plan.steps.forEach((s, i) => {
    const at = `第 ${i + 1} 步`;
    if (!isObj(s)) { errors.push(`${at}不是对象`); return; }
    const hit = lookupIntent(s.view, s.name);
    const key = stepName(s);
    if (!hit) { errors.push(`${at}：动作 ${key} 不在可用动作清单里`); return; }
    const canon = `${hit.view}.${hit.name}`;
    if (EXCLUDED[canon]) { errors.push(`${at}：动作 ${canon} 不对导演模式开放（${EXCLUDED[canon]}）`); return; }
    const schema = SCHEMAS[hit.view] && SCHEMAS[hit.view][hit.name];
    if (!schema) { errors.push(`${at}：动作 ${canon} 没有参数表，不对导演模式开放`); return; }
    for (const e of checkArgs(schema, s.args)) errors.push(`${at} ${canon}：${e}`);
  });
  return errors;
}

// ---------- 干跑 ----------

const generatedIds = (g) => Object.keys(g.nodes).filter((id) => kernel.GENERATED_TYPES.includes(g.nodes[id].type));

/**
 * 在克隆图上顺序试跑。返回 { ok, graph, steps, errors, staleNodes }：
 *   steps[i] = { index, view, name, label, ok, error?, op_count, ops, stale_nodes }
 *   stale_nodes = 这一步让原本新鲜的节点过期（applyTx.invalidated）∪ 这一步新建的生成类节点（它们从未生成过）
 *   staleNodes = 全计划的并集（去重，记第一次造成过期的步骤；最终图里已不存在的节点剔除）
 * 第一步失败即停止（后面的步骤建立在前面的结果上，无法评估）。
 */
function dryRun(graph, plan) {
  let g = graph;
  const steps = [];
  const errors = [];
  const stale = new Map();
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    const hit = lookupIntent(s.view, s.name);
    const rec = { index: i, view: hit ? hit.view : s.view, name: s.name, label: '', ok: false, op_count: 0, ops: [], stale_nodes: [] };
    steps.push(rec);
    try {
      if (!hit) throw new kernel.KernelError('INTENT', `unknown intent ${stepName(s)}`);
      const tx = hit.fn(g, s.args, { tx_id: `director-dry-${i + 1}` });
      const before = new Set(generatedIds(g));
      const r = kernel.applyTx(g, tx);
      const added = generatedIds(r.graph).filter((id) => !before.has(id));
      rec.label = tx.label || s.name;
      rec.op_count = tx.ops.length;
      rec.ops = tx.ops;
      rec.ok = true;
      rec.stale_nodes = [...r.invalidated, ...added];
      for (const id of rec.stale_nodes) if (!stale.has(id)) stale.set(id, i);
      g = r.graph;
    } catch (e) {
      rec.error = e && e.message ? e.message : String(e);
      rec.error_code = e && e.code ? e.code : null;
      errors.push(`第 ${i + 1} 步 ${stepName(s)} 执行失败：${rec.error}`);
      break;
    }
  }
  if (!errors.length && steps.every((x) => x.op_count === 0)) errors.push('计划不会产生任何改动（每一步都是空操作）');
  const staleNodes = [...stale.entries()].filter(([id]) => g.nodes[id]).map(([node, step]) => ({ node, type: g.nodes[node].type, step }));
  return { ok: errors.length === 0, graph: g, steps, errors, staleNodes };
}

/** 执行时在最新图上重跑所有步骤，合成一个事务的 ops；任一步失败抛 KernelError。 */
function compileOps(graph, steps) {
  let g = graph;
  const ops = [];
  const labels = [];
  steps.forEach((s, i) => {
    const hit = lookupIntent(s.view, s.name);
    if (!hit) throw new kernel.KernelError('INTENT', `第 ${i + 1} 步：动作 ${stepName(s)} 不在可用动作清单里`);
    const tx = hit.fn(g, s.args, { tx_id: `director-compile-${i + 1}` });
    g = kernel.applyTx(g, tx).graph;
    ops.push(...tx.ops);
    labels.push(tx.label || s.name);
  });
  return { ops, labels, graph: g };
}

/** 结构摘要：节点（含参数）、边、组、顺序；不含版本 / 采用 / 布局，所以生成结果写回不会让计划失效。 */
function structureHash(graph) {
  return kernel.sha256(kernel.canonicalJSON({ nodes: graph.nodes, edges: graph.edges, groups: graph.groups, group_order: graph.group_order }));
}

// ---------- 影响范围 ----------

function flattenShots(g) {
  const view = kernel.shotView(g);
  const out = [];
  let n = 0;
  for (const grp of view.groups) {
    for (const s of grp.shots) {
      n += 1;
      out.push({
        id: s.id, no: n, group: grp.id, title: s.params.title || cut(s.params.description) || `镜头 ${n}`,
        used_ms: s.used_ms, planned_ms: s.planned_ms, dialogue: s.dialogue, params: JSON.stringify(g.nodes[s.id].params),
        segments: JSON.stringify(kernel.segmentsOfShot(g, s.id)),
        gen: JSON.stringify([kernel.partsOfShot(g, s.id)].map((p) => ['image', 'video', 'narration'].map((k) => (p[k] ? g.nodes[p[k]].params : null)))),
      });
    }
  }
  return out;
}

/** 两张图的镜头级差异。shotsBefore / shotsAfter 给前端画节奏条；changed_shots 带变化类型。 */
function computeImpact(before, after, staleNodes = []) {
  const sb = flattenShots(before);
  const sa = flattenShots(after);
  const bMap = new Map(sb.map((s) => [s.id, s]));
  const aMap = new Map(sa.map((s) => [s.id, s]));
  const survivors = sb.filter((s) => aMap.has(s.id)).map((s) => s.id);
  const afterOrder = sa.filter((s) => bMap.has(s.id)).map((s) => s.id);
  const movedSet = new Set(survivors.filter((id, i) => afterOrder[i] !== id));
  const changed = [];
  const unchanged = [];
  const added = [];
  for (const s of sa) {
    const b = bMap.get(s.id);
    if (!b) { added.push(s.id); changed.push({ id: s.id, no: s.no, title: s.title, change: 'added', changes: ['added'], before: null, after: { no: s.no, used_ms: s.used_ms, title: s.title } }); continue; }
    const changes = [];
    if (b.params !== s.params) changes.push('content');
    if (b.dialogue !== s.dialogue) changes.push('lines');
    if (b.gen !== s.gen) changes.push('generation');
    if (b.segments !== s.segments) changes.push('segments');
    if (b.group !== s.group) changes.push('group');
    if (movedSet.has(s.id)) changes.push('order');
    const rec = { id: s.id, no: s.no, title: s.title, changes, before: { no: b.no, used_ms: b.used_ms, title: b.title }, after: { no: s.no, used_ms: s.used_ms, title: s.title } };
    if (!changes.length) unchanged.push(s.id);
    else changed.push({ ...rec, change: changes.every((c) => c === 'order' || c === 'group') ? 'moved' : 'modified' });
  }
  const removed = sb.filter((s) => !aMap.has(s.id)).map((s) => ({ id: s.id, no: s.no, title: s.title, change: 'removed', changes: ['removed'], before: { no: s.no, used_ms: s.used_ms, title: s.title }, after: null }));
  const changeOf = new Map(changed.map((c) => [c.id, c.change]));
  const shotNo = (g, list, nodeId) => {
    for (const s of list) { const p = kernel.partsOfShot(g, s.id); if (p.image === nodeId || p.video === nodeId || p.narration === nodeId) return s; }
    return null;
  };
  const stale = staleNodes.map((n) => {
    const owner = shotNo(after, sa, n.node);
    return { node: n.node, type: n.type, step: n.step, shot_id: owner ? owner.id : null, shot_no: owner ? owner.no : null };
  });
  return {
    changed_shots: [...changed, ...removed].sort((a, b) => (a.no ?? 0) - (b.no ?? 0)),
    unchanged_shots: unchanged,
    added_shots: added,
    removed_shots: removed.map((r) => r.id),
    duration: { before_ms: kernel.timelineView(before).duration_ms, after_ms: kernel.timelineView(after).duration_ms },
    shots_before: sb.map((s) => ({ id: s.id, no: s.no, title: s.title, used_ms: s.used_ms, change: aMap.has(s.id) ? (changeOf.get(s.id) || 'unchanged') : 'removed' })),
    shots_after: sa.map((s) => ({ id: s.id, no: s.no, title: s.title, used_ms: s.used_ms, change: changeOf.get(s.id) || 'unchanged' })),
    stale_nodes: stale,
  };
}

// ---------- 估价 ----------

const VIDEO_MIN_SEC = 1;
const VIDEO_MAX_SEC = 15;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * 过期节点的重新生成估价。
 *   image / video：有生成服务时用它的计划（planGraph，与点击“生成”看到的模型、提示词、时长一致，缓存命中记 0）；
 *                  没有时按已启用服务商与默认模型粗估。
 *   narration：按配音文字字数（tts 价目）。compose 不计费，不列入。
 * 返回 { total, max, currency, sample_prices, known, allowed, refusal, items }。
 */
function estimateCost({ graph, staleNodes, episodeId, spend, generation = null, listConfigs = null, catalogModels = null }) {
  const enablement = require('../providers/enablement');
  const ids = new Set(staleNodes.map((n) => n.node));
  const stepOf = new Map(staleNodes.map((n) => [n.node, n.step]));
  const owner = (nodeId) => {
    for (const sid of kernel.shotOrder(graph)) { const p = kernel.partsOfShot(graph, sid); if (p.image === nodeId || p.video === nodeId || p.narration === nodeId) return sid; }
    return null;
  };
  const nums = Object.fromEntries(kernel.shotOrder(graph).map((id, i) => [id, i + 1]));
  const items = [];
  const specs = [];
  const push = (node, kind, spec, model) => {
    const shotId = owner(node);
    items.push({ node, type: graph.nodes[node].type, shot_id: shotId, shot_no: shotId ? nums[shotId] : null, kind, model: model || null, step: stepOf.get(node) ?? null, spec });
    specs.push(spec);
  };

  const shotIds = [...new Set(staleNodes.map((n) => owner(n.node)).filter(Boolean))];
  const want = (kind) => staleNodes.filter((n) => n.type === kind).map((n) => n.node);
  if (want('image').length || want('video').length) {
    if (generation && typeof generation.planGraph === 'function') {
      for (const it of generation.planGraph(graph, episodeId, shotIds, ['image', 'video'])) {
        if (!it.node || !ids.has(it.node)) continue;
        if (it.action === 'create' || it.action === 'chain') push(it.node, it.kind, it.spec, it.model);
        else push(it.node, it.kind, null, it.model); // 缓存命中 / 已新鲜：不花钱
      }
    } else {
      const { chooseProvider, pickModel } = require('../generation/models');
      const list = listConfigs || (() => []);
      for (const node of [...want('image'), ...want('video')]) {
        const kind = graph.nodes[node].type;
        const provider = chooseProvider(list, kind).provider;
        const shotId = owner(node);
        const dur = shotId ? graph.nodes[shotId].params.duration_ms || kernel.DEFAULT_SHOT_MS : kernel.DEFAULT_SHOT_MS;
        const model = pickModel({ provider, kind, hasFrame: kind === 'video', listConfigs: list, catalogModels: catalogModels ? catalogModels() : [] });
        const params = kind === 'video' ? { duration: Math.min(VIDEO_MAX_SEC, Math.max(VIDEO_MIN_SEC, Math.round(dur / 1000))) } : {};
        if (model) params.model = model;
        push(node, kind, { provider, kind, params }, model);
      }
    }
  }
  if (want('narration').length) {
    const { spokenText } = require('../voiceover/service');
    const provider = enablement.getEnabled()[0];
    for (const node of want('narration')) {
      const shotId = owner(node);
      const text = shotId ? spokenText(graph, shotId) : '';
      if (!text) { push(node, 'tts', null, null); continue; }
      push(node, 'tts', { provider, kind: 'tts', params: { text } }, null);
    }
  }

  const billable = items.filter((i) => i.spec);
  const check = spend && typeof spend.checkBatch === 'function'
    ? spend.checkBatch(billable.map((i) => i.spec))
    : batchFallback(billable.map((i) => i.spec), spend);
  let k = 0;
  const out = items.map((i) => {
    const e = i.spec ? check.estimates[k++] : null;
    const { spec, ...rest } = i;
    return { ...rest, estimate: e ? e.estimate : 0, max: e ? e.max : 0, basis: e ? e.basis : (i.spec === null && i.kind !== 'tts' ? '沿用旧素材，不花钱' : '没有可配音的文字'), known: e ? e.known : true };
  });
  return {
    total: round6(check.total), max: round6(check.max), currency: check.currency, sample_prices: check.sample_prices, known: check.known,
    allowed: check.ok, refusal: check.ok ? null : { reason: check.reason, message: check.message }, items: out,
  };
}

function batchFallback(specs, spend) {
  const estimator = spend && typeof spend.estimate === 'function' ? spend : require('../spend').createEstimator();
  const estimates = specs.map((s) => estimator.estimate(s));
  return {
    ok: true, reason: null, message: null, estimates,
    total: estimates.reduce((a, e) => a + e.estimate, 0), max: estimates.reduce((a, e) => a + e.max, 0),
    currency: estimates[0] ? estimates[0].currency : 'CNY', sample_prices: estimates.every((e) => e.sample !== false), known: estimates.every((e) => e.known),
  };
}

module.exports = { MAX_STEPS, parsePlan, normalizePlan, checkPlan, dryRun, compileOps, structureHash, computeImpact, estimateCost, flattenShots };
