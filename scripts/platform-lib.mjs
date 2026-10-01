// 打包 / ffmpeg 获取脚本的平台差异（纯函数，platform 与 arch 都可注入，Linux 上即可单测 Windows / macOS 分支）。
import path from 'node:path';

export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

/** lycore 可执行文件名：只有 Windows 带 .exe。 */
export const lycoreName = (platform = process.platform) => (platform === 'win32' ? 'lycore.exe' : 'lycore');

/** ffmpeg 与 ffprobe 的可执行文件名。 */
export const ffmpegTools = (platform = process.platform) => (platform === 'win32' ? ['ffmpeg.exe', 'ffprobe.exe'] : ['ffmpeg', 'ffprobe']);

/** 没传参数时 electron-builder 的默认目标：跟随宿主平台。 */
export function defaultBuilderArgs(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return ['--win'];
  if (platform === 'darwin') return ['--mac', arch === 'arm64' ? '--arm64' : '--x64'];
  return ['--linux'];
}

/** electron-builder 的 extraResources：lycore 与 ffmpeg 放进 <resources>/lycore/（lycore 按 <exe 目录>/ffmpeg 找 ffmpeg）。 */
export function extraResources({ root, desktop, platform = process.platform }) {
  const bin = lycoreName(platform);
  return [
    { from: path.join(root, 'apps', 'renderer', 'dist'), to: 'renderer' },
    { from: path.join(root, 'packages', 'core', 'target', 'release', bin), to: `lycore/${bin}` },
    { from: path.join(desktop, 'resources', 'ffmpeg'), to: 'lycore/ffmpeg' },
  ];
}

/**
 * macOS：把签名相关的路径改成绝对路径（electron-builder 在 pnpm deploy 出来的 .stage 目录里运行，
 * 相对 apps/desktop 的路径在那里不存在），并列出需要单独签名的内置可执行文件。
 * 非 macOS 原样返回，不影响 Windows。
 */
export function applyMacBuildConfig(build, { desktop, platform = process.platform }) {
  if (platform !== 'darwin' || !build.mac) return build;
  const abs = (p) => (p && !path.isAbsolute(p) ? path.join(desktop, p) : p);
  const mac = { ...build.mac };
  if (mac.entitlements) mac.entitlements = abs(mac.entitlements);
  if (mac.entitlementsInherit) mac.entitlementsInherit = abs(mac.entitlementsInherit);
  return { ...build, mac };
}

// ---------------------------------------------------------------- ffmpeg 固定清单

export class PinError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PinError';
    this.code = code; // unsupported_platform | pin_placeholder | pin_invalid
  }
}

const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
const isPlaceholderValue = (s) => typeof s !== 'string' || !s.trim() || /TODO/i.test(s);

/** 某平台的条目是否仍是占位（版本、地址或哈希含 TODO / 为空 / 哈希不是 64 位十六进制）。 */
export function isPlaceholder(entry) {
  return !entry || isPlaceholderValue(entry.version) || isPlaceholderValue(entry.url) || !isHex64(entry.sha256);
}

/**
 * 取当前平台的固定条目；没有条目或仍是占位就抛错，并在错误里写明要补什么。
 * 绝不返回占位条目，也不编造哈希。
 */
export function selectPin(pin, key = platformKey()) {
  const entry = pin && pin.platforms && pin.platforms[key];
  if (!entry) {
    const have = Object.keys((pin && pin.platforms) || {}).join(', ') || '(无)';
    throw new PinError('unsupported_platform', `scripts/ffmpeg-pin.json 没有 ${key} 的条目（已有：${have}）`);
  }
  if (isPlaceholder(entry)) {
    throw new PinError(
      'pin_placeholder',
      `scripts/ffmpeg-pin.json 的 ${key} 仍是占位（TODO）。请先按 docs/phase2-macos.md 第 4 节获得 LGPL 构建、核实来源，` +
        '把真实的 version / url / sha256（对下载到的文件自己计算）填进去；在此之前不会下载任何东西。',
    );
  }
  if (!['zip'].includes(entry.archive || 'zip')) throw new PinError('pin_invalid', `不支持的 archive 类型：${entry.archive}`);
  return entry;
}

/**
 * 压缩包里的哪些条目要解出来。
 *  layout 'btbn'：<顶层目录>/bin/<tool>（Windows 的 BtbN 包）+ 顶层目录下的 LICENSE/COPYING；
 *  layout 'flat'：任意层级里 basename 命中的可执行文件（常见于 macOS 单文件 zip）+ 任意层级的 LICENSE/COPYING。
 * 返回 'tool' | 'license' | null。
 */
export function classifyEntry(entryName, tools, layout = 'btbn') {
  const base = entryName.split('/').pop();
  if (!base) return null;
  if (layout === 'flat') {
    if (tools.includes(base)) return 'tool';
    return /^(LICENSE|COPYING)[^/]*$/i.test(base) ? 'license' : null;
  }
  if (/\/bin\/[^/]+$/.test(entryName) && tools.includes(base)) return 'tool';
  return /^[^/]+\/(LICENSE|COPYING)[^/]*$/i.test(entryName) ? 'license' : null;
}

/** 写出文件的权限：工具需要可执行位（macOS / Linux），Windows 无意义。 */
export const fileMode = (kind, platform = process.platform) => (kind === 'tool' && platform !== 'win32' ? 0o755 : 0o644);
