const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLifecycle, quitPrompt, notificationFor, createNotificationBatcher } = require('../lifecycle');

function fakeWindow() {
  const h = {};
  return {
    hidden: false,
    on(ev, fn) { h[ev] = fn; },
    emit(ev, ...a) { return h[ev] && h[ev](...a); },
    hide() { this.hidden = true; },
    show() { this.hidden = false; },
    focus() {}, restore() {}, isMinimized: () => false, isDestroyed: () => false,
  };
}

function fakes({ unfinished = 0, response = 1, trayThrows = false } = {}) {
  const calls = { quit: 0, dialogs: [], notes: [], resume: 0 };
  const worker = { unfinishedCount: () => unfinished, onResume: async () => { calls.resume++; } };
  const handlers = {};
  const deps = {
    app: { quit: () => { calls.quit++; } },
    dialog: { showMessageBox: async (_w, opts) => { calls.dialogs.push(opts); return { response }; } },
    Notification: class { static isSupported() { return true; } constructor(o) { this.o = o; } on() {} show() { calls.notes.push(this.o); } },
    Tray: class { constructor() { if (trayThrows) throw new Error('no tray'); } setToolTip() {} setContextMenu() {} on() {} },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createFromDataURL: () => ({}) },
    powerMonitor: { on: (ev, fn) => { handlers[ev] = fn; } },
    getWorker: () => worker,
    setTimer: (fn) => { calls.flush = fn; return 1; },
  };
  return { calls, deps, handlers, worker };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('quit confirmation', () => {
  it('prompt only when tasks are unfinished', () => {
    assert.equal(quitPrompt(0), null);
    assert.match(quitPrompt(3).message, /3 个/);
  });
  it('quits without asking when nothing is running', () => {
    const { deps, calls } = fakes({ unfinished: 0 });
    const lc = createLifecycle(deps);
    let prevented = false;
    assert.equal(lc.onBeforeQuit({ preventDefault: () => { prevented = true; } }), true);
    assert.equal(prevented, false);
    assert.equal(calls.dialogs.length, 0);
  });
  it('blocks the quit and asks; choosing quit re-quits without asking again', async () => {
    const { deps, calls } = fakes({ unfinished: 2, response: 1 });
    const lc = createLifecycle(deps);
    let prevented = 0;
    assert.equal(lc.onBeforeQuit({ preventDefault: () => prevented++ }), false);
    assert.equal(prevented, 1);
    await tick(); await tick();
    assert.equal(calls.quit, 1);
    assert.equal(lc.onBeforeQuit({ preventDefault: () => prevented++ }), true);
    assert.equal(prevented, 1);
    assert.equal(calls.dialogs.length, 1);
  });
  it('choosing to keep running does not quit', async () => {
    const { deps, calls } = fakes({ unfinished: 1, response: 0 });
    const lc = createLifecycle(deps);
    lc.onBeforeQuit({ preventDefault() {} });
    await tick(); await tick();
    assert.equal(calls.quit, 0);
  });
});

describe('tray', () => {
  it('close hides the window (worker keeps running) and a real quit lets it close', () => {
    const { deps } = fakes();
    const lc = createLifecycle(deps);
    assert.equal(lc.setupTray(), true);
    const win = fakeWindow();
    lc.attachWindow(win);
    let prevented = false;
    win.emit('close', { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(win.hidden, true);
    lc.onBeforeQuit({ preventDefault() {} });
    prevented = false;
    win.emit('close', { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false);
  });
  it('without a tray the window closes and the app quits', () => {
    const { deps, calls } = fakes({ trayThrows: true });
    const lc = createLifecycle(deps);
    assert.equal(lc.setupTray(), false);
    const win = fakeWindow();
    lc.attachWindow(win);
    let prevented = false;
    win.emit('close', { preventDefault: () => { prevented = true; } });
    win.emit('closed');
    assert.equal(prevented, false);
    assert.equal(calls.quit, 1);
  });
});

describe('notifications and resume', () => {
  it('notification text for succeeded/failed only', () => {
    assert.match(notificationFor({ state: 'succeeded', kind: 'video' }).body, /video/);
    const f = notificationFor({ state: 'failed', error_code: 'INSUFFICIENT_BALANCE' }, { readable: () => '余额不足' });
    assert.match(f.body, /余额不足/);
    assert.equal(notificationFor({ state: 'cancelled' }), null);
  });
  it('batches bursts into one summary', () => {
    const shown = [];
    let flush;
    const push = createNotificationBatcher({ show: (n) => shown.push(n), setTimer: (fn) => { flush = fn; return 1; } });
    push(notificationFor({ state: 'succeeded' }));
    push(notificationFor({ state: 'failed' }));
    flush();
    assert.equal(shown.length, 1);
    assert.match(shown[0].body, /2 个任务已结束，其中 1 个失败/);
  });
  it('onTaskFinished shows a system notification', () => {
    const { deps, calls } = fakes();
    const lc = createLifecycle(deps);
    lc.onTaskFinished({ state: 'succeeded', kind: 'generic' });
    calls.flush();
    assert.equal(calls.notes.length, 1);
  });
  it('powerMonitor resume triggers worker.onResume', async () => {
    const { deps, calls, handlers } = fakes();
    const lc = createLifecycle(deps);
    assert.equal(lc.bindPower(), true);
    handlers.resume();
    await tick();
    assert.equal(calls.resume, 1);
  });
});
