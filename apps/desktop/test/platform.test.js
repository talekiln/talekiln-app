const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const plat = require('../platform');
const { makeEndpoint, resolveLycoreBin, resolveFfmpeg } = require('../core-runtime');
const { createLifecycle } = require('../lifecycle');

describe('exeName / pathFor', () => {
  it('.exe only on win32', () => {
    assert.equal(plat.exeName('lycore', 'win32'), 'lycore.exe');
    assert.equal(plat.exeName('lycore', 'darwin'), 'lycore');
    assert.equal(plat.exeName('ffmpeg', 'linux'), 'ffmpeg');
  });
  it('path semantics follow the target platform, not the host', () => {
    assert.equal(plat.pathFor('darwin').join('/Applications/Talekiln.app/Contents/Resources', 'lycore', 'lycore'), '/Applications/Talekiln.app/Contents/Resources/lycore/lycore');
    assert.equal(plat.pathFor('win32').join('C:\\r', 'lycore', 'lycore.exe'), 'C:\\r\\lycore\\lycore.exe');
  });
});

describe('resolveLycoreBin / resolveFfmpeg on macOS (platform injected)', () => {
  const res = '/Applications/Talekiln.app/Contents/Resources';
  it('packaged: no .exe, posix path', () => {
    const want = `${res}/lycore/lycore`;
    assert.equal(resolveLycoreBin({ isPackaged: true, resourcesPath: res, env: {}, exists: (p) => p === want, platform: 'darwin' }), want);
    // a Windows-style name must not be accepted on macOS
    assert.equal(resolveLycoreBin({ isPackaged: true, resourcesPath: res, env: {}, exists: (p) => p.endsWith('.exe'), platform: 'darwin' }), null);
  });
  it('dev: picks newest of target/release|debug', () => {
    const t = { '/r/core/target/release/lycore': 5, '/r/core/target/debug/lycore': 9 };
    assert.equal(resolveLycoreBin({ isPackaged: false, repoCoreDir: '/r/core', env: {}, exists: (p) => p in t, mtime: (p) => t[p], platform: 'darwin' }), '/r/core/target/debug/lycore');
  });
  it('bundled ffmpeg found as ffmpeg (no .exe)', async () => {
    const r = await resolveFfmpeg({ env: {}, lycoreBin: `${res}/lycore/lycore`, exists: (p) => p === `${res}/lycore/ffmpeg/ffmpeg`, platform: 'darwin' });
    assert.deepEqual(r, { source: 'bundled' });
    const win = await resolveFfmpeg({ env: {}, lycoreBin: 'C:\\r\\lycore\\lycore.exe', exists: (p) => p === 'C:\\r\\lycore\\ffmpeg\\ffmpeg.exe', platform: 'win32' });
    assert.deepEqual(win, { source: 'bundled' });
  });
});

describe('Unix socket endpoint on macOS', () => {
  it('uses TMPDIR when it fits', () => {
    const ep = makeEndpoint({ platform: 'darwin', tmpDir: '/var/folders/zz/abcdefghijklmnopqrstuvwxyz0123456789/T', pid: 1234 });
    assert.match(ep, /^\/var\/folders\/.*\/T\/talekiln-lycore-1234-[0-9a-f]{8}\.sock$/);
    assert.ok(Buffer.byteLength(ep) < 104);
  });
  it('falls back to /tmp when TMPDIR makes the path exceed the 104-byte sun_path limit', () => {
    const longTmp = '/Users/someone-with-a-long-name/Library/Caches/some/very/deeply/nested/custom/tmp/directory/tree';
    const ep = makeEndpoint({ platform: 'darwin', tmpDir: longTmp, pid: 1 });
    assert.ok(ep.startsWith('/tmp/talekiln-lycore-1-'), ep);
    assert.ok(Buffer.byteLength(ep) < 104);
  });
  it('throws instead of failing later at bind() when nothing fits', () => {
    assert.throws(() => plat.pickSocketPath({ platform: 'darwin', tmpDir: '/x'.repeat(60), fileName: 'f'.repeat(60), fallbackDir: '/y'.repeat(60) }), /too long/);
  });
  it('Linux limit is larger than macOS', () => {
    assert.equal(plat.udsPathLimit('darwin'), 104);
    assert.equal(plat.udsPathLimit('linux'), 108);
  });
  it('Windows endpoint unchanged (named pipe)', () => {
    assert.match(makeEndpoint({ platform: 'win32', pid: 7 }), /^\\\\\.\\pipe\\talekiln-lycore-7-[0-9a-f]{8}$/);
  });
});

