'use strict';
const crypto = require('crypto');

// 与云端 /telemetry 白名单一致。客户端先过滤一遍：不在白名单的事件/字段根本不会被发出。
const EVENT_NAMES = ['app_open', 'onboarding_step', 'connect_test', 'project_created', 'export_done', 'export_failed', 'task_failed'];
const CODE_RE = /^[A-Z][A-Z0-9_]{1,47}$/;
const STEP_RE = /^[a-z0-9_]{1,32}$/;

/**
 * 匿名统计客户端。默认关闭（opt-in）：isEnabled() 返回 true 才会记录与发送。
 * deps: { isEnabled(): boolean, getInstallId(): string, send(body): Promise }
 * track(name, { code?, step? }) 只取这两个字段，其余（提示词、路径、Key 等）一律丢弃。
 */
function createTelemetry({ isEnabled, getInstallId, send, appVersion, maxQueue = 200 }) {
  let queue = [];
  return {
    track(name, props = {}) {
      if (!isEnabled() || !EVENT_NAMES.includes(name)) return false;
      const e = { name };
      if (typeof props.code === 'string' && CODE_RE.test(props.code)) e.code = props.code;
      if (typeof props.step === 'string' && STEP_RE.test(props.step)) e.step = props.step;
      queue.push(e);
      if (queue.length > maxQueue) queue = queue.slice(-maxQueue);
      return true;
    },
    pending: () => queue.length,
    /** 发送队列；用户中途关闭统计后不再发送并清空。失败保留以便下次重试。 */
    async flush() {
      if (!isEnabled()) { queue = []; return 0; }
      if (!queue.length) return 0;
      const batch = queue.slice(0, 50);
      await send({ installId: getInstallId(), ...(appVersion ? { appVersion } : {}), events: batch });
      queue = queue.slice(batch.length);
      return batch.length;
    },
  };
}

const newInstallId = () => crypto.randomUUID();

module.exports = { createTelemetry, newInstallId, EVENT_NAMES };
