'use strict';
/**
 * 旁白配音走持久队列（任务中心可见）：估价 -> 确认 -> 建 tts 任务 -> 任务成功时经内核 recordGeneration 写回。
 *
 * 行为与之前直连 provider 的版本一致：
 *   - 配音文字取自 script_line（service.spokenText），对白去掉“说话人：”；
 *   - 音色先经 shot.setVoice 写进 narration 节点（进 cacheKey），任务的 cache_key 即建任务时的 narration key；
 *   - 幂等键由 narration cacheKey 派生：台词/音色没变就复用已有任务（排队中的不重复提交）；
 *     用户明确要求重做（点名镜头或 force）而上次任务已成功落地时才换键重做；
 *   - 写回在同一个 SQLite 事务里基于最新图构造；期间台词或音色被改过就不采用（STALE_INPUT，只记日志）；
 *   - 音频从队列的内容寻址 blob 复制到 audio/narration/e<ep>_<shot>_<hash10>.<format>（与直连版同一路径规则），
 *     词级时间戳从 words blob 读出，字幕块 cues 由 splitCues 算出，一起存进版本 metadata；
 *   - 花费由队列的 spend.recordFinished 统一记账（含真实字数回写），本服务不再单独写 spend_log。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kernel = require('@talekiln/kernel');
const store = require('../kernel/store');
const legacy = require('../kernel/legacy');
const svc = require('./service');
const { splitCues } = require('../subtitles');
const enablement = require('../providers/enablement');

const { KernelError } = kernel;
const I = kernel.intents;

const VO_PREFIX = 'vo:';
const ACTIVE = new Set(['queued', 'submitting', 'submitted', 'polling', 'downloading']);

class VoiceoverError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'VoiceoverError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
class SkipAdoption extends Error {}

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };
const voOf = (task) => (parseJson(task.params) || {})._vo || null;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 默认的配音目标：按已启用的服务商取其 tts 配置（或同一 Key 的其他配置）的 provider / 默认模型。facade 由队列适配器自己建。 */
function defaultTarget(listConfigs) {
  const { pickConfig, pickSharedKeyConfig } = require('../queue/providerAdapter');
  return (preferred) => {
    for (const p of enablement.getEnabled()) {
      if (preferred && preferred !== p) continue;
      const own = pickConfig(listConfigs, p, 'tts');
      const cfg = own && own.api_key ? own : pickSharedKeyConfig(listConfigs, p, 'tts');
      if (!cfg || !cfg.api_key) continue;
      const model = own === cfg ? (cfg.default_model || (Array.isArray(cfg.model) ? cfg.model[0] : cfg.model)) : undefined;
      return { provider: p, model: model || undefined };
    }
    return null;
  };
}

function aspectOf(db, episodeId) {
  try {
    const row = db.prepare('SELECT d.metadata FROM episodes e JOIN dramas d ON d.id = e.drama_id WHERE e.id = ?').get(episodeId);
    const m = row && row.metadata ? JSON.parse(row.metadata) : {};
    return ['9:16', '16:9', '1:1'].includes(m.aspect_ratio) ? m.aspect_ratio : '9:16';
  } catch (_) { return '9:16'; }
}

/**
 * @param {object} o
 * @param {object} o.db
 * @param {object} o.store         队列任务存储（createAiTaskStore）
 * @param {object} [o.worker]      有则建任务后 wake()
 * @param {object} o.spend         花费服务（estimate / checkBatch）
 * @param {string} o.storageRoot
 * @param {(preferred?:string)=>({provider,model}|null)} [o.resolve]  配音目标解析（测试注入）
 * @param {(type:string)=>object[]} [o.listConfigs]
 */
