'use strict';
const { ACTIVE, TERMINAL } = require('./states');

const DEFAULTS = Object.freeze({
  limits: { default: 2 },
  idle_min_ms: 500,      // tick interval while there is activity
  idle_max_ms: 5000,     // tick interval cap while idle (grows by idle_factor)
  idle_factor: 1.7,
  poll_min_ms: 2000,     // delay between polls of a running vendor task...
  poll_max_ms: 30000,    // ...which grows with the task's age
  jitter_ratio: 0.2,
});

function resolveOptions(cfg) {
  const c = (cfg && (cfg.ai_queue || cfg)) || {};
  const num = (k) => (Number.isFinite(Number(c[k])) && Number(c[k]) > 0 ? Number(c[k]) : DEFAULTS[k]);
  const limits = { ...DEFAULTS.limits };
  for (const [k, v] of Object.entries(c.limits || {})) if (Number.isFinite(Number(v)) && Number(v) > 0) limits[k] = Math.floor(Number(v));
  return {
    limits,
    idle_min_ms: num('idle_min_ms'), idle_max_ms: num('idle_max_ms'), idle_factor: num('idle_factor'),
    poll_min_ms: num('poll_min_ms'), poll_max_ms: num('poll_max_ms'),
    jitter_ratio: Number.isFinite(Number(c.jitter_ratio)) && Number(c.jitter_ratio) >= 0 ? Number(c.jitter_ratio) : DEFAULTS.jitter_ratio,
  };
}

/** Adds 0..ratio of extra wait on top of ms; never shorter than the vendor's Retry-After. */
function makeJitter(random = Math.random, ratio = DEFAULTS.jitter_ratio) {
  return (ms) => ms + ms * ratio * random();
}

/** Poll delay grows with the age of the vendor task: a quarter of its age, clamped. */
function pollDelayFor(ageMs, { poll_min_ms = DEFAULTS.poll_min_ms, poll_max_ms = DEFAULTS.poll_max_ms } = {}) {
  return Math.min(poll_max_ms, Math.max(poll_min_ms, Math.floor(Math.max(0, ageMs) / 4)));
}

/** Loop interval: reset to min after activity, otherwise grow geometrically up to max. */
function nextLoopDelay(prev, active, o = DEFAULTS) {
  if (active) return o.idle_min_ms;
  return Math.min(o.idle_max_ms, Math.max(o.idle_min_ms, Math.round(prev * o.idle_factor)));
}

/** Queue options derived from config: spread into createAiTaskQueue. */
function queueOptionsFromConfig(cfg, { now = () => Date.now(), random = Math.random } = {}) {
  const o = resolveOptions(cfg);
  return {
    limits: o.limits,
    jitter: makeJitter(random, o.jitter_ratio),
    pollDelay: (task) => pollDelayFor(now() - (task.submitted_at || task.created_at || now()), o),
  };
}

const NON_TERMINAL = ['queued', ...ACTIVE];

/**
 * Drives queue.tick() on a self-adjusting timer. tick/reconcile never overlap (shared mutex), so
 * reconcileNow('resume') is safe to call from the desktop main process at any time.
 */
function createWorker({ queue, store, config, setTimer = setTimeout, clearTimer = clearTimeout, onTaskFinished, onError = () => {} }) {
  const o = resolveOptions(config);
  let timer = null;
  let running = false;
  let delay = o.idle_min_ms;
  let chain = Promise.resolve();
  const tracked = new Set();

  const exclusive = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  function sync() {
    const cur = new Set(store.listByState(NON_TERMINAL).map((t) => t.id));
    for (const id of [...tracked]) {
      if (cur.has(id)) continue;
      tracked.delete(id);
      const t = store.get(id);
      if (t && TERMINAL.has(t.state) && onTaskFinished) {
        try { onTaskFinished(t); } catch (e) { onError(e); }
      }
    }
    for (const id of cur) tracked.add(id);
  }

  function runOnce() {
    return exclusive(async () => {
      sync();
      try { return await queue.tick(); } finally { sync(); }
    });
  }

  function schedule(ms = delay) {
    if (!running) return;
    clearTimer(timer);
    timer = setTimer(loop, ms);
    if (timer && timer.unref) timer.unref();
  }

  async function loop() {
    timer = null;
    if (!running) return;
    try {
      const r = await runOnce();
      delay = nextLoopDelay(delay, !!(r && (r.submitted || r.polled || r.downloaded)), o);
    } catch (e) {
      onError(e);
      delay = o.idle_max_ms;
    }
    schedule();
  }

  /** Tick soon (e.g. right after enqueue). */
  function wake() {
    delay = o.idle_min_ms;
    schedule(0);
  }

  /** Startup / system-resume recovery (never resubmits to a vendor), then wake the loop. */
  async function reconcileNow(reason = 'manual') {
    const out = await exclusive(async () => {
      sync();
      try { return await queue.reconcile(); } finally { sync(); }
    });
    out.reason = reason;
    wake();
    return out;
  }

  async function start() {
    if (running) return;
    running = true;
    try { await reconcileNow('startup'); } catch (e) { onError(e); }
    schedule();
  }

  async function stop() {
    running = false;
    clearTimer(timer);
    timer = null;
    await chain;
  }

  /** Tasks that are not finished: used for the "quit while tasks running" confirmation. */
  const unfinishedCount = () => store.listByState(NON_TERMINAL).length;

  return { start, stop, wake, runOnce, reconcileNow, onResume: () => reconcileNow('resume'), unfinishedCount, isRunning: () => running, options: o };
}

module.exports = { createWorker, resolveOptions, makeJitter, pollDelayFor, nextLoopDelay, queueOptionsFromConfig, DEFAULTS };
