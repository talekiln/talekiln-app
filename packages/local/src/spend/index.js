'use strict';
/**
 * D06 spend control: estimate before run, per-run and monthly caps, spend_log aggregation.
 * Prices come from configs/prices.json (public 百炼 list prices, dated in the file; remote config can override).
 * Money is a plain number in the price table's currency (CNY).
 */
const fs = require('fs');
const path = require('path');
const { getGlobalSetting, setGlobalSetting } = require('../services/settingsService');
const { toCsv } = require('./csv');

const LIMITS_KEY = 'spend.limits';
const PRICES_PATH = path.join(__dirname, '..', '..', 'configs', 'prices.json');
const round = (n) => Math.round(n * 1e6) / 1e6;

function loadPrices(file = PRICES_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const ACTIVE_STATES = ['queued', 'submitting', 'submitted', 'polling', 'downloading'];

function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 百炼 CosyVoice 计费规则：一个汉字算 2 个字符，字母 / 数字 / 标点 / 空格算 1 个（日文假名、韩文同按 2 计）。
const WIDE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿\u{20000}-\u{2fa1f}]/u;
function billableChars(text) {
  let n = 0;
  for (const ch of String(text || '')) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

function createEstimator(prices = loadPrices()) {
  const factor = Number(prices.max_factor) >= 1 ? Number(prices.max_factor) : 1;
  const base = () => ({
    currency: prices.currency || 'CNY', sample: prices.sample !== false, price_version: prices.version || null,
    price_date: prices.price_date || null, price_source: prices.source || null,
  });
  const entryFor = (provider, kind, params) => {
    const model = params.model || null;
    const table = prices.providers && prices.providers[provider] && prices.providers[provider][kind];
    return table ? (model && table[model]) || table._default || null : null;
  };
  // 分辨率档位不区分大小写（价目写 720P，用量可能回 720p）
  const unitPriceOf = (entry, resolution) => {
    let p = Number(entry.price) || 0;
    if (entry.by_resolution && resolution != null && resolution !== '') {
      const want = String(resolution).toLowerCase();
      const key = Object.keys(entry.by_resolution).find((k) => k.toLowerCase() === want);
      if (key != null) p = Number(entry.by_resolution[key]);
    }
    return p;
  };
  // 价目整体标成示例，或该条目未经核实，都算“示例价”
  const flags = (entry) => ({ ...base(), sample: prices.sample !== false || entry.verified === false });

  /** estimate({provider, kind, params}) -> { estimate, max, currency, known, sample, price_version, price_date, basis } */
  function estimate({ provider, kind, params = {} }) {
    const entry = entryFor(provider, kind, params);
    if (!entry) return { ...base(), estimate: 0, max: 0, known: false, basis: 'no price entry' };
    const unitPrice = unitPriceOf(entry, params.resolution);
    let units;
    let basis;
    if (entry.per === 'image') {
      units = Math.max(1, Math.floor(Number(params.n) || 1));
      basis = `${units} image x ${unitPrice}`;
    } else if (entry.per === 'second') {
      const dflt = (prices.defaults && prices.defaults.duration_seconds) || 5;
      units = Number(params.duration) > 0 ? Number(params.duration) : dflt;
      basis = `${units}s x ${unitPrice}`;
    } else if (entry.per === 'char') {
      units = billableChars(params.text);
      basis = `${units} chars x ${unitPrice}`;
    } else {
      units = 1;
      basis = `flat ${unitPrice}`;
    }
    const est = round(units * unitPrice);
    return { ...flags(entry), estimate: est, max: round(est * factor), known: true, basis };
  }

  /**
   * 真实费用：按服务商回传的用量（视频计费秒数 + 分辨率 / 配音计费字符数 / 图片张数）乘以同一价目。
   * 没有可用的用量就返回 null（spend_log.actual 留空，统计时退回预估）。
   * usage 字段兼容：视频 duration | video_duration（秒），SR | resolution（档位）；配音 characters；图片 images | image_count，否则数 result.urls。
   */
  function actual({ provider, kind, params = {} }, usage, result) {
    const entry = entryFor(provider, kind, params);
    if (!entry) return null;
    const u = usage && typeof usage === 'object' ? usage : {};
    const num = (...vals) => { for (const v of vals) { const n = Number(v); if (v != null && v !== '' && Number.isFinite(n)) return n; } return null; };
    let units = null;
    let resolution = params.resolution;
    if (entry.per === 'second') {
      const d = num(u.duration, u.video_duration, u.seconds);
      if (d != null && d > 0) units = d;
      if (u.SR != null && u.SR !== '') resolution = /^\d+$/.test(String(u.SR)) ? `${u.SR}P` : String(u.SR);
      else if (u.resolution) resolution = String(u.resolution);
    } else if (entry.per === 'char') {
      const c = num(u.characters, u.input_characters, u.chars);
      if (c != null && c >= 0) units = c;
    } else if (entry.per === 'image') {
      const c = num(u.images, u.image_count, u.n);
      if (c != null && c > 0) units = c;
      else if (result && Array.isArray(result.urls) && result.urls.length) units = result.urls.length;
    } else {
      units = 1;
    }
    if (units == null) return null;
    const unitPrice = unitPriceOf(entry, resolution);
    const out = { actual: round(units * unitPrice), units, unit: entry.per || 'flat', unit_price: unitPrice, basis: `${units} ${entry.per || 'flat'} x ${unitPrice}` };
    if (resolution) out.resolution = resolution;
    return out;
  }

  const info = () => base();
  return { estimate, actual, billableChars, prices, info };
}

function normalizeCap(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new RangeError('limit must be a non-negative number or null');
  return n;
}

function createSpendService(db, { estimator = createEstimator(), now = () => Date.now() } = {}) {
  const getLimits = () => {
    const v = getGlobalSetting(db, LIMITS_KEY, null) || {};
    return { per_run_cap: v.per_run_cap == null ? null : Number(v.per_run_cap), monthly_cap: v.monthly_cap == null ? null : Number(v.monthly_cap) };
  };

  function setLimits(patch = {}) {
    const cur = getLimits();
    const next = { ...cur };
    if ('per_run_cap' in patch) next.per_run_cap = normalizeCap(patch.per_run_cap);
    if ('monthly_cap' in patch) next.monthly_cap = normalizeCap(patch.monthly_cap);
    setGlobalSetting(db, LIMITS_KEY, next);
    return next;
  }

  const metaOf = (task) => {
    let params = {};
    try { params = task.params ? JSON.parse(task.params) : {}; } catch (_) { /* ignore */ }
    return { params, projectId: params._project || null };
  };

  const estimateTask = (task) => estimator.estimate({ provider: task.provider, kind: task.kind, params: metaOf(task).params });

  function monthSpent() {
    const prefix = localDay(now()).slice(0, 7);
    return db.prepare(`SELECT COALESCE(SUM(COALESCE(actual, estimated)), 0) s FROM spend_log WHERE day LIKE ?`).get(`${prefix}-%`).s;
  }

  /** Worst-case cost of tasks that are accepted but not yet logged (excluding `exceptId`). */
  function inFlightMax(exceptId) {
    const ph = ACTIVE_STATES.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, provider, kind, params FROM ai_tasks WHERE state IN (${ph})`).all(...ACTIVE_STATES);
    let sum = 0;
    for (const t of rows) if (t.id !== exceptId) sum += estimateTask(t).max;
    return sum;
  }

  /** check({provider, kind, params}) -> { ok:true, est } | { ok:false, reason, message, est } */
  function check(spec, { exceptId = null } = {}) {
    const est = estimator.estimate(spec);
    const lim = getLimits();
    const cur = est.currency;
    if (lim.per_run_cap != null && est.max > lim.per_run_cap) {
      return { ok: false, reason: 'per_run', est, message: `预计最高费用 ${est.max} ${cur} 超过单次上限 ${lim.per_run_cap} ${cur}` };
    }
    if (lim.monthly_cap != null) {
      const projected = monthSpent() + inFlightMax(exceptId) + est.max;
      if (projected > lim.monthly_cap) {
        return { ok: false, reason: 'monthly', est, message: `本月已用及在途预计 ${round(projected - est.max)} ${cur}，加上本次最高 ${est.max} ${cur} 将超过月度上限 ${lim.monthly_cap} ${cur}` };
      }
    }
    return { ok: true, est };
  }

  /** Cap status for confirm dialogs: limits, month spent, in-flight worst case and what is left. */
  function capStatus() {
    const lim = getLimits();
    const spent = monthSpent();
    const inflight = inFlightMax(null);
    return {
      currency: estimator.prices.currency || 'CNY',
      per_run_cap: lim.per_run_cap,
      monthly_cap: lim.monthly_cap,
      month_spent: round(spent),
      in_flight_max: round(inflight),
      monthly_remaining: lim.monthly_cap == null ? null : round(Math.max(0, lim.monthly_cap - spent - inflight)),
    };
  }

  /**
   * Estimate a whole batch (one click) BEFORE any task exists, and check it against the caps as one run:
   * per_run_cap applies to the batch's worst case, monthly_cap to month spent + in-flight + the batch.
   * specs: [{ provider, kind, params }]. Creates nothing.
   */
  function checkBatch(specs) {
    const estimates = specs.map((s) => estimator.estimate(s));
    const total = round(estimates.reduce((a, e) => a + e.estimate, 0));
    const max = round(estimates.reduce((a, e) => a + e.max, 0));
    const cap = capStatus();
    const cur = cap.currency;
    const out = {
      ok: true, reason: null, message: null, estimates, total, max, currency: cur,
      sample_prices: estimator.prices.sample !== false, known: estimates.every((e) => e.known), cap,
    };
    if (cap.per_run_cap != null && max > cap.per_run_cap) {
      return { ...out, ok: false, reason: 'per_run', message: `本次预计最高费用 ${max} ${cur} 超过单次上限 ${cap.per_run_cap} ${cur}` };
    }
    if (cap.monthly_cap != null && cap.month_spent + cap.in_flight_max + max > cap.monthly_cap) {
      return { ...out, ok: false, reason: 'monthly', message: `本月已用 ${cap.month_spent} ${cur}、在途最高 ${cap.in_flight_max} ${cur}，加上本次最高 ${max} ${cur} 将超过月度上限 ${cap.monthly_cap} ${cur}` };
    }
    return out;
  }

  /** Queue spendGuard: re-checked at submit time, so caps hold even if the limits changed after enqueue. */
  function guardTask(task) {
    const { params } = metaOf(task);
    const r = check({ provider: task.provider, kind: task.kind, params }, { exceptId: task.id });
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  }

  const resultOf = (task) => { try { return task.result ? JSON.parse(task.result) : null; } catch (_) { return null; } };

  /** 真实用量 -> 费用（spend_log.actual 的来源）；没有可用用量返回 null。 */
  function actualOf(task) {
    if (typeof estimator.actual !== 'function') return null;
    const { params } = metaOf(task);
    const r = resultOf(task);
    return estimator.actual({ provider: task.provider, kind: task.kind, params }, r && r.usage, r);
  }

  /**
   * Record a finished (succeeded) task once. `actual` is taken from the caller when given, otherwise computed from the
   * usage the vendor reported in the task result (video seconds, tts characters, image count) at the current price table;
   * when nothing usable was reported it stays null and the estimate is what counts.
   */
  function recordFinished(task, { actual = null } = {}) {
    if (!task || task.state !== 'succeeded') return false;
    const { params, projectId } = metaOf(task);
    const est = estimator.estimate({ provider: task.provider, kind: task.kind, params });
    let real = actual;
    let usage = null;
    if (real == null) {
      const a = actualOf(task);
      if (a) {
        const r = resultOf(task);
        real = a.actual;
        usage = { ...a, reported: r && r.usage && typeof r.usage === 'object' ? r.usage : null };
      }
    }
    const t = task.completed_at || now();
    const info = db.prepare(
      `INSERT OR IGNORE INTO spend_log (task_id, provider, kind, model, project_id, currency, estimated, actual, usage, day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(task.id, task.provider, task.kind, params.model || null, projectId, est.currency, est.estimate, real, usage ? JSON.stringify(usage) : null, localDay(t), now());
    return info.changes === 1;
  }

  function summary({ from, to } = {}) {
    const f = from || `${localDay(now()).slice(0, 7)}-01`;
    const t = to || '9999-12-31';
    const cost = 'COALESCE(actual, estimated)';
    const agg = (col) => db.prepare(
      `SELECT ${col} AS key, COUNT(*) AS count, ROUND(SUM(estimated), 6) AS estimated, ROUND(SUM(COALESCE(actual, 0)), 6) AS actual, ROUND(SUM(${cost}), 6) AS cost
       FROM spend_log WHERE day >= ? AND day <= ? GROUP BY ${col} ORDER BY ${col}`
    ).all(f, t);
    const total = db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(ROUND(SUM(${cost}), 6), 0) AS cost, COALESCE(ROUND(SUM(estimated), 6), 0) AS estimated,
              COALESCE(ROUND(SUM(COALESCE(actual, 0)), 6), 0) AS actual, COALESCE(SUM(CASE WHEN actual IS NULL THEN 0 ELSE 1 END), 0) AS actual_count
       FROM spend_log WHERE day >= ? AND day <= ?`
    ).get(f, t);
    const pinfo = typeof estimator.info === 'function' ? estimator.info() : { sample: estimator.prices.sample !== false, price_version: estimator.prices.version || null, price_date: null, price_source: null };
    const lim = getLimits();
    const spent = monthSpent();
    return {
      currency: estimator.prices.currency || 'CNY',
      sample_prices: estimator.prices.sample !== false,
      from: f,
      to: to || null,
      prices: { version: pinfo.price_version, date: pinfo.price_date, source: pinfo.price_source, sample: pinfo.sample },
      total: { count: total.count, cost: total.cost, estimated: total.estimated, actual: total.actual, actual_count: total.actual_count },
      by_provider: agg('provider').map(({ key, ...r }) => ({ provider: key, ...r })),
      by_model: agg("COALESCE(provider, '') || '/' || COALESCE(model, '')").map(({ key, ...r }) => {
        const i = key.indexOf('/');
        return { provider: key.slice(0, i), model: key.slice(i + 1) || null, ...r };
      }),
      by_project: agg("COALESCE(project_id, '')").map(({ key, ...r }) => ({ project_id: key || null, ...r })),
      by_day: agg('day').map(({ key, ...r }) => ({ day: key, ...r })),
      month: { spent: round(spent), in_flight_max: round(inFlightMax(null)), monthly_cap: lim.monthly_cap, remaining: lim.monthly_cap == null ? null : round(Math.max(0, lim.monthly_cap - spent)) },
      limits: lim,
    };
  }

  /** Per-task rows (newest first) for the cost view and CSV export. cost = actual when reported, else estimate. */
  function listTasks({ from, to, project_id, limit = 200, offset = 0 } = {}) {
    const where = ['day >= ?', 'day <= ?'];
    const args = [from || '0000-01-01', to || '9999-12-31'];
    if (project_id !== undefined && project_id !== null && project_id !== '') {
      where.push('project_id = ?');
      args.push(String(project_id));
    }
    const lim = Math.min(Math.max(Math.floor(Number(limit)) || 200, 1), 100000);
    const off = Math.max(Math.floor(Number(offset)) || 0, 0);
    const w = where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM spend_log WHERE ${w}`).get(...args).n;
    const items = db.prepare(
      `SELECT task_id, provider, kind, model, project_id, currency, estimated, actual, usage,
              ROUND(COALESCE(actual, estimated), 6) AS cost, day, created_at
       FROM spend_log WHERE ${w} ORDER BY day DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...args, lim, off).map((r) => { let u = null; try { u = r.usage ? JSON.parse(r.usage) : null; } catch (_) { /* ignore */ } return { ...r, usage: u }; });
    return { items, total, limit: lim, offset: off, currency: estimator.prices.currency || 'CNY' };
  }

  return { estimate: (spec) => estimator.estimate(spec), actualOf, listTasks, toCsv, check, checkBatch, capStatus, guardTask, recordFinished, getLimits, setLimits, summary, monthSpent, inFlightMax };
}

module.exports = { createEstimator, createSpendService, loadPrices, localDay, billableChars, LIMITS_KEY, PRICES_PATH };
