'use strict';
/**
 * P3-C 角色一致性：生成结果（首帧图 / 视频）对镜头里每张锁定参考图（场景、角色）的评分。
 *
 *   评分     由 lycore 的 consistency.score 完成（ffmpeg 抽帧后算感知哈希、色彩直方图、主色调，不依赖模型，
 *            认不出“是不是同一张脸”）；scorer 可注入，默认经 JSON-RPC 调 lycore，没有内核时静默不评分。
 *   触发     生成服务每写回一个新版本就调 onAdopted（见 generation/service.js），对该版本与镜头的每张锁定参考图各评一次，
 *            结果存 consistency_scores（版本 × 参考实体 唯一，重评覆盖）。
 *   阈值     configs/config.yaml consistency.min_score（默认 60）：score ≥ 阈值 ok；低 20 分以上 retry；其间 check。
 *   报告     episodeReport：每镜头最好 / 最差分、最差对应的实体、建议，以及按建议重做的估价（经生成服务的估算，只算不建任务）。
 *   自动挑参考图  autoPickCharacter：角色的主图 / 额外图 / 已完成的生成图作候选，四视图作锚图，
 *            由 consistency.pick_reference 按清晰度、分辨率、与锚图相似度排序；lock=true 时锁定第一名并同步进内核。
 *
 * 只有本机存储目录里的文件能评分（远程 URL 不下载），跳过的会在结果里标明原因。
 */
const fs = require('fs');
const path = require('path');
const kernel = require('@talekiln/kernel');
const store = require('../kernel/store');
const kernelInputs = require('../kernel/inputs');
const referenceLocks = require('../services/referenceLockService');

const DEFAULTS = Object.freeze({ enabled: true, min_score: 60, sample_frames: 5 });
const RETRY_MARGIN = 20;
const SEVERITY = { ok: 0, check: 1, retry: 2 };
const CORE_RETRY_MS = 30000;

class ConsistencyError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'ConsistencyError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** 配置段 -> 生效设置（非法值回退默认）。 */
function settingsFrom(config) {
  const c = (config && config.consistency) || {};
  const min = Number(c.min_score);
  const frames = Number(c.sample_frames);
  return {
    enabled: c.enabled !== false,
    min_score: Number.isFinite(min) && min >= 0 && min <= 100 ? min : DEFAULTS.min_score,
    sample_frames: Number.isInteger(frames) && frames >= 1 && frames <= 30 ? frames : DEFAULTS.sample_frames,
  };
}

/** 与 lycore 相同的规则（存行时内核没给建议、或阈值变化后重算时用）。 */
function suggestionFor(score, minScore) {
  if (score >= minScore) return 'ok';
  if (score < minScore - RETRY_MARGIN) return 'retry';
  return 'check';
}

const worstSuggestion = (list) => list.reduce((w, s) => (SEVERITY[s] > SEVERITY[w] ? s : w), 'ok');

/** 存储目录相对路径（或 /static/<rel>）-> 存储目录里的相对路径；远程 / data URL 返回 null。 */
function relOf(ref) {
  if (typeof ref !== 'string' || !ref.trim() || /^(https?:|data:|oss:)/i.test(ref)) return null;
  const rel = ref.startsWith('/static/') ? ref.slice('/static/'.length) : ref.replace(/^\/+/, '');
  return rel || null;
}

/** 本机存储目录里存在的文件 -> 绝对路径；远程、目录外、不存在 -> null。 */
function resolveLocal(storageRoot, ref) {
  const rel = relOf(ref);
  if (!rel || !storageRoot) return null;
  const root = path.resolve(storageRoot);
  const abs = path.resolve(root, rel);
  const within = path.relative(root, abs);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) return null;
  try { return fs.statSync(abs).isFile() ? abs : null; } catch (_) { return null; }
}

/** 镜头（旧表 id）的锁定参考实体：场景在前、角色按镜头顺序。 */
function lockedEntitiesForStoryboard(db, storyboardId) {
  if (storyboardId == null) return [];
  const sb = db.prepare('SELECT scene_id, characters FROM storyboards WHERE id = ?').get(Number(storyboardId));
  if (!sb) return [];
  const out = [];
  const push = (type, id) => {
    const lock = referenceLocks.getLock(db, type, id);
    const ref = referenceLocks.lockToRefUrl(lock);
    if (lock && ref) out.push({ entity_type: type, entity_id: Number(id), ref });
  };
  if (sb.scene_id) push('scene', sb.scene_id);
  for (const cid of referenceLocks.parseCharacterIds(sb.characters)) push('character', cid);
  return out;
}

