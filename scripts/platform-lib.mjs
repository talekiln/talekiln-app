// 打包 / ffmpeg 获取脚本的平台差异（纯函数，platform 与 arch 都可注入，Linux 上即可单测 Windows / macOS 分支）。
import path from 'node:path';
import crypto from 'node:crypto';

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

/**
 * electron-builder 的 extraResources：lycore 与 ffmpeg 放进 <resources>/lycore/（lycore 按 <exe 目录>/ffmpeg 找 ffmpeg）；
 * 人脸模型（scripts/fetch-face-models.mjs 取到 apps/desktop/resources/models/face）放进 <resources>/models/。
 */
export function extraResources({ root, desktop, platform = process.platform }) {
  const bin = lycoreName(platform);
  return [
    { from: path.join(root, 'apps', 'renderer', 'dist'), to: 'renderer' },
    { from: path.join(root, 'packages', 'core', 'target', 'release', bin), to: `lycore/${bin}` },
    { from: path.join(desktop, 'resources', 'ffmpeg'), to: 'lycore/ffmpeg' },
    { from: path.join(desktop, 'resources', 'models'), to: 'models' },
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

// ---------------------------------------------------------------- 人脸模型固定清单（scripts/fetch-face-models.mjs）

/**
 * scripts/face-models-pin.json 里要下载的模型条目 [{ name, url, sha256, size, license, license_file, license_url, license_sha256, ... }]。
 * 任一条目缺 url / 64 位 sha256 / size 或许可信息就抛 PinError：绝不下载没法校验的东西。
 */
export function faceModelEntries(pin) {
  const models = (pin && pin.models) || {};
  const names = Object.keys(models);
  if (!names.length) throw new PinError('pin_invalid', 'scripts/face-models-pin.json 没有 models 条目');
  return names.map((name) => {
    const e = models[name];
    if (!e || isPlaceholderValue(e.url) || !isHex64(e.sha256) || !Number.isInteger(e.size) || e.size <= 0) {
      throw new PinError('pin_placeholder', `scripts/face-models-pin.json 的 ${name} 条目不完整（需要 https url、64 位 sha256、size）`);
    }
    if (isPlaceholderValue(e.license_url) || !isHex64(e.license_sha256) || isPlaceholderValue(e.license_file) || isPlaceholderValue(e.license)) {
      throw new PinError('pin_placeholder', `scripts/face-models-pin.json 的 ${name} 缺许可信息（license、license_file、license_url、license_sha256）`);
    }
    return { name, ...e };
  });
}

/** 模型目录里 .pin 戳记的内容：清单里任一哈希变了戳记就变，fetch 脚本据此决定要不要重下。 */
export const faceModelsStamp = (pin) => faceModelEntries(pin).map((e) => `${e.name}=${e.sha256.toLowerCase()}`).join('\n');

/** 下载到的内容对固定条目校验：给了 size 就先比大小，再比 SHA-256；不符抛 PinError（size_mismatch / hash_mismatch）。通过返回原 buffer。 */
export function verifyPinnedBuffer(buf, want, label = '') {
  if (Number.isInteger(want.size) && buf.length !== want.size) throw new PinError('size_mismatch', `${label} 大小不符：期望 ${want.size}，实际 ${buf.length}`);
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== String(want.sha256).toLowerCase()) throw new PinError('hash_mismatch', `${label} SHA-256 不符：期望 ${want.sha256}，实际 ${got}`);
  return buf;
}

// ---------------------------------------------------------------- onnxruntime-node 裁剪（scripts/pack-desktop.mjs）

/** electron-builder 参数 -> 目标平台 / 架构：--win / --mac / --linux，--x64 / --arm64 / --ia32；没给的跟随宿主。 */
export function builderTarget(args, platform = process.platform, arch = process.arch) {
  const p = args.includes('--win') ? 'win32' : args.includes('--mac') ? 'darwin' : args.includes('--linux') ? 'linux' : platform;
  const a = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : args.includes('--ia32') ? 'ia32' : arch;
  return { platform: p, arch: a };
}

/**
 * onnxruntime-node 的 npm 包带着所有平台的 CPU 二进制（bin/napi-v6/<platform>/<arch>，合计近 300 MB）。
 * entries = 实际存在的 [{ platform, arch }]；返回要删掉的 '<platform>/<arch>' 列表——只留目标那份。
 * 目标那份不存在时别的照删（这样的包里人脸评分会报“不可用”，不会崩），调用方应另外警告。
 */
export function onnxRuntimePrune(entries, { platform, arch }) {
  return entries.filter((e) => !(e.platform === platform && e.arch === arch)).map((e) => `${e.platform}/${e.arch}`);
}
