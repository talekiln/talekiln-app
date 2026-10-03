'use strict';
/**
 * 生成编排（I1）：把“给这些镜头出图 / 出视频”变成持久队列任务，并在任务成功时把结果写回数据内核。
 *
 *   plan      读内核图，按每个镜头的 image / video 节点的 cacheKey 决定：已新鲜（跳过）、缓存命中（改采用旧版本）、
 *             需要生成。先估算，不建任何任务。
 *   create    估算 + 额度检查（整批按一次运行算）通过后才建任务；幂等键由节点 cacheKey 派生，
 *             所以对没改过的镜头再点一次不花钱。
 *   finish    onTaskFinished：成功 -> 一次 commit 里 addVersion + adoptVersion（带任务建立时的 cacheKey），
 *             物化到旧表；失败 -> 图不动，旧版本保留，只有队列里的任务状态变化。
 *   status    每镜头 none / queued / running / stale / fresh / failed。
 *
 * 锁定的参考图、尾帧、所选模型是节点自己的参数（image.model/reference_hashes、video.model/reference_hashes/tail_frame_hash，见 kernel/inputs.js），
 * 估算/建任务前先经内核事务同步进图，所以它们进 cacheKey：改了会让该镜头的 image + video + 合成过期，改回去命中旧版本。
 * 幂等键仍带上它们（防御性，与 cacheKey 重复无害）。锁定参考图同时进出图请求（referenceImages）与出视频请求（referenceUrls，
 * 适配器按模型决定是否真的发给服务商）。
 *
 * 质量档（草稿 / 成片，spec §10.2）：项目的 quality 只改“这一次发给服务商的请求”（模型 / 分辨率 / 尺寸，取值见 qualityProfiles.js），
 * 不是节点参数、不进 cacheKey，所以切档位不会让任何产物过期；档位记在新版本的 metadata.quality（草稿 / 成片）。
 * “按成片质量重跑”（draftNodes + create 的 force/only）对草稿产物用同一个 cacheKey 再出一个成片版本并采用，图的过期集合不变。
 *
 * onAdopted（可选钩子）：每次有新版本写进图后调用 { task, episode_id, shot_id, storyboard_id, node, kind, version_id, adopted }；
 * 一致性评分（P3-C）挂在这里。钩子的 promise 计入 idle()。
 */
const path = require('node:path');
const kernel = require('@talekiln/kernel');
const store = require('../kernel/store');
const legacy = require('../kernel/legacy');
const inputs = require('../kernel/inputs');
const { chooseProvider, pickModel, modelAllowed } = require('./models');
const { normalizeQuality, applyQuality } = require('./qualityProfiles');

const { KernelError } = kernel;

class GenerationError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'GenerationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
class SkipAdoption extends Error {}

const KINDS = ['image', 'video'];
const ACTIVE = new Set(['queued', 'submitting', 'submitted', 'polling', 'downloading']);
const GEN_PREFIX = 'gen:';
const VIDEO_MIN_SEC = 1;
const VIDEO_MAX_SEC = 15;

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };
const genOf = (task) => (parseJson(task.params) || {})._gen || null;
const staticRef = (rel) => (rel ? `/static/${String(rel).replace(/^\/+/, '')}` : '');

/** kinds 请求 -> 要处理的节点类型。 */
function kindsOf(kind) {
  if (kind === 'both' || kind == null) return ['image', 'video'];
  if (KINDS.includes(kind)) return [kind];
  throw new GenerationError('BAD_REQUEST', "kind 必须是 'image' / 'video' / 'both'");
}

