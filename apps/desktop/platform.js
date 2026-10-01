'use strict';
// 平台差异的纯函数集合（Windows / macOS / Linux）。每个函数都接受注入的 platform，便于在任何系统上单测，
// 不依赖真实 macOS。Electron / 文件系统对象由调用方注入。

const path = require('path');

const isWin = (platform) => platform === 'win32';
const isMac = (platform) => platform === 'darwin';

/** 按目标平台选路径语义（而不是宿主平台），这样在 Linux 上也能断言 Windows / macOS 路径。 */
const pathFor = (platform) => (isWin(platform) ? path.win32 : path.posix);

/** 可执行文件名：只有 Windows 加 .exe。 */
function exeName(base, platform = process.platform) {
  return isWin(platform) ? `${base}.exe` : base;
}

/**
 * Unix 域套接字路径上限（含结尾 NUL）：macOS / BSD 的 sun_path 为 104 字节，Linux 为 108。
 * 取保守值留出余量；超过会在 bind 时报 EINVAL / "path must be shorter than SUN_LEN"。
 */
function udsPathLimit(platform = process.platform) {
  return isMac(platform) ? 104 : 108;
}

/**
 * 选一个放得下套接字文件的目录：首选 tmpDir，路径过长（macOS 的 $TMPDIR 形如 /var/folders/xx/yyyy/T/，
 * 再加上长用户目录或自定义 TMPDIR 时可能逼近上限）则退到 /tmp。
 */
function pickSocketPath({ platform = process.platform, tmpDir, fileName, fallbackDir = '/tmp' }) {
  const p = pathFor(platform);
  const limit = udsPathLimit(platform);
  const fits = (full) => Buffer.byteLength(full) < limit;
  const first = p.join(tmpDir, fileName);
  if (fits(first)) return first;
  const second = p.join(fallbackDir, fileName);
  if (fits(second)) return second;
  throw new Error(`socket path too long (limit ${limit - 1} bytes): ${first}`);
}

/**
 * 应用数据目录。目录名固定为小写 'talekiln'：macOS（APFS/HFS+ 默认不区分大小写）与 Windows 上 'Talekiln' 和
 * 'talekiln' 会指向同一目录，但 Linux 区分；统一小写才能让同一份数据在三个系统上路径规则一致，也不改变已有 Windows 用户的位置。
 * macOS 上 appData 为 ~/Library/Application Support。
 */
function userDataDir(appData, platform = process.platform) {
  return pathFor(platform).join(appData, 'talekiln');
}

/** 需要保证可执行权限的文件（拷贝 / 解压可能丢失 x 位）。非 Windows 才有意义；失败不抛错，返回是否可执行。 */
function ensureExecutable(file, { platform = process.platform, stat, chmod, access } = {}) {
  if (isWin(platform)) return true;
  const fs = require('fs');
  const st = stat || ((f) => fs.statSync(f));
  const ch = chmod || ((f, m) => fs.chmodSync(f, m));
  const ac = access || ((f) => fs.accessSync(f, fs.constants.X_OK));
  try { ac(file); return true; } catch (_) { /* 没有 x 位，尝试补上 */ }
  try {
    const mode = st(file).mode & 0o777;
    ch(file, mode | 0o755);
    ac(file);
    return true;
  } catch (_) { return false; }
}

/** macOS：关闭最后一个窗口不退出应用（Dock 图标常驻，点击 Dock 重开）；其他平台关窗即退出（无托盘时）。 */
function quitOnAllWindowsClosed(platform = process.platform) {
  return !isMac(platform);
}

/**
 * 应用菜单。Windows/Linux 保持无菜单（与此前行为一致）；macOS 必须有菜单，否则 ⌘C/⌘V/⌘A/⌘Z/⌘Q/⌘W/⌘M
 * 这些键位都不生效（它们由菜单项的 role 提供，不是由页面脚本处理）。
 */
function buildAppMenuTemplate({ platform = process.platform, appName = 'Talekiln' } = {}) {
  if (!isMac(platform)) return null;
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `关于 ${appName}` },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${appName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${appName}` },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
  ];
}

/**
 * 托盘差异：macOS 菜单栏图标应为“模板图”（纯黑 + 透明，系统按深浅色自动着色），
 * 且菜单栏空间小，不显示 tooltip 以外的文字。当前图标是占位纯色块，换正式图标前在 mac 上会显示为黑方块。
 */
function trayOptions(platform = process.platform) {
  return { templateImage: isMac(platform) };
}

/**
 * safeStorage 在三个平台的行为差异：
 *  - Windows：DPAPI，绑定当前 Windows 用户，始终可用；
 *  - macOS：Keychain（条目名 “<应用名> Safe Storage”），首次访问可能弹授权框；应用代码签名身份变化
 *    （未签名 -> 正式签名、换证书）后，旧密文可能无法解密或反复弹框，需要用户重新填写 Key；
 *  - Linux：依赖 libsecret/kwallet；拿不到时会退化为 basic_text（硬编码口令，等同明文），必须当作不可用。
 * 返回 { available, reason }。backend 仅 Linux 有意义（safeStorage.getSelectedStorageBackend()）。
 */
function evaluateSafeStorage({ platform = process.platform, isEncryptionAvailable, backend } = {}) {
  if (!isEncryptionAvailable) return { available: false, reason: 'encryption_unavailable' };
  if (platform === 'linux' && (backend === 'basic_text' || backend === 'unknown')) {
    return { available: false, reason: `weak_backend:${backend}` };
  }
  return { available: true, reason: 'ok' };
}

/** 把 evaluateSafeStorage 套在 Electron safeStorage 上，得到 secrets 模块用的 cipher 包装（不可用时 isEncryptionAvailable 返回 false）。 */
function guardSafeStorage(safeStorage, platform = process.platform) {
  const verdict = () => {
    let available = false;
    let backend;
    try { available = !!safeStorage.isEncryptionAvailable(); } catch (_) { available = false; }
    try { if (platform === 'linux' && safeStorage.getSelectedStorageBackend) backend = safeStorage.getSelectedStorageBackend(); } catch (_) { /* 旧版本没有 */ }
    return evaluateSafeStorage({ platform, isEncryptionAvailable: available, backend });
  };
  return {
    isEncryptionAvailable: () => verdict().available,
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b),
    verdict,
  };
}

module.exports = {
  isWin, isMac, pathFor, exeName, udsPathLimit, pickSocketPath, userDataDir, ensureExecutable,
  quitOnAllWindowsClosed, buildAppMenuTemplate, trayOptions, evaluateSafeStorage, guardSafeStorage,
};
