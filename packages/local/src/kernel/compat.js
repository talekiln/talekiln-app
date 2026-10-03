'use strict';
// 旧写接口的兼容层（docs/kernel-design.md §6、§11）：
// 项目图是唯一可写源。旧 REST 接口保持 URL 与返回形状，写入改为：确保该剧集有图（首次写入自动 importLegacy）
// -> 把请求翻译成内核意图 / 事务 -> store.commit（同一 SQLite 事务里物化回旧表）-> 从物化后的旧表读出响应。
// 无法表达的请求映射到最接近的意图，或以 409/400 + 错误码表里的码明确拒绝（见各函数注释，汇总在 §11）。
const crypto = require('node:crypto');
const kernel = require('@talekiln/kernel');
const store = require('./store');
const legacy = require('./legacy');
const timeline = require('../timeline');

const { KernelError, canonicalJSON, intents: I } = kernel;

const unsupported = (m) => new KernelError('GRAPH_UNSUPPORTED_EDIT', m);
const orderUnsupported = (m) => new KernelError('TIMELINE_ORDER_UNSUPPORTED', m);

const KERNEL_STATUS = {
  NOT_FOUND: 404, GRAPH_NOT_FOUND: 404, NOTHING_TO_UNDO: 409, NOTHING_TO_REDO: 409,
  GRAPH_UNSUPPORTED_EDIT: 409, TIMELINE_ORDER_UNSUPPORTED: 409,
};

/** 把内核 / 时间线错误写成统一错误响应；不认识的错误返回 false，由调用方按 500 处理。 */
function handleError(res, err) {
  const response = require('../response');
  if (err instanceof KernelError) { response.error(res, KERNEL_STATUS[err.code] || 400, err.code, err.message); return true; }
  if (err instanceof timeline.TimelineError) { response.error(res, err.status, err.code, err.message); return true; }
  return false;
}

// ---------------------------------------------------------------- 基础设施

/** 在一个调用里按顺序应用若干意图事务，收集合并后的 ops（每步都在上一步结果上构造并校验）。 */
class Chain {
  constructor(graph) { this.g = graph; this.ops = []; }
  add(tx) {
    if (!tx || !tx.ops.length) return tx ? tx.meta : undefined;
    this.ops.push(...tx.ops);
    this.g = kernel.applyTx(this.g, { tx_id: 'chain', label: tx.label, ops: tx.ops }).graph;
    return tx.meta;
  }
  raw(ops) { return this.add({ label: 'raw', ops }); }
  tx(label, tx_id) { return { tx_id: tx_id || crypto.randomUUID(), label, ops: this.ops }; }
}

function ensureGraph(db, episodeId) {
  if (!store.hasProject(db, episodeId)) legacy.importLegacy(db, episodeId);
}

/** 丢弃某剧集的项目图（整集重建分镜后调用）：下次写入会从旧表重新导入。撤销历史随之清空。 */
function resetGraph(db, episodeId) {
  const ep = Number(episodeId);
  db.transaction(() => {
    db.prepare('DELETE FROM graph_ops WHERE episode_id = ?').run(ep);
    db.prepare('DELETE FROM graph_legacy_map WHERE episode_id = ?').run(ep);
    db.prepare('DELETE FROM project_graphs WHERE episode_id = ?').run(ep);
  })();
}

/**
 * 构造并提交一个事务。build(chain) 用 chain.add(intentTx) 累积 ops，返回任意结果；ops 为空则什么也不提交。
 * 先在当前图上试算一遍（空则跳过，不产生撤销步），再在 store.commit 的 SQLite 事务里基于最新图重算后提交。
 */
function run(db, episodeId, label, build, opts = {}) {
  return db.transaction(() => {
    const p = store.openProject(db, episodeId);
    const probe = new Chain(p.graph);
    const probed = build(probe);
    if (!probe.ops.length) return { applied: false, graph: p.graph, result: probed };
    let result;
    const r = store.commit(db, episodeId, (g) => {
      const c = new Chain(g);
      result = build(c);
      return c.tx(label, opts.tx_id);
    }, opts);
    return { ...r, result };
  })();
}

const shotNodeOfLegacy = (g, legacyId) => kernel.shotOrder(g).find((id) => String(g.nodes[id].legacy_id) === String(legacyId)) || null;
const shotsIn = (g, groupId) => g.groups[groupId].children.filter((id) => g.nodes[id].type === 'shot');

const TEXT_PARAMS = ['title', 'description', 'location', 'time', 'shot_type', 'angle', 'movement', 'image_prompt', 'video_prompt', 'atmosphere'];

function durationMs(v) {
  if (v === null || v === '' || v === 0 || v === '0') return kernel.DEFAULT_SHOT_MS; // 旧表 0 = 未设置，用默认 5 秒
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new KernelError('INTENT', 'duration must be a non-negative number of seconds');
  return Math.max(1, Math.round(n * 1000));
}

