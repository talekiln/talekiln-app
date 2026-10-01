const { app, BrowserWindow, Menu, session, shell, dialog, safeStorage, Tray, Notification, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');

try {
  require('dns').setDefaultResultOrder('ipv4first');
} catch (_) {}

const plat = require('./platform');
// Windows: %APPDATA%\talekiln；macOS: ~/Library/Application Support/talekiln；目录名规则见 platform.userDataDir
const USERDATA_DIR = plat.userDataDir(app.getPath('appData'));
app.setPath('userData', USERDATA_DIR);

const LOG_FILE = path.join(USERDATA_DIR, 'main.log');
function writeMainLog(msg) {
  try {
    fs.mkdirSync(USERDATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {}
}
process.on('uncaughtException', (e) => writeMainLog(`uncaughtException: ${e && e.stack ? e.stack : e}`));
process.on('unhandledRejection', (r) => writeMainLog(`unhandledRejection: ${r instanceof Error ? r.stack : r}`));

// 每次启动生成的本地服务令牌，只存在于主进程内存，通过请求头注入渲染进程的请求
const LOCAL_TOKEN = crypto.randomBytes(32).toString('hex');
const TOKEN_HEADER = 'X-Talekiln-Token';

const LOCAL_DIR = path.dirname(require.resolve('@talekiln/local/package.json'));
const RENDERER_DIST = app.isPackaged
  ? path.join(process.resourcesPath, 'renderer')
  : path.join(__dirname, '..', 'renderer', 'dist');
const DATA_DIR = path.join(USERDATA_DIR, 'local');

let serverInstance = null;
let aiWorker = null;
let coreRuntime = null;

// lycore（渲染核心）：由主进程守护，崩溃自动重启；管道地址经 LYCORE_ENDPOINT 传给本地服务。后台启动，失败不阻止应用
function setupCore() {
  const rt = require('./core-runtime');
  const coreDir = app.isPackaged ? null : path.join(path.dirname(require.resolve('@talekiln/core/package.json')));
  const client = require('@talekiln/core');
  coreRuntime = rt.createCoreRuntime({
    createSupervisor: client.createSupervisor,
    bin: rt.resolveLycoreBin({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, repoCoreDir: coreDir }),
    endpoint: rt.makeEndpoint(),
    logDir: path.join(USERDATA_DIR, 'logs'),
    appDataDir: USERDATA_DIR,
    provision: (o) => client.provision(o),
    log: (m) => writeMainLog(m),
    onFailed: () => dialog.showErrorBox('Talekiln', '渲染核心多次崩溃，导出功能暂不可用。请重启应用；若仍失败请导出诊断包反馈。'),
  });
  coreRuntime.start().catch((e) => writeMainLog(`core runtime start threw: ${e && e.stack ? e.stack : e}`));
}

// 托盘 / 退出确认 / 完成通知 / 系统唤醒（逻辑在 lifecycle.js，Electron 对象注入）
const lifecycle = require('./lifecycle').createLifecycle({
  app, dialog, Notification, Tray, Menu, nativeImage, powerMonitor,
  getWorker: () => aiWorker,
  readableError: (code, msg) => {
    try { return require(path.join(LOCAL_DIR, 'src', 'queue', 'taskView.js')).readableError(code, msg); } catch (_) { return msg; }
  },
  getExtraTrayItems: () => (updater ? [updater.trayItem()] : []),
  log: (m) => writeMainLog(m),
});

// 自动更新：配置来自 update-config.json（占位）+ 环境变量；未配置/开发模式下保持关闭。electron-updater 缺失也不影响启动
let updater = null;
function setupUpdater() {
  try {
    const { resolveConfig } = require('./updater-logic');
    const { createUpdateController } = require('./updater');
    let file = {};
    try { file = JSON.parse(fs.readFileSync(path.join(__dirname, 'update-config.json'), 'utf8')); } catch (_) {}
    const config = resolveConfig({ file, env: process.env, isPackaged: app.isPackaged });
    let autoUpdater = null;
    if (config.enabled) ({ autoUpdater } = require('electron-updater'));
    updater = createUpdateController({
      autoUpdater, dialog, config, currentVersion: app.getVersion(),
      getWindow: () => BrowserWindow.getAllWindows()[0],
      unfinishedCount: () => (aiWorker ? aiWorker.unfinishedCount() : 0),
      onStateChange: () => lifecycle.refreshTrayMenu(),
      log: (m) => writeMainLog(m),
    });
    updater.start();
    lifecycle.refreshTrayMenu();
  } catch (e) {
    writeMainLog(`updater setup failed: ${e && e.stack ? e.stack : e}`);
    updater = null;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function ensureDataDir() {
  for (const d of ['configs', 'data', 'logs']) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
  const cfg = path.join(DATA_DIR, 'configs', 'config.yaml');
  const bundled = path.join(LOCAL_DIR, 'configs', 'config.yaml');
  if (!fs.existsSync(cfg) && fs.existsSync(bundled)) fs.copyFileSync(bundled, cfg);
}

async function startLocalService() {
  ensureDataDir();
  setupCore();
  process.env.TALEKILN_LOCAL_TOKEN = LOCAL_TOKEN;
  process.env.WEB_DIST_PATH = RENDERER_DIST;
  process.env.LOG_FILE = path.join(DATA_DIR, 'logs', 'app.log');
  process.chdir(DATA_DIR);

  require(path.join(LOCAL_DIR, 'src', 'db', 'migrate.js'));
  const { createApp } = require(path.join(LOCAL_DIR, 'src', 'app.js'));
  // 密钥：主进程用 safeStorage 加密，仅密文落盘；明文只在本地服务内存中。不可用时拒绝保存而非降级明文
  const { FileSecretStore, createSafeStorageCipher } = require(path.join(LOCAL_DIR, 'src', 'secrets'));
  const secretStore = new FileSecretStore({
    // guardSafeStorage：Linux 上退化为 basic_text 的后端视为不可用；macOS 走 Keychain
    cipher: createSafeStorageCipher(plat.guardSafeStorage(safeStorage)),
    filePath: path.join(DATA_DIR, 'data', 'secrets.enc.json'),
  });
  if (!secretStore.isAvailable()) writeMainLog('safeStorage encryption unavailable: API keys cannot be saved');
  const { app: expressApp, aiQueue } = createApp({ secretStore, onTaskFinished: (t) => lifecycle.onTaskFinished(t) });
  aiWorker = aiQueue.worker;
  // 启动对账（恢复未完成任务，不会重复提交）后开始调度；失败不阻止应用启动
  aiWorker.start().catch((e) => writeMainLog(`ai worker start failed: ${e && e.stack ? e.stack : e}`));
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const server = require('http').createServer(expressApp);
    serverInstance = server;
    server.on('error', reject);
    // 只监听回环地址，局域网不可达
    server.listen(port, '127.0.0.1', () => resolve(port));
  });
}

function hardenSession(port) {
  const origin = `http://127.0.0.1:${port}`;
  const ses = session.defaultSession;
  ses.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, cb) => {
    details.requestHeaders[TOKEN_HEADER] = LOCAL_TOKEN;
    cb({ requestHeaders: details.requestHeaders });
  });
  ses.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; ` +
            `style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:`,
        ],
      },
    });
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

function isExternal(url, port) {
  try {
    return new URL(url).origin !== `http://127.0.0.1:${port}`;
  } catch (_) {
    return true;
  }
}