function shotOfNode(g, nodeId) {
  for (const s of kernel.shotOrder(g)) {
    const p = kernel.partsOfShot(g, s);
    if (p.image === nodeId || p.video === nodeId) return s;
  }
  return null;
}

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };

/**
 * 默认评分器：经 lycore 客户端调 consistency.*。连不上内核时 30 秒内不再重试（避免每个任务都等一次连接超时）。
 */
function createCoreScorer(getCore, { retryAfterMs = CORE_RETRY_MS, now = Date.now } = {}) {
  let failedAt = 0;
  async function core() {
    if (!getCore) return null;
    if (failedAt && now() - failedAt < retryAfterMs) return null;
    try {
      const c = await getCore();
      failedAt = c ? 0 : now();
      return c || null;
    } catch (_) {
      failedAt = now();
      return null;
    }
  }
  const unavailable = () => new ConsistencyError('CONSISTENCY_UNAVAILABLE', '一致性评分不可用：渲染核心未启动或连不上', 503);
  const call = async (method, params) => {
    const c = await core();
    if (!c) throw unavailable();
    try {
      return await c.call(method, params);
    } catch (e) {
      // 内核的数字错误码（如 -32020 缺 ffmpeg）原样带回：错误码表里有对应文案
      if (e && typeof e.code === 'number') throw new ConsistencyError(String(e.code), e.message, 502, e.data);
      throw e;
    }
  };
  return {
    available: async () => !!(await core()),
    score: (params) => call('consistency.score', params),
    pickReference: (params) => call('consistency.pick_reference', params),
  };
}

/**
 * @param {object} o
 * @param {object} o.db
 * @param {string} o.storageRoot
 * @param {object} [o.config]       完整配置（读 consistency 段）
 * @param {object} [o.scorer]       { available(), score(params), pickReference(params) }；缺省用 getCore 建
 * @param {Function} [o.getCore]
 * @param {Function} [o.generation] () => 生成服务（估算重做费用用；惰性取，因为生成服务在本服务之后创建）
 */
