'use strict';
/**
 * 云端更新检查与公告（二期遗留 P2-H）：主进程启动后延迟 30 秒、之后每 6 小时各调一次
 * GET /updates/check（带当前版本、平台、架构、渠道、设备 ID）与 GET /public/announcements?channel=，结果通过 onStatus 回调发给渲染端（IPC）。
 * 离线 / 云端未配置 / 云端不可达时静默：只记日志，保留上一次的结果。
 * http 是 packages/local/src/cloud/http.js 的 createCloudHttp（沿用 base URL 配置与错误模型），计时器可注入。
 */
const logic = require('./cloud-check-logic');

function createCloudCheck({
  http, currentVersion, channel = 'latest', deviceId = null, platform = process.platform, arch = process.arch,
  onStatus = () => {}, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(),
  startDelayMs = logic.START_DELAY_MS, intervalMs = logic.INTERVAL_MS,
} = {}) {
  const state = { update: { available: false }, announcements: [], checkedAt: null, error: null };
  let timer = null;
  let running = false;
  let inFlight = null;

  const payload = () => logic.statusPayload({ currentVersion, channel, ...state });
  const emit = () => { try { onStatus(payload()); } catch (e) { log(`cloud-check: onStatus failed ${e && e.message}`); } };

  /** 立刻检查一次（两个请求各自失败不影响另一个）。返回状态快照。 */
  async function check() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (!http || typeof http.request !== 'function') { state.error = 'cloud_not_configured'; return payload(); }
      let changed = false;
      let error = null;
      try {
        const res = await http.request('GET', '/updates/check', { query: logic.buildCheckQuery({ version: currentVersion, channel, deviceId, platform, arch }) });
        const next = logic.evaluateUpdate(currentVersion, res);
        if (JSON.stringify(next) !== JSON.stringify(state.update)) { state.update = next; changed = true; }
        if (next.available) log(`cloud-check: update available ${next.version}${next.forced ? ' (forced)' : ''}`);
      } catch (e) {
        error = (e && e.code) || 'network';
        log(`cloud-check: updates/check failed: ${error}${e && e.network ? ' (offline)' : ''}`);
      }
      try {
        const res = await http.request('GET', '/public/announcements', { query: { channel: logic.cloudChannel(channel) } });
        const next = logic.filterAnnouncements(res, { channel, now: now() });
        if (JSON.stringify(next) !== JSON.stringify(state.announcements)) { state.announcements = next; changed = true; }
      } catch (e) {
        error = error || (e && e.code) || 'network';
        log(`cloud-check: announcements failed: ${(e && e.code) || 'network'}`);
      }
      state.checkedAt = new Date(now()).toISOString();
      if (state.error !== error) { state.error = error; changed = true; }
      if (changed || !error) emit();
      return payload();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule(ms) {
    if (!running) return;
    if (timer != null) clearTimer(timer);
    timer = setTimer(async () => {
      timer = null;
      try { await check(); } catch (e) { log(`cloud-check: tick failed ${e && e.message}`); }
      schedule(intervalMs);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** 启动：延迟 startDelayMs 首次检查，之后每 intervalMs 一次。 */
  function start() {
    if (running) return false;
    running = true;
    schedule(logic.nextCheckDelay({ lastCheckedAt: state.checkedAt, now: now(), intervalMs, startDelayMs }));
    return true;
  }

  function stop() { running = false; if (timer != null) { clearTimer(timer); timer = null; } }

  return { start, stop, check, getStatus: payload, isRunning: () => running };
}

module.exports = { createCloudCheck };