function createWindow(port) {
  // Windows/Linux 无菜单栏；macOS 必须保留应用菜单，否则 ⌘C/⌘V/⌘Q 等键位失效
  const tpl = plat.buildAppMenuTemplate({ appName: app.getName() });
  Menu.setApplicationMenu(tpl ? Menu.buildFromTemplate(tpl) : null);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // 外链一律交给系统浏览器，仅放行 https
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isExternal(url, port)) {
      e.preventDefault();
      if (url.startsWith('https://')) shell.openExternal(url);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => writeMainLog(`did-fail-load ${code} ${desc} ${url}`));
  win.loadURL(`http://127.0.0.1:${port}`);
  lifecycle.attachWindow(win);
  if (process.env.TALEKILN_DEVTOOLS === '1') win.webContents.openDevTools();
}

let servicePort = null;
// macOS：点击 Dock 图标时窗口已关闭则重建；无托盘时关窗并不退出应用
app.on('activate', () => {
  if (servicePort) lifecycle.reopen(() => createWindow(servicePort));
});
// 显式声明 window-all-closed：mac 上保持运行；其他平台由 lifecycle 在关窗时退出，这里不重复处理
app.on('window-all-closed', () => {
  if (plat.quitOnAllWindowsClosed()) app.quit();
});

app.whenReady().then(async () => {
  try {
    const port = await startLocalService();
    servicePort = port;
    hardenSession(port);
    lifecycle.setupTray();
    createWindow(port);
    lifecycle.bindPower();
    setupUpdater();
  } catch (err) {
    const stack = err && err.stack ? err.stack : String(err);
    writeMainLog(`startup failed\n${stack}`);
    dialog.showErrorBox('Talekiln 启动失败', `本地服务未能启动，日志：${LOG_FILE}\n\n${stack}`);
    app.quit();
  }
});

let coreStopped = false;
app.on('before-quit', (e) => {
  if (!lifecycle.onBeforeQuit(e)) return; // 有未完成任务：等待用户确认
  if (coreRuntime && !coreStopped) {
    // 先优雅关闭 lycore（最多几秒），再真正退出
    coreStopped = true;
    e.preventDefault();
    coreRuntime.stop().finally(() => app.quit());
    return;
  }
  if (aiWorker) { aiWorker.stop().catch(() => {}); aiWorker = null; }
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
});
