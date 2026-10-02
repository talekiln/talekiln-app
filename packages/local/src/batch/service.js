'use strict';
/**
 * P3-B 批量生成：一次排多集，按服务商并发上限、总预算上限与失败策略调度生成任务。
 *
 *   create   逐集经生成服务估算（planGraph + 估价器），求和得到预计区间；整批过一次花费守卫 checkBatch 与批次预算上限；
 *            只建 batch_jobs / batch_items 行，不建任何任务。
 *   tick     调度一轮（由 scheduler 定时调用，可注入时钟）。同一时刻只跑最早的一个 queued/running 批次：
 *            1. 结算进行中的集：发现接着出的视频任务、按策略重试失败任务、所有镜头落地后标记成功/失败；
 *            2. 按集、按镜头顺序建任务：只在夜间时段内、该服务商在途任务数低于批次并发上限、
 *               已花费 + 在途最高 + 本镜头最高 不超过预算时才建；
 *            3. 所有集结束 -> completed（有成功的集）/ failed（全失败）。
 *   任务与批次的关联：任务参数里的 `_batch: { id, episode_id }`（生成服务写入，首帧 -> 视频链沿用）。
 *   金额：外部一律用分（整数）；价格表里的元在边界换算。
 */
const crypto = require('crypto');
const { TERMINAL } = require('../queue/states');
const { isUncertain, readableError } = require('../queue/taskView');
const { getEnabled, listEnabledMeta } = require('../providers/enablement');
const { GenerationError } = require('../generation/service');
const P = require('./policy');

const { BatchError, toCents, yuanText } = P;
const ITEM_DONE = new Set(['succeeded', 'failed', 'cancelled']);
const BATCH_OPEN = new Set(['queued', 'running', 'paused']);
const GEN_PREFIX = 'gen:';
const KIND_LABEL = { image: '首帧图', video: '视频' };

const parseJson = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch (_) { return dflt; } };
const uniq = (list) => [...new Set(list)];

