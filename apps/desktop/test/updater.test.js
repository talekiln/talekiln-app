const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const logic = require('../updater-logic');
const { createUpdateController } = require('../updater');

const GOOD = { feedUrl: 'https://updates.talekiln.app/win', channel: 'latest', publisherName: 'Talekiln Test CN' };

describe('compareVersions', () => {
  it('orders releases and prereleases', () => {
    assert.equal(logic.compareVersions('1.2.9', '1.2.8'), 1);
    assert.equal(logic.compareVersions('1.2.8', '1.10.0'), -1);
    assert.equal(logic.compareVersions('v2.0.0', '2.0.0'), 0);
    assert.equal(logic.compareVersions('2.0.0', '2.0.0-beta.1'), 1);
    assert.equal(logic.compareVersions('2.0.0-beta.2', '2.0.0-beta.10'), -1);
    assert.equal(logic.compareVersions('2.0.0-alpha', '2.0.0-beta'), -1);
    assert.equal(logic.compareVersions('x', '1.0.0'), null);
  });
  it('shouldOffer is upgrade-only', () => {
    assert.equal(logic.shouldOffer('1.2.8', '1.3.0'), true);
    assert.equal(logic.shouldOffer('1.2.8', '1.2.8'), false);
    assert.equal(logic.shouldOffer('1.2.8', '1.2.7'), false);
    assert.equal(logic.shouldOffer('1.2.8', 'garbage'), false);
    assert.equal(logic.shouldOffer('1.2.8', undefined), false);
  });
});

describe('validateFeedUrl / resolveConfig', () => {
  it('rejects non-https, credentials, junk and placeholders', () => {
    assert.equal(logic.validateFeedUrl('http://updates.talekiln.app').ok, false);
    assert.equal(logic.validateFeedUrl('https://u:p@updates.talekiln.app').ok, false);
    assert.equal(logic.validateFeedUrl('not a url').ok, false);
    assert.equal(logic.validateFeedUrl('').ok, false);
    assert.equal(logic.validateFeedUrl('https://updates.example.invalid/talekiln').ok, false);
    assert.equal(logic.validateFeedUrl('file:///etc/passwd').ok, false);
    assert.deepEqual(logic.validateFeedUrl('https://updates.talekiln.app/win/'), { ok: true, url: 'https://updates.talekiln.app/win' });
  });
  it('is disabled for placeholder config, dev mode, bad channel, and missing publisher', () => {
    const placeholder = { feedUrl: 'https://updates.example.invalid/talekiln', channel: 'latest', publisherName: 'X' };
    assert.equal(logic.resolveConfig({ file: placeholder, isPackaged: true }).enabled, false);
    assert.equal(logic.resolveConfig({ file: GOOD, isPackaged: false }).enabled, false);
    assert.equal(logic.resolveConfig({ file: { ...GOOD, channel: 'nightly' }, isPackaged: true }).enabled, false);
    const noPub = logic.resolveConfig({ file: { ...GOOD, publisherName: '' }, isPackaged: true });
    assert.equal(noPub.enabled, false);
    assert.match(noPub.reason, /publisherName/);
  });
  it('enables when valid; env overrides file; allowUnsigned only via env', () => {
    const c = logic.resolveConfig({ file: GOOD, isPackaged: true });
    assert.equal(c.enabled, true);
    assert.equal(c.feedUrl, 'https://updates.talekiln.app/win');
    const o = logic.resolveConfig({ file: GOOD, isPackaged: true, env: { TALEKILN_UPDATE_URL: 'https://beta.talekiln.app/x', TALEKILN_UPDATE_CHANNEL: 'BETA' } });
    assert.equal(o.feedUrl, 'https://beta.talekiln.app/x');
    assert.equal(o.channel, 'beta');
    const u = logic.resolveConfig({ file: { ...GOOD, publisherName: '' }, isPackaged: true, env: { TALEKILN_UPDATE_ALLOW_UNSIGNED: '1' } });
    assert.equal(u.enabled, true);
    assert.equal(logic.resolveConfig({ file: { ...GOOD, publisherName: '', allowUnsigned: true }, isPackaged: true }).enabled, false);
  });
  it('clamps numeric settings', () => {
    const c = logic.resolveConfig({ file: { ...GOOD, checkOnStartDelayMs: -5, checkIntervalHours: 'x' }, isPackaged: true });
    assert.equal(c.checkOnStartDelayMs, 0);
    assert.equal(c.checkIntervalMs, 6 * 3600 * 1000);
  });
  it('feed file names follow the generic-provider convention', () => {
    assert.equal(logic.feedFileName('latest'), 'latest.yml');
    assert.equal(logic.feedFileName('beta'), 'beta.yml');
  });
});

