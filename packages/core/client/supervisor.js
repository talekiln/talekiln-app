'use strict';
// lycore 进程守护（桌面主进程侧）：启动、core.hello 健康探测、退避自动重启、干净退出。无依赖。
//
// 状态：stopped -> starting -> running -> (子进程退出/探测失败) -> backoff -> starting ...
//       连续重启超过 maxRestarts 次 -> failed（不再重试，触发 'failed' 事件，由上层提示用户）
//       stop() -> stopping -> stopped
// 事件（EventEmitter）：'state'(state, info)、'restart'({attempt, delayMs, reason})、'failed'({restarts, reason})、
//       'ready'(hello 结果)、'exit'({code, signal, expected})、'log'(line)。
// 稳定运行超过 resetAfterMs 后，重启计数清零（偶发崩溃不会累积到上限）。

const { EventEmitter } = require('events');
const { spawn: nodeSpawn } = require('child_process');


const defaults = {
  maxRestarts: 5,
  backoff: { baseMs: 500, factor: 2, maxMs: 30000 },
  healthIntervalMs: 5000,
  healthTimeoutMs: 3000,
  healthFailures: 3, // 连续探测失败多少次后判定挂死并杀掉子进程
  resetAfterMs: 60000,
  connectTries: 50,
  connectDelayMs: 100,
  stopGraceMs: 3000, // stop() 发出终止信号后等待退出的时间，超时强杀
};

/** 第 attempt 次（从 1 开始）重启前的等待时间：base * factor^(attempt-1)，上限 maxMs。 */
function backoffDelay(attempt, { baseMs, factor, maxMs }) {
  return Math.min(maxMs, Math.round(baseMs * Math.pow(factor, attempt - 1)));
}

function withTimeout(p, ms, what) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout: ' + what)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} o
 * @param {string} o.bin lycore 可执行文件路径
 * @param {string} o.endpoint 命名管道（Windows）或 socket 路径
 * @param {string} [o.logDir]
 * @param {object} [o.env] 额外环境变量（如 LYCORE_FFMPEG_DIR）
 * @param {Function} [o.spawn] 注入：(bin, args, opts) => ChildProcess 形对象（测试用假子进程）
 * @param {Function} [o.connect] 注入：(endpoint) => Promise<client>（client 需有 hello/call/close）
 * 其余字段见 defaults。
 */
