'use strict';
const { ERROR_CODES } = require('../providers/errors');
const { STATES, ACTIVE } = require('./states');

/** Thrown by injected crash points in tests. Never swallowed by the queue. */
class CrashSignal extends Error {
  constructor(point) { super(`simulated crash at ${point}`); this.name = 'CrashSignal'; this.point = point; }
}

const SUBMIT_UNCERTAIN = 'SUBMIT_UNCERTAIN';

/**
 * providers: { [name]: facade } where facade is
 *   submit(task, { idempotencyKey }) -> { vendorTaskId }
 *   poll(task) -> { status: 'running'|'succeeded'|'failed', result?, errorCode?, errorMessage? }
 *   download?(task, result) -> result      (optional, runs in 'downloading')
 *   lookupByKey?(idempotencyKey) -> vendorTaskId|null   (optional, resolves uncertain submits)
 * options:
 *   limits: { default: n, [provider]: n }      per-provider concurrency (E02 may extend)
 *   backoff(provider, err, attempt) -> ms      used when no Retry-After is present
 *   hooks.onRateLimit({ provider, retryAfterMs, taskId })
 *   jitter(ms) -> ms                            applied to the 429 wait (Retry-After or backoff)
 *   pollDelay(task) -> ms                       delay before the next poll of a still-running task
 *   crash(point): called at 'before_submit' | 'after_submit' | 'after_id_write'
 *   maxPollErrors                               consecutive poll OR download errors before the task fails
 *   downloadBackoff(provider, err, attempt) -> ms   wait before the next download attempt (default 15s*2^(n-1), cap 5min)
 *   spendGuard(task) -> { ok: true } | { ok: false, message }   checked before a queued task is claimed;
 *     a refusal fails the task with SPEND_LIMIT (never submitted, retryable once limits change)
 */

/**
 * Download attempts are slow-paced on purpose: each one already retries inside download.js for ~13s, and the
 * typical cause (network not back yet after sleep/wake, DNS EAI_AGAIN) takes tens of seconds to clear.
 */
const defaultDownloadBackoff = (p, err, attempt) => Math.min(300000, 15000 * 2 ** Math.max(0, attempt - 1));