describe('prompts and tray label', () => {
  it('install prompt defaults to "later" and warns about unfinished tasks', () => {
    const p = logic.installPrompt({ version: '1.3.0' }, { unfinished: 2 });
    assert.equal(p.defaultId, 1);
    assert.equal(p.buttons[0], '立即重启并安装');
    assert.match(p.message, /1\.3\.0/);
    assert.match(p.detail, /2 个 AI 任务/);
    assert.doesNotMatch(logic.installPrompt({ version: '1.3.0' }).detail, /AI 任务/);
  });
  it('tray label follows state', () => {
    assert.equal(logic.trayLabel({ status: 'idle' }), '检查更新');
    assert.equal(logic.trayLabel({ status: 'downloading', percent: 40 }), '正在下载更新 40%');
    assert.equal(logic.trayLabel({ status: 'downloaded', version: '1.3.0' }), '安装更新 1.3.0');
  });
});

function harness({ enabled = true, current = '1.2.8', response = 0, unfinished = 0, checkImpl } = {}) {
  const calls = { dialogs: [], install: 0, feed: null, timers: [], logs: [], changes: 0 };
  const au = new EventEmitter();
  au.checkForUpdates = async () => (checkImpl ? checkImpl(au) : undefined);
  au.setFeedURL = (o) => { calls.feed = o; };
  au.quitAndInstall = (...a) => { calls.install++; calls.installArgs = a; };
  const config = logic.resolveConfig({ file: GOOD, isPackaged: enabled });
  const ctl = createUpdateController({
    autoUpdater: au, config, currentVersion: current,
    dialog: { showMessageBox: async (_w, o) => { calls.dialogs.push(o); return { response }; } },
    unfinishedCount: () => unfinished,
    onStateChange: () => { calls.changes++; },
    setTimer: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
    clearTimer: () => {},
    log: (m) => calls.logs.push(m),
  });
  return { ctl, au, calls };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('update controller', () => {
  it('stays off with placeholder config, and a manual check explains why', async () => {
    const calls = { dialogs: [] };
    const config = logic.resolveConfig({ file: { feedUrl: 'https://updates.example.invalid/talekiln', publisherName: 'X' }, isPackaged: true });
    const ctl = createUpdateController({ autoUpdater: null, config, currentVersion: '1.2.8', dialog: { showMessageBox: async (_w, o) => { calls.dialogs.push(o); return {}; } } });
    assert.equal(ctl.start(), false);
    assert.equal(ctl.getState().status, 'disabled');
    await ctl.check({ manual: true });
    assert.equal(calls.dialogs.length, 1);
    assert.match(calls.dialogs[0].detail, /占位/);
  });

  it('configures electron-updater safely: no silent install, no downgrade, generic feed', () => {
    const { ctl, au, calls } = harness();
    assert.equal(ctl.init(), true);
    assert.equal(au.autoInstallOnAppQuit, false);
    assert.equal(au.allowDowngrade, false);
    assert.equal(au.allowPrerelease, false);
    assert.deepEqual(calls.feed, { provider: 'generic', url: 'https://updates.talekiln.app/win', channel: 'latest' });
  });

  it('start() schedules a delayed startup check and a periodic one', async () => {
    let checked = 0;
    const { ctl, calls } = harness({ checkImpl: () => { checked++; } });
    assert.equal(ctl.start(), true);
    assert.equal(calls.timers[0].ms, 15000);
    assert.equal(calls.timers[1].ms, 6 * 3600 * 1000);
    calls.timers[0].fn();
    await tick();
    assert.equal(checked, 1);
  });

  it('startup check is silent when up to date or when it fails', async () => {
    const a = harness({ checkImpl: (au) => au.emit('update-not-available', { version: '1.2.8' }) });
    a.ctl.init();
    await a.ctl.check({ manual: false });
    assert.equal(a.calls.dialogs.length, 0);
    const b = harness({ checkImpl: () => { throw new Error('ENOTFOUND'); } });
    b.ctl.init();
    assert.equal(await b.ctl.check({ manual: false }), false);
    assert.equal(b.calls.dialogs.length, 0);
    assert.ok(b.calls.logs.some((l) => l.includes('ENOTFOUND')));
  });

  it('manual check reports up-to-date, error, and new version', async () => {
    const a = harness({ checkImpl: (au) => au.emit('update-not-available', {}) });
    a.ctl.init();
    await a.ctl.check({ manual: true });
    await tick();
    assert.match(a.calls.dialogs[0].message, /最新/);

    const b = harness({ checkImpl: (au) => au.emit('error', new Error('sha512 checksum mismatch')) });
    b.ctl.init();
    await b.ctl.check({ manual: true });
    await tick();
    assert.match(b.calls.dialogs[0].detail, /checksum/);

    const c = harness({ checkImpl: (au) => au.emit('update-available', { version: '1.3.0' }) });
    c.ctl.init();
    await c.ctl.check({ manual: true });
    await tick();
    assert.match(c.calls.dialogs[0].message, /1\.3\.0/);
    assert.equal(c.ctl.getState().status, 'downloading');
  });

  it('prompts after download and installs only when the user confirms', async () => {
    const yes = harness({ response: 0, unfinished: 1 });
    yes.ctl.init();
    yes.au.emit('update-available', { version: '1.3.0' });
    yes.au.emit('download-progress', { percent: 55.4 });
    assert.equal(yes.ctl.getState().percent, 55);
    yes.au.emit('update-downloaded', { version: '1.3.0' });
    await tick();
    assert.equal(yes.calls.dialogs.length, 1);
    assert.match(yes.calls.dialogs[0].detail, /1 个 AI 任务/);
    assert.equal(yes.calls.install, 1);
    assert.deepEqual(yes.calls.installArgs, [false, true]);

    const no = harness({ response: 1 });
    no.ctl.init();
    no.au.emit('update-downloaded', { version: '1.3.0' });
    await tick();
    assert.equal(no.calls.install, 0);
    assert.equal(no.ctl.getState().status, 'downloaded');
    assert.equal(no.ctl.trayItem().label, '安装更新 1.3.0');
    // 同一版本不会反复弹窗；手动点击托盘项才再次询问
    no.au.emit('update-downloaded', { version: '1.3.0' });
    await tick();
    assert.equal(no.calls.dialogs.length, 1);
    await no.ctl.check({ manual: true });
    assert.equal(no.calls.dialogs.length, 2);
  });

  it('ignores a "newer" offer that is not actually newer', () => {
    const { ctl, au } = harness({ current: '1.2.8' });
    ctl.init();
    au.emit('update-available', { version: '1.2.7' });
    assert.equal(ctl.getState().status, 'idle');
  });

  it('an error event after download keeps the downloaded state (no install without confirmation)', () => {
    const { ctl, au, calls } = harness({ response: 1 });
    ctl.init();
    au.emit('update-downloaded', { version: '1.3.0' });
    au.emit('error', new Error('network blip'));
    assert.equal(ctl.getState().status, 'downloaded');
    assert.equal(calls.install, 0);
  });

  it('notifies state changes so the tray menu can refresh', () => {
    const { ctl, au, calls } = harness();
    ctl.init();
    au.emit('checking-for-update');
    au.emit('update-not-available', {});
    assert.ok(calls.changes >= 2);
  });

  it('configure failure degrades to disabled instead of throwing', () => {
    const { ctl, au } = harness();
    au.setFeedURL = () => { throw new Error('bad feed'); };
    assert.equal(ctl.init(), false);
    assert.equal(ctl.getState().status, 'disabled');
  });
});