describe('userDataDir', () => {
  it('stable lower-case folder name on every platform', () => {
    assert.equal(plat.userDataDir('/Users/jay/Library/Application Support', 'darwin'), '/Users/jay/Library/Application Support/talekiln');
    assert.equal(plat.userDataDir('C:\\Users\\jay\\AppData\\Roaming', 'win32'), 'C:\\Users\\jay\\AppData\\Roaming\\talekiln');
    assert.equal(plat.userDataDir('/home/jay/.config', 'linux'), '/home/jay/.config/talekiln');
  });
});

describe('ensureExecutable', () => {
  it('Windows: always true, never touches the file', () => {
    assert.equal(plat.ensureExecutable('x', { platform: 'win32', access: () => { throw new Error('no'); }, chmod: () => { throw new Error('no'); } }), true);
  });
  it('already executable: no chmod', () => {
    let chmods = 0;
    assert.equal(plat.ensureExecutable('/a/lycore', { platform: 'darwin', access: () => {}, chmod: () => { chmods++; } }), true);
    assert.equal(chmods, 0);
  });
  it('missing x bit: chmod adds it, keeps other bits', () => {
    let executable = false;
    const calls = [];
    const ok = plat.ensureExecutable('/a/lycore', {
      platform: 'darwin',
      access: () => { if (!executable) throw new Error('EACCES'); },
      stat: () => ({ mode: 0o100644 }),
      chmod: (f, m) => { calls.push([f, m]); executable = true; },
    });
    assert.equal(ok, true);
    assert.deepEqual(calls, [['/a/lycore', 0o755]]);
  });
  it('chmod failing (read-only volume) reports false instead of throwing', () => {
    assert.equal(plat.ensureExecutable('/a/lycore', { platform: 'darwin', access: () => { throw new Error('EACCES'); }, stat: () => ({ mode: 0o644 }), chmod: () => { throw new Error('EROFS'); } }), false);
  });
});

describe('application menu', () => {
  it('none on Windows/Linux (unchanged behaviour)', () => {
    assert.equal(plat.buildAppMenuTemplate({ platform: 'win32' }), null);
    assert.equal(plat.buildAppMenuTemplate({ platform: 'linux' }), null);
  });
  it('macOS menu supplies the roles behind ⌘C/⌘V/⌘A/⌘Z/⌘Q/⌘W/⌘M', () => {
    const tpl = plat.buildAppMenuTemplate({ platform: 'darwin', appName: 'Talekiln' });
    const roles = new Set(tpl.flatMap((m) => m.submenu.map((i) => i.role).filter(Boolean)));
    for (const r of ['quit', 'copy', 'paste', 'cut', 'selectAll', 'undo', 'redo', 'minimize', 'close', 'hide']) assert.ok(roles.has(r), r);
    assert.equal(tpl[0].label, 'Talekiln');
  });
});

describe('safeStorage differences', () => {
  it('Windows / macOS: availability is what Electron says', () => {
    assert.deepEqual(plat.evaluateSafeStorage({ platform: 'win32', isEncryptionAvailable: true }), { available: true, reason: 'ok' });
    assert.deepEqual(plat.evaluateSafeStorage({ platform: 'darwin', isEncryptionAvailable: true }), { available: true, reason: 'ok' });
    assert.equal(plat.evaluateSafeStorage({ platform: 'darwin', isEncryptionAvailable: false }).available, false);
  });
  it('Linux basic_text backend counts as unavailable (it is effectively plaintext)', () => {
    assert.equal(plat.evaluateSafeStorage({ platform: 'linux', isEncryptionAvailable: true, backend: 'basic_text' }).available, false);
    assert.equal(plat.evaluateSafeStorage({ platform: 'linux', isEncryptionAvailable: true, backend: 'gnome_libsecret' }).available, true);
  });
  it('guardSafeStorage wraps Electron safeStorage and tolerates throwing APIs', () => {
    const ss = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
    assert.equal(plat.guardSafeStorage(ss, 'linux').isEncryptionAvailable(), false);
    assert.equal(plat.guardSafeStorage(ss, 'darwin').isEncryptionAvailable(), true); // backend is ignored off Linux
    assert.equal(plat.guardSafeStorage({ isEncryptionAvailable: () => { throw new Error('before ready'); } }, 'darwin').isEncryptionAvailable(), false);
    assert.equal(plat.guardSafeStorage(ss, 'darwin').decryptString(plat.guardSafeStorage(ss, 'darwin').encryptString('k')), 'k');
  });
});

