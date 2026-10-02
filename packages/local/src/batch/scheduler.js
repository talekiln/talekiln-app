'use strict';
/**
 * P3-B 批次调度器：定时调用 service.tick()。有批次在跑时按 activeMs 轮询，否则按 idleMs；
 * 任务结束 / 新建批次 / 继续时 wake() 立刻跑一轮。tick 之间不重叠（共享 promise 链）。
 * setTimer / clearTimer 可注入（测试用假定时器）。
 */
const DEFAULTS = Object.freeze({ activeMs: 2000, idleMs: 15000 });

function createBatchScheduler({ service, setTimer = setTimeout, clearTimer = clearTimeout, activeMs = DEFAULTS.activeMs, idleMs = DEFAULTS.idleMs, onError = () => {} }) {
  if (!service || typeof service.tick !== 'function') throw new Error('service.tick is required');
  let timer = null;
  let running = false;
  let chain = Promise.resolve();

  const exclusive = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  /** 跑一轮（返回 service.tick 的结果）。 */
  function runOnce() {
    return exclusive(async () => service.tick());
  }

  function schedule(ms) {
    if (!running) return;
    clearTimer(timer);
    timer = setTimer(loop, ms);
    if (timer && timer.unref) timer.unref();
  }

  async function loop() {
    timer = null;
    if (!running) return;
    let delay = idleMs;
    try {
      const r = await runOnce();
      if (r && r.active) delay = activeMs;
    } catch (e) {
      onError(e);
    }
    schedule(delay);
  }

  function wake() {
    schedule(0);
  }

  function start() {
    if (running) return;
    running = true;
    schedule(0);
  }

  async function stop() {
    running = false;
    clearTimer(timer);
    timer = null;
    await chain;
  }

  if (typeof service.onWake === 'function') service.onWake(wake);
  return { start, stop, wake, runOnce, isRunning: () => running, options: { activeMs, idleMs } };
}

/**
 * 桌面主进程与 server.js 只调用 aiQueue.worker.start() / stop()：把批次调度器挂到同一生命周期上
 * （worker 启动后启动调度器，停止前先停调度器）。原地改写 worker 的两个方法，返回同一个 worker。
 */
function attachToWorker(worker, scheduler) {
  const start = worker.start;
  const stop = worker.stop;
  worker.start = async (...args) => {
    const r = await start.apply(worker, args);
    scheduler.start();
    return r;
  };
  worker.stop = async (...args) => {
    await scheduler.stop();
    return stop.apply(worker, args);
  };
  return worker;
}

module.exports = { createBatchScheduler, attachToWorker, DEFAULTS };
