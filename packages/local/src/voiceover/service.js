'use strict';
/**
 * 旁白配音（CosyVoice）：估价 -> 确认 -> 逐镜合成 -> 经内核 recordGeneration 写回 narration 节点。
 *
 * 唯一事实源：
 *   - 配音文字取自 script_line（旁白/对白行；对白行去掉“说话人：”前缀），不另存；
 *   - 音频与逐字时间戳是 narration 采用版本的产物：asset { ref, hash, kind:'audio' } +
 *     metadata { duration_ms, voice, words, cues, text_sha }；
 *   - 字幕块 cues 由 splitCues(words) 算出，存在同一个版本的 metadata 里（相对镜头起点），
 *     timelineView 只在旁白“新鲜”时使用；行文字改了旁白就过期，字幕自动退回按行文字的整镜字幕；
 *   - 旧列 storyboards.narration_audio_local_path 由物化从采用版本写出。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kernel = require('@talekiln/kernel');
const store = require('../kernel/store');
const { splitCues } = require('../subtitles');

const { KernelError } = kernel;
const I = kernel.intents;

const DEFAULT_VOICE = 'longxiaochun_v2';

/** 音色清单。只有 longxiaochun_v2 用真 Key 验证过，其余按官方命名列出，未实测。 */
const VOICES = Object.freeze([
  { id: 'longxiaochun_v2', label: '龙小淳（女声，默认）', verified: true },
  { id: 'longxiaoxia_v2', label: '龙小夏（女声，未实测）', verified: false },
  { id: 'longyue_v2', label: '龙悦（女声，未实测）', verified: false },
  { id: 'longcheng_v2', label: '龙诚（男声，未实测）', verified: false },
  { id: 'longshu_v2', label: '龙书（男声，未实测）', verified: false },
]);

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const chars = (t) => Array.from(String(t || '')).length;

/** 配音文字：旁白/对白行文字按剧本顺序以换行拼接；对白行去掉行首“说话人：”。 */
function spokenText(graph, shotId) {
  return kernel.spokenLines(graph, shotId).map((id) => {
    const p = graph.nodes[id].params;
    let t = String(p.text || '').trim();
    if (p.kind === 'dialogue' && p.speaker) {
      const m = /^([^：:]{1,20})[：:]\s*([\s\S]*)$/.exec(t);
      if (m && m[1].trim() === p.speaker) t = m[2].trim();
    }
    return t;
  }).filter(Boolean).join('\n');
}

/** 请求里的镜头标识：图节点 id（字符串）或旧分镜 id（数字）。 */
function resolveShots(graph, want) {
  const order = kernel.shotOrder(graph);
  if (want === 'all' || want === true) return order;
  if (!Array.isArray(want) || !want.length) throw new KernelError('INTENT', 'shots 必须是镜头 id 数组，或用 all: true');
  const byLegacy = new Map(order.map((id) => [graph.nodes[id].legacy_id, id]));
  const out = new Set();
  for (const w of want) {
    const id = typeof w === 'string' && graph.nodes[w] && graph.nodes[w].type === 'shot' ? w : byLegacy.get(Number(w));
    if (!id) throw new KernelError('NOT_FOUND', `镜头不存在：${w}`);
    out.add(id);
  }
  return order.filter((id) => out.has(id));
}

/**
 * 计划（纯读）：每个镜头要读什么字、用什么音色、是否跳过。
 * all 模式跳过已有新鲜旁白的镜头（force: true 时不跳过）；明确点名的镜头一律重做。
 */
