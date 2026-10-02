'use strict';
/**
 * Desktop lifecycle policy (tray, quit confirmation, completion notifications, resume hook).
 * Electron objects are injected so this module is unit-testable without Electron; every Electron
 * call is guarded so a missing/failed API degrades to "feature off" instead of crashing main.
 */

// Placeholder 16x16 tray icon (solid colour). Replace with a real asset when branding lands.
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGNwyPn/nxLMMGrAqAGjBgwXAwA9KKof3o3xWwAAAABJRU5ErkJggg==';

/** Pure: what to ask when the user quits. */
function quitPrompt(unfinished) {
  if (!Number.isFinite(unfinished) || unfinished <= 0) return null;
  return {
    type: 'warning',
    buttons: ['继续运行（最小化到托盘）', '退出'],
    defaultId: 0,
    cancelId: 0,
    title: '仍有任务在运行',
    message: `还有 ${unfinished} 个 AI 任务未完成`,
    detail: '退出后任务会暂停，下次启动时自动恢复；已提交到服务商的任务不会重复提交。',
  };
}

/** Pure: notification text for a finished task, or null when none is warranted. */
function notificationFor(task, { readable } = {}) {
  if (!task) return null;
  const label = task.kind && task.kind !== 'generic' ? task.kind : 'AI';
  if (task.state === 'succeeded') return { title: 'Talekiln 任务完成', body: `${label} 任务已完成` };
  if (task.state === 'failed') {
    const why = readable ? readable(task) : task.error_message;
    return { title: 'Talekiln 任务失败', body: `${label} 任务失败${why ? `：${why}` : ''}` };
  }
  return null;
}

/**
 * Collapse many completions in a short window into one notification.
 * Returns push(task); flushes via the injected timer.
 */
function createNotificationBatcher({ show, windowMs = 1500, setTimer = setTimeout }) {
  let pending = [];
  let timer = null;
  const flush = () => {
    timer = null;
    const items = pending;
    pending = [];
    if (!items.length) return;
    if (items.length === 1) return show(items[0]);
    const failed = items.filter((n) => n.title.includes('失败')).length;
    show({ title: 'Talekiln 任务已结束', body: `${items.length} 个任务已结束${failed ? `，其中 ${failed} 个失败` : ''}` });
  };
  return (n) => {
    if (!n) return;
    pending.push(n);
    if (!timer) timer = setTimer(flush, windowMs);
  };
}

const plat = require('./platform');

function createLifecycle({ app, dialog, Notification, Tray, Menu, nativeImage, powerMonitor, getWorker, readableError, getExtraTrayItems = () => [], log = () => {}, setTimer, platform = process.platform }) {
  let tray = null;
  let win = null;
  let quitConfirmed = false;
  let quitting = false;

  const worker = () => { try { return getWorker && getWorker(); } catch (_) { return null; } };
  const unfinished = () => { try { const w = worker(); return w ? w.unfinishedCount() : 0; } catch (_) { return 0; } };

  function showWindow() {
    try {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch (e) { log(`showWindow failed: ${e && e.message}`); }
  }

  /** 托盘菜单每次重建，使“检查更新/安装更新”等动态文案生效。 */
  function refreshTrayMenu() {
    try {
      if (!tray) return;
      let extra = [];
      try { extra = getExtraTrayItems() || []; } catch (_) { extra = []; }
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '显示窗口', click: showWindow },
        ...extra,
        { label: '退出', click: () => app.quit() },
      ]));
    } catch (e) { log(`tray menu refresh failed: ${e && e.message}`); }
  }

  function setupTray() {
    try {
      if (tray || !Tray || !nativeImage) return false;
      const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
      // macOS 菜单栏要求模板图（黑色 + 透明），系统才会按深浅色主题着色
      if (plat.trayOptions(platform).templateImage && icon && icon.setTemplateImage) icon.setTemplateImage(true);
      tray = new Tray(icon);
      tray.setToolTip('Talekiln');
      refreshTrayMenu();
      tray.on('click', showWindow);
      return true;
    } catch (e) {
      log(`tray unavailable: ${e && e.message}`);
      tray = null;
      return false;
    }
  }

  /** Close button hides to tray (worker keeps running); without a tray the window really closes. */
  function attachWindow(w) {
    win = w;
    w.on('close', (e) => {
      if (quitting || !tray) return;
      e.preventDefault();
      w.hide();
    });
    // macOS：关掉最后一个窗口应用继续运行（Dock 重开，见 reopen）；其他平台无托盘时退出
    w.on('closed', () => { win = null; if (!tray && plat.quitOnAllWindowsClosed(platform)) app.quit(); });
  }

  /** Wire to app.on('before-quit'). Returns true when the quit goes ahead. */
  function onBeforeQuit(e) {
    if (quitConfirmed) { quitting = true; return true; }
    const prompt = quitPrompt(unfinished());
    if (!prompt) { quitting = true; return true; }
    e.preventDefault();
    Promise.resolve()
      .then(() => dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, prompt))
      .then((r) => {
        if (r && r.response === 1) { quitConfirmed = true; quitting = true; app.quit(); }
        else showWindow();
      })
      .catch((err) => { log(`quit dialog failed: ${err && err.message}`); quitConfirmed = true; quitting = true; app.quit(); });
    return false;
  }

  const show = (n) => {
    try {
      if (!Notification || (Notification.isSupported && !Notification.isSupported())) return;
      const note = new Notification({ title: n.title, body: n.body });
      note.on('click', showWindow);
      note.show();
    } catch (err) { log(`notification failed: ${err && err.message}`); }
  };
  const batch = createNotificationBatcher({ show, setTimer });

  /** Pass as createApp({ onTaskFinished }). */
  function onTaskFinished(task) {
    batch(notificationFor(task, { readable: readableError ? (t) => readableError(t.error_code, t.error_message) : undefined }));
  }

  /** System resume (sleep/hibernate): re-reconcile so tasks whose vendor state moved are picked up. */
  function bindPower() {
    try {
      if (!powerMonitor) return false;
      powerMonitor.on('resume', () => {
        const w = worker();
        if (w && w.onResume) Promise.resolve(w.onResume()).catch((err) => log(`resume reconcile failed: ${err && err.message}`));
      });
      return true;
    } catch (e) { log(`powerMonitor unavailable: ${e && e.message}`); return false; }
  }

  /** macOS Dock 图标被点击（app 'activate'）：窗口还在就显示，已销毁则交给 create 重建。返回是否重建。 */
  function reopen(create) {
    if (win && !win.isDestroyed()) { showWindow(); return false; }
    if (create) { create(); return true; }
    return false;
  }

  return { setupTray, refreshTrayMenu, attachWindow, onBeforeQuit, onTaskFinished, bindPower, showWindow, reopen, isQuitting: () => quitting };
}

module.exports = { createLifecycle, quitPrompt, notificationFor, createNotificationBatcher, TRAY_ICON_PNG_BASE64 };
