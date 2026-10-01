const { app, BrowserWindow, Menu, session, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');

try {
  require('dns').setDefaultResultOrder('ipv4first');
} catch (_) {}

const USERDATA_DIR = path.join(app.getPath('appData'), 'talekiln');
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
  process.env.TALEKILN_LOCAL_TOKEN = LOCAL_TOKEN;
  process.env.WEB_DIST_PATH = RENDERER_DIST;
  process.env.LOG_FILE = path.join(DATA_DIR, 'logs', 'app.log');
  process.chdir(DATA_DIR);

  require(path.join(LOCAL_DIR, 'src', 'db', 'migrate.js'));
  const { createApp } = require(path.join(LOCAL_DIR, 'src', 'app.js'));
  const { app: expressApp } = createApp();
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
  Menu.setApplicationMenu(null);
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
  win.on('closed', () => app.quit());
  if (process.env.TALEKILN_DEVTOOLS === '1') win.webContents.openDevTools();
}

app.whenReady().then(async () => {
  try {
    const port = await startLocalService();
    hardenSession(port);
    createWindow(port);
  } catch (err) {
    const stack = err && err.stack ? err.stack : String(err);
    writeMainLog(`startup failed\n${stack}`);
    dialog.showErrorBox('Talekiln 启动失败', `本地服务未能启动，日志：${LOG_FILE}\n\n${stack}`);
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
});
