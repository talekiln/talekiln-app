const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { resolveLycoreBin, makeEndpoint, resolveFfmpeg, createCoreRuntime } = require('../core-runtime');

const EXE = process.platform === 'win32' ? 'lycore.exe' : 'lycore';

describe('resolveLycoreBin', () => {
  it('packaged: <resources>/lycore/', () => {
    const res = path.join('x', 'resources');
    assert.equal(resolveLycoreBin({ isPackaged: true, resourcesPath: res, env: {}, exists: () => true }), path.join(res, 'lycore', EXE));
    assert.equal(resolveLycoreBin({ isPackaged: true, resourcesPath: res, env: {}, exists: () => false }), null);
  });
  it('dev: newest of release/debug', () => {
    const t = { [path.join('c', 'target', 'release', EXE)]: 1, [path.join('c', 'target', 'debug', EXE)]: 2 };
    const got = resolveLycoreBin({ isPackaged: false, repoCoreDir: 'c', env: {}, exists: (p) => p in t, mtime: (p) => t[p] });
    assert.equal(got, path.join('c', 'target', 'debug', EXE));
  });
  it('LYCORE_BIN override; none -> null', () => {
    assert.equal(resolveLycoreBin({ isPackaged: false, repoCoreDir: 'c', env: { LYCORE_BIN: 'z' }, exists: () => true }), 'z');
    assert.equal(resolveLycoreBin({ isPackaged: false, repoCoreDir: 'c', env: {}, exists: () => false }), null);
  });
});

describe('makeEndpoint', () => {
  it('unique per call; pipe on win32, socket elsewhere', () => {
    const a = makeEndpoint({ platform: 'win32' });
    assert.ok(a.startsWith(String.raw`\\.\pipe\talekiln-lycore-`));
    assert.notEqual(a, makeEndpoint({ platform: 'win32' }));
    assert.match(makeEndpoint({ platform: 'linux', tmpDir: '/tmp' }), /talekiln-lycore-.*\.sock$/);
  });
});

describe('resolveFfmpeg', () => {
  const bin = path.join('r', 'lycore', EXE);
  it('env wins', async () => {
    assert.deepEqual(await resolveFfmpeg({ env: { LYCORE_FFMPEG_DIR: 'd' }, lycoreBin: bin }), { dir: 'd', source: 'env' });
  });
  it('bundled next to lycore needs no dir', async () => {
    const tool = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const r = await resolveFfmpeg({ env: {}, lycoreBin: bin, exists: (p) => p === path.join('r', 'lycore', 'ffmpeg', tool) });
    assert.deepEqual(r, { source: 'bundled' });
  });
  it('falls back to provision; errors are logged, not thrown', async () => {
    const ok = await resolveFfmpeg({ env: {}, lycoreBin: bin, exists: () => false, appDataDir: 'a', provision: async () => ({ dir: 'p' }) });
    assert.deepEqual(ok, { dir: 'p', source: 'provisioned' });
    const logs = [];
    const bad = await resolveFfmpeg({ env: {}, lycoreBin: bin, exists: () => false, provision: async () => { const e = new Error('placeholder'); e.code = 'manifest_placeholder'; throw e; }, log: (m) => logs.push(m) });
    assert.equal(bad.source, 'none');
    assert.match(logs[0], /manifest_placeholder/);
  });
});

function fakeSupervisor({ failStart } = {}) {
  const ev = new EventEmitter();
  ev.pid = 4242;
  ev.started = 0; ev.stopped = 0; ev.opts = null;
  ev.start = async () => { ev.started++; if (failStart) throw new Error('lycore failed to start: x'); return { name: 'lycore', version: '0.1.0' }; };
  ev.stop = async () => { ev.stopped++; };
  return ev;
}

describe('createCoreRuntime', () => {
  const base = (o) => ({ bin: 'b', endpoint: 'EP', env: {}, ...o });
  it('sets LYCORE_ENDPOINT at construction (before local service reads it)', () => {
    const env = {};
    createCoreRuntime(base({ env, createSupervisor: () => fakeSupervisor() }));
    assert.equal(env.LYCORE_ENDPOINT, 'EP');
  });
  it('starts supervisor with ffmpeg dir env; stop is idempotent-safe', async () => {
    let seen; const sup = fakeSupervisor();
    const rt = createCoreRuntime(base({ env: { LYCORE_FFMPEG_DIR: 'D' }, createSupervisor: (o) => { seen = o; return sup; } }));
    const r = await rt.start();
    assert.equal(r.ok, true);
    assert.deepEqual(seen.env, { LYCORE_FFMPEG_DIR: 'D' });
    assert.equal(seen.endpoint, 'EP');
    await rt.stop(); await rt.stop();
    assert.equal(sup.stopped, 2); // supervisor.stop 自身幂等
  });
  it('missing binary: no endpoint exported, no throw', async () => {
    const env = {};
    const rt = createCoreRuntime({ bin: null, endpoint: 'EP', env, createSupervisor: () => { throw new Error('should not be called'); } });
    assert.equal(env.LYCORE_ENDPOINT, undefined);
    assert.deepEqual(await rt.start(), { ok: false, reason: 'binary_missing' });
    await rt.stop();
  });
  it('start failure resolves ok:false; permanent failure triggers onFailed', async () => {
    const sup = fakeSupervisor({ failStart: true }); let failed = null;
    const rt = createCoreRuntime(base({ createSupervisor: () => sup, onFailed: (f) => { failed = f; } }));
    const r = await rt.start();
    assert.equal(r.ok, false);
    sup.emit('failed', { restarts: 5, reason: 'boom' });
    assert.equal(failed.reason, 'boom');
  });
});
