const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../cloud-check-logic');
const { createCloudCheck } = require('../cloud-check');

const H = 3600 * 1000;

describe('cloud-check logic', () => {
  it('maps the updater channel to the cloud release channel', () => {
    assert.equal(logic.cloudChannel('latest'), 'stable');
    assert.equal(logic.cloudChannel('beta'), 'beta');
    assert.equal(logic.cloudChannel('BETA'), 'beta');
    assert.equal(logic.cloudChannel(undefined), 'stable');
    assert.equal(logic.cloudChannel('nightly'), 'stable');
  });

  it('device ids must match the cloud rule (8–128 of [A-Za-z0-9._:-])', () => {
    assert.equal(logic.normalizeDeviceId('abcdef0123456789'), 'abcdef0123456789');
    assert.equal(logic.normalizeDeviceId('  a.b:c-d_e12  '), 'a.b:c-d_e12');
    assert.equal(logic.normalizeDeviceId('short'), null);
    assert.equal(logic.normalizeDeviceId('has space 123'), null);
    assert.equal(logic.normalizeDeviceId('x'.repeat(129)), null);
    assert.equal(logic.normalizeDeviceId(null), null);
  });

  it('buildCheckQuery carries version, channel, device, platform and arch; drops an invalid device id', () => {
    assert.deepEqual(
      logic.buildCheckQuery({ version: '1.2.8', channel: 'latest', deviceId: 'deadbeefdeadbeef', platform: 'win32', arch: 'x64' }),
      { version: '1.2.8', channel: 'stable', deviceId: 'deadbeefdeadbeef', platform: 'win32', arch: 'x64' },
    );
    assert.deepEqual(logic.buildCheckQuery({ version: '1.2.8', channel: 'beta', deviceId: 'bad' }), { version: '1.2.8', channel: 'beta' });
  });

  it('nextCheckDelay: 30 s after start, then the remainder of the 6 h interval (never sooner than 30 s)', () => {
    const now = Date.parse('2026-10-02T10:00:00Z');
    assert.equal(logic.nextCheckDelay({ now }), 30 * 1000);
    assert.equal(logic.nextCheckDelay({ lastCheckedAt: null, now }), 30 * 1000);
    assert.equal(logic.nextCheckDelay({ lastCheckedAt: now - 2 * H, now }), 4 * H);
    assert.equal(logic.nextCheckDelay({ lastCheckedAt: new Date(now - 2 * H).toISOString(), now }), 4 * H);
    assert.equal(logic.nextCheckDelay({ lastCheckedAt: now - 10 * H, now }), 30 * 1000); // 早就该查了：仍等 30 秒再打云端
    assert.equal(logic.nextCheckDelay({ lastCheckedAt: now + H, now }), 6 * H); // 时钟倒拨：封顶一个间隔
    assert.equal(logic.nextCheckDelay({ lastCheckedAt: 'garbage', now }), 30 * 1000);
    assert.equal(logic.INTERVAL_MS, 6 * H);
    assert.equal(logic.START_DELAY_MS, 30 * 1000);
  });

  it('evaluateUpdate only accepts a strictly newer semver and normalises the fields', () => {
    const cur = '1.2.8';
    assert.deepEqual(logic.evaluateUpdate(cur, { update: false }), { available: false });
    assert.deepEqual(logic.evaluateUpdate(cur, null), { available: false });
    assert.deepEqual(logic.evaluateUpdate(cur, { update: true, version: '1.2.8' }), { available: false });
    assert.deepEqual(logic.evaluateUpdate(cur, { update: true, version: '1.2.7' }), { available: false });
    assert.deepEqual(logic.evaluateUpdate(cur, { update: true, version: 'nope' }), { available: false });
    assert.deepEqual(
      logic.evaluateUpdate(cur, { update: true, version: '1.3.0', channel: 'stable', notes: '修复', forced: false, minVersion: '1.0.0', rolloutPercent: 50 }),
      { available: true, version: '1.3.0', forced: false, notes: '修复', minVersion: '1.0.0', channel: 'stable', rolloutPercent: 50 },
    );
    const forced = logic.evaluateUpdate(cur, { update: true, version: '2.0.0-beta.1', channel: 'beta', forced: true, notes: 7 });
    assert.deepEqual([forced.available, forced.forced, forced.notes, forced.channel, forced.rolloutPercent], [true, true, '', 'beta', null]);
  });

  it('filterAnnouncements: channel, time window, shape; critical first, newest first; capped', () => {
    const now = Date.parse('2026-10-02T10:00:00Z');
    const iso = (h) => new Date(now + h * H).toISOString();
    const list = [
      { id: 'a', title: '所有人', body: 'x', level: 'info', channel: 'all', startsAt: iso(-5), endsAt: null },
      { id: 'b', title: 'beta 专属', level: 'warn', channel: 'beta', startsAt: iso(-1), endsAt: null },
      { id: 'c', title: '紧急', level: 'critical', channel: 'stable', startsAt: iso(-10), endsAt: iso(2) },
      { id: 'd', title: '还没开始', level: 'info', channel: 'all', startsAt: iso(1), endsAt: null },
      { id: 'e', title: '已结束', level: 'info', channel: 'all', startsAt: iso(-10), endsAt: iso(-1) },
      { id: 'f', title: '', level: 'info', channel: 'all', startsAt: iso(-1) },
      { id: 'g', title: '怪级别', level: 'loud', channel: 'all', startsAt: iso(-2) },
      null, 'junk',
    ];
    const stable = logic.filterAnnouncements(list, { channel: 'latest', now });
    assert.deepEqual(stable.map((a) => a.id), ['c', 'g', 'a']);
    assert.equal(stable.find((a) => a.id === 'g').level, 'info');
    assert.equal(stable.find((a) => a.id === 'b'), undefined);
    const beta = logic.filterAnnouncements(list, { channel: 'beta', now });
    assert.deepEqual(beta.map((a) => a.id), ['b', 'g', 'a']); // stable 专属的 c 不发给 beta
    assert.deepEqual(logic.filterAnnouncements('nope'), []);
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, title: `t${i}`, channel: 'all', startsAt: iso(-i - 1) }));
    assert.equal(logic.filterAnnouncements(many, { now }).length, logic.MAX_ANNOUNCEMENTS);
    assert.equal(logic.filterAnnouncements(many, { now, limit: 2 }).length, 2);
  });
});