function charactersOf(b) {
  const v = b.character_ids !== undefined ? b.character_ids : b.characters;
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return structuredClone(v);
  if (typeof v === 'string') { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
  return [];
}

/** 请求体里属于镜头 params 的字段 -> params 补丁。 */
function paramsFromBody(b) {
  const p = {};
  for (const k of TEXT_PARAMS) if (b[k] !== undefined) p[k] = b[k] == null ? '' : String(b[k]);
  if (b.duration !== undefined) p.duration_ms = durationMs(b.duration);
  const ch = charactersOf(b);
  if (ch !== undefined) p.characters = ch;
  return p;
}

const GRAPH_KEYS = [...TEXT_PARAMS, 'duration', 'characters', 'character_ids', 'dialogue', 'narration', 'action', 'segment_title', 'segment_index'];
const LINE_COLUMNS = ['action', 'narration', 'dialogue']; // 对应行 kind

function lineSpecs(kind, raw) {
  return legacy.splitLines(raw).map((text) => {
    const m = kind === 'dialogue' ? legacy.SPEAKER_RE.exec(text) : null;
    return { kind, speaker: m ? m[1].trim() : '', text };
  });
}

/** 新行在组内的插入位置（行序号）：优先接在本镜头已有行之后，其次前一镜头最后一行之后，其次下一镜头第一行之前，否则放组末尾。 */
function lineSlot(g, groupId, { own = [], prev = null, next = null } = {}) {
  const L = g.groups[groupId].children.filter((id) => g.nodes[id].type === 'script_line');
  const last = (ids) => ids.reduce((m, id) => Math.max(m, L.indexOf(id)), -1);
  let i = last(own);
  if (i >= 0) return i + 1;
  if (prev) { i = last(kernel.linesOfShot(g, prev)); if (i >= 0) return i + 1; }
  if (next) {
    const idx = kernel.linesOfShot(g, next).map((id) => L.indexOf(id)).filter((x) => x >= 0);
    if (idx.length) return Math.min(...idx);
  }
  return L.length;
}

/** 新建镜头（含它的行）：行插在邻近镜头的行旁边，镜头放在组内第 index 个镜头位置（缺省为末尾）。返回新镜头 id。 */
function addShotWithLines(c, { group, index, params = {}, specs = [] }) {
  const S = shotsIn(c.g, group);
  const k = index === undefined ? S.length : Math.max(0, Math.min(index, S.length));
  let slot = lineSlot(c.g, group, { prev: S[k - 1] || null, next: S[k] || null });
  const ids = [];
  for (const l of specs) {
    const m = c.add(I.script.insertLine(c.g, { group, index: slot++, kind: l.kind, speaker: l.speaker, text: l.text }));
    ids.push(m.line_id);
  }
  return c.add(I.shot.addShot(c.g, { group, index: k, params, lines: ids })).shot_id;
}

const edgeBetween = (g, lineId, shotId) => g.edges.find((e) => e.from.node === lineId && e.to.node === shotId && e.to.port === 'lines');

/**
 * 把镜头某个 kind（dialogue/narration/action）的行改成 rawText 切出的那些行：按位置改写、多的删、少的补。
 * 被多个镜头共用的行不直接改（会牵连别的镜头）：对本镜头断开关联，再建一行新的。
 */
function applyLineKind(c, shotId, kind, rawText) {
  const want = lineSpecs(kind, rawText);
  const have = kernel.linesOfShot(c.g, shotId).filter((id) => c.g.nodes[id].params.kind === kind);
  const own = () => kernel.linesOfShot(c.g, shotId);
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const g = c.g;
    const id = have[i];
    const w = want[i];
    if (id && w) {
      const p = g.nodes[id].params;
      if (p.text === w.text && p.speaker === w.speaker) continue;
      if (kernel.shotsOfLine(g, id).length > 1) {
        const gid = kernel.groupOf(g, id);
        c.raw([{ op: 'disconnect', id: edgeBetween(g, id, shotId).id }]);
        const pos = c.g.groups[gid].children.filter((x) => c.g.nodes[x].type === 'script_line').indexOf(id) + 1;
        c.add(I.script.insertLine(c.g, { group: gid, index: pos, kind, speaker: w.speaker, text: w.text, shot_ids: [shotId] }));
      } else {
        c.add(I.script.rewriteLine(g, id, { text: w.text, speaker: w.speaker }));
      }
    } else if (id) {
      if (kernel.shotsOfLine(g, id).length > 1) c.raw([{ op: 'disconnect', id: edgeBetween(g, id, shotId).id }]);
      else c.add(I.script.deleteLine(g, id));
    } else {
      const lines = own();
      const gid = lines.length ? kernel.groupOf(g, lines[lines.length - 1]) : kernel.groupOf(g, shotId);
      const S = shotsIn(g, gid);
      const at = S.indexOf(shotId);
      const slot = lineSlot(g, gid, { own: lines, prev: at > 0 ? S[at - 1] : null, next: S[at + 1] || null });
      c.add(I.script.insertLine(g, { group: gid, index: slot, kind: w.kind, speaker: w.speaker, text: w.text, shot_ids: [shotId] }));
    }
  }
}

/** 过滤掉与现值等价的补丁（避免给没有 atmosphere 的镜头写一个空串）。 */
function effectivePatch(node, patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'atmosphere' && v === '' && !node.params.atmosphere) continue;
    out[k] = v;
  }
  return out;
}

/** 在镜头 shotId 上应用请求体里的镜头字段（params、台词行、所属段落）。 */
function applyShotBody(c, shotId, body) {
  const patch = effectivePatch(c.g.nodes[shotId], paramsFromBody(body));
  if (Object.keys(patch).length) c.add(I.shot.setShotField(c.g, shotId, patch));
  for (const kind of LINE_COLUMNS) if (body[kind] !== undefined) applyLineKind(c, shotId, kind, body[kind]);
  if (body.segment_title !== undefined) {
    const title = body.segment_title == null ? '' : String(body.segment_title);
    const gid = kernel.groupOf(c.g, shotId);
    if (c.g.groups[gid].title !== title) {
      const target = c.g.group_order.find((id) => c.g.groups[id].title === title);
      if (!target) throw unsupported(`段落「${title}」不存在：项目图里镜头只能在已有段落之间移动`);
      c.add(I.shot.moveShotToGroup(c.g, shotId, target, undefined));
    }
  }
}

