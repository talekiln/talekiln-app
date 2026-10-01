'use strict';
/**
 * 自动更新的纯逻辑（不依赖 Electron / electron-updater），便于单元测试。
 * 配置解析、版本比较、对话框文案都在这里；副作用在 updater.js。
 */

const PLACEHOLDER_SUFFIXES = ['.invalid', '.example', '.test', '.localhost'];
const CHANNELS = ['latest', 'beta'];

/** 比较 semver（含预发布段）。a>b 返回 1，a<b 返回 -1，相等 0；无法解析返回 null。 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v || '').trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i] ? 1 : -1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q) ? 1 : -1;
    if (pn) return -1;
    if (qn) return 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

/** 更新源只接受 https；占位域名视为“未配置”。 */
function validateFeedUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return { ok: false, reason: '未配置更新地址' };
  let u;
  try { u = new URL(url.trim()); } catch (_) { return { ok: false, reason: '更新地址格式不正确' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: '更新地址必须使用 https' };
  if (u.username || u.password) return { ok: false, reason: '更新地址不能包含账号口令' };
  const host = u.hostname.toLowerCase();
  if (PLACEHOLDER_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) return { ok: false, reason: '更新地址仍是占位值' };
  return { ok: true, url: u.toString().replace(/\/+$/, '') };
}

function intOr(v, d, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : d;
}

/**
 * 合并 文件配置 < 环境变量，并判定是否启用。
 * 启用条件：已打包 + https 非占位地址 + 渠道合法 + 配置了 publisherName（否则 electron-updater 不验证签名，见 docs/auto-update.md）。
 * allowUnsigned 仅用于内部测试渠道，需显式设置环境变量 TALEKILN_UPDATE_ALLOW_UNSIGNED=1。
 */
function resolveConfig({ file = {}, env = {}, isPackaged = false } = {}) {
  const channel = String(env.TALEKILN_UPDATE_CHANNEL || file.channel || 'latest').toLowerCase();
  const feed = validateFeedUrl(env.TALEKILN_UPDATE_URL || file.feedUrl);
  const publisherName = String(file.publisherName || '').trim();
  const allowUnsigned = env.TALEKILN_UPDATE_ALLOW_UNSIGNED === '1';
  let reason = null;
  if (!isPackaged) reason = '开发模式不检查更新';
  else if (!CHANNELS.includes(channel)) reason = `未知更新渠道：${channel}`;
  else if (!feed.ok) reason = feed.reason;
  else if (!publisherName && !allowUnsigned) reason = '未配置签名发布者（publisherName），拒绝启用更新以免跳过签名校验';
  return {
    enabled: reason === null,
    reason,
    feedUrl: feed.ok ? feed.url : null,
    channel: CHANNELS.includes(channel) ? channel : 'latest',
    publisherName: publisherName || null,
    allowUnsigned,
    checkOnStartDelayMs: intOr(file.checkOnStartDelayMs, 15000, 0, 10 * 60 * 1000),
    checkIntervalMs: intOr(file.checkIntervalHours, 6, 0, 24 * 7) * 3600 * 1000,
  };
}

/** 渠道对应的元数据文件名（generic provider 约定）。 */
function feedFileName(channel) {
  return channel === 'latest' ? 'latest.yml' : `${channel}.yml`;
}

/** 远端版本是否值得提示（只升不降；无法解析则不提示）。 */
function shouldOffer(current, remote) {
  return compareVersions(remote, current) === 1;
}

function installPrompt(info, { unfinished = 0 } = {}) {
  const v = info && info.version ? info.version : '新版本';
  const lines = ['点击“立即重启并安装”会关闭应用并完成升级。'];
  if (unfinished > 0) lines.push(`当前还有 ${unfinished} 个 AI 任务未完成：升级后会自动恢复，已提交到服务商的任务不会重复提交。`);
  lines.push('选择“稍后”也可以：下次点击托盘菜单里的“安装更新”再升级。');
  return {
    type: 'info',
    buttons: ['立即重启并安装', '稍后'],
    defaultId: 1,
    cancelId: 1,
    title: '更新已下载',
    message: `Talekiln ${v} 已下载完成`,
    detail: lines.join('\n'),
  };
}

function manualResultPrompt(kind, { version, reason, error } = {}) {
  switch (kind) {
    case 'disabled': return { type: 'info', buttons: ['好'], title: '检查更新', message: '当前无法检查更新', detail: reason || '' };
    case 'up-to-date': return { type: 'info', buttons: ['好'], title: '检查更新', message: '已是最新版本', detail: version ? `当前版本 ${version}` : '' };
    case 'downloading': return { type: 'info', buttons: ['好'], title: '检查更新', message: `发现新版本 ${version || ''}`.trim(), detail: '正在后台下载，完成后会提示你安装。' };
    case 'error': return { type: 'warning', buttons: ['好'], title: '检查更新', message: '检查更新失败', detail: `${error || '未知错误'}\n请检查网络后重试。` };
    default: return null;
  }
}

/** 托盘菜单项文案。 */
function trayLabel(state) {
  switch (state.status) {
    case 'checking': return '正在检查更新…';
    case 'downloading': return `正在下载更新${state.percent != null ? ` ${state.percent}%` : ''}`;
    case 'downloaded': return `安装更新 ${state.version || ''}`.trim();
    default: return '检查更新';
  }
}

module.exports = { compareVersions, validateFeedUrl, resolveConfig, feedFileName, shouldOffer, installPrompt, manualResultPrompt, trayLabel, CHANNELS };