function plan(graph, { shots, all, voice, force }) {
  const ids = resolveShots(graph, all ? 'all' : shots);
  const keys = kernel.cacheKeys(graph);
  return ids.map((shotId) => {
    const node = graph.nodes[shotId];
    const parts = kernel.partsOfShot(graph, shotId);
    const text = spokenText(graph, shotId);
    const nodeVoice = parts.narration ? graph.nodes[parts.narration].params.voice : null;
    const v = voice || (nodeVoice && nodeVoice !== 'default' ? nodeVoice : DEFAULT_VOICE);
    const item = { shot_id: shotId, legacy_id: node.legacy_id ?? null, text, chars: chars(text), voice: v };
    if (!parts.narration) item.skip = 'no_narration_node';
    else if (!text) item.skip = 'no_text';
    else if (all && !force && kernel.nodeState(graph, parts.narration, keys) === 'fresh' && v === nodeVoice) item.skip = 'fresh';
    return item;
  });
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** 估价汇总（按字数）。 */
function summarize(items, estimator, provider, model) {
  let estimate = 0;
  let max = 0;
  let currency = 'CNY';
  let sample = true;
  let known = true;
  const rows = items.map((it) => {
    if (it.skip) return { shot_id: it.shot_id, legacy_id: it.legacy_id, chars: it.chars, skip: it.skip, estimate: 0 };
    const e = estimator.estimate({ provider, kind: 'tts', params: { model, text: it.text } });
    estimate += e.estimate; max += e.max; currency = e.currency; sample = e.sample; known = known && e.known;
    return { shot_id: it.shot_id, legacy_id: it.legacy_id, chars: it.chars, voice: it.voice, estimate: e.estimate };
  });
  return { items: rows, estimate: round6(estimate), max: round6(max), currency, sample_prices: sample, price_known: known };
}

/**
 * 合成并写回。deps：
 *   facade   { tts: { synthesize(provider, req) } }
 *   provider, model, storageRoot, aspectRatio, fps, concurrency, signal
 *   logSpend(entry)  可选，成功后记账
 * 单镜失败不影响其他镜头。返回 { done, failed, skipped }。
 */
async function run(db, episodeId, items, deps) {
  const { facade, provider, model, storageRoot, signal } = deps;
  const todo = items.filter((i) => !i.skip);
  const out = { done: [], failed: [], skipped: items.filter((i) => i.skip).map((i) => ({ shot_id: i.shot_id, reason: i.skip })) };
  let next = 0;

  async function one(it) {
    // 1) 音色先写进 narration 节点：这样写回时的 cacheKey 已包含新音色
    const nar = kernel.partsOfShot(store.openProject(db, episodeId).graph, it.shot_id).narration;
    if (nar && store.openProject(db, episodeId).graph.nodes[nar].params.voice !== it.voice) {
      store.commit(db, episodeId, (g) => I.shot.setVoice(g, it.shot_id, { voice: it.voice }));
    }
    // 2) 合成
    const r = await facade.tts.synthesize(provider, { model, text: it.text, voice: it.voice, wordTimestamps: true, signal });
    if (!r || !r.audio || !r.audio.length) throw Object.assign(new Error('配音服务返回了空音频'), { code: 'BAD_RESPONSE' });
    const audio = Buffer.from(r.audio);
    const format = r.format || 'mp3';
    const hash = sha(audio);
    const words = (r.words || []).map((w) => ({ text: w.text, startMs: Math.round(w.startMs), endMs: Math.round(w.endMs) }));
    const durationMs = words.length ? words[words.length - 1].endMs : 0;
    const cues = splitCues(words, { aspectRatio: deps.aspectRatio, fps: deps.fps }).map((c) => ({ start_ms: c.startMs, end_ms: c.endMs, text: c.text }));
    const rel = `audio/narration/e${episodeId}_${it.shot_id}_${hash.slice(0, 10)}.${format}`;
    const abs = path.join(storageRoot, ...rel.split('/'));
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) {
      const tmp = `${abs}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, audio);
      await fs.promises.rename(tmp, abs);
    }
    // 3) 写回：在同一个 SQLite 事务里基于最新图构造；合成期间台词或音色被改过就不写
    const res = store.commit(db, episodeId, (g) => {
      const parts = kernel.partsOfShot(g, it.shot_id);
      if (!parts.narration || spokenText(g, it.shot_id) !== it.text || g.nodes[parts.narration].params.voice !== it.voice) {
        throw new KernelError('STALE_INPUT', '合成期间台词或音色已被修改，结果未采用');
      }
      const metadata = { voice: it.voice, format, text_sha: sha(it.text), words, cues, aspect_ratio: deps.aspectRatio || '9:16' };
      if (durationMs) metadata.duration_ms = durationMs;
      return I.shot.recordGeneration(g, parts.narration, { asset: { ref: rel, hash, kind: 'audio' }, metadata }, { tx_id: `voiceover:${episodeId}:${it.shot_id}:${hash.slice(0, 16)}` });
    });
    if (deps.logSpend) deps.logSpend({ id: `voiceover:${episodeId}:${it.shot_id}:${hash.slice(0, 12)}`, provider, model, text: it.text, project: episodeId });
    out.done.push({
      shot_id: it.shot_id, legacy_id: it.legacy_id, voice: it.voice, ref: rel, duration_ms: durationMs, cues: cues.length,
      version_id: res.meta && res.meta.version_id, applied: res.applied,
    });
  }

  async function worker() {
    while (next < todo.length) {
      const it = todo[next++];
      try { await one(it); } catch (e) {
        out.failed.push({ shot_id: it.shot_id, legacy_id: it.legacy_id, code: e.code || 'VOICEOVER_FAILED', message: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(deps.concurrency || 2, todo.length) }, worker));
  const order = new Map(items.map((i, k) => [i.shot_id, k]));
  out.done.sort((a, b) => order.get(a.shot_id) - order.get(b.shot_id));
  return out;
}

/** 直接合成（不走队列）的花费记录：spend_log.task_id 唯一，用 voiceover:... 作键，重复记录被忽略。 */
function createSpendLogger(db, estimator, now = () => Date.now()) {
  const { localDay } = require('../spend');
  return ({ id, provider, model, text, project }) => {
    const e = estimator.estimate({ provider, kind: 'tts', params: { model, text } });
    db.prepare(`INSERT OR IGNORE INTO spend_log (task_id, provider, kind, model, project_id, currency, estimated, actual, day, created_at)
                VALUES (?, ?, 'tts', ?, ?, ?, ?, NULL, ?, ?)`).run(id, provider, model || null, String(project), e.currency, e.estimate, localDay(now()), now());
  };
}

module.exports = { VOICES, DEFAULT_VOICE, spokenText, plan, summarize, run, resolveShots, createSpendLogger };