// ---------------------------------------------------------------- 分镜接口

function episodeIdOf(db, storyboardId) {
  const row = db.prepare('SELECT episode_id FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(storyboardId));
  return row ? row.episode_id : null;
}

function nonGraphBody(b) {
  const rest = {};
  for (const [k, v] of Object.entries(b)) if (!GRAPH_KEYS.includes(k) || k === 'characters' || k === 'character_ids') rest[k] = v;
  return rest;
}

/** 新镜头放哪：给定 storyboard_number（1 起）= 全局第 n 个位置；没给 = 末尾。segment_title 命中已有段落则放进该段落。 */
function placeNew(g, req, c) {
  const order = kernel.shotOrder(g);
  const n = Number(req.storyboard_number) || 0;
  const at = n > 0 ? Math.min(n - 1, order.length) : order.length;
  let group = null;
  let index;
  if (at < order.length) {
    const ref = order[at];
    group = kernel.groupOf(g, ref);
    index = shotsIn(g, group).indexOf(ref);
  } else if (order.length) {
    group = kernel.groupOf(g, order[order.length - 1]);
  }
  const title = req.segment_title == null ? null : String(req.segment_title);
  if (title) {
    const hit = g.group_order.find((id) => g.groups[id].title === title);
    if (hit && hit !== group) { group = hit; index = undefined; }
  }
  if (!group) group = g.group_order[0] || null;
  if (!group) {
    let n2 = 1;
    while (g.groups[`grp_${n2}`]) n2++;
    group = `grp_${n2}`;
    c.raw([{ op: 'addGroup', group: { id: group, title: title || '', children: [] } }]);
  }
  return { group, index };
}

/**
 * POST /storyboards。storyboard_number 改为“插在全局第 n 个位置”（旧实现只写数字，不挪别人；现在其余镜头顺延，编号物化为 1..N 连续）。
 * scene_id / result 等图里没有的列照旧直接写。
 */
function createStoryboard(db, log, req) {
  const storyboardService = require('../services/storyboardService');
  const ep = Number(req.episode_id);
  if (!Number.isInteger(ep) || ep <= 0) throw new KernelError('INTENT', 'episode_id is required');
  return db.transaction(() => {
    ensureGraph(db, ep);
    const r = run(db, ep, 'createStoryboard', (c) => {
      const { group, index } = placeNew(c.g, req, c);
      const params = effectivePatch({ params: {} }, paramsFromBody(req));
      const specs = LINE_COLUMNS.flatMap((k) => (req[k] !== undefined ? lineSpecs(k, req[k]) : []));
      return addShotWithLines(c, { group, index, params, specs });
    });
    const id = r.graph.nodes[r.result].legacy_id;
    const rest = {};
    for (const k of ['scene_id', 'result']) if (req[k] !== undefined) rest[k] = req[k];
    if (Object.keys(rest).length) storyboardService.updateStoryboard(db, log, id, rest);
    log.info('Storyboard created', { id, episode_id: ep });
    return storyboardService.getStoryboardById(db, id);
  })();
}

/** POST /storyboards/:id/insert-before：在目标镜头前插一个空白镜头（同段落），其余顺延。 */
function insertBeforeStoryboard(db, log, targetId) {
  const storyboardService = require('../services/storyboardService');
  const ep = episodeIdOf(db, targetId);
  if (ep == null) return null;
  return db.transaction(() => {
    ensureGraph(db, ep);
    const r = run(db, ep, 'insertBefore', (c) => {
      const t = shotNodeOfLegacy(c.g, targetId);
      if (!t) throw new KernelError('NOT_FOUND', `storyboard ${targetId} is not in the project graph`);
      const group = kernel.groupOf(c.g, t);
      return addShotWithLines(c, { group, index: shotsIn(c.g, group).indexOf(t) });
    });
    const id = r.graph.nodes[r.result].legacy_id;
    log.info('Storyboard inserted before', { new_id: id, before_id: targetId });
    return storyboardService.getStoryboardById(db, id);
  })();
}

/**
 * PUT /storyboards/:id。图里有的字段（标题、描述、提示词、时长、台词/旁白/动作行……）走 setShotField / 行意图；
 * 其余列（scene_id、生成结果列、universal_segment_text……）照旧直接写。
 * duration 秒 -> duration_ms；segment_index 忽略（由段落顺序推出）；segment_title 改成另一个已有段落 = 移动镜头，没有这个段落 -> 409。
 */
function updateStoryboard(db, log, id, body) {
  const storyboardService = require('../services/storyboardService');
  const ep = episodeIdOf(db, id);
  if (ep == null) return null;
  const b = body || {};
  return db.transaction(() => {
    if (GRAPH_KEYS.some((k) => b[k] !== undefined)) {
      ensureGraph(db, ep);
      run(db, ep, 'updateStoryboard', (c) => {
        const shotId = shotNodeOfLegacy(c.g, id);
        if (!shotId) throw new KernelError('NOT_FOUND', `storyboard ${id} is not in the project graph`);
        applyShotBody(c, shotId, b);
      });
    }
    return storyboardService.updateStoryboard(db, log, id, nonGraphBody(b));
  })();
}

/** 给若干镜头改图里的字段（提示词润色、批量推断运镜、角色补全……）。changes: [{ id（旧 storyboards.id）, patch }]，一个事务。 */
function setShotFields(db, changes) {
  const list = changes.filter((x) => x && Object.keys(x.patch || {}).length);
  if (!list.length) return { applied: false };
  const byEp = new Map();
  for (const ch of list) {
    const ep = episodeIdOf(db, ch.id);
    if (ep == null) continue;
    if (!byEp.has(ep)) byEp.set(ep, []);
    byEp.get(ep).push(ch);
  }
  return db.transaction(() => {
    let applied = false;
    for (const [ep, items] of byEp) {
      ensureGraph(db, ep);
      const r = run(db, ep, 'setShotFields', (c) => {
        for (const it of items) {
          const shotId = shotNodeOfLegacy(c.g, it.id);
          if (shotId) applyShotBody(c, shotId, it.patch);
        }
      });
      applied = applied || r.applied;
    }
    return { applied };
  })();
}

/** DELETE /storyboards/:id：删除镜头（旧表软删除；台词行仍留在剧本里）。 */
function deleteStoryboard(db, log, id) {
  const ep = episodeIdOf(db, id);
  if (ep == null) return false;
  db.transaction(() => {
    ensureGraph(db, ep);
    run(db, ep, 'deleteStoryboard', (c) => {
      const shotId = shotNodeOfLegacy(c.g, id);
      if (!shotId) throw new KernelError('NOT_FOUND', `storyboard ${id} is not in the project graph`);
      c.add(I.shot.deleteShot(c.g, shotId));
    });
  })();
  log.info('Storyboard deleted', { id });
  return true;
}

// ---------------------------------------------------------------- 镜头全局顺序

/** 在 children 里把镜头位置按 shots 重排：非镜头原位保留，镜头按顺序填进原来的镜头位置，多出的接在后面。 */
function rebuildChildren(g, children, shots) {
  const out = [];
  let k = 0;
  for (const id of children) {
    if (g.nodes[id].type !== 'shot') out.push(id);
    else if (k < shots.length) out.push(shots[k++]);
  }
  while (k < shots.length) out.push(shots[k++]);
  return out;
}

/**
 * 把全部镜头排成 target（镜头 id 的一个全排列）。组内重排 = setChildren；跨段落移动的镜头并入它新位置前一个镜头所在的段落
 * （最长不降子序列里的镜头保持原段落，其余的随邻居），所以结果总是合法图。
 */
function reorderShotsGlobal(c, target) {
  const g = c.g;
  const cur = kernel.shotOrder(g);
  if (cur.length === target.length && cur.every((s, i) => s === target[i])) return;
  const gIdx = Object.fromEntries(g.group_order.map((id, i) => [id, i]));
  const orig = target.map((s) => kernel.groupOf(g, s));
  const seq = orig.map((id) => gIdx[id]);
  // 最长不降子序列（O(n^2)，镜头数很小）
  const len = seq.map(() => 1);
  const prev = seq.map(() => -1);
  let best = 0;
  for (let i = 0; i < seq.length; i++) {
    for (let j = 0; j < i; j++) if (seq[j] <= seq[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    if (len[i] > len[best]) best = i;
  }
  const keep = new Set();
  for (let i = best; i >= 0 && seq.length; i = prev[i]) keep.add(i);
  const assigned = [];
  let lastGroup = null;
  for (let i = 0; i < target.length; i++) {
    if (keep.has(i)) lastGroup = orig[i];
    assigned[i] = keep.has(i) ? orig[i] : lastGroup;
  }
  const firstKept = orig[[...keep].sort((a, b) => a - b)[0]];
  for (let i = 0; i < target.length; i++) if (assigned[i] === null) assigned[i] = firstKept;
  const ops = [];
  for (const gid of g.group_order) {
    const shots = target.filter((s, i) => assigned[i] === gid);
    const now = shotsIn(g, gid);
    if (shots.length === now.length && shots.every((s, i) => s === now[i])) continue;
    ops.push({ op: 'setChildren', group: gid, ids: rebuildChildren(g, g.groups[gid].children, shots) });
  }
  c.raw(ops);
}

/** PUT /episodes/:id/storyboards/order：ids 为旧 storyboards.id 的全排列。 */
function reorderStoryboards(db, episodeId, ids) {
  const ep = Number(episodeId);
  const rows = db.prepare('SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').all(ep);
  const have = new Set(rows.map((r) => r.id));
  const want = (ids || []).map(Number);
  if (want.length !== have.size || new Set(want).size !== want.length || want.some((i) => !have.has(i))) {
    const e = new Error('ids 必须恰好包含该剧集的全部分镜');
    e.status = 400;
    throw e;
  }
  db.transaction(() => {
    ensureGraph(db, ep);
    run(db, ep, 'reorderStoryboards', (c) => {
      const target = want.map((id) => {
        const s = shotNodeOfLegacy(c.g, id);
        if (!s) throw new KernelError('NOT_FOUND', `storyboard ${id} is not in the project graph`);
        return s;
      });
      reorderShotsGlobal(c, target);
    });
  })();
}

// ---------------------------------------------------------------- 按对白拆镜

/**
 * split-by-audio 的图写入：第一个方案改写原镜头（行按方案重写，标题/时长/景别/运镜随之变，视频与配音采用版本解除），
 * 其余方案新建镜头插在它后面（克隆图里的参数，行按方案新建）。返回按顺序的旧 storyboards.id。
 */
function splitShotByPlans(db, row, plans) {
  const ep = row.episode_id;
  return db.transaction(() => {
    ensureGraph(db, ep);
    const r = run(db, ep, 'splitByAudio', (c) => {
      const base = shotNodeOfLegacy(c.g, row.id);
      if (!base) throw new KernelError('NOT_FOUND', `storyboard ${row.id} is not in the project graph`);
      const baseParams = structuredClone(c.g.nodes[base].params);
      const planPatch = (p) => {
        const patch = { title: p.title, duration_ms: durationMs(p.duration) };
        if (p.shot_type != null) patch.shot_type = p.shot_type;
        if (p.movement != null) patch.movement = p.movement;
        return patch;
      };
      c.add(I.shot.setShotField(c.g, base, planPatch(plans[0])));
      applyLineKind(c, base, 'dialogue', plans[0].dialogue || '');
      applyLineKind(c, base, 'narration', plans[0].narration || '');
      applyLineKind(c, base, 'action', plans[0].action || '');
      const parts = kernel.partsOfShot(c.g, base);
      c.raw([parts.video, parts.narration].filter(Boolean).map((node) => ({ op: 'adoptVersion', node, version_id: null })));
      const group = kernel.groupOf(c.g, base);
      let at = shotsIn(c.g, group).indexOf(base);
      const ids = [base];
      for (const p of plans.slice(1)) {
        const specs = [
          ...lineSpecs('action', p.action || ''), ...lineSpecs('narration', p.narration || ''), ...lineSpecs('dialogue', p.dialogue || ''),
        ];
        const params = { ...baseParams, ...planPatch(p), video_prompt: '' };
        ids.push(addShotWithLines(c, { group, index: ++at, params, specs }));
      }
      return ids;
    });
    return r.result.map((s) => r.graph.nodes[s].legacy_id);
  })();
}

// ---------------------------------------------------------------- 时间线接口

const clipPrefix = (ep) => `e${ep}_`;
const sortClips = (a, b) => a.start_ms - b.start_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 把“用户想要的时间线”(tl，F02 形状) 翻译成对图的修改，累积在 chain 里。
 * - 视频轨 = compose.segments：每个片段必须属于某个分镜（storyboard_id）；起点由顺序 + gap_before_ms 累加，
 *   所以任意不重叠的绝对起点都能表达（gap = 起点 - 上一片段终点）；同一镜头的片段必须相邻；
 *   片段顺序里镜头出现次序 = 镜头顺序（段落内重排、跨段落移动按 reorderShotsGlobal）；
 *   某镜头一个片段都不剩 = 删除该镜头（内核 deleteSegment 的语义）。
 * - 字幕轨由台词行推导：只接受文字与样式的修改（文字改行、样式写 subtitle_overrides），起止时间忽略（跟随视频）；
 *   删除/拆分/新增多条字幕、无对应分镜的字幕 -> 409。
 * - 配音轨由采用版本推导：与现状不一致 -> 409（时间忽略）。
 * - 音乐轨 = compose.music，整体替换（绝对起点，可重叠）。
 */
function translateTimeline(c, ep, tl) {
  const g0 = c.g;
  const cid = kernel.composeId(g0);
  if (!cid) throw unsupported('该剧集没有合成节点');
  const prefix = clipPrefix(ep);
  const by = Object.fromEntries(tl.tracks.map((t) => [t.kind, t.clips]));
  const shotOfSb = new Map(kernel.shotOrder(g0).map((s) => [g0.nodes[s].legacy_id, s]));
  const view0 = kernel.timelineView(g0);
  const viewTrack = (kind) => view0.tracks.find((t) => t.kind === kind).clips;
  const segs0 = g0.nodes[cid].params.segments || [];
  const segById = new Map(segs0.map((s) => [s.id, s]));
  const unprefix = (id, known) => (known.has(id) ? id : id.startsWith(prefix) && known.has(id.slice(prefix.length)) ? id.slice(prefix.length) : id);
  const curVideo = new Map(viewTrack('video').map((x) => [x.id, x]));

  // ---- 视频轨
  const target = [];
  const lastOut = new Map();
  const seenShots = new Set();
  let prevShot = null;
  let cursor = 0;
  for (const clip of [...by.video].sort(sortClips)) {
    const shotId = clip.storyboard_id != null ? shotOfSb.get(clip.storyboard_id) : undefined;
    if (!shotId) throw unsupported(`视频片段 ${clip.id} 没有对应的分镜：项目图里视频轨只能放分镜片段`);
    const sid = unprefix(clip.id, segById);
    const old = segById.get(sid);
    if (old) {
      if (old.shot_id !== shotId) throw unsupported(`视频片段 ${clip.id} 不能改属于另一个分镜`);
      const cur = curVideo.get(sid);
      if ((clip.asset_ref ?? null) !== (cur.asset_ref ?? null) || (clip.volume ?? 1) !== 1) throw unsupported(`视频片段 ${clip.id} 的素材/音量由生成结果决定，不能手改`);
    }
    const styleKeys = Object.keys(clip.style || {});
    if (styleKeys.some((k) => k !== 'transition')) throw unsupported(`视频片段 ${clip.id} 只支持 style.transition`);
    let inMs;
    let outMs;
    if (clip.src_in_ms != null) { inMs = clip.src_in_ms; outMs = clip.src_out_ms; }
    else { inMs = old ? old.in_ms : (lastOut.get(shotId) ?? 0); outMs = inMs + clip.duration_ms; }
    if (shotId !== prevShot) {
      if (seenShots.has(shotId)) throw orderUnsupported('同一分镜的多个视频片段必须相邻，不能被别的分镜的片段隔开');
      seenShots.add(shotId);
      prevShot = shotId;
    }
    const tr = clip.style && typeof clip.style.transition === 'string' && clip.style.transition ? clip.style.transition : null;
    target.push({ id: sid, shot_id: shotId, in_ms: inMs, out_ms: outMs, gap_before_ms: clip.start_ms - cursor, transition: tr });
    lastOut.set(shotId, outMs);
    cursor = clip.start_ms + clip.duration_ms;
  }
  for (const s of kernel.shotOrder(g0)) if (!seenShots.has(s)) c.add(I.shot.deleteShot(c.g, s));
  const wantOrder = [...seenShots];
  reorderShotsGlobal(c, wantOrder);
  const curSegs = kernel.shotOrder(c.g).flatMap((s) => kernel.segmentsOfShot(c.g, s));
  if (canonicalJSON(curSegs) !== canonicalJSON(target)) c.raw([{ op: 'setComposeSegments', node: cid, segments: target }]);

  // ---- 字幕轨
  const subByShot = new Map();
  for (const s of by.subtitle) {
    const shot = s.storyboard_id != null ? shotOfSb.get(s.storyboard_id) : undefined;
    if (!shot) throw unsupported(`字幕片段 ${s.id} 没有对应的分镜：字幕由分镜的台词行推导`);
    if (!c.g.nodes[shot]) continue; // 该镜头已在这次编辑里删除
    if (subByShot.has(shot)) throw unsupported('同一分镜只能有一条字幕（字幕由台词行推导，不能拆成多条）');
    subByShot.set(shot, s);
  }
  for (const shot of kernel.shotOrder(c.g)) {
    const inc = subByShot.get(shot);
    const curText = kernel.shotDialogue(c.g, shot).trim();
    if (!inc) {
      if (curText) throw unsupported('字幕由台词行推导，不能单独删除；请在剧本里删除对应台词');
      continue;
    }
    const text = String(inc.text ?? '').trim();
    if (text !== curText) {
      const spoken = kernel.spokenLines(c.g, shot);
      const texts = text.split('\n');
      if (!spoken.length) {
        const group = kernel.groupOf(c.g, shot);
        const S = shotsIn(c.g, group);
        const at = S.indexOf(shot);
        let slot = lineSlot(c.g, group, { own: kernel.linesOfShot(c.g, shot), prev: S[at - 1] || null, next: S[at + 1] || null });
        for (const t of texts) c.add(I.script.insertLine(c.g, { group, index: slot++, kind: 'narration', text: t, shot_ids: [shot] }));
      } else if (spoken.length === texts.length) {
        spoken.forEach((id, i) => c.add(I.script.rewriteLine(c.g, id, { text: texts[i] })));
      } else {
        throw unsupported(`字幕有 ${texts.length} 行，台词行有 ${spoken.length} 行，无法一一对应`);
      }
    }
    const first = kernel.spokenLines(c.g, shot)[0];
    if (first) {
      const overrides = c.g.nodes[cid].params.subtitle_overrides || {};
      const curStyle = overrides[first] ?? null;
      const incStyle = inc.style ?? null;
      if (canonicalJSON(curStyle) !== canonicalJSON(incStyle)) {
        c.raw([incStyle === null
          ? { op: 'setParam', node: cid, path: ['subtitle_overrides', first], unset: true }
          : { op: 'setParam', node: cid, path: ['subtitle_overrides', first], value: incStyle }]);
      }
    }
  }

  // ---- 配音轨（只读校验）
  const curNar = new Map(viewTrack('narration').map((x) => [x.storyboard_id, x]));
  const seenNar = new Set();
  for (const n of by.narration) {
    const shot = n.storyboard_id != null ? shotOfSb.get(n.storyboard_id) : undefined;
    if (shot && !c.g.nodes[shot]) continue;
    const cur = curNar.get(n.storyboard_id);
    if (!shot || !cur || (n.asset_ref ?? null) !== cur.asset_ref || (n.volume ?? 1) !== 1) throw unsupported(`配音片段 ${n.id} 的素材由生成结果决定，不能手改`);
    seenNar.add(n.storyboard_id);
  }
  for (const [sb, cur] of curNar) {
    const shot = shotOfSb.get(sb);
    if (shot && c.g.nodes[shot] && !seenNar.has(sb)) throw unsupported(`配音片段 ${cur.id} 由生成结果决定，不能单独删除`);
  }

  // ---- 音乐轨
  const curMusic = c.g.nodes[cid].params.music || [];
  const knownMusic = new Set(curMusic.map((m) => m.id));
  const norm = (m) => ({
    id: m.id, asset_ref: m.asset_ref, start_ms: m.start_ms, duration_ms: m.duration_ms, src_in_ms: m.src_in_ms ?? 0, volume: m.volume ?? 1,
  });
  const wantMusic = [...by.music].sort(sortClips).map((m) => norm({ ...m, id: unprefix(m.id, knownMusic) }));
  const sortM = (a, b) => a.start_ms - b.start_ms || (a.id < b.id ? -1 : 1);
  if (canonicalJSON([...curMusic].map(norm).sort(sortM)) !== canonicalJSON([...wantMusic].sort(sortM))) {
    c.raw([{ op: 'setParam', node: cid, path: ['music'], value: wantMusic }]);
  }
}

function timelineRow(db, timelineId) {
  const row = db.prepare('SELECT * FROM timelines WHERE id = ?').get(Number(timelineId));
  if (!row) throw new timeline.TimelineError('timeline not found', 404, 'NOT_FOUND');
  return row;
}

/** 轨道音量/静音与混音设置不在图里（图只管内容），照旧直接写时间线表；返回是否有改动。 */
function writeTrackSettings(db, timelineId, tl, mixIn) {
  let changed = false;
  const cur = new Map(db.prepare('SELECT kind, volume, muted FROM timeline_tracks WHERE timeline_id = ?').all(Number(timelineId)).map((t) => [t.kind, t]));
  for (const t of tl.tracks) {
    const o = cur.get(t.kind);
    if (!o || (o.volume === t.volume && !!o.muted === !!t.muted)) continue;
    db.prepare('UPDATE timeline_tracks SET volume = ?, muted = ? WHERE timeline_id = ? AND kind = ?').run(t.volume, t.muted ? 1 : 0, Number(timelineId), t.kind);
    changed = true;
  }
  if (mixIn !== undefined) {
    const row = timelineRow(db, timelineId);
    let settings = {};
    try { settings = JSON.parse(row.settings) || {}; } catch (_) { settings = {}; }
    if (canonicalJSON(settings.mix) !== canonicalJSON(mixIn)) {
      db.prepare('UPDATE timelines SET settings = ? WHERE id = ?').run(JSON.stringify({ ...settings, mix: mixIn }), Number(timelineId));
      changed = true;
    }
  }
  return changed;
}

/** 旧接口每次保存都 version+1；图的物化只在内容变了才写，这里补上。 */
function bumpIfUnchanged(db, timelineId, versionBefore) {
  const row = timelineRow(db, timelineId);
  if (row.version === versionBefore) {
    db.prepare('UPDATE timelines SET version = version + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), Number(timelineId));
  }
}

/**
 * 把一份完整的时间线写进图（PUT /timelines/:id、各种片段编辑都走这里）。
 * 先按旧规则校验（400/409 OVERLAP），再翻译成事务提交；任何一步失败，图与旧表都不变。
 */
function saveTimelineViaGraph(db, timelineId, input) {
  return db.transaction(() => {
    const cur = timelineRow(db, timelineId);
    const ep = cur.episode_id;
    const tl = timeline.normalizeTimeline({ ...input, episode_id: ep });
    timeline.validateTimeline(tl);
    const mixIn = input.mix === undefined ? undefined : timeline.normalizeMix(input.mix);
    if (input.episode_id != null && Number(input.episode_id) !== ep) throw new timeline.TimelineError('episode_id mismatch');
    if (input.version != null && input.version !== cur.version) {
      throw new timeline.TimelineError(`stale version (have ${cur.version}, got ${input.version})`, 409, 'CONFLICT');
    }
    ensureGraph(db, ep);
    run(db, ep, 'editTimeline', (c) => translateTimeline(c, ep, tl));
    writeTrackSettings(db, timelineId, tl, mixIn);
    bumpIfUnchanged(db, timelineId, cur.version);
    return timeline.loadTimeline(db, timelineId);
  })();
}

/** 在内存里对已存时间线做一次变换（timeline.transforms.*），再整体写进图。返回与旧 mutate 相同的形状。 */
function editTimeline(db, timelineId, fn) {
  return db.transaction(() => {
    const tl = timeline.loadTimeline(db, timelineId);
    if (!tl) throw new timeline.TimelineError('timeline not found', 404, 'NOT_FOUND');
    const extra = fn(tl);
    const saved = saveTimelineViaGraph(db, timelineId, { ...tl, version: undefined });
    return extra ? { timeline: saved, ...extra } : saved;
  })();
}

/**
 * POST /timelines/episode/:id/assemble：按当前图重新装配时间线。
 * 先把旧表里新生成的素材补成采用版本，再把每个镜头的片段重置为整段（gap 0、无转场），清空音乐与字幕样式覆盖；
 * 没有 replace 且已有时间线 -> 409。字幕轨由台词行推导，所以旁白行也会出字幕（见 §10.6）。
 */
function assembleTimeline(db, episodeId, opts = {}) {
  const ep = Number(episodeId);
  return db.transaction(() => {
    const rows = db.prepare('SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id').all(ep);
    if (!rows.length) throw new timeline.TimelineError('episode has no storyboards', 400, 'NO_STORYBOARDS');
    const existing = timeline.getTimelineIdByEpisode(db, ep);
    if (existing != null && !opts.replace) throw new timeline.TimelineError('timeline already exists for episode', 409, 'CONFLICT');
    const versionBefore = existing != null ? timelineRow(db, existing).version : null;
    ensureGraph(db, ep);
    const byLegacy = new Map(rows.map((r) => [r.id, r]));
    run(db, ep, 'assemble', (c) => {
      const cid = kernel.composeId(c.g);
      if (!cid) throw unsupported('该剧集没有合成节点');
      // 素材同步
      const keys = kernel.cacheKeys(c.g);
      const ops = [];
      for (const shotId of kernel.shotOrder(c.g)) {
        const row = byLegacy.get(c.g.nodes[shotId].legacy_id);
        if (!row) continue;
        const parts = kernel.partsOfShot(c.g, shotId);
        for (const [part, ref, kind] of [
          ['video', row.video_url, 'video'], ['image', row.local_path || row.image_url, 'image'],
          ['narration', row.narration_audio_local_path || row.audio_local_path, 'audio'],
        ]) {
          const node = parts[part];
          if (!node || !ref) continue;
          const adopted = kernel.adoptedVersion(c.g, node);
          if (adopted && adopted.asset && adopted.asset.ref === ref) continue;
          const vid = `legacy_${(c.g.versions[node] || []).length + 1}`;
          ops.push({ op: 'addVersion', node, version: { id: vid, cache_key: keys[node], asset: { ref, kind, hash: kernel.sha256(`ref:${ref}`) }, source: 'legacy-sync' } });
          ops.push({ op: 'adoptVersion', node, version_id: vid });
        }
      }
      c.raw(ops);
      // 片段重置
      let n = 0;
      const segments = kernel.shotOrder(c.g).map((s) => ({
        id: `seg_${++n}`, shot_id: s, in_ms: 0, out_ms: c.g.nodes[s].params.duration_ms ?? kernel.DEFAULT_SHOT_MS, gap_before_ms: 0, transition: null,
      }));
      c.raw([
        { op: 'setComposeSegments', node: cid, segments },
        { op: 'setParam', node: cid, path: ['music'], value: [] },
        { op: 'setParam', node: cid, path: ['subtitle_overrides'], value: {} },
      ]);
    });
    const id = timeline.getTimelineIdByEpisode(db, ep);
    if (existing != null) bumpIfUnchanged(db, id, versionBefore);
    return { timeline: timeline.loadTimeline(db, id), created: existing == null };
  })();
}

// ---------------------------------------------------------------- 整集替换分镜

/**
 * 整集替换分镜（POST /episodes/:id/storyboards 重新生成用，docs/kernel-design.md §12.5）：
 * 一次内核事务里加入新段落 + 新镜头（带各自的台词 / 旁白 / 动作行），再删除全部旧镜头、只属于旧镜头的行、清空后的旧段落。
 * 先加后删：新节点的 id 一定不与旧节点相撞（旧镜头在 graph_legacy_map 里的映射不会被新镜头误用）。
 * 事务由 store.commit 在同一个 SQLite 事务里物化到旧表；撤销 = 旧镜头（连同首帧 / 视频版本与采用关系）原样回来，重做 = 新分镜回来。
 * 不重置图、不清日志：日志里只多一条 apply，seq 单调增加。
 *
 * items: [{ segment_index, segment_title, body }]，body 与 POST /storyboards 的请求体同形（title / description / duration（秒）/ characters /
 * dialogue / narration / action ...）；连续且 (segment_index, segment_title) 相同的条目归入同一个新段落。
 * opts.txId（别名 tx_id）：幂等键，重放为空操作。
 * 返回 { applied, tx_id, seq, can_undo, can_redo, legacy_ids（按新镜头顺序的 storyboards.id）, removed_ids（被替换的旧 storyboards.id） }。
 */
function replaceEpisodeShots(db, episodeId, items, opts = {}) {
  if (!Array.isArray(items) || !items.length) throw new KernelError('INTENT', 'replaceEpisodeShots needs at least one new shot');
  const ep = Number(episodeId);
  const txId = opts.txId || opts.tx_id || undefined;
  return db.transaction(() => {
    ensureGraph(db, ep);
    const r = run(db, ep, 'regenerateStoryboards', (c) => {
      const oldShots = kernel.shotOrder(c.g);
      const oldGroups = [...c.g.group_order];
      const oldLines = new Set(oldShots.flatMap((s) => kernel.linesOfShot(c.g, s)));
      const removed = oldShots.map((s) => c.g.nodes[s].legacy_id).filter((x) => x != null);
      const added = [];
      let lastKey = null;
      let group = null;
      for (const it of items) {
        const b = it.body || {};
        const title = it.segment_title == null ? '' : String(it.segment_title);
        const key = `${Number(it.segment_index) || 0}|${title}`;
        if (key !== lastKey) {
          let n = 1;
          while (c.g.groups[`grp_${n}`]) n++;
          group = `grp_${n}`;
          c.raw([{ op: 'addGroup', group: { id: group, title, children: [] } }]);
          lastKey = key;
        }
        const params = effectivePatch({ params: {} }, paramsFromBody(b));
        const specs = LINE_COLUMNS.flatMap((k) => (b[k] !== undefined ? lineSpecs(k, b[k]) : []));
        added.push(addShotWithLines(c, { group, params, specs }));
      }
      for (const s of oldShots) c.add(I.shot.deleteShot(c.g, s));
      for (const l of oldLines) if (c.g.nodes[l] && !kernel.shotsOfLine(c.g, l).length) c.add(I.script.deleteLine(c.g, l));
      for (const gid of oldGroups) if (c.g.groups[gid] && !c.g.groups[gid].children.length) c.raw([{ op: 'removeGroup', id: gid }]);
      return { added, removed };
    }, { tx_id: txId });
    if (!r.result) return { applied: false, tx_id: txId, seq: r.seq, can_undo: !!r.canUndo, can_redo: !!r.canRedo, legacy_ids: [], removed_ids: [] };
    return {
      applied: r.applied, tx_id: r.tx_id, seq: r.seq, can_undo: r.canUndo, can_redo: r.canRedo,
      legacy_ids: r.result.added.map((id) => r.graph.nodes[id].legacy_id),
      removed_ids: r.result.removed,
    };
  })();
}

module.exports = {
  handleError, ensureGraph, resetGraph, run, Chain, replaceEpisodeShots,
  createStoryboard, insertBeforeStoryboard, updateStoryboard, deleteStoryboard, setShotFields, reorderStoryboards, reorderShotsGlobal,
  splitShotByPlans, saveTimelineViaGraph, editTimeline, assembleTimeline, translateTimeline,
};