function createGenerationService({
  db, store: taskStore, worker = null, spend, storageRoot, getCore = null, listConfigs = null,
  catalogModels = () => [], log = console, resolution = null, onAdopted = null,
}) {
  if (!db || !taskStore || !spend) throw new Error('db, store and spend are required');
  const list = listConfigs || ((type) => require('../services/aiConfigService').listConfigsInternal(db, type));
  const warn = (msg, extra) => { try { (log.warn || log.error || (() => {})).call(log, msg, extra); } catch (_) { /* ignore */ } };

  // ---------- 图与镜头 ----------

  function episodeRow(ep) {
    const row = db.prepare('SELECT id, drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(ep));
    if (!row) throw new GenerationError('NOT_FOUND', `分集 ${ep} 不存在`, 404);
    return row;
  }

  /** 第一次用到生成时把旧表导入成项目图（幂等）。 */
  function openGraph(ep) {
    episodeRow(ep);
    if (!store.hasProject(db, ep)) legacy.importLegacy(db, ep);
    return store.openProject(db, ep);
  }

  /** shots: 'all' | [storyboard id | 镜头节点 id]。返回镜头节点 id（按剧本顺序，去重）。 */
  function resolveShots(g, shots) {
    const order = kernel.shotOrder(g);
    if (shots === 'all' || shots == null) return order;
    if (!Array.isArray(shots) || !shots.length) throw new GenerationError('BAD_REQUEST', "shots 必须是 'all' 或非空数组");
    const byLegacy = new Map(order.map((id) => [g.nodes[id].legacy_id, id]));
    const picked = new Set();
    for (const s of shots) {
      let id = null;
      if (typeof s === 'string' && g.nodes[s] && g.nodes[s].type === 'shot') id = s;
      else if (byLegacy.has(Number(s))) id = byLegacy.get(Number(s));
      if (!id) throw new GenerationError('NOT_FOUND', `镜头不存在：${s}`, 404);
      picked.add(id);
    }
    return order.filter((id) => picked.has(id));
  }

  const adoptedRef = (g, nodeId) => {
    const v = nodeId && kernel.adoptedVersion(g, nodeId);
    return v && v.asset && v.asset.ref ? v.asset.ref : null;
  };

  // ---------- 计划 ----------

  function buildParams(kind, { shot, refs = [], firstFrame, tailFrame, model, projectId, seconds, qResolution, qSize }) {
    const p = {};
    if (kind === 'image') {
      p.prompt = shot.image_prompt || shot.description || '';
      if (refs.length) p.referenceImages = refs;
      if (qSize) p.size = qSize;
    } else {
      p.prompt = shot.video_prompt || shot.description || '';
      p.duration = seconds;
      if (firstFrame) p.firstFrameUrl = firstFrame;
      if (firstFrame && tailFrame) p.lastFrameUrl = tailFrame;
      if (refs.length) p.referenceUrls = refs; // 锁定参考图：与旧流程 videoService 的 reference_urls 一致，适配器按模型取用
      if (qResolution || resolution) p.resolution = qResolution || resolution;
      if (qSize) p.size = qSize;
    }
    if (model) p.model = model;
    if (projectId != null) p._project = String(projectId);
    return p;
  }

  /** 项目的质量档（dramas.quality，缺省 / 旧库 / 非法值 = final）。 */
  function projectQuality(ep) {
    try {
      const row = db.prepare('SELECT d.quality AS quality FROM episodes e JOIN dramas d ON d.id = e.drama_id WHERE e.id = ?').get(Number(ep));
      return normalizeQuality(row && row.quality);
    } catch (_) {
      return 'final';
    }
  }

  /** 计划项上的质量字段：tier 是请求的档位；quality 是这一次实际生效的档位（档位表对该请求形态没有更便宜的已验证选项时 = final）。 */
  function qualityFields(tier, q, rerunOf) {
    return {
      tier, quality: q.applied ? 'draft' : 'final', resolution: q.resolution || null, size: q.size || null,
      ...(rerunOf ? { rerun_of: rerunOf } : {}),
    };
  }

  /**
   * 在图 g 上为一组镜头做计划。纯读：不写库、不建任务。
   * 每项 action：fresh（已新鲜）| cache_hit（有同 key 旧版本，改采用）| create（建任务）| chain（接在首帧之后建）| blocked。
   * opts：{ quality（缺省取项目的）, force（节点 id 集合：即使已新鲜也规划成 create / chain，用于草稿重跑）, only（只规划 force 里的节点）}。
   */
  function planGraph(g, ep, shotIds, kinds, contexts = null, opts = {}) {
    const keys = kernel.cacheKeys(g);
    const quality = normalizeQuality(opts.quality != null ? opts.quality : projectQuality(ep));
    const force = opts.force instanceof Set ? opts.force : new Set(opts.force || []);
    const only = !!opts.only; // 只规划 force 里的节点
    const adoptedId = (nodeId) => { const v = nodeId && kernel.adoptedVersion(g, nodeId); return v ? v.id : null; };
    const legacy = inputs.legacyKeys(g);
    const dramaId = episodeRow(ep).drama_id;
    const items = [];
    const sbRow = db.prepare('SELECT * FROM storyboards WHERE id = ?');
    const providerFor = {};
    for (const k of KINDS) providerFor[k] = chooseProvider(list, k);
    const catalog = catalogModels() || [];

    for (const shotId of shotIds) {
      const shotNode = g.nodes[shotId];
      const shot = shotNode.params;
      const parts = kernel.partsOfShot(g, shotId);
      const legacyId = shotNode.legacy_id ?? null;
      const row = legacyId != null ? sbRow.get(legacyId) : null;
      const base = { shot_id: shotId, storyboard_id: legacyId };
      let refsCache = null;
      const shotRefs = () => refsCache || (refsCache = inputs.shotInputs(db, g, shotId).refs); // 锁定参考图（图与视频共用）

      const nodeState = (kind) => kernel.nodeState(g, parts[kind], keys);
      // 缓存命中：同 key 的旧版本；或没有记录模型的旧版本（当时用的模型未知）且提示词/上游/参考图/尾帧与现在一致（改记到当前 key 后采用）
      const cacheVersion = (nodeId) => {
        const list = g.versions[nodeId] || [];
        const usable = (v) => v.asset && v.asset.ref;
        const isDraft = (v) => !!(v.metadata && v.metadata.quality === 'draft');
        const unknownModel = (v) => !(v.metadata && v.metadata.inputs && 'model' in v.metadata.inputs) && !list.some((x) => x.rebased_from === v.id); // 改记过的旧版本，模型假设已经落定在别名版本上
        return list.find((v) => v.cache_key === keys[nodeId] && usable(v) && !isDraft(v)) // 成片版本优先于草稿版本
          || list.find((v) => v.cache_key === keys[nodeId] && usable(v))
          || list.find((v) => unknownModel(v) && v.cache_key === legacy[nodeId] && usable(v)) || null;
      };

      // 首帧图
      let imageItem = null;
      if (kinds.includes('image')) {
        const node = parts.image;
        const forced = !!node && force.has(node);
        if (!node) {
          imageItem = { ...base, kind: 'image', action: 'blocked', reason: 'no_node' };
        } else if (only && !forced) {
          imageItem = null; // 只重跑指定节点：其余节点不规划
        } else {
          const state = nodeState('image');
          const it = { ...base, kind: 'image', node, state, cache_key: keys[node] };
          if (state === 'fresh' && !forced) imageItem = { ...it, action: 'fresh' };
          else if (!forced && cacheVersion(node)) imageItem = { ...it, action: 'cache_hit', version_id: cacheVersion(node).id, ref: cacheVersion(node).asset.ref };
          else if (!(shot.image_prompt || shot.description)) imageItem = { ...it, action: 'blocked', reason: 'no_prompt' };
          else {
            const refs = shotRefs();
            const { provider, ready } = providerFor.image;
            const saved = g.nodes[node].params.model; // 已同步进图的所选模型；'default' = 交给适配器挑
            const auto = pickModel({ provider, kind: 'image', hasRefs: refs.length > 0, listConfigs: list, catalogModels: catalog });
            const model = saved && saved !== 'default' ? saved : auto;
            const q = applyQuality({ quality, provider, kind: 'image', shape: { hasRefs: refs.length > 0 }, model, autoModel: auto, allowed: modelAllowed({ provider, kind: 'image', catalogModels: catalog }) });
            imageItem = {
              ...it, action: 'create', provider, provider_ready: ready, model: q.model || null, refs,
              ...qualityFields(quality, q, forced ? adoptedId(node) : null),
              inputs: { model: model || null, reference_hashes: refs.map(inputs.hashRef), tail_frame_hash: null },
              spec: { provider, kind: 'image', params: buildParams('image', { shot, refs, model: q.model, projectId: dramaId, qResolution: q.resolution, qSize: q.size }) },
            };
          }
        }
        if (imageItem) items.push(imageItem);
      }

      // 视频：首帧来源 / 尾帧 / 模型（与动作无关，所以同步输入时也能单独取到）
      const videoCtx = () => {
        const warnings = [];
        let firstFrame = null;
        let chained = false;
        if (imageItem && imageItem.action === 'create') chained = true;
        else if (imageItem && imageItem.action === 'cache_hit') firstFrame = imageItem.ref;
        else {
          firstFrame = adoptedRef(g, parts.image);
          if (firstFrame && parts.image && nodeState('image') !== 'fresh') warnings.push('first_frame_stale');
        }
        const tailFrame = row ? (row.last_frame_local_path ? staticRef(row.last_frame_local_path) : (row.last_frame_image_url || null)) : null;
        const hasFrame = chained || !!firstFrame;
        const saved = g.nodes[parts.video].params.model; // 已同步进图的所选模型；'default' = 没选/交给适配器
        const model = saved && saved !== 'default' ? saved : pickModel({ provider: providerFor.video.provider, kind: 'video', hasFrame, listConfigs: list, catalogModels: catalog });
        return { warnings, firstFrame, chained, tailFrame: hasFrame ? tailFrame : null, hasFrame, model };
      };
      if (contexts && parts.video) {
        // 同步用：不看已存模型，按“此刻的请求形态”选模型
        const c = videoCtx();
        const fresh = pickModel({ provider: providerFor.video.provider, kind: 'video', hasFrame: c.hasFrame, listConfigs: list, catalogModels: catalog });
        contexts[shotId] = { hasFrame: c.hasFrame, tail_frame_hash: c.tailFrame ? inputs.hashRef(c.tailFrame) : null, model: fresh || null };
      }
      if (kinds.includes('video')) {
        const node = parts.video;
        if (!node) {
          items.push({ ...base, kind: 'video', action: 'blocked', reason: 'no_node' });
          continue;
        }
        const forced = force.has(node);
        if (only && !forced) continue;
        const state = nodeState('video');
        const it = { ...base, kind: 'video', node, state, cache_key: keys[node] };
        const hit = forced ? null : cacheVersion(node);
        if (state === 'fresh' && !forced) { items.push({ ...it, action: 'fresh' }); continue; }
        if (hit) { items.push({ ...it, action: 'cache_hit', version_id: hit.id, ref: hit.asset.ref }); continue; }
        if (!(shot.video_prompt || shot.description)) { items.push({ ...it, action: 'blocked', reason: 'no_prompt' }); continue; }

        const { warnings, firstFrame, chained, tailFrame, hasFrame, model } = videoCtx();
        if (chained) { imageItem.then_video = true; if (forced) imageItem.then_video_force = true; }
        const seconds = Math.min(VIDEO_MAX_SEC, Math.max(VIDEO_MIN_SEC, Math.round((shot.duration_ms || kernel.DEFAULT_SHOT_MS) / 1000)));
        const { provider, ready } = providerFor.video;
        const refs = shotRefs();
        const auto = pickModel({ provider, kind: 'video', hasFrame, listConfigs: list, catalogModels: catalog });
        const q = applyQuality({ quality, provider, kind: 'video', shape: { hasFrame }, model, autoModel: auto, allowed: modelAllowed({ provider, kind: 'video', catalogModels: catalog }) });
        const params = buildParams('video', { shot, refs, firstFrame, tailFrame, model: q.model, projectId: dramaId, seconds, qResolution: q.resolution, qSize: q.size });
        items.push({
          ...it, action: chained ? 'chain' : 'create', provider, provider_ready: ready, model: q.model || null,
          ...qualityFields(quality, q, forced ? adoptedId(node) : null),
          mode: hasFrame ? 'first_frame' : 'text', first_frame: firstFrame, tail_frame: tailFrame, warnings, refs,
          inputs: { model: model || null, reference_hashes: refs.map(inputs.hashRef), tail_frame_hash: tailFrame ? inputs.hashRef(tailFrame) : null },
          spec: { provider, kind: 'video', params },
        });
      }
    }
    return items;
  }

  /** 同步进节点参数的模型选择（与 planGraph 里没有已存模型时的选择同一规则）。 */
  function modelPicker() {
    const catalog = catalogModels() || [];
    const prov = {};
    for (const k of KINDS) prov[k] = chooseProvider(list, k).provider;
    return {
      image: ({ hasRefs }) => pickModel({ provider: prov.image, kind: 'image', hasRefs, listConfigs: list, catalogModels: catalog }),
      video: ({ hasFrame }) => pickModel({ provider: prov.video, kind: 'video', hasFrame, listConfigs: list, catalogModels: catalog }),
    };
  }

  /**
   * 让节点参数与“此刻会发给服务商的输入”一致的事务（没有变化返回 null）：先写出图的参考图哈希与模型，
   * 在这张图上做计划得到视频的首帧形态（决定尾帧是否生效、选哪种视频模型），再写视频的尾帧与模型。
   * 一个事务（含首次基线改记，见 kernel/inputs.js）；估算时只在副本上演算，建任务前才提交。
   */
  function syncTx(g, ep, ids, kinds, tx_id) {
    const ops1 = inputs.inputOps(db, g, ids, { models: { image: modelPicker().image }, tail: false });
    const g1 = ops1.length ? kernel.applyTx(g, { tx_id: 'sim1', ops: ops1 }).graph : g;
    const ctx = {};
    planGraph(g1, ep, ids, kinds, ctx);
    const ops2 = [];
    for (const id of ids) {
      if (!ctx[id]) continue;
      ops2.push(...kernel.intents.shot.setShotReferences(g1, id, { video_model: ctx[id].model || 'default', tail_frame_hash: ctx[id].tail_frame_hash }).ops);
    }
    const ops = [...ops1, ...ops2];
    if (!ops.length) return null;
    return { tx_id: tx_id || `gen-inputs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, label: 'generation inputs', ops: [...ops, ...inputs.rebaseOps(g, ops)] };
  }

  /** 把计划项变成幂等键：cacheKey + 其余未进 key 的输入。 */
  function idempotencyKey(ep, item) {
    const p = item.spec.params;
    const extra = kernel.sha256(kernel.canonicalJSON({
      provider: item.spec.provider, model: p.model || null, first: p.firstFrameUrl || null, last: p.lastFrameUrl || null,
      refs: p.referenceImages || null, ref_urls: p.referenceUrls || null, duration: p.duration || null, resolution: p.resolution || null,
      ...(p.size ? { size: p.size } : {}), // 质量档带来的尺寸（没有时不进，旧键不变）
      ...(item.rerun_of ? { rerun: item.rerun_of } : {}), // 草稿重跑：同一个 cacheKey，靠被替换的草稿版本 id 区分
    }));
    return `${GEN_PREFIX}${ep}:${item.node}:${item.cache_key.slice(0, 32)}:${extra.slice(0, 12)}`;
  }

  const summarize = (items) => {
    const by = {};
    for (const it of items) by[it.action] = (by[it.action] || 0) + 1;
    return by;
  };

  const publicItem = (it) => ({
    shot_id: it.shot_id, storyboard_id: it.storyboard_id, kind: it.kind, node: it.node || null, action: it.action,
    state: it.state || null, reason: it.reason || null, model: it.model || null, mode: it.mode || null,
    provider: it.provider || null, warnings: it.warnings || [], cache_key: it.cache_key ? it.cache_key.slice(0, 12) : null,
    refs: it.refs ? it.refs.length : 0, tail_frame: !!it.tail_frame, quality: it.quality || null,
  });

  /** 对一次点击做估算 + 额度检查。不建任何任务。 */
  function estimate(ep, { shots = 'all', kind = 'both', regenerate = false, force = null, only = false, quality = null } = {}) {
    const kinds = kindsOf(kind);
    const { graph } = openGraph(ep);
    const ids = resolveShots(graph, shots);
    let g = graph;
    const sync = syncTx(graph, ep, ids, kinds);
    if (sync) g = kernel.applyTx(g, sync).graph; // 只在副本上演算：估算不写库
    if (regenerate) g = kernel.applyTx(g, regenerateTx(g, ids, kinds)).graph; // 只在副本上演算
    const items = planGraph(g, ep, ids, kinds, null, { quality, force, only });
    const billable = items.filter((i) => i.action === 'create' || i.action === 'chain');
    const check = spend.checkBatch(billable.map((i) => i.spec));
    return { items, billable, check };
  }

  function regenerateTx(g, shotIds, kinds, tx_id) {
    const ops = [];
    for (const id of shotIds) ops.push(...kernel.intents.shot.regenerateShot(g, id, { targets: kinds }).ops);
    return { tx_id: tx_id || `regen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, label: 'regenerate', ops };
  }

  function estimateView(ep, { items, billable, check }, extra = {}) {
    return {
      episode_id: Number(ep),
      confirmed: false,
      items: items.map(publicItem),
      counts: summarize(items),
      billable: billable.length,
      estimate: {
        total: check.total, max: check.max, currency: check.currency, sample_prices: check.sample_prices, known: check.known,
        by_item: billable.map((b, i) => ({ shot_id: b.shot_id, kind: b.kind, estimate: check.estimates[i].estimate, max: check.estimates[i].max, basis: check.estimates[i].basis })),
      },
      cap: check.cap,
      allowed: check.ok,
      refusal: check.ok ? null : { reason: check.reason, message: check.message },
      provider_ready: billable.every((b) => b.provider_ready !== false),
      ...extra,
    };
  }

  /** confirm=false 的入口。 */
  function preview(ep, args) {
    return estimateView(ep, estimate(ep, args));
  }

  // ---------- 建任务 ----------

  /** 同键任务已存在时：失败的重试、取消的换键重建、其余复用。batch（P3-B）：所属批次，只作内部标记（不进幂等键、不发给服务商）。 */
  function enqueueOrReuse(item, key, batch = null) {
    const spec = item.spec;
    const params = {
      ...spec.params,
      _gen: {
        episode_id: item.episode_id, shot_id: item.shot_id, storyboard_id: item.storyboard_id, node: item.node, kind: item.kind,
        cache_key: item.cache_key, ...(item.inputs ? { inputs: item.inputs } : {}), ...(item.then_video ? { then_video: true } : {}),
        quality: item.quality || 'final', ...(item.tier ? { tier: item.tier } : {}),
        ...(item.resolution ? { resolution: item.resolution } : {}), ...(item.size ? { size: item.size } : {}),
        ...(item.rerun_of ? { rerun_of: item.rerun_of } : {}), ...(item.then_video_force ? { then_video_force: true } : {}),
      },
      ...(batch ? { _batch: batch } : {}),
    };
    let k = key;
    let existing = taskStore.getByKey(k);
    if (existing && existing.state === 'cancelled') {
      const n = db.prepare('SELECT COUNT(*) n FROM ai_tasks WHERE idempotency_key = ? OR idempotency_key LIKE ?').get(key, `${key}:c%`).n;
      k = `${key}:c${n}`;
      existing = taskStore.getByKey(k);
    }
    if (!existing) {
      const { task } = taskStore.enqueue({ idempotencyKey: k, provider: spec.provider, kind: spec.kind, params });
      return { outcome: 'created', task };
    }
    if (existing.state === 'failed') {
      const uncertain = existing.error_message && String(existing.error_message).startsWith('SUBMIT_UNCERTAIN');
      if (uncertain) return { outcome: 'uncertain', task: existing };
      taskStore.retry(existing.id);
      return { outcome: 'retried', task: taskStore.get(existing.id) };
    }
    if (existing.state === 'succeeded') return { outcome: 'already_done', task: existing };
    return { outcome: 'already_queued', task: existing };
  }

  /** 缓存命中：同一事务里改采用旧版本（不花钱）。 */
  function adoptCacheHits(ep, hits) {
    if (!hits.length) return;
    store.commit(db, ep, (g) => {
      const keys = kernel.cacheKeys(g);
      const legacy = inputs.legacyKeys(g);
      const ops = [];
      for (const h of hits) {
        if (!g.nodes[h.node]) continue;
        const v = (g.versions[h.node] || []).find((x) => x.id === h.version_id);
        if (!v) continue;
        if (v.cache_key === keys[h.node]) { if (g.adopted[h.node] !== v.id) ops.push({ op: 'adoptVersion', node: h.node, version_id: v.id }); }
        else if (!(v.metadata && v.metadata.inputs && 'model' in v.metadata.inputs) && !(g.versions[h.node] || []).some((x) => x.rebased_from === v.id) && v.cache_key === legacy[h.node]) ops.push(...inputs.aliasOps(g, h.node, v, keys[h.node], { model: g.nodes[h.node].params.model }));
      }
      return { tx_id: `gen-hit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, label: 'generation cache hit', ops };
    });
  }

  /**
   * confirm=true：先估算和查额度（超限整批拒绝，不建任何任务），再采用缓存命中、建任务、唤醒 worker。
   * opts.skipCap 只给“首帧完成后接着出视频”的内部链用（点击时整批已批准过）。
   * opts.batch（P3-B）：{ id, episode_id }，写进任务参数 `_batch`，接着出的视频任务沿用。
   */
  function create(ep, args = {}, opts = {}) {
    const kinds = kindsOf(args.kind);
    const opened = openGraph(ep);
    // 先把锁定参考图 / 尾帧 / 所选模型同步进图（一个内核事务）：它们进 cacheKey，之后的计划、幂等键、任务的 cache_key 都基于同步后的图
    const syncIds = resolveShots(opened.graph, args.shots);
    if (syncTx(opened.graph, ep, syncIds, kinds)) store.commit(db, ep, (g) => syncTx(g, ep, syncIds, kinds) || { tx_id: `gen-inputs-noop-${Date.now().toString(36)}`, label: 'noop', ops: [] });
    if (args.regenerate) {
      const { graph } = store.openProject(db, ep);
      const ids = resolveShots(graph, args.shots);
      // 先对副本估算：超限则一个字节都不写（包括种子变更）
      const sim = kernel.applyTx(graph, regenerateTx(graph, ids, kinds)).graph;
      const pre = spend.checkBatch(planGraph(sim, ep, ids, kinds, null, { quality: args.quality }).filter((i) => i.action === 'create' || i.action === 'chain').map((i) => i.spec));
      if (!pre.ok && !opts.skipCap) throw refusal(pre, ep);
      store.commit(db, ep, (g) => regenerateTx(g, ids, kinds, args.tx_id ? `${args.tx_id}:regen` : undefined), args.tx_id ? { tx_id: `${args.tx_id}:regen` } : {});
    }
    const est = estimate(ep, { shots: args.shots, kind: args.kind, force: args.force, only: args.only, quality: args.quality });
    if (!est.check.ok && !opts.skipCap) throw refusal(est.check, ep);
    const unready = est.billable.find((b) => b.provider_ready === false);
    if (unready && !opts.allowNoKey) {
      throw new GenerationError('INVALID_API_KEY', `未配置 ${unready.provider} 的 ${unready.kind} 服务或 Key，请先在设置里添加`, 400);
    }

    const tasks = [];
    adoptCacheHits(ep, est.items.filter((i) => i.action === 'cache_hit'));
    for (const item of est.items) {
      if (item.action !== 'create') continue;
      item.episode_id = Number(ep);
      const key = idempotencyKey(ep, item);
      const r = enqueueOrReuse(item, key, opts.batch || null);
      tasks.push({ shot_id: item.shot_id, storyboard_id: item.storyboard_id, kind: item.kind, outcome: r.outcome, task_id: r.task.id, state: r.task.state });
    }
    if (tasks.length && worker) worker.wake();
    return { ...estimateView(ep, est), confirmed: true, tasks };
  }

  function refusal(check, ep) {
    return new GenerationError('SPEND_LIMIT', check.message, 402, {
      reason: check.reason, estimate: check.total, max: check.max, currency: check.currency, episode_id: Number(ep),
    });
  }

  // ---------- 写回 ----------

  async function probeDurationMs(rel) {
    if (!getCore || !rel || !storageRoot) return null;
    try {
      const core = await getCore();
      if (!core) return null;
      const r = await core.call('media.probe', { path: path.join(storageRoot, ...String(rel).split('/')) });
      const sec = r && Number(r.durationSec);
      return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null;
    } catch (_) {
      return null;
    }
  }

  /** 任务结果 -> 内核资产 + 版本元数据（视频带真实时长）。 */
  async function assetFromTask(task, gen) {
    const result = parseJson(task.result) || {};
    const file = Array.isArray(result.files) && result.files[0] ? result.files[0] : null;
    const remote = result.url || (Array.isArray(result.urls) ? result.urls[0] : null) || null;
    const ref = file ? staticRef(file.path) : remote;
    if (!ref) throw new SkipAdoption('任务结果里没有可用的文件');
    const asset = { ref, kind: gen.kind, hash: file ? file.sha256 : kernel.sha256(`ref:${ref}`) };
    if (file) { asset.size = file.size; asset.path = file.path; }
    const meta = { task_id: task.id, provider: task.provider };
    if (gen.inputs) meta.inputs = gen.inputs;
    const params = parseJson(task.params) || {};
    if (params.model) meta.model = params.model;
    meta.quality = gen.quality === 'draft' ? 'draft' : 'final'; // 质量档只进元数据，不进 cacheKey
    if (gen.resolution) meta.resolution = gen.resolution;
    if (gen.size) meta.size = gen.size;
    if (gen.rerun_of) meta.rerun_of = gen.rerun_of;
    if (gen.kind === 'video') {
      let ms = file ? await probeDurationMs(file.path) : null;
      let source = 'probe';
      if (ms == null) {
        const sec = Number(result.usage && result.usage.duration);
        if (Number.isFinite(sec) && sec > 0) { ms = Math.round(sec * 1000); source = 'provider'; }
      }
      if (ms == null && Number(params.duration) > 0) { ms = Math.round(Number(params.duration) * 1000); source = 'requested'; }
      if (ms != null) { meta.duration_ms = ms; meta.duration_source = source; }
    }
    return { asset, meta };
  }

  /**
   * 成功任务 -> 内核：一次 commit（addVersion + adoptVersion，带任务建立时的 cacheKey）。
   * 版本的 cacheKey 是建任务时的，所以期间改过镜头的话结果会被标成过期而不是新鲜；
   * 且已有一个新鲜的采用版本时，迟到的旧结果只入库不采用。同一任务重复写回是空操作（tx_id 固定）。
   */
  async function adoptTask(task) {
    const gen = genOf(task);
    if (!gen || task.state !== 'succeeded') return { adopted: false, reason: 'not_applicable' };
    const ep = Number(gen.episode_id);
    if (!store.hasProject(db, ep)) return { adopted: false, reason: 'no_graph' };
    const { asset, meta } = await assetFromTask(task, gen);
    const vid = `t_${task.id}`;
    let adoptedNow = false;
    try {
      const r = store.commit(db, ep, (g) => {
        const node = g.nodes[gen.node];
        if (!node || node.type !== gen.kind) throw new SkipAdoption('节点已不存在');
        const cur = kernel.cacheKeys(g)[gen.node];
        const adoptedV = kernel.adoptedVersion(g, gen.node);
        const adoptedFresh = !!adoptedV && adoptedV.cache_key === cur;
        const adopt = gen.cache_key === cur || !adoptedFresh;
        const ops = [];
        if (!(g.versions[gen.node] || []).some((v) => v.id === vid)) {
          ops.push({ op: 'addVersion', node: gen.node, version: { id: vid, cache_key: gen.cache_key, asset, metadata: meta, source: `ai-task:${task.id}` } });
        }
        if (adopt) ops.push({ op: 'adoptVersion', node: gen.node, version_id: vid });
        adoptedNow = adopt;
        return { tx_id: `gen-done:${task.id}`, label: `generation ${gen.kind}`, ops };
      }, { tx_id: `gen-done:${task.id}` });
      if (!r.applied) return { adopted: false, reason: 'already_recorded' };
    } catch (e) {
      if (e instanceof SkipAdoption) return { adopted: false, reason: e.message };
      throw e;
    }
    if (adoptedNow && gen.then_video) chainVideo(ep, gen, (parseJson(task.params) || {})._batch || null);
    if (onAdopted) {
      // 新版本已在图里：交给钩子（一致性评分等），失败只记日志，不影响写回结果
      const hook = Promise.resolve()
        .then(() => onAdopted({ task, episode_id: ep, shot_id: gen.shot_id, storyboard_id: gen.storyboard_id ?? null, node: gen.node, kind: gen.kind, version_id: vid, adopted: adoptedNow }))
        .catch((e) => warn('generation adopted hook', { error: e && e.message, task: task.id }));
      pending.add(hook);
      hook.finally(() => pending.delete(hook));
    }
    return { adopted: adoptedNow, reason: adoptedNow ? 'adopted' : 'superseded' };
  }

  /** 首帧图落地后接着出视频（点击时整批估算已批准；提交时队列的花费守卫还会再查一次）。batch：首帧任务所属批次，沿用到视频任务。 */
  function chainVideo(ep, gen, batch = null) {
    try {
      const { graph } = store.openProject(db, ep);
      const node = graph.nodes[gen.shot_id];
      if (!node) return;
      const parts = kernel.partsOfShot(graph, gen.shot_id);
      if (kernel.nodeState(graph, parts.image) !== 'fresh') return; // 首帧已被改过，不接着出
      const next = { shots: [gen.shot_id], kind: 'video' };
      if (gen.tier) next.quality = gen.tier; // 沿用点击时的档位
      if (gen.then_video_force) { // 草稿重跑：首帧换成成片后，视频也按同一 cacheKey 重出
        const vnode = kernel.partsOfShot(graph, gen.shot_id).video;
        if (!vnode) return;
        next.force = [vnode];
        next.only = true;
      }
      create(ep, next, { skipCap: true, batch });
    } catch (e) {
      warn('generation chain video', { error: e && e.message, shot: gen.shot_id });
    }
  }

  const pending = new Set();
  /** worker 的 onTaskFinished 入口（同步返回；写回在后台完成）。失败/取消不碰图。 */
  function onTaskFinished(task) {
    if (!task || !String(task.idempotency_key || '').startsWith(GEN_PREFIX)) return null;
    if (task.state !== 'succeeded') return null;
    const p = adoptTask(task).catch((e) => warn('generation write-back', { error: e && e.message, task: task.id }));
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  }

  /** 等所有进行中的写回结束（测试与优雅退出用）。 */
  const idle = async () => { while (pending.size) await Promise.all([...pending]); };

  /**
   * 启动恢复：已成功但写回前进程就崩了的任务补写（tx_id 固定，已写过的是空操作）。
   * “提交了没写回”的任务由队列自己的 reconcile 续轮询，结束时同样走 onTaskFinished。
   */
  async function recoverFinished() {
    const rows = db.prepare(`SELECT * FROM ai_tasks WHERE state = 'succeeded' AND idempotency_key LIKE ? ORDER BY completed_at, rowid`).all(`${GEN_PREFIX}%`);
    const out = [];
    for (const t of rows) {
      try { out.push({ task_id: t.id, ...(await adoptTask(t)) }); } catch (e) { warn('generation recover', { error: e && e.message, task: t.id }); }
    }
    return out;
  }

  // ---------- 状态 ----------

  /** 每镜头状态：none / queued / running / stale / fresh / failed（图的过期集合 + 队列里当前 key 的任务）。 */
  function status(ep) {
    const { graph: g, seq } = openGraph(ep);
    const keys = kernel.cacheKeys(g);
    const rows = db.prepare(`SELECT * FROM ai_tasks WHERE idempotency_key LIKE ? ORDER BY created_at DESC, rowid DESC`).all(`${GEN_PREFIX}${Number(ep)}:%`);
    const byNode = new Map();
    for (const t of rows) {
      const gen = genOf(t);
      if (!gen) continue;
      if (!byNode.has(gen.node)) byNode.set(gen.node, []);
      byNode.get(gen.node).push({ t, gen });
    }
    const nodeStatus = (nodeId) => {
      if (!nodeId) return { state: 'none', task_id: null };
      const kstate = kernel.nodeState(g, nodeId, keys);
      const mine = (byNode.get(nodeId) || []).filter((x) => x.gen.cache_key === keys[nodeId]);
      const active = mine.find((x) => ACTIVE.has(x.t.state));
      const adoptedV = kernel.adoptedVersion(g, nodeId);
      const base = { kernel: kstate, version_id: adoptedV ? adoptedV.id : null, duration_ms: adoptedV && adoptedV.metadata ? adoptedV.metadata.duration_ms ?? null : null };
      if (kstate !== 'fresh' && active) {
        return { ...base, state: active.t.state === 'queued' ? 'queued' : 'running', task_id: active.t.id, task_state: active.t.state };
      }
      // 任务已成功但结果还没写进图（写回进行中或等待崩溃恢复）：仍算进行中
      const landing = kstate !== 'fresh' ? mine.find((x) => x.t.state === 'succeeded' && !(g.versions[nodeId] || []).some((v) => v.id === `t_${x.t.id}`)) : null;
      if (landing) return { ...base, state: 'running', task_id: landing.t.id, task_state: 'writing_back' };
      const failed = kstate !== 'fresh' ? mine.find((x) => x.t.state === 'failed') : null;
      if (failed && !mine.some((x) => x.t.state === 'succeeded')) {
        return { ...base, state: 'failed', task_id: failed.t.id, task_state: 'failed', error_code: failed.t.error_code, error_message: failed.t.error_message };
      }
      return { ...base, state: kstate, task_id: null };
    };
    const ORDER = ['running', 'queued', 'failed', 'stale', 'none', 'fresh'];
    const shots = kernel.shotOrder(g).map((id, i) => {
      const parts = kernel.partsOfShot(g, id);
      const image = nodeStatus(parts.image);
      const video = nodeStatus(parts.video);
      const state = ORDER.find((s) => image.state === s || video.state === s) || 'none';
      return { shot_id: id, storyboard_id: g.nodes[id].legacy_id ?? null, number: i + 1, state, image, video };
    });
    const counts = {};
    for (const s of shots) counts[s.state] = (counts[s.state] || 0) + 1;
    return { episode_id: Number(ep), seq, shots, counts, stale: kernel.staleSet(g), cap: spend.capStatus() };
  }

  // ---------- 质量档：草稿产物重跑 ----------

  /**
   * 当前采用的版本是草稿档产出、且仍新鲜（版本 cacheKey = 当前 key）的 image / video 节点，
   * 以及按成片档重跑它们的估算（与 rerunDrafts 实际入队的是同一批）。
   */
  function draftNodes(ep) {
    const opened = openGraph(ep);
    const ids = kernel.shotOrder(opened.graph);
    let g = opened.graph;
    const sync = syncTx(g, ep, ids, KINDS);
    if (sync) g = kernel.applyTx(g, sync).graph; // 只在副本上演算
    const keys = kernel.cacheKeys(g);
    const picked = [];
    for (const shotId of ids) {
      const parts = kernel.partsOfShot(g, shotId);
      for (const kind of KINDS) {
        const node = parts[kind];
        const v = node && kernel.adoptedVersion(g, node);
        if (v && v.metadata && v.metadata.quality === 'draft' && v.cache_key === keys[node]) picked.push({ node, kind, shot: shotId });
      }
    }
    const force = picked.map((p) => p.node);
    const items = picked.length
      ? planGraph(g, ep, ids, KINDS, null, { quality: 'final', force: new Set(force), only: true }).filter((i) => i.action === 'create' || i.action === 'chain')
      : [];
    const check = spend.checkBatch(items.map((i) => i.spec));
    return {
      episode_id: Number(ep),
      count: picked.length,
      nodes: picked,
      force,
      estimate: { amount: check.total, max: check.max, currency: check.currency },
      allowed: check.ok,
      refusal: check.ok ? null : { reason: check.reason, message: check.message },
    };
  }

  /** 按成片档重跑草稿产物：同一批节点、同一套规划，先估算 + 额度检查再入队。 */
  function rerunDrafts(ep, opts = {}) {
    const d = draftNodes(ep);
    if (!d.count) return { ...d, tasks: [] };
    const shots = [...new Set(d.nodes.map((n) => n.shot))];
    const r = create(ep, { shots, kind: 'both', force: d.force, only: true, quality: 'final' }, opts);
    return { ...d, tasks: r.tasks };
  }

  return { preview, create, status, onTaskFinished, adoptTask, recoverFinished, idle, planGraph, estimate, draftNodes, rerunDrafts, projectQuality };
}

module.exports = { createGenerationService, GenerationError, GEN_PREFIX, KernelError };
