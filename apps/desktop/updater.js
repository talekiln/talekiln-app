'use strict';
/**
 * 自动更新控制器。electron-updater 的 autoUpdater、dialog 等全部注入，便于用假对象测试。
 * 策略：启动后延迟检查一次 + 之后定时检查（静默：无更新/失败只写日志）；托盘菜单可手动检查（有结果弹窗）；
 * 发现新版本后台下载，下载完成后由用户确认才重启安装（不开 autoInstallOnAppQuit，绝不静默安装）。
 */
const logic = require('./updater-logic');

function createUpdateController({
  autoUpdater, dialog, config, currentVersion, getWindow = () => undefined,
  unfinishedCount = () => 0, onStateChange = () => {}, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const state = { status: 'idle', version: null, percent: null, error: null };
  let manualPending = false;
  let promptedVersion = null;
  let periodic = null;
  let initialised = false;

  const changed = () => { try { onStateChange(); } catch (_) {} };
  const win = () => { try { return getWindow() || undefined; } catch (_) { return undefined; } };
  const say = (kind, extra) => {
    const opts = logic.manualResultPrompt(kind, extra);
    if (!opts) return Promise.resolve();
    return Promise.resolve().then(() => dialog.showMessageBox(win(), opts)).catch((e) => log(`update dialog failed: ${e && e.message}`));
  };

  function promptInstall(info) {
    promptedVersion = info && info.version;
    const opts = logic.installPrompt(info, { unfinished: safeUnfinished() });
    return Promise.resolve()
      .then(() => dialog.showMessageBox(win(), opts))
      .then((r) => {
        if (r && r.response === 0) {
          log(`update: user confirmed install ${state.version}`);
          autoUpdater.quitAndInstall(false, true);
        }
      })
      .catch((e) => log(`update install prompt failed: ${e && e.message}`));
  }
  function safeUnfinished() { try { return unfinishedCount(); } catch (_) { return 0; } }

  function init() {
    if (initialised) return config.enabled;
    initialised = true;
    if (!config.enabled) {
      state.status = 'disabled';
      log(`update: disabled (${config.reason})`);
      return false;
    }
    try {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false; // 安装必须经用户确认
      autoUpdater.allowDowngrade = false;
      autoUpdater.allowPrerelease = config.channel !== 'latest';
      autoUpdater.channel = config.channel;
      if (autoUpdater.logger === undefined) autoUpdater.logger = null;
      autoUpdater.setFeedURL({ provider: 'generic', url: config.feedUrl, channel: config.channel });
    } catch (e) {
      state.status = 'disabled';
      state.error = String(e && e.message);
      log(`update: configure failed: ${state.error}`);
      return false;
    }

    autoUpdater.on('checking-for-update', () => { state.status = 'checking'; changed(); });
    autoUpdater.on('update-available', (info) => {
      if (!logic.shouldOffer(currentVersion, info && info.version)) {
        state.status = 'idle';
        log(`update: ignoring non-newer version ${info && info.version}`);
        changed();
        return;
      }
      state.status = 'downloading';
      state.version = info.version;
      state.percent = 0;
      log(`update: found ${info.version}, downloading`);
      changed();
      if (manualPending) { manualPending = false; say('downloading', { version: info.version }); }
    });
    autoUpdater.on('update-not-available', () => {
      state.status = 'idle';
      changed();
      if (manualPending) { manualPending = false; say('up-to-date', { version: currentVersion }); }
    });
    autoUpdater.on('download-progress', (p) => { state.percent = p && Number.isFinite(p.percent) ? Math.floor(p.percent) : state.percent; changed(); });
    autoUpdater.on('update-downloaded', (info) => {
      state.status = 'downloaded';
      state.version = (info && info.version) || state.version;
      state.percent = 100;
      log(`update: downloaded ${state.version}`);
      changed();
      if (promptedVersion !== state.version) promptInstall(info || { version: state.version });
    });
    autoUpdater.on('error', (err) => {
      const msg = err && err.message ? String(err.message) : String(err);
      state.status = state.status === 'downloaded' ? 'downloaded' : 'idle';
      state.error = msg;
      changed();
      log(`update: error ${msg}`); // 签名不匹配 / 校验失败也走这里：不安装，只记日志
      if (manualPending) { manualPending = false; say('error', { error: msg }); }
    });
    return true;
  }

  /** 手动或自动检查。已下载则直接再次询问安装。 */
  async function check({ manual = false } = {}) {
    if (!initialised) init();
    if (!config.enabled || state.status === 'disabled') {
      if (manual) await say('disabled', { reason: config.reason || state.error });
      return false;
    }
    if (state.status === 'downloaded') {
      if (manual) await promptInstall({ version: state.version });
      return true;
    }
    if (state.status === 'checking' || state.status === 'downloading') {
      if (manual) await say('downloading', { version: state.version });
      return true;
    }
    manualPending = manual;
    try {
      await autoUpdater.checkForUpdates();
      return true;
    } catch (e) {
      // 'error' 事件通常也会触发；这里兜底，避免 manualPending 卡住
      if (manualPending) { manualPending = false; await say('error', { error: e && e.message }); }
      state.status = 'idle';
      log(`update: check failed ${e && e.message}`);
      return false;
    }
  }

  /** 启动后延迟检查 + 定时检查。 */
  function start() {
    if (!init()) return false;
    setTimer(() => { check({ manual: false }); }, config.checkOnStartDelayMs);
    if (config.checkIntervalMs > 0) {
      periodic = setTimer(function tick() {
        check({ manual: false });
        periodic = setTimer(tick, config.checkIntervalMs);
      }, config.checkIntervalMs);
    }
    return true;
  }

  function stop() { if (periodic != null) { clearTimer(periodic); periodic = null; } }

  /** 托盘菜单项（lifecycle 的 extraTrayItems 使用）。 */
  function trayItem() {
    return {
      label: logic.trayLabel(state),
      enabled: state.status !== 'checking' && state.status !== 'downloading',
      click: () => { check({ manual: true }); },
    };
  }

  return { init, check, start, stop, trayItem, getState: () => ({ ...state }) };
}

module.exports = { createUpdateController };