// ---------- 控制器：假 http + 假计时器 ----------

function fakeTimers() {
  const timers = new Map();
  let id = 0;
  let nowMs = Date.parse('2026-10-02T10:00:00Z');
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => { id++; timers.set(id, { fn, at: nowMs + ms }); return id; },
    clearTimer: (t) => timers.delete(t),
    pending: () => [...timers.values()].map((t) => t.at - nowMs),
    async advance(ms) {
      nowMs += ms;
      for (const [k, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= nowMs) { timers.delete(k); await t.fn(); }
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

function fakeHttp(responses) {
  const calls = [];
  return {
    calls,
    request: async (method, pathname, opts) => {
      calls.push({ method, pathname, query: opts && opts.query });
      const r = responses[pathname];
      if (typeof r === 'function') return r();
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const netErr = () => Object.assign(new Error('network error'), { code: 'network', network: true });

describe('cloud-check controller', () => {
  it('checks 30 s after start then every 6 h, with version / channel / device / platform / arch; pushes status once per change', async () => {
    const t = fakeTimers();
    const http = fakeHttp({
      '/updates/check': { update: true, version: '1.3.0', channel: 'stable', notes: 'n', forced: false, minVersion: null, rolloutPercent: 100 },
      '/public/announcements': [{ id: 'a1', title: '公告', body: 'b', level: 'info', channel: 'all', startsAt: '2026-10-01T00:00:00Z', endsAt: null }],
    });
    const pushed = [];
    const logs = [];
    const cc = createCloudCheck({
      http, currentVersion: '1.2.8', channel: 'latest', deviceId: 'deadbeefdeadbeef', platform: 'win32', arch: 'x64',
      onStatus: (p) => pushed.push(p), log: (m) => logs.push(m), ...t,
    });
    assert.equal(cc.start(), true);
    assert.equal(cc.start(), false);
    assert.deepEqual(t.pending(), [30 * 1000]);
    assert.equal(http.calls.length, 0);
    await t.advance(30 * 1000);
    assert.equal(http.calls.length, 2);
    assert.deepEqual(http.calls[0], { method: 'GET', pathname: '/updates/check', query: { version: '1.2.8', channel: 'stable', deviceId: 'deadbeefdeadbeef', platform: 'win32', arch: 'x64' } });
    assert.deepEqual(http.calls[1], { method: 'GET', pathname: '/public/announcements', query: { channel: 'stable' } });
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].update.version, '1.3.0');
    assert.equal(pushed[0].announcements[0].id, 'a1');
    assert.equal(pushed[0].currentVersion, '1.2.8');
    assert.equal(pushed[0].error, null);
    assert.ok(pushed[0].checkedAt);
    assert.deepEqual(t.pending(), [6 * H]);
    assert.ok(logs.some((m) => /update available 1\.3\.0/.test(m)));

    await t.advance(6 * H);
    assert.equal(http.calls.length, 4);
    assert.deepEqual(t.pending(), [6 * H]);
    assert.equal(cc.getStatus().update.version, '1.3.0');
    cc.stop();
    assert.deepEqual(t.pending(), []);
    assert.equal(cc.isRunning(), false);
  });

  it('offline / unconfigured cloud stays silent: only a log line, previous result kept, error recorded in status', async () => {
    const t = fakeTimers();
    const good = fakeHttp({ '/updates/check': { update: true, version: '1.3.0' }, '/public/announcements': [] });
    const pushed = [];
    const logs = [];
    const cc = createCloudCheck({ http: good, currentVersion: '1.2.8', onStatus: (p) => pushed.push(p), log: (m) => logs.push(m), ...t });
    await cc.check();
    assert.equal(pushed.length, 1);
    // 之后云端不可达：不覆盖已有结果，不抛错
    good.request = async () => { throw netErr(); };
    const s = await cc.check();
    assert.equal(s.update.version, '1.3.0');
    assert.equal(s.error, 'network');
    assert.ok(logs.some((m) => /updates\/check failed: network \(offline\)/.test(m)));
    assert.equal(pushed.length, 2); // 错误状态变化推一次（界面可显示「上次检查失败」），之后不再重复推
    await cc.check();
    assert.equal(pushed.length, 2);
    // 未配置云端（占位域名）：CloudError('cloud_not_configured')
    const unconf = fakeHttp({ '/updates/check': Object.assign(new Error('cloud_not_configured'), { code: 'cloud_not_configured' }), '/public/announcements': Object.assign(new Error('cloud_not_configured'), { code: 'cloud_not_configured' }) });
    const cc2 = createCloudCheck({ http: unconf, currentVersion: '1.2.8', ...t });
    const s2 = await cc2.check();
    assert.deepEqual([s2.update, s2.announcements, s2.error], [{ available: false }, [], 'cloud_not_configured']);
    // 没有 http 也不会炸
    const cc3 = createCloudCheck({ currentVersion: '1.2.8', ...t });
    assert.equal((await cc3.check()).error, 'cloud_not_configured');
  });

  it('a failure of one endpoint does not hide the other; concurrent checks are coalesced; beta channel asks for beta', async () => {
    const t = fakeTimers();
    const http = fakeHttp({ '/updates/check': netErr(), '/public/announcements': [{ id: 'z', title: '只公告', channel: 'beta', startsAt: '2026-10-01T00:00:00Z' }] });
    const cc = createCloudCheck({ http, currentVersion: '1.2.8', channel: 'beta', ...t });
    const [a, b] = await Promise.all([cc.check(), cc.check()]);
    assert.equal(a, b);
    assert.equal(http.calls.length, 2);
    assert.equal(http.calls[1].query.channel, 'beta');
    assert.deepEqual(a.announcements.map((x) => x.id), ['z']);
    assert.equal(a.update.available, false);
    assert.equal(a.error, 'network');
    assert.equal(a.channel, 'beta');
  });
});
