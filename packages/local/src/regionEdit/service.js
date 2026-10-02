'use strict';
/**
 * P3-R 选镜改片编排（docs/phase3-region-edit.md）：对一个镜头已采用的视频，只重做 [t0, t1) 这一段里框选的区域。
 *
 *   estimate  读内核图，用 editShotRegion 意图校验入出点 / 区域 / 提示词，并在图的副本上算出“改片后”的 cacheKey；
 *             只对重做的那一段按整秒估价（spend 估算器），同时给出整镜重做的价格作对比。不写库、不建任务。
 *   submit    confirm=true：估算 + 额度检查通过后记一行 edit_regions，建一个持久队列任务（幂等键 `edit:` 前缀，
 *             与生成服务的 `gen:` 前缀互不干扰，所以两个服务的 onTaskFinished / recover 不会抢对方的任务）：
 *               provider_mask   适配器有 video.edit 能力：videoUrl + edit{t0,t1,rect,mode} 交给服务商（百炼 / 方舟目前都没有，未验证）
 *               segment_splice  降级：ffmpeg 截取入点 / 出点两帧 -> 首尾帧生视频（与出视频同一条队列路径，参数带 _edit）
 *                               -> 成功后用 ffmpeg 把 [0,t0) + 新片段 + [t1,end) 重新编码拼成整条
 *             提交时不改图：改片配方只在任务参数里，结果落地时才作为版本的 metadata.edit 入图。这样等待期间原视频仍是“新鲜”，
 *             不会被批量生成误当成过期而整镜重做。
 *   finish    onTaskFinished：成功 -> 拼接（降级路径）-> addVersion 入图（cache_key = 提交时算出的改片后 key），不自动采用；
 *             失败 -> 图不动，只改 edit_regions 行的状态。同一任务重复写回是空操作（tx_id 固定）。
 *   adopt     用 adoptShotVersion 意图采用某版本：节点的 edit 参数跟随版本配方，所以采用改片结果与采用回原版本都“新鲜”。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const kernel = require('@talekiln/kernel');
const store = require('../kernel/store');
const legacy = require('../kernel/legacy');
const { chooseProvider, pickModel } = require('../generation/models');
const { blobPath, sha256File } = require('../queue/download');
const { describe: describeError } = require('../errors');
const { createFfmpeg, FfmpegError } = require('./ffmpeg');
const { segmentSeconds, fullSeconds, pickStrategy, fallbackPrompt, toCents } = require('./prompt');

const { KernelError } = kernel;

class RegionEditError extends Error {
  constructor(code, message, status = 400, details) {
    super(message || describeError(code).message);
    this.name = 'RegionEditError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
class Skip extends Error {}

const EDIT_PREFIX = 'edit:';
const ACTIVE = new Set(['queued', 'submitting', 'submitted', 'polling', 'downloading']);

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };
const editOf = (task) => (parseJson(task.params) || {})._edit || null;
const genOf = (task) => (parseJson(task.params) || {})._gen || null;
const staticRef = (rel) => (rel ? `/static/${String(rel).replace(/^\/+/, '')}` : '');
const nowIso = () => new Date().toISOString();
const rand = () => `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

/** 适配器的能力列表（不联网：只建适配器对象读它声明的能力）。 */
function defaultCapabilities(provider) {
  const { createProviders } = require('../providers');
  const facade = createProviders({ [provider]: { apiKey: '' } });
  const a = facade.registry.list().find((x) => x.id === provider);
  return a ? a.capabilities : [];
}

