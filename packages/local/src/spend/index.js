'use strict';
/**
 * D06 spend control: estimate before run, per-run and monthly caps, spend_log aggregation.
 * Prices come from configs/prices.json, which holds SAMPLE prices to be replaced by remote config.
 * Money is a plain number in the price table's currency (CNY).
 */
const fs = require('fs');
const path = require('path');
const { getGlobalSetting, setGlobalSetting } = require('../services/settingsService');

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

function createEstimator(prices = loadPrices()) {
  /** estimate({provider, kind, params}) -> { estimate, max, currency, known, sample, basis } */
  function estimate({ provider, kind, params = {} }) {
    const model = params.model || null;
    const table = prices.providers && prices.providers[provider] && prices.providers[provider][kind];
    const entry = table ? (model && table[model]) || table._default || null : null;
    const factor = Number(prices.max_factor) >= 1 ? Number(prices.max_factor) : 1;
    const base = { currency: prices.currency || 'CNY', sample: prices.sample !== false, price_version: prices.version || null };
    if (!entry) return { ...base, estimate: 0, max: 0, known: false, basis: 'no price entry' };
    let unitPrice = Number(entry.price) || 0;
    if (entry.by_resolution && params.resolution && entry.by_resolution[params.resolution] != null) {
      unitPrice = Number(entry.by_resolution[params.resolution]);
    }
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
      units = Array.from(String(params.text || '')).length;
      basis = `${units} chars x ${unitPrice}`;
    } else {
      units = 1;
      basis = `flat ${unitPrice}`;
    }
    const est = round(units * unitPrice);
    return { ...base, estimate: est, max: round(est * factor), known: true, basis };
  }
  return { estimate, prices };
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

  /** Queue spendGuard: re-checked at submit time, so caps hold even if the limits changed after enqueue. */
  function guardTask(task) {
    const { params } = metaOf(task);
    const r = check({ provider: task.provider, kind: task.kind, params }, { exceptId: task.id });
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  }

  /** Record a finished (succeeded) task. actual is only set when the provider reported a cost. */
  function recordFinished(task, { actual = null } = {}) {
    if (!task || task.state !== 'succeeded') return false;
    const { params, projectId } = metaOf(task);
    const est = estimator.estimate({ provider: task.provider, kind: task.kind, params });
    const t = task.completed_at || now();
    const info = db.prepare(
      `INSERT OR IGNORE INTO spend_log (task_id, provider, kind, model, project_id, currency, estimated, actual, day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(task.id, task.provider, task.kind, params.model || null, projectId, est.currency, est.estimate, actual, localDay(t), now());
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
    const total = db.prepare(`SELECT COUNT(*) AS count, COALESCE(ROUND(SUM(${cost}), 6), 0) AS cost FROM spend_log WHERE day >= ? AND day <= ?`).get(f, t);
    const lim = getLimits();
    const spent = monthSpent();
    return {
      currency: estimator.prices.currency || 'CNY',
      sample_prices: estimator.prices.sample !== false,
      from: f,
      to: to || null,
      total: { count: total.count, cost: total.cost },
      by_provider: agg('provider').map(({ key, ...r }) => ({ provider: key, ...r })),
      by_project: agg("COALESCE(project_id, '')").map(({ key, ...r }) => ({ project_id: key || null, ...r })),
      by_day: agg('day').map(({ key, ...r }) => ({ day: key, ...r })),
      month: { spent: round(spent), in_flight_max: round(inFlightMax(null)), monthly_cap: lim.monthly_cap, remaining: lim.monthly_cap == null ? null : round(Math.max(0, lim.monthly_cap - spent)) },
      limits: lim,
    };
  }

  return { estimate: (spec) => estimator.estimate(spec), check, guardTask, recordFinished, getLimits, setLimits, summary, monthSpent, inFlightMax };
}

module.exports = { createEstimator, createSpendService, loadPrices, localDay, LIMITS_KEY, PRICES_PATH };