describe('lifecycle on macOS', () => {
  const fakeWin = () => {
    const h = {};
    return { on: (e, f) => { h[e] = f; }, emit: (e, ...a) => h[e] && h[e](...a), isDestroyed: () => false, isMinimized: () => false, show() { this.shown = true; }, focus() {}, hide() { this.hidden = true; }, h };
  };
  const base = (platform, extra = {}) => {
    const quits = [];
    const lc = createLifecycle({
      app: { quit: () => quits.push(1) }, dialog: {}, Notification: null, Menu: { buildFromTemplate: (t) => t },
      Tray: class { setToolTip() {} setContextMenu() {} on() {} },
      nativeImage: { createFromDataURL: () => ({ setTemplateImage(v) { this.tpl = v; } }) },
      powerMonitor: null, getWorker: () => null, platform, ...extra,
    });
    return { lc, quits };
  };
  it('closing the last window does not quit on macOS even without a tray', () => {
    const { lc, quits } = base('darwin');
    const w = fakeWin();
    lc.attachWindow(w);
    w.emit('closed');
    assert.equal(quits.length, 0);
  });
  it('...but still quits on Windows without a tray (unchanged)', () => {
    const { lc, quits } = base('win32');
    const w = fakeWin();
    lc.attachWindow(w);
    w.emit('closed');
    assert.equal(quits.length, 1);
  });
  it('Dock click (activate): recreates a destroyed window, otherwise shows the existing one', () => {
    const { lc } = base('darwin');
    let created = 0;
    assert.equal(lc.reopen(() => { created++; }), true); // no window yet
    assert.equal(created, 1);
    const w = fakeWin();
    lc.attachWindow(w);
    assert.equal(lc.reopen(() => { created++; }), false);
    assert.equal(w.shown, true);
    assert.equal(created, 1);
    w.isDestroyed = () => true;
    assert.equal(lc.reopen(() => { created++; }), true);
    assert.equal(created, 2);
  });
  it('tray icon is marked as a template image only on macOS', () => {
    let icon;
    const mk = (platform) => createLifecycle({
      app: {}, dialog: {}, Menu: { buildFromTemplate: (t) => t }, Notification: null,
      Tray: class { constructor(i) { icon = i; } setToolTip() {} setContextMenu() {} on() {} },
      nativeImage: { createFromDataURL: () => ({ setTemplateImage(v) { this.tpl = v; } }) },
      getWorker: () => null, platform,
    });
    assert.equal(mk('darwin').setupTray(), true);
    assert.equal(icon.tpl, true);
    icon = null;
    assert.equal(mk('win32').setupTray(), true);
    assert.equal(icon.tpl, undefined);
  });
  it('macOS quits via Cmd+Q path: before-quit with no unfinished work proceeds', () => {
    const { lc } = base('darwin');
    assert.equal(lc.onBeforeQuit({ preventDefault() { throw new Error('should not block'); } }), true);
    assert.equal(lc.isQuitting(), true);
  });
});

describe('quitOnAllWindowsClosed', () => {
  it('false only on macOS', () => {
    assert.equal(plat.quitOnAllWindowsClosed('darwin'), false);
    assert.equal(plat.quitOnAllWindowsClosed('win32'), true);
    assert.equal(plat.quitOnAllWindowsClosed('linux'), true);
  });
});