function createBatchService({ db, store, generation, spend, worker = null, limits = {}, now = () => Date.now(), minutesOfDay = P.localMinutesOfDay, log = console }) {
  if (!db || !store || !generation || !spend) throw new Error('db, store, generation and spend are required');
  const warn = (msg, extra) => { try { (log.warn || log.error || (() => {})).call(log, msg, extra); } catch (_) { /* ignore */ } };
  let wakeFn = () => {};
  const waitReason = new Map(); // batch id -> 'night' | 'concurrency' | 'budget' | null（上一轮为什么没有继续建任务）

  // ---------- 行 <-> 对象 ----------

  const rowToBatch = (r) => r && ({
    ...r,
    episode_ids: parseJson(r.episode_ids, []),
    kinds: parseJson(r.kinds, ['image', 'video']),
    concurrency: parseJson(r.concurrency, {}),
    failure_policy: parseJson(r.failure_policy, {}),
    totals: parseJson(r.totals, {}),
  });
  const rowToItem = (r) => r && ({ ...r, task_ids: parseJson(r.task_ids, []), prior_task_ids: parseJson(r.prior_task_ids, []), plan: parseJson(r.plan, null), retries: parseJson(r.retries, {}) });
  const getBatch = (id) => rowToBatch(db.prepare('SELECT * FROM batch_jobs WHERE id = ?').get(String(id)));
  const listItems = (batchId) => db.prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY position, id').all(batchId).map(rowToItem);
  const JSON_COLS = new Set(['episode_ids', 'kinds', 'concurrency', 'failure_policy', 'totals', 'task_ids', 'prior_task_ids', 'plan', 'retries']);

  function update(table, id, fields) {
    const cols = { ...fields, updated_at: now() };
    const vals = {};
    for (const [k, v] of Object.entries(cols)) vals[k] = JSON_COLS.has(k) ? (v == null ? null : JSON.stringify(v)) : v;
    const sets = Object.keys(vals).map((c) => `${c} = @${c}`).join(', ');
    return db.prepare(`UPDATE ${table} SET ${sets} WHERE id = @id`).run({ ...vals, id }).changes === 1;
  }
  const updateBatch = (id, fields) => update('batch_jobs', id, fields);
  const updateItem = (id, fields) => update('batch_items', id, fields);

  const episodeRows = (ids) => {
    if (!ids.length) return new Map();
    const ph = ids.map(() => '?').join(',');
    return new Map(db.prepare(`SELECT id, drama_id, episode_number, title FROM episodes WHERE id IN (${ph}) AND deleted_at IS NULL`).all(...ids).map((r) => [r.id, r]));
  };
  const episodeLabel = (ep, rows) => { const r = rows && rows.get(Number(ep)); return r ? `第 ${r.episode_number} 集` : `分集 ${ep}`; };

  // ---------- 服务商上限 ----------

  function providerLimits() {
    const out = {};
    for (const p of getEnabled()) out[p] = P.providerLimit(limits, p);
    return out;
  }
  const providersMeta = () => listEnabledMeta().map((m) => ({ id: m.id, label: m.label, limit: P.providerLimit(limits, m.id) }));
  const capFor = (b, p) => (Number.isInteger(b.concurrency[p]) ? b.concurrency[p] : P.providerLimit(limits, p));

  // ---------- 任务 ----------

  const taskMeta = (t) => { const p = parseJson(t.params, {}) || {}; return { gen: p._gen || null, batch: p._batch || null, params: p }; };
  const taskMaxCents = (t) => toCents(spend.estimate({ provider: t.provider, kind: t.kind, params: taskMeta(t).params }).max);

  /** 某集里带本批次标记的任务（含首帧完成后自动接上的视频任务）。 */
  function discoverTasks(batchId, episodeId) {
    const rows = db.prepare('SELECT * FROM ai_tasks WHERE idempotency_key LIKE ?').all(`${GEN_PREFIX}${Number(episodeId)}:%`);
    return rows.filter((t) => { const m = taskMeta(t); return m.batch && m.batch.id === batchId; });
  }

  /** 刷新一集的任务列表（已记录的 + 发现的），返回任务行。 */
  function refreshItemTasks(b, it) {
    const prior = new Set(it.prior_task_ids);
    const ids = uniq([...it.task_ids, ...discoverTasks(b.id, it.episode_id).map((t) => t.id)]).filter((id) => !prior.has(id));
    const tasks = ids.map((id) => store.get(id)).filter(Boolean);
    if (ids.length !== it.task_ids.length || ids.some((id, i) => it.task_ids[i] !== id)) { it.task_ids = ids; updateItem(it.id, { task_ids: ids }); }
    return tasks;
  }

  function spentCents(taskIds) {
    const ids = uniq(taskIds);
    let sum = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const ph = chunk.map(() => '?').join(',');
      sum += db.prepare(`SELECT COALESCE(SUM(COALESCE(actual, estimated)), 0) s FROM spend_log WHERE task_id IN (${ph})`).get(...chunk).s;
    }
    return toCents(sum);
  }

  // ---------- 计划 ----------

  /** 估算结果 -> 一集的执行计划：按镜头分组，记录要处理的类型、马上会建任务的服务商、费用。fresh 跳过，blocked 只计数。 */
  function planFromEstimate(est) {
    const byShot = new Map();
    let blocked = 0;
    for (const i of est.items) {
      if (i.action === 'fresh') continue;
      if (i.action === 'blocked') { blocked++; continue; }
      const e = byShot.get(i.shot_id) || { shot: i.shot_id, storyboard_id: i.storyboard_id ?? null, kinds: [], providers_now: [], est_cents: 0, max_cents: 0 };
      if (!e.kinds.includes(i.kind)) e.kinds.push(i.kind);
      if (i.action === 'create' && i.provider && !e.providers_now.includes(i.provider)) e.providers_now.push(i.provider);
      byShot.set(i.shot_id, e);
    }
    est.billable.forEach((bi, idx) => {
      const e = byShot.get(bi.shot_id);
      const c = est.check.estimates[idx] || { estimate: 0, max: 0 };
      if (e) { e.est_cents += toCents(c.estimate); e.max_cents += toCents(c.max); }
    });
    const shots = [...byShot.values()];
    return { shots, blocked, est_cents: shots.reduce((a, s) => a + s.est_cents, 0), max_cents: shots.reduce((a, s) => a + s.max_cents, 0) };
  }

  // ---------- 创建 ----------

  /**
   * 建批次。input.dry_run=true 只估算不建：返回 { dry_run: true, allowed, refusal, totals, per_episode, warnings }
   * （额度 / 预算不够时 allowed=false 而不是抛错，给界面显示）。
   */
  function create(input = {}) {
    const dryRun = input.dry_run === true;
    const dramaId = Number(input.drama_id);
    if (!Number.isInteger(dramaId) || dramaId <= 0) throw new BatchError('BAD_REQUEST', 'drama_id 必填');
    if (!db.prepare('SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dramaId)) throw new BatchError('NOT_FOUND', `项目 ${dramaId} 不存在`, 404);
    const rawIds = Array.isArray(input.episode_ids) ? input.episode_ids : [];
    const episodeIds = uniq(rawIds.map(Number));
    if (!episodeIds.length || episodeIds.some((n) => !Number.isInteger(n) || n <= 0)) throw new BatchError('BAD_REQUEST', 'episode_ids 必须是非空的分集 id 数组');
    const eps = episodeRows(episodeIds);
    for (const ep of episodeIds) {
      const r = eps.get(ep);
      if (!r) throw new BatchError('NOT_FOUND', `分集 ${ep} 不存在`, 404);
      if (Number(r.drama_id) !== dramaId) throw new BatchError('BAD_REQUEST', `分集 ${ep} 不属于项目 ${dramaId}`);
    }
    const kinds = P.normalizeKinds(input.kinds != null ? input.kinds : input.kind);
    const failurePolicy = P.normalizePolicy(input.failure_policy);
    const concurrency = P.normalizeConcurrency(input.concurrency, limits, getEnabled());
    const budget = P.normalizeBudget(input.budget_cap_cents);

    // 逐集估算（不写库、不建任务）
    const perEpisode = [];
    const specs = [];
    let cacheHits = 0;
    for (const ep of episodeIds) {
      const est = generation.estimate(ep, { shots: 'all', kind: P.kindArg(kinds) });
      const unready = est.billable.find((x) => x.provider_ready === false);
      if (unready) throw new BatchError('INVALID_API_KEY', `未配置 ${unready.provider} 的 ${unready.kind} 服务或 Key，请先在设置里添加`, 400);
      const plan = planFromEstimate(est);
      const hits = est.items.filter((i) => i.action === 'cache_hit').length;
      cacheHits += hits;
      specs.push(...est.billable.map((x) => x.spec));
      perEpisode.push({ episode_id: ep, estimate_min_cents: plan.est_cents, estimate_max_cents: plan.max_cents, shots: plan.shots.length, billable: est.billable.length, cache_hits: hits, blocked: plan.blocked });
    }
    const nothing = !specs.length && !cacheHits;
    const check = spend.checkBatch(specs);
    const estimateMin = toCents(check.total);
    const estimateMax = toCents(check.max);
    const overBudget = budget != null && estimateMin > budget;
    const budgetMessage = overBudget ? `预算上限 ¥${yuanText(budget)} 低于预计费用 ¥${yuanText(estimateMin)}（最高 ¥${yuanText(estimateMax)}）` : null;
    const warnings = [];
    if (budget != null && !overBudget && estimateMax > budget) warnings.push(`预算上限 ¥${yuanText(budget)} 低于最高预计费用 ¥${yuanText(estimateMax)}，批次可能在完成前因预算停下`);
    if (check.sample_prices) warnings.push('价格表为示例价，实际以服务商账单为准');
    if (check.known === false) warnings.push('部分模型没有价格，未计入预计费用');
    if (dryRun) {
      const refusal = nothing ? { code: 'BATCH_NOTHING_TO_DO', message: '所选分集没有需要生成的镜头（已全部是最新，或缺少分镜与提示词）' }
        : !check.ok ? { code: 'SPEND_LIMIT', reason: check.reason, message: check.message }
          : overBudget ? { code: 'BATCH_BUDGET_EXCEEDED', message: budgetMessage } : null;
      return {
        dry_run: true, allowed: !refusal, refusal, kinds, concurrency, provider_limits: providerLimits(), budget_cap_cents: budget, failure_policy: failurePolicy,
        currency: check.currency, sample_prices: !!check.sample_prices, warnings,
        totals: { estimate_min_cents: estimateMin, estimate_max_cents: estimateMax, spent_cents: 0 },
        per_episode: perEpisode, cap: check.cap,
      };
    }
    if (nothing) throw new BatchError('BATCH_NOTHING_TO_DO', '所选分集没有需要生成的镜头（已全部是最新，或缺少分镜与提示词）');
    if (!check.ok) throw new BatchError('SPEND_LIMIT', check.message, 402, { reason: check.reason, estimate: check.total, max: check.max, currency: check.currency });
    if (overBudget) throw new BatchError('BATCH_BUDGET_EXCEEDED', budgetMessage, 402, { estimate_min_cents: estimateMin, estimate_max_cents: estimateMax, budget_cap_cents: budget });

    const id = crypto.randomUUID();
    const t = now();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO batch_jobs (id, drama_id, episode_ids, kinds, concurrency, budget_cap_cents, failure_policy, status, totals, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
      ).run(id, dramaId, JSON.stringify(episodeIds), JSON.stringify(kinds), JSON.stringify(concurrency), budget, JSON.stringify(failurePolicy),
        JSON.stringify({ estimate_min_cents: estimateMin, estimate_max_cents: estimateMax, spent_cents: 0, per_episode: perEpisode, currency: check.currency, sample_prices: !!check.sample_prices, warnings }), t, t);
      const ins = db.prepare(`INSERT INTO batch_items (batch_id, episode_id, position, status, task_ids, prior_task_ids, retries, updated_at) VALUES (?, ?, ?, 'pending', '[]', '[]', '{}', ?)`);
      episodeIds.forEach((ep, i) => ins.run(id, ep, i, t));
    })();
    wakeFn();
    return view(id);
  }

  // ---------- 调度 ----------

  function failItem(b, it, message, { pauseBatch = false } = {}) {
    updateItem(it.id, { status: 'failed', error: message, finished_at: now(), retries: it.retries, attempts: it.attempts, task_ids: it.task_ids });
    if (pauseBatch || b.failure_policy.on_fail === 'pause') {
      updateBatch(b.id, { status: 'paused', error: `${episodeLabel(it.episode_id, episodeRows([it.episode_id]))}生成失败，已按策略暂停：${message}` });
    }
  }

  function pauseBatch(b, message) {
    updateBatch(b.id, { status: 'paused', error: message });
  }

  /** 进行中的集：发现新任务、按策略处理失败、全部落地后结算。 */
  function settleItem(b, it) {
    const tasks = refreshItemTasks(b, it);
    const retries = { ...it.retries };
    let attempts = it.attempts;
    let retried = false;
    for (const t of tasks) {
      if (t.state !== 'failed') continue;
      if (t.error_code === 'SPEND_LIMIT') { pauseBatch(b, `费用上限不允许继续提交：${t.error_message || readableError(t.error_code, t.error_message)}`); updateItem(it.id, { retries, attempts }); return; }
      const n = retries[t.id] || 0;
      if (!isUncertain(t) && n < b.failure_policy.retry) {
        if (store.retry(t.id)) { retries[t.id] = n + 1; attempts++; retried = true; }
        continue;
      }
      const g = taskMeta(t).gen;
      const what = g ? `镜头 #${g.storyboard_id ?? '?'} ${KIND_LABEL[g.kind] || g.kind}` : `任务 ${t.id}`;
      it.retries = retries; it.attempts = attempts;
      failItem(b, it, `${what}：${readableError(t.error_code, t.error_message) || '生成失败'}${n ? `（已重试 ${n} 次）` : ''}`);
      return;
    }
    if (retried) { updateItem(it.id, { retries, attempts }); it.retries = retries; it.attempts = attempts; if (worker) worker.wake(); return; }
    if (!it.plan || it.cursor < it.plan.shots.length) return; // 还有镜头没建任务
    if (tasks.some((t) => !TERMINAL.has(t.state))) return;   // 还有任务在跑
    // 全部任务已结束：看图里每个计划镜头是否都已是最新（接着出的视频 / 写回中的任务由 status 判为进行中）
    let st;
    try { st = generation.status(it.episode_id); } catch (e) { failItem(b, it, `读取分集状态失败：${e.message}`); return; }
    const byShot = new Map(st.shots.map((s) => [s.shot_id, s]));
    const stale = [];
    for (const p of it.plan.shots) {
      const s = byShot.get(p.shot);
      if (!s) { stale.push(`镜头 #${p.storyboard_id ?? p.shot} 已不存在`); continue; }
      for (const k of p.kinds) {
        const n = s[k];
        if (!n) continue;
        if (n.state === 'queued' || n.state === 'running') return; // 写回中或接着出的任务还在跑
        if (n.state !== 'fresh') stale.push(`镜头 ${s.number} 的${KIND_LABEL[k]}（${n.state === 'failed' ? '失败' : '未更新'}）`);
      }
    }
    if (stale.length) { failItem(b, it, `有镜头没有生成最新版本（可能在批次运行期间被修改）：${stale.join('、')}`); return; }
    updateItem(it.id, { status: 'succeeded', finished_at: now(), error: null });
  }

  /** 待处理的集：做计划。没有要做的直接成功。 */
  function startItem(b, it) {
    let est;
    try { est = generation.estimate(it.episode_id, { shots: 'all', kind: P.kindArg(b.kinds) }); } catch (e) {
      failItem(b, it, e instanceof GenerationError ? e.message : `估算失败：${e.message}`);
      return null;
    }
    const plan = planFromEstimate(est);
    const t = now();
    if (!plan.shots.length) {
      updateItem(it.id, { status: 'succeeded', plan, cursor: 0, started_at: t, finished_at: t, error: plan.blocked ? `${plan.blocked} 个镜头缺少提示词，已跳过` : null });
      return null;
    }
    updateItem(it.id, { status: 'running', plan, cursor: 0, started_at: t, error: null });
    return { ...it, status: 'running', plan, cursor: 0, started_at: t };
  }

  /** 按集、按镜头顺序建任务，直到并发 / 预算 / 夜间时段不允许。 */
  function enqueueNext(b) {
    const items = listItems(b.id);
    const inflight = {};
    let inflightMax = 0;
    let inflightCount = 0;
    const allIds = [];
    for (const it of items) {
      const tasks = ITEM_DONE.has(it.status) ? it.task_ids.map((id) => store.get(id)).filter(Boolean) : refreshItemTasks(b, it);
      allIds.push(...it.task_ids, ...it.prior_task_ids);
      for (const t of tasks) {
        if (TERMINAL.has(t.state)) continue;
        inflight[t.provider] = (inflight[t.provider] || 0) + 1;
        inflightMax += taskMaxCents(t);
        inflightCount++;
      }
    }
    const spent = spentCents(allIds);
    const inWindow = P.inNightWindow(minutesOfDay(now()), b.failure_policy.night);
    let reason = null;
    let woke = false;
    outer: for (let it of items) {
      if (ITEM_DONE.has(it.status)) continue;
      if (it.status === 'pending') {
        it = startItem(b, it);
        if (!it) { if (getBatch(b.id).status !== 'running') return; continue; }
      }
      const shots = it.plan.shots;
      while (it.cursor < shots.length) {
        const shot = shots[it.cursor];
        if (!inWindow) { reason = 'night'; break outer; }
        const full = shot.providers_now.find((p) => (inflight[p] || 0) >= capFor(b, p));
        if (full) { reason = 'concurrency'; break outer; }
        if (b.budget_cap_cents != null && spent + inflightMax + shot.max_cents > b.budget_cap_cents) {
          if (inflightCount === 0) {
            pauseBatch(b, `预算上限 ¥${yuanText(b.budget_cap_cents)} 不足以继续：已花费 ¥${yuanText(spent)}，下一镜头最高 ¥${yuanText(shot.max_cents)}。提高预算后可继续`);
            waitReason.set(b.id, 'budget');
            return;
          }
          reason = 'budget';
          break outer;
        }
        let r;
        try {
          r = generation.create(it.episode_id, { shots: [shot.shot], kind: P.kindArg(shot.kinds) }, { batch: { id: b.id, episode_id: it.episode_id } });
        } catch (e) {
          if (e instanceof GenerationError && e.code === 'SPEND_LIMIT') { pauseBatch(b, e.message); waitReason.set(b.id, 'budget'); return; }
          failItem(b, it, e instanceof GenerationError ? e.message : `建任务失败：${e.message}`);
          if (getBatch(b.id).status !== 'running') return;
          continue outer;
        }
        for (const tk of r.tasks || []) {
          if (!it.task_ids.includes(tk.task_id)) it.task_ids.push(tk.task_id);
          const row = store.get(tk.task_id);
          if (row && !TERMINAL.has(row.state)) { inflight[row.provider] = (inflight[row.provider] || 0) + 1; inflightMax += taskMaxCents(row); inflightCount++; woke = true; }
        }
        it.cursor++;
        updateItem(it.id, { cursor: it.cursor, task_ids: it.task_ids });
      }
    }
    waitReason.set(b.id, reason);
    if (woke && worker) worker.wake();
  }

  function finishBatch(b) {
    const items = listItems(b.id);
    if (!items.every((i) => ITEM_DONE.has(i.status))) return false;
    const ok = items.some((i) => i.status === 'succeeded');
    updateBatch(b.id, { status: ok ? 'completed' : 'failed', finished_at: now(), error: ok ? null : '所有分集都失败了' });
    waitReason.delete(b.id);
    return true;
  }

  function refreshTotals(b) {
    const items = listItems(b.id);
    const spent = spentCents(items.flatMap((i) => [...i.task_ids, ...i.prior_task_ids]));
    if (spent !== (b.totals.spent_cents || 0)) updateBatch(b.id, { totals: { ...b.totals, spent_cents: spent } });
  }

  /** 一轮调度。只跑最早的一个 queued / running 批次。返回 { active, batch_id? }。 */
  function tick() {
    const row = db.prepare(`SELECT * FROM batch_jobs WHERE status IN ('queued','running') ORDER BY created_at, rowid LIMIT 1`).get();
    if (!row) return { active: false };
    let b = rowToBatch(row);
    if (b.status === 'queued') { updateBatch(b.id, { status: 'running', started_at: b.started_at || now(), error: null }); b = getBatch(b.id); }
    try {
      for (const it of listItems(b.id)) if (it.status === 'running') settleItem(b, it);
      b = getBatch(b.id);
      if (b.status === 'running') enqueueNext(b);
      b = getBatch(b.id);
      refreshTotals(b);
      if (b.status === 'running') finishBatch(b);
    } catch (e) {
      warn('batch tick', { batch: b.id, error: e && e.message });
      throw e;
    }
    return { active: true, batch_id: b.id, status: getBatch(b.id).status };
  }

  // ---------- 控制 ----------

  function mustGet(id) {
    const b = getBatch(id);
    if (!b) throw new BatchError('NOT_FOUND', `批次 ${id} 不存在`, 404);
    return b;
  }

  function pause(id) {
    const b = mustGet(id);
    if (b.status !== 'running' && b.status !== 'queued') throw new BatchError('BATCH_STATE', `批次当前是「${b.status}」，不能暂停`, 409);
    updateBatch(b.id, { status: 'paused', error: null });
    waitReason.delete(b.id);
    return view(b.id);
  }

  /** 继续：可同时提高预算上限（预算不足而暂停时）。 */
  function resume(id, { budget_cap_cents } = {}) {
    const b = mustGet(id);
    if (b.status !== 'paused') throw new BatchError('BATCH_STATE', `批次当前是「${b.status}」，不能继续`, 409);
    const fields = { status: 'queued', error: null };
    if (budget_cap_cents !== undefined) fields.budget_cap_cents = P.normalizeBudget(budget_cap_cents);
    updateBatch(b.id, fields);
    wakeFn();
    return view(b.id);
  }

  /** 取消：未提交的任务取消；已提交给服务商的任务跑完照常写回（钱已花，结果不丢）。 */
  function cancel(id) {
    const b = mustGet(id);
    if (!BATCH_OPEN.has(b.status)) throw new BatchError('BATCH_STATE', `批次当前是「${b.status}」，不能取消`, 409);
    const t = now();
    db.transaction(() => {
      for (const it of listItems(b.id)) {
        if (ITEM_DONE.has(it.status)) continue;
        for (const tid of it.task_ids) {
          const row = store.get(tid);
          if (row && row.state === 'queued') store.cancel(tid);
        }
        updateItem(it.id, { status: 'cancelled', finished_at: t });
      }
      updateBatch(b.id, { status: 'cancelled', finished_at: t });
    })();
    waitReason.delete(b.id);
    return view(b.id);
  }

  /** 失败的集重新排进去（重新做计划，已最新的镜头不会再花钱）；批次回到排队。episode_ids 可只重试其中几集。 */
  function retryFailed(id, { episode_ids } = {}) {
    const b = mustGet(id);
    if (b.status === 'cancelled') throw new BatchError('BATCH_STATE', '已取消的批次不能重试', 409);
    const only = Array.isArray(episode_ids) && episode_ids.length ? new Set(episode_ids.map(Number)) : null;
    const failed = listItems(b.id).filter((i) => i.status === 'failed' && (!only || only.has(Number(i.episode_id))));
    if (!failed.length) throw new BatchError('BATCH_STATE', only ? '所选分集没有失败' : '没有失败的分集', 409);
    db.transaction(() => {
      for (const it of failed) {
        updateItem(it.id, { status: 'pending', error: null, plan: null, cursor: 0, retries: {}, attempts: 0, task_ids: [], prior_task_ids: uniq([...it.prior_task_ids, ...it.task_ids]), started_at: null, finished_at: null });
      }
      updateBatch(b.id, { status: 'queued', error: null, finished_at: null });
    })();
    wakeFn();
    return view(b.id);
  }

  // ---------- 视图 ----------

  function itemView(b, it, eps) {
    const ep = eps.get(Number(it.episode_id));
    const perEp = ((b.totals.per_episode || []).find((x) => Number(x.episode_id) === Number(it.episode_id))) || {};
    const tasks = it.task_ids.map((tid) => store.get(tid)).filter(Boolean);
    const counts = { total: tasks.length, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const t of tasks) {
      if (t.state === 'queued') counts.queued++;
      else if (TERMINAL.has(t.state)) counts[t.state]++;
      else counts.running++;
    }
    const plan = it.plan;
    const shotsTotal = plan ? plan.shots.length : (perEp.shots ?? null);
    let shotsDone = 0;
    let remainingMin = perEp.estimate_min_cents || 0;
    let remainingMax = perEp.estimate_max_cents || 0;
    if (plan) {
      const byShot = new Map();
      for (const t of tasks) { const g = taskMeta(t).gen; if (g) { if (!byShot.has(g.shot_id)) byShot.set(g.shot_id, []); byShot.get(g.shot_id).push(t); } }
      plan.shots.forEach((s, i) => {
        if (i >= it.cursor) return;
        const ts = byShot.get(s.shot) || [];
        if (ts.every((t) => t.state === 'succeeded')) shotsDone++;
      });
      if (it.status === 'succeeded') shotsDone = plan.shots.length;
      remainingMin = plan.shots.slice(it.cursor).reduce((a, s) => a + s.est_cents, 0);
      remainingMax = plan.shots.slice(it.cursor).reduce((a, s) => a + s.max_cents, 0);
    }
    if (ITEM_DONE.has(it.status) && it.status !== 'failed') { remainingMin = 0; remainingMax = 0; }
    return {
      episode_id: it.episode_id,
      episode_number: ep ? ep.episode_number : null,
      title: ep ? ep.title : null,
      position: it.position,
      status: it.status,
      attempts: it.attempts,
      error: it.error,
      started_at: it.started_at,
      finished_at: it.finished_at,
      shots_total: shotsTotal,
      shots_enqueued: plan ? it.cursor : 0,
      shots_done: shotsDone,
      blocked: plan ? plan.blocked : (perEp.blocked ?? 0),
      tasks: counts,
      spent_cents: spentCents([...it.task_ids, ...it.prior_task_ids]),
      estimate_min_cents: plan ? plan.est_cents : (perEp.estimate_min_cents || 0),
      estimate_max_cents: plan ? plan.max_cents : (perEp.estimate_max_cents || 0),
      remaining_min_cents: remainingMin,
      remaining_max_cents: remainingMax,
    };
  }

  function view(id) {
    const b = getBatch(id);
    if (!b) return null;
    const eps = episodeRows(b.episode_ids);
    const items = listItems(b.id).map((it) => itemView(b, it, eps));
    const t = now();
    const sum = (k) => items.reduce((a, i) => a + (i[k] || 0), 0);
    const tasks = { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const i of items) for (const k of Object.keys(tasks)) tasks[k] += i.tasks[k] || 0;
    const inflightMax = inflightMaxCents(b);
    const waiting = b.status === 'queued' ? (b.started_at ? 'turn' : null) : b.status === 'running' ? waitReason.get(b.id) || null : null;
    return {
      id: b.id,
      drama_id: b.drama_id,
      status: b.status,
      kinds: b.kinds,
      episode_ids: b.episode_ids,
      concurrency: b.concurrency,
      provider_limits: providerLimits(),
      budget_cap_cents: b.budget_cap_cents,
      failure_policy: b.failure_policy,
      currency: b.totals.currency || 'CNY',
      sample_prices: !!b.totals.sample_prices,
      warnings: b.totals.warnings || [],
      totals: {
        estimate_min_cents: b.totals.estimate_min_cents || 0,
        estimate_max_cents: b.totals.estimate_max_cents || 0,
        spent_cents: sum('spent_cents'),
        in_flight_max_cents: inflightMax,
        remaining_min_cents: sum('remaining_min_cents'),
        remaining_max_cents: sum('remaining_max_cents'),
      },
      progress: {
        items_total: items.length,
        items_done: items.filter((i) => ITEM_DONE.has(i.status)).length,
        items_succeeded: items.filter((i) => i.status === 'succeeded').length,
        items_failed: items.filter((i) => i.status === 'failed').length,
        items_running: items.filter((i) => i.status === 'running').length,
        shots_total: sum('shots_total'),
        shots_done: sum('shots_done'),
        tasks,
      },
      waiting,
      error: b.error,
      started_at: b.started_at,
      finished_at: b.finished_at,
      elapsed_ms: b.started_at ? Math.max(0, (b.finished_at || t) - b.started_at) : 0,
      created_at: b.created_at,
      updated_at: b.updated_at,
      items,
    };
  }

  function inflightMaxCents(b) {
    let sum = 0;
    for (const it of listItems(b.id)) for (const tid of it.task_ids) { const t = store.get(tid); if (t && !TERMINAL.has(t.state)) sum += taskMaxCents(t); }
    return sum;
  }

  function list({ drama_id } = {}) {
    const rows = drama_id != null
      ? db.prepare('SELECT id FROM batch_jobs WHERE drama_id = ? ORDER BY created_at DESC, rowid DESC').all(Number(drama_id))
      : db.prepare('SELECT id FROM batch_jobs ORDER BY created_at DESC, rowid DESC').all();
    return rows.map((r) => view(r.id));
  }

  /** worker 的 onTaskFinished：本批次的任务结束就尽快调度下一轮。 */
  function onTaskFinished(task) {
    if (!task) return false;
    const m = taskMeta(task);
    if (!m.batch) return false;
    wakeFn();
    return true;
  }

  const onWake = (fn) => { wakeFn = typeof fn === 'function' ? fn : () => {}; };

  return { create, list, get: view, pause, resume, cancel, retryFailed, tick, onTaskFinished, onWake, providerLimits, providers: providersMeta, planFromEstimate };
}

module.exports = { createBatchService, BatchError };