function createAiTaskQueue({ store, providers, limits = {}, now = () => Date.now(), backoff, jitter = (ms) => ms, pollDelay = null, hooks = {}, crash = () => {}, maxPollErrors = 5, spendGuard = null, downloadBackoff = defaultDownloadBackoff }) {
  const pausedUntil = new Map(); // provider -> epoch ms (429 backoff, shared by all tasks of the provider)
  const defaultBackoff = (p, err, attempt) => Math.min(60000, 1000 * 2 ** Math.max(0, attempt - 1));
  const computeBackoff = backoff || defaultBackoff;

  const limitFor = (p) => (limits[p] != null ? limits[p] : limits.default != null ? limits.default : 2);
  const facade = (name) => providers[name] || null;

  function retryAfterMs(err) {
    if (err && Number.isFinite(err.retryAfterMs)) return err.retryAfterMs;
    if (err && Number.isFinite(err.retryAfter)) return err.retryAfter * 1000;
    const h = err && err.headers && (err.headers['retry-after'] || err.headers['Retry-After']);
    if (h != null) {
      const n = Number(h);
      if (Number.isFinite(n)) return n * 1000;
      const d = Date.parse(h);
      if (!Number.isNaN(d)) return Math.max(0, d - now());
    }
    return null;
  }

  function noteRateLimit(task, err, attempt) {
    const ms = retryAfterMs(err);
    const wait = Math.max(0, Math.round(jitter(ms != null ? ms : computeBackoff(task.provider, err, attempt))));
    const until = now() + wait;
    pausedUntil.set(task.provider, Math.max(pausedUntil.get(task.provider) || 0, until));
    if (hooks.onRateLimit) hooks.onRateLimit({ provider: task.provider, retryAfterMs: wait, taskId: task.id });
    return until;
  }

  const isPaused = (p) => (pausedUntil.get(p) || 0) > now();
  const codeOf = (err) => (err && err.code && ERROR_CODES[err.code] ? err.code : ERROR_CODES.UNKNOWN);

  function enqueue(args) { return store.enqueue(args); }

  async function submitOne(task) {
    const p = facade(task.provider);
    if (!p) {
      if (store.claim(task.id)) store.fail(task.id, ERROR_CODES.PROVIDER_NOT_AVAILABLE, task.provider);
      return;
    }
    if (spendGuard) {
      let verdict;
      try { verdict = spendGuard(task); } catch (err) { verdict = { ok: false, message: `spend check failed: ${err && err.message}` }; }
      if (verdict && verdict.ok === false) { store.fail(task.id, ERROR_CODES.SPEND_LIMIT, verdict.message || null); return; }
    }
    if (!store.claim(task.id)) return;
    const claimed = store.get(task.id);
    crash('before_submit');
    store.markSubmitStarted(task.id);
    let res;
    try {
      res = await p.submit(claimed, { idempotencyKey: claimed.idempotency_key });
    } catch (err) {
      if (err instanceof CrashSignal) throw err;
      if (err && err.code === ERROR_CODES.RATE_LIMITED) {
        // 429 means the vendor rejected it, so retrying is safe.
        const until = noteRateLimit(claimed, err, claimed.attempts);
        store.requeue(task.id, { nextAttemptAt: until, errorCode: ERROR_CODES.RATE_LIMITED, errorMessage: err.message });
      } else {
        // Anything else may have reached the vendor: fail rather than risk a duplicate.
        store.fail(task.id, codeOf(err), err && err.message);
      }
      return;
    }
    crash('after_submit');
    if (!res || !res.vendorTaskId) { store.fail(task.id, ERROR_CODES.BAD_RESPONSE, 'missing vendor task id'); return; }
    store.recordVendorId(task.id, res.vendorTaskId);
    crash('after_id_write');
  }

  async function pollOne(task) {
    const p = facade(task.provider);
    if (!p) return;
    if (task.state === STATES.SUBMITTED) store.transition(task.id, 'submitted', 'polling');
    let r;
    try {
      r = await p.poll(store.get(task.id));
    } catch (err) {
      if (err instanceof CrashSignal) throw err;
      const n = task.poll_attempts + 1;
      const retryable = err && (err.code === ERROR_CODES.RATE_LIMITED || err.code === ERROR_CODES.NETWORK);
      if (!retryable || n >= maxPollErrors) { store.fail(task.id, codeOf(err), err && err.message); return; }
      const until = err.code === ERROR_CODES.RATE_LIMITED ? noteRateLimit(task, err, n) : now() + computeBackoff(task.provider, err, n);
      store.transition(task.id, 'polling', 'polling', { poll_attempts: n, next_attempt_at: until, error_code: codeOf(err), error_message: err.message });
      return;
    }
    if (r.status === 'succeeded') await finish(task.id, r.result);
    else if (r.status === 'failed') store.fail(task.id, r.errorCode && ERROR_CODES[r.errorCode] ? r.errorCode : ERROR_CODES.TASK_FAILED, r.errorMessage);
    else store.transition(task.id, 'polling', 'polling', { next_attempt_at: pollDelay ? now() + pollDelay(task) : null, poll_attempts: 0 });
  }

  async function finish(id, result) {
    const cur = store.get(id);
    const p = facade(cur.provider);
    if (p && p.download) {
      store.transition(id, cur.state, 'downloading', { result: JSON.stringify(result === undefined ? null : result) });
      return downloadOne(id);
    }
    store.succeed(id, result);
  }

  async function downloadOne(id) {
    const task = store.get(id);
    if (!task || task.state !== 'downloading') return;
    const p = facade(task.provider);
    let stored = null;
    try { stored = task.result ? JSON.parse(task.result) : null; } catch (_) { /* ignore */ }
    try {
      const out = await p.download(task, stored);
      store.succeed(id, out === undefined ? stored : out);
    } catch (err) {
      if (err instanceof CrashSignal) throw err;
      // The vendor already produced the result; only this machine failed to fetch it. Transient errors
      // (network down after wake, 429/5xx) keep the task in 'downloading' with its result and retry later.
      const n = task.poll_attempts + 1;
      const retryable = err && (err.code === ERROR_CODES.RATE_LIMITED || err.code === ERROR_CODES.NETWORK);
      if (!retryable || n >= maxPollErrors) { store.fail(id, codeOf(err), err && err.message); return; }
      store.transition(id, 'downloading', 'downloading', {
        poll_attempts: n, next_attempt_at: now() + downloadBackoff(task.provider, err, n), error_code: codeOf(err), error_message: err.message,
      });
    }
  }

  /**
   * Startup recovery. Never calls provider.submit. Tasks that already have a vendor id are
   * resumed through poll/download. A 'submitting' row with no vendor id is requeued only if
   * the submit marker proves the provider was never called, otherwise lookupByKey resolves it,
   * otherwise it is failed as SUBMIT_UNCERTAIN (never resubmitted).
   */
  async function reconcile() {
    const out = { requeued: [], resumed: [], uncertain: [], recovered: [] };
    for (const t of store.listByState(['submitting'])) {
      if (t.vendor_task_id) { store.transition(t.id, 'submitting', 'submitted'); continue; }
      if (!t.submit_started_at) {
        store.requeue(t.id);
        out.requeued.push(t.id);
        continue;
      }
      const p = facade(t.provider);
      let found = null;
      if (p && p.lookupByKey) {
        try { found = await p.lookupByKey(t.idempotency_key); } catch (err) { if (err instanceof CrashSignal) throw err; }
      }
      if (found) { store.recordVendorId(t.id, found); out.recovered.push(t.id); }
      else { store.fail(t.id, ERROR_CODES.UNKNOWN, `${SUBMIT_UNCERTAIN}: submit may have reached the vendor, not resubmitting`); out.uncertain.push(t.id); }
    }
    for (const t of store.listByState(['downloading'])) {
      if (facade(t.provider) && facade(t.provider).download) { await downloadOne(t.id); out.resumed.push(t.id); }
      else store.succeed(t.id, t.result ? JSON.parse(t.result) : null);
    }
    for (const t of store.listByState(['submitted', 'polling'])) {
      await pollOne(t);
      out.resumed.push(t.id);
    }
    return out;
  }

  /** One scheduler pass: poll due vendor tasks, then submit queued tasks within concurrency limits. */
  async function tick() {
    const summary = { submitted: 0, polled: 0, downloaded: 0 };
    const t0 = now();
    for (const t of store.listByState(['submitted', 'polling'], { dueAt: t0 })) {
      if (isPaused(t.provider)) continue;
      await pollOne(t);
      summary.polled++;
    }
    for (const t of store.listByState(['downloading'], { dueAt: t0 })) {
      if (!facade(t.provider) || !facade(t.provider).download) continue; // finish()/reconcile() settle these
      await downloadOne(t.id);
      summary.downloaded++;
    }
    const byProvider = new Map();
    for (const t of store.listByState(['queued'], { dueAt: t0 })) {
      if (!byProvider.has(t.provider)) byProvider.set(t.provider, []);
      byProvider.get(t.provider).push(t);
    }
    for (const [name, list] of byProvider) {
      if (isPaused(name)) continue;
      let free = limitFor(name) - store.countActive(name);
      for (const t of list) {
        if (free <= 0) break;
        await submitOne(t);
        free--;
        summary.submitted++;
        if (isPaused(name)) break;
      }
    }
    return summary;
  }

  return { enqueue, tick, reconcile, submitOne, pollOne, isPaused, pausedUntil, ACTIVE };
}

module.exports = { createAiTaskQueue, CrashSignal, SUBMIT_UNCERTAIN, defaultDownloadBackoff };