function createConsistencyService({ db, storageRoot, config = null, scorer = null, getCore = null, generation = null, log = console }) {
  if (!db) throw new Error('db is required');
  const settings = settingsFrom(config);
  const engine = scorer || createCoreScorer(getCore);
  const warn = (msg, extra) => { try { (log.warn || log.error || (() => {})).call(log, msg, extra); } catch (_) { /* ignore */ } };
  const gen = () => (typeof generation === 'function' ? generation() : generation);

  const upsert = db.prepare(`INSERT INTO consistency_scores (episode_id, node_id, version_id, entity_type, entity_id, score, parts, suggestion, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(episode_id, node_id, version_id, entity_type, entity_id) DO UPDATE SET
      score = excluded.score, parts = excluded.parts, suggestion = excluded.suggestion, created_at = excluded.created_at`);

  function entityNames(rows) {
    const ids = (type) => [...new Set(rows.filter((r) => r.entity_type === type).map((r) => Number(r.entity_id)))];
    const names = {};
    const q = (type, sql, fmt) => {
      const list = ids(type);
      if (!list.length) return;
      for (const r of db.prepare(`${sql} (${list.map(() => '?').join(',')})`).all(...list)) names[`${type}:${r.id}`] = fmt(r);
    };
    q('character', 'SELECT id, name FROM characters WHERE id IN', (r) => r.name || `角色 ${r.id}`);
    q('scene', 'SELECT id, location, time FROM scenes WHERE id IN', (r) => [r.location, r.time].filter(Boolean).join(' · ') || `场景 ${r.id}`);
    return (type, id) => names[`${type}:${id}`] || (type === 'scene' ? `场景 ${id}` : `角色 ${id}`);
  }

  const rowView = (r, nameOf) => ({
    entity_type: r.entity_type, entity_id: Number(r.entity_id), entity_name: nameOf(r.entity_type, r.entity_id),
    score: r.score, parts: parseJson(r.parts), suggestion: r.suggestion, created_at: r.created_at,
  });

  /**
   * 给一个版本评分：对镜头的每张锁定参考图各评一次并存行。
   * 返回 { scored, rows, reason? }；没有锁定参考图 / 目标不在本机 / 没有评分器时 scored=0 并给出 reason。
   */
  async function scoreVersion({ episode_id, node, version_id, shot_id = null }) {
    const ep = Number(episode_id);
    if (!store.hasProject(db, ep)) return { scored: 0, rows: [], reason: 'no_graph' };
    const { graph: g } = store.openProject(db, ep);
    const n = g.nodes[node];
    if (!n || !['image', 'video'].includes(n.type)) return { scored: 0, rows: [], reason: 'no_node' };
    const version = (g.versions[node] || []).find((v) => v.id === version_id);
    if (!version) return { scored: 0, rows: [], reason: 'no_version' };
    const shotId = shot_id && g.nodes[shot_id] ? shot_id : shotOfNode(g, node);
    const legacyId = shotId != null ? g.nodes[shotId].legacy_id ?? null : null;
    const refs = lockedEntitiesForStoryboard(db, legacyId);
    if (!refs.length) return { scored: 0, rows: [], reason: 'no_locked_references' };
    const target = resolveLocal(storageRoot, version.asset && version.asset.ref);
    if (!target) return { scored: 0, rows: [], reason: 'target_not_local' };
    if (!(await engine.available())) return { scored: 0, rows: [], reason: 'scorer_unavailable' };
    const rows = [];
    for (const r of refs) {
      const reference = resolveLocal(storageRoot, r.ref);
      if (!reference) { rows.push({ entity_type: r.entity_type, entity_id: r.entity_id, skipped: 'reference_not_local' }); continue; }
      const res = await engine.score({ reference, target, sample_frames: settings.sample_frames, min_score: settings.min_score });
      const score = Number(res && res.score);
      if (!Number.isFinite(score)) throw new ConsistencyError('CONSISTENCY_FAILED', '评分结果无效', 502);
      const suggestion = ['ok', 'check', 'retry'].includes(res.suggestion) ? res.suggestion : suggestionFor(score, settings.min_score);
      const row = { episode_id: ep, node_id: node, version_id, entity_type: r.entity_type, entity_id: r.entity_id, score, parts: res.parts || null, suggestion, created_at: new Date().toISOString() };
      upsert.run(ep, node, version_id, r.entity_type, r.entity_id, score, row.parts ? JSON.stringify(row.parts) : null, suggestion, row.created_at);
      rows.push(row);
    }
    return { scored: rows.filter((x) => !x.skipped).length, rows };
  }

  /** 生成服务的 onAdopted 钩子：评分失败只记日志。 */
  async function onAdopted(info) {
    if (!settings.enabled || !info) return null;
    try {
      const r = await scoreVersion(info);
      if (r.reason && r.reason !== 'no_locked_references') (log.info || (() => {})).call(log, 'consistency skipped', { task: info.task && info.task.id, reason: r.reason });
      return r;
    } catch (e) {
      warn('consistency score', { error: e && e.message, code: e && e.code, task: info.task && info.task.id });
      return null;
    }
  }

  function nodeReport(g, nodeId, rows, nameOf) {
    const v = nodeId && kernel.adoptedVersion(g, nodeId);
    if (!v) return null;
    const mine = rows.filter((r) => r.node_id === nodeId && r.version_id === v.id).map((r) => rowView(r, nameOf));
    if (!mine.length) return { version_id: v.id, scored: false, best: null, worst: null, suggestion: null, entity: null, scores: [] };
    const worst = mine.reduce((a, b) => (b.score < a.score ? b : a));
    const best = mine.reduce((a, b) => (b.score > a.score ? b : a));
    return {
      version_id: v.id, scored: true, best: best.score, worst: worst.score, suggestion: worstSuggestion(mine.map((x) => x.suggestion)),
      entity: { type: worst.entity_type, id: worst.entity_id, name: worst.entity_name }, scores: mine,
    };
  }

  /** 按建议重做的估价：首帧图最差 -> 图 + 视频一起重做；只有视频差 -> 只重做视频。只估算，不建任务。 */
  function regenerateEstimate(ep, shotId, image, video) {
    const service = gen();
    if (!service || typeof service.estimate !== 'function') return null;
    const bad = (x) => x && x.scored && x.suggestion !== 'ok';
    const kind = bad(image) ? 'both' : bad(video) ? 'video' : null;
    if (!kind) return null;
    try {
      const { check } = service.estimate(ep, { shots: [shotId], kind, regenerate: true });
      return { kind, estimate: check.total, max: check.max, currency: check.currency, known: check.known, allowed: check.ok };
    } catch (e) {
      warn('consistency estimate', { error: e && e.message, shot: shotId });
      return null;
    }
  }

  function shotReport(g, shotId, index, rows, nameOf, ep) {
    const parts = kernel.partsOfShot(g, shotId);
    const image = nodeReport(g, parts.image, rows, nameOf);
    const video = nodeReport(g, parts.video, rows, nameOf);
    const scored = [image, video].filter((x) => x && x.scored);
    const worstNode = scored.length ? scored.reduce((a, b) => (b.worst < a.worst ? b : a)) : null;
    return {
      shot_id: shotId, storyboard_id: g.nodes[shotId].legacy_id ?? null, number: index + 1, image, video,
      scored: scored.length > 0,
      best: scored.length ? Math.max(...scored.map((x) => x.best)) : null,
      worst: worstNode ? worstNode.worst : null,
      suggestion: scored.length ? worstSuggestion(scored.map((x) => x.suggestion)) : null,
      entity: worstNode ? worstNode.entity : null,
      regenerate: regenerateEstimate(ep, shotId, image, video),
    };
  }

  /** 一集的报告：每镜头的分数、建议与重做估价。 */
  async function episodeReport(episodeId) {
    const ep = Number(episodeId);
    if (!Number.isInteger(ep) || ep <= 0) throw new ConsistencyError('BAD_REQUEST', 'episode id must be a positive integer');
    if (!db.prepare('SELECT id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(ep)) throw new ConsistencyError('NOT_FOUND', `分集 ${ep} 不存在`, 404);
    const base = { episode_id: ep, enabled: settings.enabled, available: await engine.available(), min_score: settings.min_score, shots: [], counts: { ok: 0, check: 0, retry: 0, unscored: 0 } };
    if (!store.hasProject(db, ep)) return base;
    const { graph: g } = store.openProject(db, ep);
    const rows = db.prepare('SELECT * FROM consistency_scores WHERE episode_id = ? ORDER BY id').all(ep);
    const nameOf = entityNames(rows);
    base.shots = kernel.shotOrder(g).map((id, i) => shotReport(g, id, i, rows, nameOf, ep));
    for (const s of base.shots) base.counts[s.suggestion || 'unscored'] += 1;
    return base;
  }

  /** 定位镜头：数字 = 旧表 storyboard id；字符串 = 镜头节点 id（需给 episode_id）。 */
  function locateShot({ id, episode_id }) {
    let ep = Number(episode_id) || null;
    let legacyId = null;
    if (/^\d+$/.test(String(id))) {
      const row = db.prepare('SELECT id, episode_id FROM storyboards WHERE id = ?').get(Number(id));
      if (!row) throw new ConsistencyError('NOT_FOUND', `镜头 ${id} 不存在`, 404);
      legacyId = row.id;
      ep = ep || Number(row.episode_id);
    }
    if (!ep) throw new ConsistencyError('BAD_REQUEST', '按节点 id 重评需要 episode_id');
    if (!store.hasProject(db, ep)) throw new ConsistencyError('GRAPH_NOT_FOUND', `分集 ${ep} 还没有项目图`, 404);
    const { graph: g } = store.openProject(db, ep);
    const order = kernel.shotOrder(g);
    const shotId = legacyId != null ? order.find((s) => g.nodes[s].legacy_id === legacyId) : (g.nodes[id] && g.nodes[id].type === 'shot' ? id : null);
    if (!shotId) throw new ConsistencyError('NOT_FOUND', `镜头 ${id} 不存在`, 404);
    return { ep, g, shotId, index: order.indexOf(shotId) };
  }

  /** 重评一个镜头当前采用的首帧图与视频版本（覆盖旧行），返回该镜头的报告项。 */
  async function rescoreShot(args) {
    const { ep, g, shotId, index } = locateShot(args);
    if (!(await engine.available())) throw new ConsistencyError('CONSISTENCY_UNAVAILABLE', '一致性评分不可用：渲染核心未启动或连不上', 503);
    const parts = kernel.partsOfShot(g, shotId);
    const results = {};
    for (const kind of ['image', 'video']) {
      const v = parts[kind] && kernel.adoptedVersion(g, parts[kind]);
      results[kind] = v ? await scoreVersion({ episode_id: ep, node: parts[kind], version_id: v.id, shot_id: shotId }) : { scored: 0, rows: [], reason: 'no_version' };
    }
    const rows = db.prepare('SELECT * FROM consistency_scores WHERE episode_id = ? ORDER BY id').all(ep);
    const nameOf = entityNames(rows);
    return { ...shotReport(g, shotId, index, rows, nameOf, ep), rescored: { image: results.image.scored, video: results.video.scored }, reasons: { image: results.image.reason || null, video: results.video.reason || null } };
  }

  /** 角色的候选参考图（本机文件）：主图、额外图（extra_images）、已完成的生成图；锚图 = 四视图。 */
  function characterCandidates(ch) {
    const seen = new Map();
    const add = (ref, image_url, source_image_id, source) => {
      if (typeof ref !== 'string' || !ref.trim()) return;
      const rel = relOf(ref);
      const abs = rel ? resolveLocal(storageRoot, ref) : null;
      if (!abs) {
        // 远程 URL（不下载）或本机缺失的文件：都列进 skipped 说明原因
        if (!seen.has(`!${ref}`)) seen.set(`!${ref}`, { local_path: rel, image_url: image_url || (rel ? null : ref), source_image_id, source, skipped: rel ? 'not_local' : 'remote' });
        return;
      }
      if (!seen.has(abs)) seen.set(abs, { abs, local_path: rel, image_url: image_url || null, source_image_id, source });
    };
    add(ch.local_path, ch.image_url, null, 'main');
    if (!ch.local_path && ch.image_url) add(ch.image_url, ch.image_url, null, 'main');
    const extras = parseJson(ch.extra_images);
    for (const x of Array.isArray(extras) ? extras : []) add(typeof x === 'string' ? x : x && x.local_path, null, null, 'extra');
    const gens = db.prepare("SELECT id, local_path, image_url FROM image_generations WHERE character_id = ? AND status = 'completed' AND deleted_at IS NULL ORDER BY created_at DESC").all(ch.id);
    for (const r of gens) add(r.local_path || r.image_url, r.image_url, r.id, 'generated');
    const anchorAbs = resolveLocal(storageRoot, ch.four_view_image_url);
    const all = [...seen.values()];
    return {
      anchor: anchorAbs ? { abs: anchorAbs, local_path: relOf(ch.four_view_image_url) } : null,
      candidates: all.filter((c) => c.abs && c.abs !== anchorAbs),
      skipped: all.filter((c) => !c.abs).map(({ local_path, image_url, source, skipped }) => ({ local_path, image_url, source, reason: skipped })),
    };
  }

  /** 自动挑选角色参考图；lock=true 时锁定第一名并同步进内核（与 PUT /reference-locks 相同）。 */
  async function autoPickCharacter(characterId, { lock = false } = {}) {
    const ch = db.prepare('SELECT id, drama_id, name, image_url, local_path, extra_images, four_view_image_url FROM characters WHERE id = ? AND deleted_at IS NULL').get(Number(characterId));
    if (!ch) throw new ConsistencyError('NOT_FOUND', '角色不存在', 404);
    const { anchor, candidates, skipped } = characterCandidates(ch);
    if (!candidates.length) throw new ConsistencyError('NO_REFERENCE_CANDIDATES', '该角色没有可用的本机候选图：先生成或上传角色图片', 400, { skipped });
    const res = await engine.pickReference({ candidates: candidates.map((c) => c.abs), ...(anchor ? { anchor: anchor.abs } : {}) });
    const byAbs = new Map(candidates.map((c) => [c.abs, c]));
    const ranked = (res && Array.isArray(res.ranked) ? res.ranked : []).map((r) => {
      const c = byAbs.get(r.path) || {};
      return {
        local_path: c.local_path || null, image_url: c.image_url || null, source_image_id: c.source_image_id ?? null, source: c.source || null,
        score: r.score, sharpness: r.sharpness, width: r.width, height: r.height, similarity: r.similarity ?? null,
      };
    });
    const coreSkipped = (res && Array.isArray(res.skipped) ? res.skipped : []).map((s) => ({ local_path: (byAbs.get(s.path) || {}).local_path || null, source: (byAbs.get(s.path) || {}).source || null, reason: s.error || 'unreadable' }));
    let saved = null;
    let synced = null;
    if (lock && ranked.length) {
      const top = ranked[0];
      saved = referenceLocks.setLock(db, 'character', ch.id, { image_url: top.image_url, local_path: top.local_path, source_image_id: top.source_image_id });
      try { synced = kernelInputs.syncReferences(db); } catch (e) { warn('auto-pick sync', { error: e && e.message }); }
    }
    return {
      character_id: ch.id, name: ch.name, anchor: anchor ? { local_path: anchor.local_path } : null,
      ranked, skipped: [...skipped, ...coreSkipped], picked: ranked[0] || null, locked: !!saved, lock: saved, synced,
    };
  }

  return { settings, scorer: engine, scoreVersion, onAdopted, episodeReport, rescoreShot, autoPickCharacter, resolveLocal: (ref) => resolveLocal(storageRoot, ref) };
}

module.exports = {
  createConsistencyService, createCoreScorer, ConsistencyError, settingsFrom, suggestionFor, resolveLocal, relOf, lockedEntitiesForStoryboard, shotOfNode, DEFAULTS, RETRY_MARGIN,
};
