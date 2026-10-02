'use strict';
/**
 * 云端「更新检查 + 公告」的纯逻辑（不依赖 Electron / 网络），便于单元测试。
 * 接口见 docs/phase2-admin.md §1.3 / §1.4：GET /updates/check、GET /public/announcements。副作用在 cloud-check.js。
 */
const { compareVersions } = require('./updater-logic');

const START_DELAY_MS = 30 * 1000; // 启动后 30 秒首次检查
const INTERVAL_MS = 6 * 60 * 60 * 1000; // 之后每 6 小时
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const LEVELS = ['info', 'warn', 'critical'];
const MAX_ANNOUNCEMENTS = 5;

/** electron-updater 的渠道（latest / beta）-> 云端发布通道（stable / beta）。 */
function cloudChannel(updateChannel) {
  return String(updateChannel || '').toLowerCase() === 'beta' ? 'beta' : 'stable';
}

/** 设备 ID 校验：不合法返回 null。同一台机器要始终传同一个（灰度分档据此稳定）。 */
function normalizeDeviceId(id) {
  const s = String(id == null ? '' : id).trim();
  return DEVICE_ID_RE.test(s) ? s : null;
}

/** /updates/check 的查询参数。platform / arch 云端目前忽略（zod 会剥掉未知键），先带上供以后按平台分发。 */
function buildCheckQuery({ version, channel, deviceId, platform, arch } = {}) {
  const q = { version: String(version || '').trim(), channel: cloudChannel(channel) };
  const dev = normalizeDeviceId(deviceId);
  if (dev) q.deviceId = dev;
  if (platform) q.platform = String(platform);
  if (arch) q.arch = String(arch);
  return q;
}

/**
 * 距下一次检查的毫秒数：从未检查过 -> startDelayMs；否则 上次时间 + intervalMs - now，但至少 startDelayMs（启动后不立刻打云端）。
 */
function nextCheckDelay({ lastCheckedAt = null, now = Date.now(), intervalMs = INTERVAL_MS, startDelayMs = START_DELAY_MS } = {}) {
  const last = lastCheckedAt == null ? NaN : (typeof lastCheckedAt === 'number' ? lastCheckedAt : Date.parse(lastCheckedAt));
  if (!Number.isFinite(last)) return startDelayMs;
  const due = last + intervalMs - now;
  return Math.max(startDelayMs, Math.min(intervalMs, due));
}

/**
 * 把 /updates/check 的响应变成界面要的结果；只接受比当前版本高的语义化版本，其它一律当作「没有更新」。
 * 返回 { available: false } 或 { available: true, version, forced, notes, minVersion, channel, rolloutPercent }。
 */
function evaluateUpdate(currentVersion, response) {
  const none = { available: false };
  if (!response || typeof response !== 'object' || response.update !== true) return none;
  const version = String(response.version || '').trim();
  if (compareVersions(version, currentVersion) !== 1) return none;
  return {
    available: true,
    version,
    forced: response.forced === true,
    notes: typeof response.notes === 'string' ? response.notes : '',
    minVersion: typeof response.minVersion === 'string' ? response.minVersion : null,
    channel: response.channel === 'beta' ? 'beta' : 'stable',
    rolloutPercent: Number.isFinite(Number(response.rolloutPercent)) ? Number(response.rolloutPercent) : null,
  };
}

/**
 * 过滤 /public/announcements 的结果（云端已按时间窗与渠道过滤过，这里再做一次兜底：结构、渠道、时间窗、级别），
 * 按级别（critical > warn > info）再按生效时间倒序排序，最多 MAX_ANNOUNCEMENTS 条。
 */
function filterAnnouncements(list, { channel = 'stable', now = Date.now(), limit = MAX_ANNOUNCEMENTS } = {}) {
  if (!Array.isArray(list)) return [];
  const ch = cloudChannel(channel);
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const id = String(a.id == null ? '' : a.id).trim();
    const title = String(a.title == null ? '' : a.title).trim();
    if (!id || !title) continue;
    const aCh = String(a.channel || 'all');
    if (aCh !== 'all' && aCh !== ch) continue;
    const starts = a.startsAt ? Date.parse(a.startsAt) : NaN;
    if (Number.isFinite(starts) && starts > now) continue;
    const ends = a.endsAt ? Date.parse(a.endsAt) : NaN;
    if (Number.isFinite(ends) && ends <= now) continue;
    out.push({
      id, title, body: typeof a.body === 'string' ? a.body : '',
      level: LEVELS.includes(a.level) ? a.level : 'info',
      channel: aCh, startsAt: a.startsAt || null, endsAt: a.endsAt || null,
    });
  }
  out.sort((x, y) => (LEVELS.indexOf(y.level) - LEVELS.indexOf(x.level)) || ((Date.parse(y.startsAt) || 0) - (Date.parse(x.startsAt) || 0)));
  return out.slice(0, Math.max(0, limit));
}

/** 发给渲染端的状态快照。 */
function statusPayload({ currentVersion, channel, update, announcements, checkedAt, error }) {
  return {
    currentVersion: String(currentVersion || ''),
    channel: cloudChannel(channel),
    update: update && update.available ? update : { available: false },
    announcements: Array.isArray(announcements) ? announcements : [],
    checkedAt: checkedAt || null,
    error: error || null,
  };
}

module.exports = {
  START_DELAY_MS, INTERVAL_MS, MAX_ANNOUNCEMENTS, DEVICE_ID_RE,
  cloudChannel, normalizeDeviceId, buildCheckQuery, nextCheckDelay, evaluateUpdate, filterAnnouncements, statusPayload,
};