function createRegionEditService({
  db, store: taskStore, worker = null, spend, storageRoot, listConfigs = null, catalogModels = () => [],
  log = console, ffmpeg = null, capabilities = null, resolution = null,
}) {
  if (!db || !taskStore || !spend || !storageRoot) throw new Error('db, store, spend and storageRoot are required');
  const list = listConfigs || ((type) => require('../services/aiConfigService').listConfigsInternal(db, type));
  const ff = ffmpeg || createFfmpeg();
  const caps = capabilities || defaultCapabilities;
  const warn = (msg, extra) => { try { (log.warn || log.error || (() => {})).call(log, msg, extra); } catch (_) { /* ignore */ } };
  const hasVideoEdit = (provider) => { try { return (caps(provider) || []).includes('video.edit'); } catch (_) { return false; } };

  // ---------- 图与镜头 ----------

  function episodeRow(ep) {
    const row = db.prepare('SELECT id, drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(ep));
    if (!row) throw new RegionEditError('NOT_FOUND', `分集 ${ep} 不存在`, 404);
    return row;
  }

  function openGraph(ep) {
    episodeRow(ep);
    if (!store.hasProject(db, ep)) legacy.importLegacy(db, ep);
    return store.openProject(db, ep);
  }

  /** 镜头引用：数字 = storyboards.id（由此找到分集）；字符串 = 镜头节点 id（需给 episode_id）。 */
  function resolveShot(ref, episodeId) {
    const numeric = /^\d+$/.test(String(ref));
    let ep = episodeId != null && episodeId !== '' ? Number(episodeId) : null;
    if (numeric) {
      const row = db.prepare('SELECT id, episode_id FROM storyboards WHERE id = ?').get(Number(ref));
      if (!row) throw new RegionEditError('NOT_FOUND', `镜头不存在：${ref}`, 404);
      ep = row.episode_id;
    } else if (!Number.isInteger(ep) || ep <= 0) {
      throw new RegionEditError('BAD_REQUEST', '按节点 id 引用镜头时需要 episode_id');
    }
    const opened = openGraph(ep);
    const g = opened.graph;
    let shotId = null;
    if (numeric) shotId = kernel.shotOrder(g).find((id) => g.nodes[id].legacy_id === Number(ref)) || null;
    else if (g.nodes[ref] && g.nodes[ref].type === 'shot') shotId = ref;
    if (!shotId) throw new RegionEditError('NOT_FOUND', `镜头不存在：${ref}`, 404);
    return { ep, graph: g, seq: opened.seq, shotId, legacyId: g.nodes[shotId].legacy_id ?? null };
  }

  /** 资产的本地文件（asset.path 或 /static/<rel> 引用，限定在存储目录内）；没有为 null。 */
  function localPath(asset) {
    if (!asset) return null;
    const rel = asset.path || (typeof asset.ref === 'string' && asset.ref.startsWith('/static/') ? asset.ref.slice('/static/'.length) : null);
    if (!rel) return null;
    const root = path.resolve(storageRoot);
    const abs = path.resolve(root, rel);
    const within = path.relative(root, abs);
    if (!within || within.startsWith('..') || path.isAbsolute(within)) return null;
    return abs;
  }
  const relOf = (abs) => path.relative(path.resolve(storageRoot), abs).split(path.sep).join('/');
  const absOf = (rel) => path.join(storageRoot, ...String(rel).split('/'));

  // ---------- 计划 / 估算 ----------

  /** 在图上为一次改片做计划（纯读）：校验、改片后的 key、策略、模型、估价。 */
  function plan(ctx, { t0_ms, t1_ms, rect, prompt, mode = 'region' } = {}) {
    const { graph: g, shotId, ep, legacyId } = ctx;
    const video = kernel.partsOfShot(g, shotId).video;
    const base = video ? kernel.adoptedVersion(g, video) : null;
    if (!base || !base.asset || !base.asset.ref) throw new RegionEditError('REGION_EDIT_NO_VIDEO', null, 409);
    let tx;
    try {
      tx = kernel.intents.shot.editShotRegion(g, shotId, { t0_ms, t1_ms, rect, prompt, mode }, { tx_id: 'sim' });
    } catch (e) {
      if (e instanceof KernelError) throw new RegionEditError('BAD_REQUEST', `入出点、区域或提示词不合法：${e.message}`);
      throw e;
    }
    const edit = tx.meta.edit;
    const sim = tx.ops.length ? kernel.applyTx(g, tx).graph : g; // 只在副本上演算：估算与提交都不改图
    const cache_key = kernel.cacheKeys(sim)[video];
    const total_ms = kernel.realVideoMs(g, shotId) || g.nodes[shotId].params.duration_ms || kernel.DEFAULT_SHOT_MS;
    const { provider, ready } = chooseProvider(list, 'video');
    const strategy = pickStrategy(hasVideoEdit(provider));
    const saved = g.nodes[video].params.model;
    // 降级路径一定带首尾帧，所以按“有首帧”选模型（节点里保存的整镜模型可能是文生视频的，不适用）
    const model = strategy === 'segment_splice'
      ? pickModel({ provider, kind: 'video', hasFrame: true, listConfigs: list, catalogModels: catalogModels() || [] })
      : (saved && saved !== 'default' ? saved : undefined);
    const seconds = segmentSeconds(edit.t0_ms, edit.t1_ms);
    const shot = g.nodes[shotId].params;
    const params = { prompt: strategy === 'segment_splice' ? fallbackPrompt(edit, shot.video_prompt || shot.description) : edit.prompt, duration: seconds };
    if (model) params.model = model;
    if (resolution) params.resolution = resolution;
    const dramaId = episodeRow(ep).drama_id;
    if (dramaId != null) params._project = String(dramaId);
    const spec = { provider, kind: 'video', params };
    const check = spend.checkBatch([spec]);
    const full = spend.estimate({ provider, kind: 'video', params: { ...params, duration: fullSeconds(total_ms) } });
    return { ep, shotId, storyboard_id: legacyId, node: video, base, edit, cache_key, total_ms, seconds, strategy, provider, provider_ready: ready, model: model || null, spec, check, full };
  }

  function estimateView(p) {
    const est = p.check.estimates[0];
    return {
      episode_id: p.ep, shot_id: p.shotId, storyboard_id: p.storyboard_id, node: p.node, confirmed: false,
      base_version_id: p.base.id, total_ms: p.total_ms, edit: p.edit,
      strategy: p.strategy, provider: p.provider, provider_ready: p.provider_ready, model: p.model,
      segment: { t0_ms: p.edit.t0_ms, t1_ms: p.edit.t1_ms, seconds: p.seconds },
      estimate: {
        cents: toCents(p.check.total), total: p.check.total, max: p.check.max, currency: p.check.currency,
        basis: est ? est.basis : null, known: p.check.known, sample_prices: p.check.sample_prices,
        full: { cents: toCents(p.full.estimate), total: p.full.estimate, seconds: fullSeconds(p.total_ms) },
      },
      cap: p.check.cap,
      allowed: p.check.ok,
      refusal: p.check.ok ? null : { reason: p.check.reason, message: p.check.message },
    };
  }

  /** confirm=false 的入口：只估算。 */
  function estimate(ref, args = {}) {
    return estimateView(plan(resolveShot(ref, args.episode_id), args));
  }

  // ---------- 建任务 ----------

  async function storeBlob(file) {
    const sha256 = await sha256File(file);
    const dest = blobPath(storageRoot, sha256);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) {
      const tmp = `${dest}.${process.pid}.tmp`;
      await fsp.copyFile(file, tmp);
      await fsp.rename(tmp, dest);
    }
    const st = await fsp.stat(dest);
    return { sha256, size: st.size, rel: relOf(dest) };
  }

  const asFfmpegError = (e) => (e instanceof FfmpegError || (e && e.code === 'REGION_EDIT_FFMPEG')
    ? new RegionEditError('REGION_EDIT_FFMPEG', `${describeError('REGION_EDIT_FFMPEG').message}：${e.message}`, 500)
    : e);

  /** 截取入点与出点的画面（出点在片尾时取最后一帧），写进内容寻址目录。 */
  async function extractFrames(basePath, edit) {
    const tmpDir = path.join(storageRoot, 'tmp');
    await fsp.mkdir(tmpDir, { recursive: true });
    try {
      const probe = await ff.probe(basePath);
      const frameMs = probe.fps > 0 ? 1000 / probe.fps : 40;
      const lastFrameAt = Math.max(0, probe.duration_ms - frameMs);
      const grab = async (ms, tag) => {
        const tmp = path.join(tmpDir, `edit-frame-${tag}-${rand()}.png`);
        try {
          await ff.extractFrame(basePath, ms, tmp);
          if (!fs.existsSync(tmp)) throw new FfmpegError(`在 ${ms} ms 处没有截到画面`);
          const b = await storeBlob(tmp);
          return { ref: staticRef(b.rel), at_ms: Math.round(ms), hash: b.sha256 };
        } finally {
          await fsp.rm(tmp, { force: true }).catch(() => {});
        }
      };
      return { first: await grab(Math.min(edit.t0_ms, lastFrameAt), 'in'), last: await grab(Math.min(edit.t1_ms, lastFrameAt), 'out'), real_ms: probe.duration_ms };
    } catch (e) {
      throw asFfmpegError(e);
    }
  }

  function idempotencyKey(p, params) {
    const extra = kernel.sha256(kernel.canonicalJSON({
      provider: p.provider, strategy: p.strategy, model: params.model || null, first: params.firstFrameUrl || null, last: params.lastFrameUrl || null,
      duration: params.duration || null, resolution: params.resolution || null,
    }));
    return `${EDIT_PREFIX}${p.ep}:${p.node}:${p.cache_key.slice(0, 32)}:${extra.slice(0, 12)}`;
  }

  const rowById = (id) => db.prepare('SELECT * FROM edit_regions WHERE id = ?').get(Number(id)) || null;
  const rowByTask = (taskId) => db.prepare('SELECT * FROM edit_regions WHERE task_id = ? ORDER BY id DESC').get(taskId) || null;
  function insertRow(p, { task_id = null, status = 'queued' } = {}) {
    const t = nowIso();
    const info = db.prepare(
      `INSERT INTO edit_regions (episode_id, node_id, base_version_id, t0_ms, t1_ms, rect, prompt, mode, strategy, task_id, status, cost_estimate_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(p.ep, p.node, p.base.id, p.edit.t0_ms, p.edit.t1_ms, JSON.stringify(p.edit.rect), p.edit.prompt, p.edit.mode, p.strategy, task_id, status, toCents(p.check.total), t, t);
    return rowById(info.lastInsertRowid);
  }
  function updateRow(id, patch) {
    const cols = { ...patch, updated_at: nowIso() };
    const sets = Object.keys(cols).map((c) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE edit_regions SET ${sets} WHERE id = @id`).run({ ...cols, id: Number(id) });
    return rowById(id);
  }
  const markFailed = (row, error) => (row ? updateRow(row.id, { status: 'failed', error: error ? String(error).slice(0, 500) : null }) : null);

  function refusal(check, ep) {
    return new RegionEditError('SPEND_LIMIT', check.message, 402, {
      reason: check.reason, estimate: check.total, max: check.max, currency: check.currency, episode_id: Number(ep),
    });
  }

  /**
   * confirm=true：估算 + 额度检查（超限不建任务、不写任何东西）-> 截帧（降级路径）-> 记行 + 建任务 -> 唤醒 worker。
   * 同一配方再点一次：排队 / 已完成的复用，失败的重试，不建新任务。
   */
  async function submit(ref, args = {}) {
    const ctx = resolveShot(ref, args.episode_id);
    const p = plan(ctx, args);
    if (!p.check.ok) throw refusal(p.check, p.ep);
    if (!p.provider_ready) throw new RegionEditError('INVALID_API_KEY', `未配置 ${p.provider} 的视频服务或 Key，请先在设置里添加`, 400);
    const params = { ...p.spec.params };
    let frames = null;
    let baseRel = null;
    if (p.strategy === 'segment_splice') {
      const basePath = localPath(p.base.asset);
      if (!basePath || !fs.existsSync(basePath)) throw new RegionEditError('REGION_EDIT_BASE_MISSING', null, 409);
      baseRel = relOf(basePath);
      frames = await extractFrames(basePath, p.edit);
      params.firstFrameUrl = frames.first.ref;
      params.lastFrameUrl = frames.last.ref;
    } else {
      params.videoUrl = p.base.asset.ref;
      params.edit = { t0_ms: p.edit.t0_ms, t1_ms: p.edit.t1_ms, rect: p.edit.rect, mode: p.edit.mode };
    }
    const baseKey = idempotencyKey(p, params);
    let key = baseKey;
    let existing = taskStore.getByKey(key);
    if (existing && existing.state === 'cancelled') {
      const n = db.prepare('SELECT COUNT(*) n FROM ai_tasks WHERE idempotency_key = ? OR idempotency_key LIKE ?').get(baseKey, `${baseKey}:c%`).n;
      key = `${baseKey}:c${n}`;
      existing = taskStore.getByKey(key);
    }
    let outcome;
    let task;
    let row = existing ? rowByTask(existing.id) : null;
    if (!existing) {
      ({ task, row } = db.transaction(() => {
        const r = insertRow(p);
        const full = {
          ...params,
          _gen: { episode_id: p.ep, shot_id: p.shotId, storyboard_id: p.storyboard_id, node: p.node, kind: 'video', cache_key: p.cache_key, inputs: { model: p.model, reference_hashes: [], tail_frame_hash: null } },
          _edit: {
            id: r.id, strategy: p.strategy, base_version_id: p.base.id, base_rel: baseRel, total_ms: p.total_ms,
            t0_ms: p.edit.t0_ms, t1_ms: p.edit.t1_ms, rect: p.edit.rect, mode: p.edit.mode, recipe: p.edit,
            ...(frames ? { frames: { first: frames.first, last: frames.last, real_ms: frames.real_ms } } : {}),
          },
        };
        const t = taskStore.enqueue({ idempotencyKey: key, provider: p.provider, kind: 'video', params: full }).task;
        return { task: t, row: updateRow(r.id, { task_id: t.id }) };
      })());
      outcome = 'created';
    } else if (existing.state === 'failed') {
      const uncertain = existing.error_message && String(existing.error_message).startsWith('SUBMIT_UNCERTAIN');
      if (uncertain) { outcome = 'uncertain'; task = existing; }
      else { taskStore.retry(existing.id); task = taskStore.get(existing.id); outcome = 'retried'; }
      if (!row) row = insertRow(p, { task_id: existing.id, status: uncertain ? 'failed' : 'queued' });
      else if (!uncertain) row = updateRow(row.id, { status: 'queued', error: null });
    } else {
      task = existing;
      outcome = existing.state === 'succeeded' ? 'already_done' : 'already_queued';
      if (!row) row = insertRow(p, { task_id: existing.id });
      if (existing.state === 'succeeded' && row.status !== 'done') onTaskFinished(existing); // 结果已在：直接写回
    }
    if (outcome === 'created' || outcome === 'retried') { if (worker) worker.wake(); }
    return { ...estimateView(p), confirmed: true, outcome, task: { id: task.id, state: task.state }, region: rowView(row) };
  }

  // ---------- 写回 ----------

  /** 降级路径：原片 [0,t0) + 生成片段（缩放到 t1-t0）+ 原片 [t1,end) -> 内容寻址目录。 */
  async function splice(ed, insert, taskId) {
    const base = ed.base_rel ? absOf(ed.base_rel) : null;
    if (!base || !fs.existsSync(base)) throw new RegionEditError('REGION_EDIT_BASE_MISSING', null, 409);
    const tmpDir = path.join(storageRoot, 'tmp');
    await fsp.mkdir(tmpDir, { recursive: true });
    const output = path.join(tmpDir, `edit-${taskId}.mp4`);
    try {
      const bp = await ff.probe(base);
      const ip = await ff.probe(insert);
      // 以探测到的真实片长为准（元数据里的时长可能是请求值）
      const t1 = Math.min(ed.t1_ms, bp.duration_ms);
      const t0 = Math.max(0, Math.min(ed.t0_ms, t1 - 1));
      await ff.splice({ base, insert, output, t0_ms: t0, t1_ms: t1, base_ms: bp.duration_ms, insert_ms: ip.duration_ms, width: bp.width, height: bp.height, fps: bp.fps, has_audio: bp.has_audio });
      const stored = await storeBlob(output);
      const op = await ff.probe(absOf(stored.rel));
      return { ...stored, duration_ms: op.duration_ms, insert_ms: ip.duration_ms, base_ms: bp.duration_ms };
    } catch (e) {
      throw asFfmpegError(e);
    } finally {
      await fsp.rm(output, { force: true }).catch(() => {});
    }
  }

  /** 任务结果 -> 新版本的资产与元数据（含改片配方，供 adoptShotVersion 让参数跟随）。 */
  async function buildResult(task, ed, gen) {
    const result = parseJson(task.result) || {};
    const file = Array.isArray(result.files) && result.files[0] ? result.files[0] : null;
    if (!file || !file.path) throw new Skip('任务结果里没有可用的文件');
    const generated = absOf(file.path);
    const params = parseJson(task.params) || {};
    const meta = { edit: ed.recipe, strategy: ed.strategy, base_version_id: ed.base_version_id, task_id: task.id, provider: task.provider, inputs: gen.inputs || { model: params.model || null } };
    if (params.model) meta.model = params.model;
    if (ed.strategy === 'segment_splice') {
      const out = await splice(ed, generated, task.id);
      Object.assign(meta, { duration_ms: out.duration_ms, duration_source: 'probe', segment_ms: out.insert_ms, segment_ref: staticRef(file.path) });
      return { asset: { ref: staticRef(out.rel), kind: 'video', hash: out.sha256, size: out.size, path: out.rel }, meta };
    }
    let ms = null;
    try { ms = (await ff.probe(generated)).duration_ms; meta.duration_source = 'probe'; } catch (_) { ms = null; }
    if (ms == null) {
      const sec = Number(result.usage && result.usage.duration);
      if (Number.isFinite(sec) && sec > 0) { ms = Math.round(sec * 1000); meta.duration_source = 'provider'; }
    }
    if (ms == null) { ms = ed.total_ms; meta.duration_source = 'base'; }
    meta.duration_ms = ms;
    return { asset: { ref: staticRef(file.path), kind: 'video', hash: file.sha256 || kernel.sha256(`ref:${file.path}`), size: file.size, path: file.path }, meta };
  }

  /**
   * 成功任务 -> 内核：只 addVersion（不采用），版本 cache_key = 提交时算出的改片后 key，metadata.edit = 配方。
   * 同一任务重复写回是空操作（tx_id 固定）。失败只改 edit_regions 行。
   */
  async function finishTask(task) {
    const ed = editOf(task);
    const gen = genOf(task);
    if (!ed || !gen || task.state !== 'succeeded') return { recorded: false, reason: 'not_applicable' };
    const ep = Number(gen.episode_id);
    const row = rowById(ed.id) || rowByTask(task.id);
    if (!store.hasProject(db, ep)) { markFailed(row, '项目图不存在'); return { recorded: false, reason: 'no_graph' }; }
    const vid = `t_${task.id}`;
    const done = (r) => { if (row && (row.status !== 'done' || row.result_version_id !== vid)) updateRow(row.id, { status: 'done', result_version_id: vid, error: null }); return r; };
    const g0 = store.openProject(db, ep).graph;
    if ((g0.versions[gen.node] || []).some((v) => v.id === vid)) return done({ recorded: false, reason: 'already_recorded', version_id: vid });
    try {
      const { asset, meta } = await buildResult(task, ed, gen);
      const r = store.commit(db, ep, (g) => {
        const node = g.nodes[gen.node];
        if (!node || node.type !== 'video') throw new Skip('节点已不存在');
        const ops = (g.versions[gen.node] || []).some((v) => v.id === vid) ? [] : [
          { op: 'addVersion', node: gen.node, version: { id: vid, cache_key: gen.cache_key, asset, metadata: meta, source: `region-edit:${ed.id}` } },
        ];
        return { tx_id: `edit-done:${task.id}`, label: 'region edit', ops };
      }, { tx_id: `edit-done:${task.id}` });
      return done({ recorded: r.applied, reason: r.applied ? 'recorded' : 'already_recorded', version_id: vid });
    } catch (e) {
      markFailed(row, e && e.message);
      if (e instanceof Skip) return { recorded: false, reason: e.message };
      throw e;
    }
  }

  const pending = new Set();
  /** worker 的 onTaskFinished 入口（同步返回；写回在后台完成）。只认 `edit:` 前缀的任务。 */
  function onTaskFinished(task) {
    if (!task || !String(task.idempotency_key || '').startsWith(EDIT_PREFIX)) return null;
    if (task.state === 'succeeded') {
      const p = finishTask(task).catch((e) => warn('region edit write-back', { error: e && e.message, task: task.id }));
      pending.add(p);
      p.finally(() => pending.delete(p));
      return p;
    }
    if (task.state === 'failed' || task.state === 'cancelled') {
      const ed = editOf(task);
      const row = (ed && rowById(ed.id)) || rowByTask(task.id);
      if (row && row.status !== 'done') markFailed(row, task.error_message || task.error_code || task.state);
    }
    return null;
  }

  /** 等所有进行中的写回结束（测试与优雅退出用）。 */
  const idle = async () => { while (pending.size) await Promise.all([...pending]); };

  /** 启动恢复：已成功但没写回的补写（tx_id 固定，已写过的是空操作）；已失败但行还在排队的改成失败。 */
  async function recoverFinished() {
    db.prepare(`UPDATE edit_regions SET status = 'failed', error = COALESCE((SELECT error_message FROM ai_tasks t WHERE t.id = edit_regions.task_id), error), updated_at = ?
                WHERE status NOT IN ('done', 'failed') AND task_id IN (SELECT id FROM ai_tasks WHERE state IN ('failed', 'cancelled') AND idempotency_key LIKE ?)`).run(nowIso(), `${EDIT_PREFIX}%`);
    const rows = db.prepare(`SELECT * FROM ai_tasks WHERE state = 'succeeded' AND idempotency_key LIKE ? ORDER BY completed_at, rowid`).all(`${EDIT_PREFIX}%`);
    const out = [];
    for (const t of rows) {
      const ed = editOf(t);
      const row = ed && rowById(ed.id);
      if (row && row.status === 'done') continue;
      try { out.push({ task_id: t.id, ...(await finishTask(t)) }); } catch (e) { warn('region edit recover', { error: e && e.message, task: t.id }); }
    }
    return out;
  }

  // ---------- 列表 / 采用 ----------

  function rowView(row) {
    const task = row.task_id ? taskStore.get(row.task_id) : null;
    let status = row.status;
    if (status !== 'done' && status !== 'failed' && task) {
      if (task.state === 'queued') status = 'queued';
      else if (ACTIVE.has(task.state) || task.state === 'succeeded') status = 'running'; // succeeded 但行未 done = 写回中
      else if (task.state === 'failed' || task.state === 'cancelled') status = 'failed';
    }
    return {
      id: row.id, episode_id: row.episode_id, node: row.node_id, base_version_id: row.base_version_id,
      t0_ms: row.t0_ms, t1_ms: row.t1_ms, rect: parseJson(row.rect), prompt: row.prompt, mode: row.mode, strategy: row.strategy,
      task_id: row.task_id, task_state: task ? task.state : null, result_version_id: row.result_version_id, status,
      cost_estimate_cents: row.cost_estimate_cents, error: row.error || (task && task.state === 'failed' ? task.error_message : null),
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  /** 该镜头的改片记录（新的在前）+ 视频节点的内核版本列表（与 GET /episodes/:id/versions 同一份摘要）。 */
  function listRegions(ref, args = {}) {
    const ctx = resolveShot(ref, args.episode_id);
    const { graph: g, shotId, ep } = ctx;
    const video = kernel.partsOfShot(g, shotId).video;
    const rows = video ? db.prepare('SELECT * FROM edit_regions WHERE episode_id = ? AND node_id = ? ORDER BY id DESC').all(ep, video) : [];
    const versions = video ? require('../routes/kernel').nodeVersions(db, ep, g).find((v) => v.node === video) || null : null;
    const { provider, ready } = chooseProvider(list, 'video');
    return {
      episode_id: ep, shot_id: shotId, storyboard_id: ctx.legacyId, node: video, seq: ctx.seq,
      total_ms: kernel.realVideoMs(g, shotId), adopted: video ? g.adopted[video] || null : null,
      strategy: pickStrategy(hasVideoEdit(provider)), provider, provider_ready: ready,
      items: rows.map(rowView), versions,
    };
  }

  /** 采用某个视频版本（原版本或改片结果）：经 adoptShotVersion，节点参数跟随版本配方。已采用且参数一致 = 空操作，不写日志。 */
  function adoptVersion(ref, { version_id, episode_id, tx_id } = {}) {
    if (typeof version_id !== 'string' || !version_id) throw new RegionEditError('BAD_REQUEST', 'version_id 必填');
    const ctx = resolveShot(ref, episode_id);
    const id = tx_id || `edit-adopt-${rand()}`;
    const build = (g) => kernel.intents.shot.adoptShotVersion(g, ctx.shotId, { version_id }, { tx_id: id });
    try {
      const probe = build(ctx.graph);
      if (!probe.ops.length) {
        return { applied: false, tx_id: id, seq: ctx.seq, version_id, node: probe.meta.node, invalidated: [], revalidated: [], stale: kernel.staleSet(ctx.graph) };
      }
      const r = store.commit(db, ctx.ep, build, { tx_id: id });
      return {
        applied: r.applied, tx_id: r.tx_id, seq: r.seq, version_id, node: r.meta ? r.meta.node : probe.meta.node,
        invalidated: r.invalidated, revalidated: r.revalidated, stale: kernel.staleSet(r.graph), can_undo: r.canUndo, can_redo: r.canRedo,
      };
    } catch (e) {
      if (e instanceof KernelError) throw new RegionEditError(/not found/.test(e.message) ? 'NOT_FOUND' : 'BAD_REQUEST', e.message, /not found/.test(e.message) ? 404 : 400);
      throw e;
    }
  }

  return { estimate, submit, listRegions, adoptVersion, onTaskFinished, finishTask, recoverFinished, idle, plan, resolveShot, hasVideoEdit };
}

module.exports = { createRegionEditService, RegionEditError, EDIT_PREFIX };
