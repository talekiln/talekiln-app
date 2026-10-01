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
 * 尚未进入 cacheKey 的输入（锁定的参考图、尾帧、所选模型）只进幂等键，不会让“新鲜”的节点变成过期。
 */
const path = require('node:path');
const kernel = require('@talekiln/kernel');
const store = require('../kernel/store');
const legacy = require('../kernel/legacy');
const referenceLocks = require('../services/referenceLockService');
const { chooseProvider, pickModel } = require('./models');

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
  catalogModels = () => [], log = console, resolution = null,
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

  function buildParams(kind, { shot, refs, firstFrame, tailFrame, model, projectId, seconds }) {
    const p = {};
    if (kind === 'image') {
      p.prompt = shot.image_prompt || shot.description || '';
      if (refs.length) p.referenceImages = refs;
    } else {
      p.prompt = shot.video_prompt || shot.description || '';
      p.duration = seconds;
      if (firstFrame) p.firstFrameUrl = firstFrame;
      if (firstFrame && tailFrame) p.lastFrameUrl = tailFrame;
      if (resolution) p.resolution = resolution;
    }
    if (model) p.model = model;
    if (projectId != null) p._project = String(projectId);
    return p;
  }

  /**
   * 在图 g 上为一组镜头做计划。纯读：不写库、不建任务。
   * 每项 action：fresh（已新鲜）| cache_hit（有同 key 旧版本，改采用）| create（建任务）| chain（接在首帧之后建）| blocked。
   */
  function planGraph(g, ep, shotIds, kinds) {
    const keys = kernel.cacheKeys(g);
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

      const nodeState = (kind) => kernel.nodeState(g, parts[kind], keys);
      const cacheVersion = (nodeId) => (g.versions[nodeId] || []).find((v) => v.cache_key === keys[nodeId] && v.asset && v.asset.ref) || null;

      // 首帧图
      let imageItem = null;
      if (kinds.includes('image')) {
        const node = parts.image;
        if (!node) {
          imageItem = { ...base, kind: 'image', action: 'blocked', reason: 'no_node' };
        } else {
          const state = nodeState('image');
          const it = { ...base, kind: 'image', node, state, cache_key: keys[node] };
          if (state === 'fresh') imageItem = { ...it, action: 'fresh' };
          else if (cacheVersion(node)) imageItem = { ...it, action: 'cache_hit', version_id: cacheVersion(node).id, ref: cacheVersion(node).asset.ref };
          else if (!(shot.image_prompt || shot.description)) imageItem = { ...it, action: 'blocked', reason: 'no_prompt' };
          else {
            const refs = legacyId != null ? referenceLocks.collectLockedRefsForStoryboard(db, legacyId).slice(0, 4) : [];
            const { provider, ready } = providerFor.image;
            const model = pickModel({ provider, kind: 'image', hasRefs: refs.length > 0, listConfigs: list, catalogModels: catalog });
            imageItem = {
              ...it, action: 'create', provider, provider_ready: ready, model: model || null, refs,
              spec: { provider, kind: 'image', params: buildParams('image', { shot, refs, model, projectId: dramaId }) },
            };
          }
        }
        items.push(imageItem);
      }

      // 视频
      if (kinds.includes('video')) {
        const node = parts.video;
        if (!node) {
          items.push({ ...base, kind: 'video', action: 'blocked', reason: 'no_node' });
          continue;
        }
        const state = nodeState('video');
        const it = { ...base, kind: 'video', node, state, cache_key: keys[node] };
        const hit = cacheVersion(node);
        if (state === 'fresh') { items.push({ ...it, action: 'fresh' }); continue; }
        if (hit) { items.push({ ...it, action: 'cache_hit', version_id: hit.id, ref: hit.asset.ref }); continue; }
        if (!(shot.video_prompt || shot.description)) { items.push({ ...it, action: 'blocked', reason: 'no_prompt' }); continue; }

        const warnings = [];
        let firstFrame = null;
        let chained = false;
        if (imageItem && (imageItem.action === 'create')) { chained = true; imageItem.then_video = true; }
        else if (imageItem && imageItem.action === 'cache_hit') firstFrame = imageItem.ref;
        else {
          firstFrame = adoptedRef(g, parts.image);
          if (firstFrame && parts.image && nodeState('image') !== 'fresh') warnings.push('first_frame_stale');
        }
        const tailFrame = row ? (row.last_frame_local_path ? staticRef(row.last_frame_local_path) : (row.last_frame_image_url || null)) : null;
        const hasFrame = chained || !!firstFrame;
        const seconds = Math.min(VIDEO_MAX_SEC, Math.max(VIDEO_MIN_SEC, Math.round((shot.duration_ms || kernel.DEFAULT_SHOT_MS) / 1000)));
        const { provider, ready } = providerFor.video;
        const model = pickModel({ provider, kind: 'video', hasFrame: hasFrame, listConfigs: list, catalogModels: catalog });
        const params = buildParams('video', { shot, firstFrame, tailFrame: hasFrame ? tailFrame : null, model, projectId: dramaId, seconds });
        items.push({
          ...it, action: chained ? 'chain' : 'create', provider, provider_ready: ready, model: model || null,
          mode: hasFrame ? 'first_frame' : 'text', first_frame: firstFrame, tail_frame: hasFrame ? tailFrame : null, warnings,
          spec: { provider, kind: 'video', params },
        });
      }
    }
    return items;
  }

  /** 把计划项变成幂等键：cacheKey + 其余未进 key 的输入。 */
  function idempotencyKey(ep, item) {
    const p = item.spec.params;
    const extra = kernel.sha256(kernel.canonicalJSON({
      provider: item.spec.provider, model: p.model || null, first: p.firstFrameUrl || null, last: p.lastFrameUrl || null,
      refs: p.referenceImages || null, duration: p.duration || null, resolution: p.resolution || null,
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
    refs: it.refs ? it.refs.length : 0, tail_frame: !!it.tail_frame,
  });

  /** 对一次点击做估算 + 额度检查。不建任何任务。 */
  function estimate(ep, { shots = 'all', kind = 'both', regenerate = false } = {}) {
    const kinds = kindsOf(kind);
    const { graph } = openGraph(ep);
    const ids = resolveShots(graph, shots);
    let g = graph;
    if (regenerate) g = kernel.applyTx(graph, regenerateTx(graph, ids, kinds)).graph; // 只在副本上演算
    const items = planGraph(g, ep, ids, kinds);
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

  /** 同键任务已存在时：失败的重试、取消的换键重建、其余复用。 */
  function enqueueOrReuse(item, key) {
    const spec = item.spec;
    const params = {
      ...spec.params,
      _gen: {
        episode_id: item.episode_id, shot_id: item.shot_id, storyboard_id: item.storyboard_id, node: item.node, kind: item.kind,
        cache_key: item.cache_key, ...(item.then_video ? { then_video: true } : {}),
      },
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
      const ops = [];
      for (const h of hits) {
        if (!g.nodes[h.node]) continue;
        const v = (g.versions[h.node] || []).find((x) => x.id === h.version_id && x.cache_key === keys[h.node]);
        if (v && g.adopted[h.node] !== v.id) ops.push({ op: 'adoptVersion', node: h.node, version_id: v.id });
      }
      return { tx_id: `gen-hit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, label: 'generation cache hit', ops };
    });
  }

  /**
   * confirm=true：先估算和查额度（超限整批拒绝，不建任何任务），再采用缓存命中、建任务、唤醒 worker。
   * opts.skipCap 只给“首帧完成后接着出视频”的内部链用（点击时整批已批准过）。
   */
  function create(ep, args = {}, opts = {}) {
    const kinds = kindsOf(args.kind);
    openGraph(ep);
    if (args.regenerate) {
      const { graph } = store.openProject(db, ep);
      const ids = resolveShots(graph, args.shots);
      // 先对副本估算：超限则一个字节都不写（包括种子变更）
      const sim = kernel.applyTx(graph, regenerateTx(graph, ids, kinds)).graph;
      const pre = spend.checkBatch(planGraph(sim, ep, ids, kinds).filter((i) => i.action === 'create' || i.action === 'chain').map((i) => i.spec));
      if (!pre.ok && !opts.skipCap) throw refusal(pre, ep);
      store.commit(db, ep, (g) => regenerateTx(g, ids, kinds, args.tx_id ? `${args.tx_id}:regen` : undefined), args.tx_id ? { tx_id: `${args.tx_id}:regen` } : {});
    }
    const est = estimate(ep, { shots: args.shots, kind: args.kind });
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
      const r = enqueueOrReuse(item, key);
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
    const params = parseJson(task.params) || {};
    if (params.model) meta.model = params.model;
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
          ops.push({ op: 'addVersion', node: gen.node, version: { id: vid, cache_key: gen.cache_key, asset, meta, source: `ai-task:${task.id}` } });
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
    if (adoptedNow && gen.then_video) chainVideo(ep, gen);
    return { adopted: adoptedNow, reason: adoptedNow ? 'adopted' : 'superseded' };
  }

  /** 首帧图落地后接着出视频（点击时整批估算已批准；提交时队列的花费守卫还会再查一次）。 */
  function chainVideo(ep, gen) {
    try {
      const { graph } = store.openProject(db, ep);
      const node = graph.nodes[gen.shot_id];
      if (!node) return;
      const parts = kernel.partsOfShot(graph, gen.shot_id);
      if (kernel.nodeState(graph, parts.image) !== 'fresh') return; // 首帧已被改过，不接着出
      create(ep, { shots: [gen.shot_id], kind: 'video' }, { skipCap: true });
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
      const base = { kernel: kstate, version_id: adoptedV ? adoptedV.id : null, duration_ms: adoptedV && adoptedV.meta ? adoptedV.meta.duration_ms ?? null : null };
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

  return { preview, create, status, onTaskFinished, adoptTask, recoverFinished, idle, planGraph, estimate };
}

module.exports = { createGenerationService, GenerationError, GEN_PREFIX, KernelError };