function createVoiceoverService({ db, store: taskStore, worker = null, spend, storageRoot, resolve = null, listConfigs = null, log = console }) {
  if (!db || !taskStore || !spend || !storageRoot) throw new Error('db, store, spend and storageRoot are required');
  const list = listConfigs || ((type) => require('../services/aiConfigService').listConfigsInternal(db, type));
  const target = resolve || defaultTarget(list);
  const warn = (msg, extra) => { try { (log.warn || log.error || (() => {})).call(log, msg, extra); } catch (_) { /* ignore */ } };

  function episodeRow(ep) {
    const row = db.prepare('SELECT id, drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(ep));
    if (!row) throw new KernelError('NOT_FOUND', `分集 ${ep} 不存在`);
    return row;
  }

  function openGraph(ep) {
    episodeRow(ep);
    if (!store.hasProject(db, ep)) legacy.importLegacy(db, ep);
    return store.openProject(db, ep);
  }

  // ---------- 估价 ----------

  /**
   * 计划 + 估价 + 额度检查。不建任务、不写图。
   * args: { shots: [id...] | all: true, voice?, force?, provider? }
   */
  function estimate(ep, args = {}) {
    const all = args.all === true || args.shots === 'all';
    const { graph } = openGraph(ep);
    const items = svc.plan(graph, { shots: args.shots, all, voice: args.voice, force: args.force === true });
    const t = target(args.provider);
    if (!t) throw new VoiceoverError('NO_TTS_PROVIDER', `未找到可用的配音服务配置（${enablement.enabledLabels()}）`, 400);
    const { provider, model } = t;
    const sum = svc.summarize(items, { estimate: (spec) => spend.estimate(spec) }, provider, model);
    const todo = items.filter((i) => !i.skip);
    const check = spend.checkBatch(todo.map((i) => ({ provider, kind: 'tts', params: { model, text: i.text } })));
    const base = {
      episode_id: Number(ep), provider, model: model || null, voice: args.voice || null,
      shots: todo.length, chars: todo.reduce((a, i) => a + i.chars, 0), ...sum,
      allowed: check.ok, ...(check.ok ? {} : { error_code: 'SPEND_LIMIT', limit_reason: check.reason, message: check.message }),
    };
    return { items, todo, provider, model, check, base, explicit: !all || args.force === true };
  }

  /** confirm=false：只估价。 */
  function preview(ep, args) {
    const e = estimate(ep, args);
    return { confirm_required: e.todo.length > 0, confirmed: false, ...e.base };
  }

  // ---------- 建任务 ----------

  function idempotencyKey(ep, node, cacheKey, provider, model) {
    const extra = kernel.sha256(kernel.canonicalJSON({ provider, model: model || null }));
    return `${VO_PREFIX}${Number(ep)}:${node}:${String(cacheKey).slice(0, 32)}:${extra.slice(0, 12)}`;
  }

  const landed = (g, node, taskId) => (g.versions[node] || []).some((v) => v.id === `t_${taskId}`);

  /**
   * 同键任务已存在时：排队中复用；失败的重试（SUBMIT_UNCERTAIN 除外）；取消的换键重建；
   * 已成功：结果已落地且是明确重做 -> 换键重做，否则复用（写回待恢复）。
   */
  function enqueueOrReuse(g, it, key, spec, explicit) {
    let k = key;
    let existing = taskStore.getByKey(k);
    const nextKey = (suffix) => {
      const n = db.prepare('SELECT COUNT(*) n FROM ai_tasks WHERE idempotency_key = ? OR idempotency_key LIKE ?').get(key, `${key}:%`).n;
      return `${key}:${suffix}${n}`;
    };
    if (existing && existing.state === 'cancelled') { k = nextKey('c'); existing = taskStore.getByKey(k); }
    if (existing && existing.state === 'succeeded' && explicit && landed(g, it.node, existing.id)) { k = nextKey('r'); existing = taskStore.getByKey(k); }
    if (!existing) {
      const { task } = taskStore.enqueue({ idempotencyKey: k, provider: spec.provider, kind: 'tts', params: spec.params });
      return { outcome: 'created', task };
    }
    if (existing.state === 'failed') {
      if (existing.error_message && String(existing.error_message).startsWith('SUBMIT_UNCERTAIN')) return { outcome: 'uncertain', task: existing };
      taskStore.retry(existing.id);
      return { outcome: 'retried', task: taskStore.get(existing.id) };
    }
    if (existing.state === 'succeeded') return { outcome: 'already_done', task: existing };
    return { outcome: 'already_queued', task: existing };
  }

  /**
   * confirm=true：超额度整批拒绝（402，不建任何任务）；否则逐镜：音色写进节点 -> 建任务；最后唤醒 worker。
   * 返回 { ...估价, confirmed: true, tasks: [{ shot_id, legacy_id, outcome, task_id, state }], skipped }。
   */
  function create(ep, args = {}) {
    const e = estimate(ep, args);
    if (!e.check.ok) {
      throw new VoiceoverError('SPEND_LIMIT', e.check.message, 402, { reason: e.check.reason, estimate: e.base.estimate, max: e.base.max, currency: e.base.currency });
    }
    const skipped = e.items.filter((i) => i.skip).map((i) => ({ shot_id: i.shot_id, legacy_id: i.legacy_id, reason: i.skip }));
    if (!e.todo.length) return { ...e.base, confirmed: true, tasks: [], skipped };
    const dramaId = episodeRow(ep).drama_id;
    const aspect = aspectOf(db, ep);
    const tasks = [];
    for (const it of e.todo) {
      // 1) 音色先写进 narration 节点：任务的 cache_key 与写回时的 key 都包含音色
      let { graph: g } = store.openProject(db, ep);
      let nar = kernel.partsOfShot(g, it.shot_id).narration;
      if (!nar) { skipped.push({ shot_id: it.shot_id, legacy_id: it.legacy_id, reason: 'no_narration_node' }); continue; }
      if (g.nodes[nar].params.voice !== it.voice) {
        store.commit(db, ep, (x) => I.shot.setVoice(x, it.shot_id, { voice: it.voice }));
        g = store.openProject(db, ep).graph;
        nar = kernel.partsOfShot(g, it.shot_id).narration;
      }
      const cacheKey = kernel.cacheKeys(g)[nar];
      const item = { ...it, node: nar, cache_key: cacheKey };
      const params = {
        model: e.model || undefined, text: it.text, voice: it.voice, wordTimestamps: true,
        _project: String(dramaId),
        _vo: { episode_id: Number(ep), shot_id: it.shot_id, legacy_id: it.legacy_id, node: nar, cache_key: cacheKey, voice: it.voice, text_sha: sha(it.text), aspect_ratio: aspect },
      };
      if (!params.model) delete params.model;
      const r = enqueueOrReuse(g, item, idempotencyKey(ep, nar, cacheKey, e.provider, e.model), { provider: e.provider, params }, e.explicit);
      tasks.push({ shot_id: it.shot_id, legacy_id: it.legacy_id, voice: it.voice, outcome: r.outcome, task_id: r.task.id, state: r.task.state });
    }
    if (tasks.length && worker) worker.wake();
    return { ...e.base, confirmed: true, tasks, skipped };
  }

  // ---------- 写回 ----------

  const absOf = (rel) => path.join(storageRoot, ...String(rel).split('/'));

  /** 任务结果（队列适配器的 sync 结果）-> 音频文件（复制到 audio/narration）+ 词级时间戳。 */
  async function materialize(task, vo) {
    const result = parseJson(task.result) || {};
    if (!result.path || !result.sha256) throw new SkipAdoption('任务结果里没有音频文件');
    const src = absOf(result.path);
    if (!fs.existsSync(src)) throw new SkipAdoption(`音频文件不存在：${result.path}`);
    const format = String(result.format || 'mp3').replace(/[^A-Za-z0-9]/g, '') || 'mp3';
    const hash = result.sha256;
    const rel = `audio/narration/e${vo.episode_id}_${vo.shot_id}_${hash.slice(0, 10)}.${format}`;
    const abs = absOf(rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) {
      const tmp = `${abs}.${process.pid}.tmp`;
      await fs.promises.copyFile(src, tmp);
      await fs.promises.rename(tmp, abs);
    }
    let words = [];
    if (result.words && result.words.path) {
      const raw = parseJson(await fs.promises.readFile(absOf(result.words.path), 'utf8'));
      if (Array.isArray(raw)) words = raw.map((w) => ({ text: w.text, startMs: Math.round(w.startMs), endMs: Math.round(w.endMs) }));
    }
    return { rel, hash, format, words, size: result.size };
  }

  /**
   * 成功任务 -> 内核：一次 commit（recordGeneration：addVersion + adoptVersion，key 取自写回时的图）。
   * 台词或音色与建任务时不同 -> 不写（结果留在任务里，重做时再生成）。同一任务重复写回是空操作（tx_id 固定）。
   */
  async function adoptTask(task) {
    const vo = voOf(task);
    if (!vo || task.state !== 'succeeded') return { adopted: false, reason: 'not_applicable' };
    const ep = Number(vo.episode_id);
    if (!store.hasProject(db, ep)) return { adopted: false, reason: 'no_graph' };
    const txId = `vo-done:${task.id}`;
    try {
      // 已写过（崩溃恢复、重复回调）：直接跳过，不再复制文件
      const g0 = store.openProject(db, ep).graph;
      if (landed(g0, vo.node, task.id)) return { adopted: false, reason: 'already_recorded' };
      const { rel, hash, format, words } = await materialize(task, vo);
      const durationMs = words.length ? words[words.length - 1].endMs : 0;
      const aspect = vo.aspect_ratio || '9:16';
      const cues = splitCues(words, { aspectRatio: aspect }).map((c) => ({ start_ms: c.startMs, end_ms: c.endMs, text: c.text }));
      const params = parseJson(task.params) || {};
      const r = store.commit(db, ep, (g) => {
        const node = g.nodes[vo.node];
        if (!node || node.type !== 'narration') throw new SkipAdoption('旁白节点已不存在');
        if (sha(svc.spokenText(g, vo.shot_id)) !== vo.text_sha || node.params.voice !== vo.voice) {
          throw new SkipAdoption('STALE_INPUT: 合成期间台词或音色已被修改，结果未采用');
        }
        const metadata = {
          voice: vo.voice, format, text_sha: vo.text_sha, words, cues, aspect_ratio: aspect,
          task_id: task.id, provider: task.provider, ...(params.model ? { model: params.model } : {}),
        };
        if (durationMs) metadata.duration_ms = durationMs;
        return I.shot.recordGeneration(g, vo.node, { version_id: `t_${task.id}`, asset: { ref: rel, hash, kind: 'audio' }, metadata }, { tx_id: txId });
      }, { tx_id: txId });
      if (!r.applied) return { adopted: false, reason: 'already_recorded' };
      return { adopted: true, reason: 'adopted', version_id: `t_${task.id}`, ref: rel, duration_ms: durationMs, cues: cues.length };
    } catch (e) {
      if (e instanceof SkipAdoption) { warn('voiceover write-back skipped', { task: task.id, reason: e.message }); return { adopted: false, reason: e.message }; }
      throw e;
    }
  }

  const pending = new Set();
  /** worker 的 onTaskFinished 入口（同步返回；写回在后台完成）。失败/取消不碰图。 */
  function onTaskFinished(task) {
    if (!task || !String(task.idempotency_key || '').startsWith(VO_PREFIX)) return null;
    if (task.state !== 'succeeded') return null;
    const p = adoptTask(task).catch((e) => warn('voiceover write-back', { error: e && e.message, task: task.id }));
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  }

  const idle = async () => { while (pending.size) await Promise.all([...pending]); };

  /** 启动恢复：已成功但写回前进程就崩了的任务补写。 */
  async function recoverFinished() {
    const rows = db.prepare(`SELECT * FROM ai_tasks WHERE state = 'succeeded' AND idempotency_key LIKE ? ORDER BY completed_at, rowid`).all(`${VO_PREFIX}%`);
    const out = [];
    for (const t of rows) {
      try { out.push({ task_id: t.id, ...(await adoptTask(t)) }); } catch (e) { warn('voiceover recover', { error: e && e.message, task: t.id }); }
    }
    return out;
  }

  // ---------- 状态 ----------

  /** 每镜头旁白状态：none / queued / running / failed / stale / fresh（图的状态 + 队列里当前 key 的任务）。 */
  function status(ep) {
    const { graph: g, seq } = openGraph(ep);
    const keys = kernel.cacheKeys(g);
    const rows = db.prepare(`SELECT * FROM ai_tasks WHERE idempotency_key LIKE ? ORDER BY created_at DESC, rowid DESC`).all(`${VO_PREFIX}${Number(ep)}:%`);
    const byNode = new Map();
    for (const t of rows) {
      const vo = voOf(t);
      if (!vo) continue;
      if (!byNode.has(vo.node)) byNode.set(vo.node, []);
      byNode.get(vo.node).push({ t, vo });
    }
    const shots = kernel.shotOrder(g).map((id, i) => {
      const nar = kernel.partsOfShot(g, id).narration;
      const base = { shot_id: id, legacy_id: g.nodes[id].legacy_id ?? null, number: i + 1 };
      if (!nar) return { ...base, state: 'none', task_id: null };
      const kstate = kernel.nodeState(g, nar, keys);
      const mine = (byNode.get(nar) || []).filter((x) => x.vo.cache_key === keys[nar]);
      const active = mine.find((x) => ACTIVE.has(x.t.state));
      if (kstate !== 'fresh' && active) return { ...base, state: active.t.state === 'queued' ? 'queued' : 'running', task_id: active.t.id, task_state: active.t.state };
      const landing = kstate !== 'fresh' ? mine.find((x) => x.t.state === 'succeeded' && !landed(g, nar, x.t.id)) : null;
      if (landing) return { ...base, state: 'running', task_id: landing.t.id, task_state: 'writing_back' };
      const failed = kstate !== 'fresh' ? mine.find((x) => x.t.state === 'failed') : null;
      if (failed && !mine.some((x) => x.t.state === 'succeeded')) return { ...base, state: 'failed', task_id: failed.t.id, error_code: failed.t.error_code, error_message: failed.t.error_message };
      return { ...base, state: kstate, task_id: null };
    });
    const counts = {};
    for (const s of shots) counts[s.state] = (counts[s.state] || 0) + 1;
    return { episode_id: Number(ep), seq, shots, counts };
  }

  return { preview, create, estimate, status, onTaskFinished, adoptTask, recoverFinished, idle };
}

module.exports = { createVoiceoverService, VoiceoverError, VO_PREFIX, defaultTarget, aspectOf };