function createSupervisor(o) {
  const cfg = { ...defaults, ...o, backoff: { ...defaults.backoff, ...(o.backoff || {}) } };
  const spawnFn = o.spawn || nodeSpawn;
  const connectFn = o.connect || ((ep) => require('./index').connectRetry(ep, cfg.connectTries, cfg.connectDelayMs)); // 延迟 require 避免与 index.js 循环依赖
  const ev = new EventEmitter();

  let state = 'stopped';
  let child = null;
  let client = null;
  let gen = 0; // 每次启动 +1，丢弃过期的异步结果
  let restarts = 0; // 当前连续重启次数
  let startedAt = 0;
  let healthTimer = null;
  let restartTimer = null;
  let stopping = false;
  let lastHello = null;

  function setState(s, info) {
    state = s;
    ev.emit('state', s, info);
  }

  function clearTimers() {
    clearTimeout(healthTimer); healthTimer = null;
    clearTimeout(restartTimer); restartTimer = null;
  }

  function launch() {
    const myGen = ++gen;
    startedAt = Date.now(); // spawn 同步失败时也要有正确的起点，否则会误判为“稳定运行”而清零计数
    setState('starting');
    const args = ['--pipe', cfg.endpoint];
    if (cfg.logDir) args.push('--log-dir', cfg.logDir);
    let c;
    try {
      c = spawnFn(cfg.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(cfg.env || {}) }, windowsHide: true });
    } catch (e) {
      // 同步 spawn 失败（如路径不存在）按崩溃处理
      setImmediate(() => onChildGone(myGen, { code: null, signal: null, error: e }));
      return;
    }
    child = c;
    for (const s of [c.stdout, c.stderr]) {
      if (s && s.on) s.on('data', (d) => ev.emit('log', String(d).trimEnd()));
    }
    let gone = false;
    const done = (info) => { if (!gone) { gone = true; onChildGone(myGen, info); } };
    c.once('exit', (code, signal) => done({ code, signal }));
    c.once('error', (error) => done({ code: null, signal: null, error }));

    connectFn(cfg.endpoint).then(async (cl) => {
      if (myGen !== gen || stopping) { try { cl.close(); } catch { /* ignore */ } return; }
      client = cl;
      const hello = await withTimeout(cl.hello(), cfg.healthTimeoutMs, 'core.hello');
      if (myGen !== gen || stopping) return;
      lastHello = hello;
      setState('running', hello);
      ev.emit('ready', hello);
      scheduleHealth(myGen, 0);
    }).catch((e) => {
      if (myGen !== gen || stopping) return;
      // 连不上或握手失败：杀掉子进程，由退出处理走重启
      killChild(`startup failed: ${e.message}`);
    });
  }

  function killChild(reason) {
    ev.emit('log', `killing lycore: ${reason}`);
    if (client) { try { client.close(); } catch { /* ignore */ } client = null; }
    if (child) { try { child.kill(); } catch { /* ignore */ } }
  }

  let failCount = 0;
  function scheduleHealth(myGen, failures) {
    failCount = failures;
    healthTimer = setTimeout(async () => {
      if (myGen !== gen || stopping || !client) return;
      try {
        await withTimeout(client.hello(), cfg.healthTimeoutMs, 'health ping');
        if (myGen !== gen) return;
        if (Date.now() - startedAt >= cfg.resetAfterMs) restarts = 0;
        scheduleHealth(myGen, 0);
      } catch (e) {
        if (myGen !== gen || stopping) return;
        const n = failCount + 1;
        ev.emit('log', `health ping failed (${n}/${cfg.healthFailures}): ${e.message}`);
        if (n >= cfg.healthFailures) killChild('health check failed');
        else scheduleHealth(myGen, n);
      }
    }, cfg.healthIntervalMs);
  }

  function onChildGone(myGen, { code, signal, error }) {
    if (myGen !== gen) return;
    clearTimeout(healthTimer); healthTimer = null;
    if (client) { try { client.close(); } catch { /* ignore */ } client = null; }
    child = null;
    gen++; // 使该次启动的所有异步回调失效
    ev.emit('exit', { code, signal, expected: stopping });
    if (stopping) return;
    const reason = error ? `spawn error: ${error.message}` : `exited code=${code} signal=${signal}`;
    if (Date.now() - startedAt >= cfg.resetAfterMs) restarts = 0;
    if (restarts >= cfg.maxRestarts) {
      setState('failed', { reason });
      ev.emit('failed', { restarts, reason });
      return;
    }
    restarts++;
    const delayMs = backoffDelay(restarts, cfg.backoff);
    setState('backoff', { attempt: restarts, delayMs });
    ev.emit('restart', { attempt: restarts, delayMs, reason });
    restartTimer = setTimeout(() => { restartTimer = null; if (!stopping) launch(); }, delayMs);
  }

  // 注意：Object.assign 会把 getter 求值成静态值，所以访问器单独用 defineProperties。
  Object.defineProperties(ev, {
    state: { get: () => state },
    restarts: { get: () => restarts },
    pid: { get: () => (child ? child.pid : null) },
    hello: { get: () => lastHello },
  });
  return Object.assign(ev, {
    /** 启动；resolve 于首次 running，或在 failed 时 reject。 */
    start() {
      if (state !== 'stopped' && state !== 'failed') return Promise.reject(new Error('supervisor already started'));
      stopping = false;
      restarts = 0;
      const ready = new Promise((resolve, reject) => {
        const onState = (s, info) => {
          if (s === 'running') { ev.off('state', onState); resolve(info); }
          else if (s === 'failed') { ev.off('state', onState); reject(new Error('lycore failed to start: ' + info.reason)); }
        };
        ev.on('state', onState);
      });
      launch();
      return ready;
    },
    /** 当前 RPC 客户端（非 running 时为 null）。 */
    getClient() { return state === 'running' ? client : null; },
    /** 经当前连接调用；未运行时抛错，调用方可等待 'ready' 后重试。 */
    call(method, params) {
      if (state !== 'running' || !client) return Promise.reject(new Error(`lycore not running (state=${state})`));
      return client.call(method, params);
    },
    /** 干净退出：关连接、发终止信号、超时强杀；幂等。 */
    async stop() {
      if (state === 'stopped') return;
      stopping = true;
      setState('stopping');
      clearTimers();
      const c = child;
      if (client) { try { client.close(); } catch { /* ignore */ } client = null; }
      if (c) {
        await new Promise((resolve) => {
          let finished = false;
          const fin = () => { if (!finished) { finished = true; clearTimeout(t); resolve(); } };
          c.once('exit', fin);
          try { c.kill(); } catch { /* ignore */ }
          const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } setTimeout(fin, 200); }, cfg.stopGraceMs);
        });
      }
      gen++;
      child = null;
      setState('stopped');
    },
  });
}

module.exports = { createSupervisor, backoffDelay, defaults };
