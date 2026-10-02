import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  platformKey, lycoreName, ffmpegTools, defaultBuilderArgs, extraResources, applyMacBuildConfig,
  isPlaceholder, selectPin, PinError, classifyEntry, fileMode,
  faceModelEntries, faceModelsStamp, verifyPinnedBuffer, builderTarget, onnxRuntimePrune,
} from './platform-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pinFile = JSON.parse(fs.readFileSync(path.join(here, 'ffmpeg-pin.json'), 'utf8'));

test('binary names: .exe only on win32', () => {
  assert.equal(lycoreName('win32'), 'lycore.exe');
  assert.equal(lycoreName('darwin'), 'lycore');
  assert.deepEqual(ffmpegTools('win32'), ['ffmpeg.exe', 'ffprobe.exe']);
  assert.deepEqual(ffmpegTools('darwin'), ['ffmpeg', 'ffprobe']);
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64');
});

test('default electron-builder target follows the host platform', () => {
  assert.deepEqual(defaultBuilderArgs('win32', 'x64'), ['--win']);
  assert.deepEqual(defaultBuilderArgs('darwin', 'arm64'), ['--mac', '--arm64']);
  assert.deepEqual(defaultBuilderArgs('darwin', 'x64'), ['--mac', '--x64']);
});

test('extraResources: lycore name per platform, ffmpeg dir always lycore/ffmpeg', () => {
  const root = path.join('/r');
  const desktop = path.join('/r', 'apps', 'desktop');
  const win = extraResources({ root, desktop, platform: 'win32' });
  const mac = extraResources({ root, desktop, platform: 'darwin' });
  assert.ok(win.some((e) => e.to === 'lycore/lycore.exe' && e.from.endsWith('lycore.exe')));
  assert.ok(mac.some((e) => e.to === 'lycore/lycore' && e.from.endsWith(path.join('release', 'lycore'))));
  assert.ok(!mac.some((e) => /\.exe/.test(e.to + e.from)));
  assert.ok(mac.some((e) => e.to === 'lycore/ffmpeg'));
});

test('applyMacBuildConfig: absolute entitlement paths on macOS only', () => {
  const build = { win: { x: 1 }, mac: { entitlements: 'build/e.plist', entitlementsInherit: 'build/e.plist', hardenedRuntime: true } };
  const desktop = '/r/apps/desktop';
  const out = applyMacBuildConfig(build, { desktop, platform: 'darwin' });
  assert.equal(out.mac.entitlements, path.join(desktop, 'build/e.plist'));
  assert.equal(out.mac.hardenedRuntime, true);
  assert.equal(build.mac.entitlements, 'build/e.plist', 'input not mutated');
  assert.deepEqual(applyMacBuildConfig(build, { desktop, platform: 'win32' }), build);
});

test('package.json mac config lists the bundled executables and the entitlements file exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps', 'desktop', 'package.json'), 'utf8'));
  assert.equal(pkg.build.mac.hardenedRuntime, true);
  for (const b of ['lycore/lycore', 'lycore/ffmpeg/ffmpeg', 'lycore/ffmpeg/ffprobe']) {
    assert.ok(pkg.build.mac.binaries.some((x) => x.endsWith(b)), b);
  }
  assert.ok(fs.existsSync(path.join(here, '..', 'apps', 'desktop', pkg.build.mac.entitlements)));
  assert.ok(pkg.build.files.includes('platform.js'), 'platform.js must ship in the package');
  assert.ok(pkg.build.mac.target.includes('zip'), 'zip target is needed by electron-updater on macOS');
  // every top-level js required by main.js is packaged
  const main = fs.readFileSync(path.join(here, '..', 'apps', 'desktop', 'main.js'), 'utf8');
  for (const m of main.matchAll(/require\('\.\/([\w-]+)'\)/g)) assert.ok(pkg.build.files.includes(`${m[1]}.js`), `${m[1]}.js missing from build.files`);
});

test('ffmpeg pin: Windows entry is real and unchanged in meaning', () => {
  const e = selectPin(pinFile, 'win32-x64');
  assert.match(e.sha256, /^[0-9a-f]{64}$/);
  assert.ok(e.url.startsWith('https://'));
  assert.equal(e.layout, 'btbn');
});

test('ffmpeg pin: macOS entries are TODO and are refused, never invented', () => {
  for (const k of ['darwin-arm64', 'darwin-x64']) {
    assert.equal(isPlaceholder(pinFile.platforms[k]), true, k);
    assert.throws(() => selectPin(pinFile, k), (e) => e instanceof PinError && e.code === 'pin_placeholder' && /TODO/.test(e.message) && e.message.includes(k));
  }
  assert.throws(() => selectPin(pinFile, 'linux-x64'), (e) => e.code === 'unsupported_platform');
});

test('isPlaceholder: needs version, https url and a 64-hex sha256', () => {
  const ok = { version: 'n8', url: 'https://x/y.zip', sha256: 'a'.repeat(64) };
  assert.equal(isPlaceholder(ok), false);
  assert.equal(isPlaceholder({ ...ok, sha256: 'TODO' }), true);
  assert.equal(isPlaceholder({ ...ok, sha256: 'a'.repeat(63) }), true);
  assert.equal(isPlaceholder({ ...ok, url: 'TODO' }), true);
  assert.equal(isPlaceholder({ ...ok, version: '' }), true);
  assert.equal(isPlaceholder(undefined), true);
});

test('classifyEntry: btbn layout (win) and flat layout (mac)', () => {
  const win = ffmpegTools('win32');
  assert.equal(classifyEntry('ffmpeg-n8-win64-lgpl/bin/ffmpeg.exe', win, 'btbn'), 'tool');
  assert.equal(classifyEntry('ffmpeg-n8-win64-lgpl/LICENSE.txt', win, 'btbn'), 'license');
  assert.equal(classifyEntry('ffmpeg-n8-win64-lgpl/doc/ffmpeg.exe', win, 'btbn'), null);
  const mac = ffmpegTools('darwin');
  assert.equal(classifyEntry('ffmpeg', mac, 'flat'), 'tool');
  assert.equal(classifyEntry('bin/ffprobe', mac, 'flat'), 'tool');
  assert.equal(classifyEntry('COPYING.LGPLv2.1', mac, 'flat'), 'license');
  assert.equal(classifyEntry('__MACOSX/._ffmpeg', mac, 'flat'), null);
  assert.equal(classifyEntry('docs/', mac, 'flat'), null);
});

test('fileMode: executable bit for tools on macOS/Linux', () => {
  assert.equal(fileMode('tool', 'darwin'), 0o755);
  assert.equal(fileMode('license', 'darwin'), 0o644);
  assert.equal(fileMode('tool', 'win32'), 0o644);
});

// ---------------------------------------------------------------- 人脸模型清单与 onnxruntime 裁剪

const facePin = JSON.parse(fs.readFileSync(path.join(here, 'face-models-pin.json'), 'utf8'));

test('face models pin: both models have https url / sha256 / size / license; total stays small; stamp follows the hashes; broken entries refused', () => {
  const entries = faceModelEntries(facePin);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec_int8.onnx']);
  for (const e of entries) {
    assert.match(e.sha256, /^[0-9a-f]{64}$/, e.name);
    assert.ok(e.url.startsWith('https://'), e.name);
    assert.ok(Number.isInteger(e.size) && e.size > 0, e.name);
    assert.ok(['MIT', 'Apache-2.0'].includes(e.license), e.name);
    assert.match(e.license_sha256, /^[0-9a-f]{64}$/, e.name);
    assert.ok(e.license_url.startsWith('https://') && e.license_file.endsWith('.txt'), e.name);
  }
  assert.ok(entries.reduce((s, e) => s + e.size, 0) < 20 * 1024 * 1024, '默认模型合计要在几十 MB 以内');
  const stamp = faceModelsStamp(facePin);
  assert.ok(stamp.includes(entries[0].sha256));
  const changed = structuredClone(facePin);
  changed.models[entries[0].name].sha256 = 'b'.repeat(64);
  assert.notEqual(faceModelsStamp(changed), stamp);
  const broken = structuredClone(facePin);
  broken.models[entries[0].name].sha256 = 'TODO';
  assert.throws(() => faceModelEntries(broken), (e) => e instanceof PinError && e.code === 'pin_placeholder' && e.message.includes(entries[0].name));
  const noLicense = structuredClone(facePin);
  delete noLicense.models[entries[0].name].license_sha256;
  assert.throws(() => faceModelEntries(noLicense), (e) => e.code === 'pin_placeholder' && /许可/.test(e.message));
  assert.throws(() => faceModelEntries({ models: {} }), (e) => e.code === 'pin_invalid');
  assert.throws(() => faceModelEntries(null), (e) => e.code === 'pin_invalid');
  for (const [n, f] of Object.entries(facePin.fixtures)) {
    if (n.startsWith('_')) continue;
    assert.match(f.sha256, /^[0-9a-f]{64}$/, n);
    assert.ok(f.url.startsWith('https://raw.githubusercontent.com/'), n);
    assert.ok(Number.isInteger(f.size) && f.size > 0, n);
  }
});

test('verifyPinnedBuffer: size first, then sha256; mismatches throw PinError and nothing is returned', () => {
  const buf = Buffer.from('hello');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  assert.equal(verifyPinnedBuffer(buf, { sha256: sha.toUpperCase(), size: 5 }), buf);
  assert.equal(verifyPinnedBuffer(buf, { sha256: sha }), buf, 'size optional');
  assert.throws(() => verifyPinnedBuffer(buf, { sha256: sha, size: 6 }), (e) => e instanceof PinError && e.code === 'size_mismatch');
  assert.throws(() => verifyPinnedBuffer(buf, { sha256: 'a'.repeat(64), size: 5 }, 'yunet'), (e) => e.code === 'hash_mismatch' && /yunet/.test(e.message));
});

test('builderTarget / onnxRuntimePrune: keep only the target platform/arch of onnxruntime-node', () => {
  assert.deepEqual(builderTarget(['--win'], 'linux', 'x64'), { platform: 'win32', arch: 'x64' });
  assert.deepEqual(builderTarget(['--mac', '--arm64'], 'linux', 'x64'), { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(builderTarget(['--mac', '--x64'], 'darwin', 'arm64'), { platform: 'darwin', arch: 'x64' });
  assert.deepEqual(builderTarget(['--win', '--dir'], 'win32', 'x64'), { platform: 'win32', arch: 'x64' });
  assert.deepEqual(builderTarget([], 'darwin', 'arm64'), { platform: 'darwin', arch: 'arm64' });
  const entries = [
    { platform: 'win32', arch: 'x64' }, { platform: 'win32', arch: 'arm64' }, { platform: 'darwin', arch: 'arm64' },
    { platform: 'linux', arch: 'x64' }, { platform: 'linux', arch: 'arm64' },
  ];
  assert.deepEqual(onnxRuntimePrune(entries, { platform: 'win32', arch: 'x64' }), ['win32/arm64', 'darwin/arm64', 'linux/x64', 'linux/arm64']);
  assert.deepEqual(onnxRuntimePrune(entries, { platform: 'darwin', arch: 'arm64' }), ['win32/x64', 'win32/arm64', 'linux/x64', 'linux/arm64']);
  assert.deepEqual(onnxRuntimePrune(entries, { platform: 'darwin', arch: 'x64' }), entries.map((e) => `${e.platform}/${e.arch}`), 'target absent: everything pruned, pack-desktop warns');
  assert.deepEqual(onnxRuntimePrune([], { platform: 'win32', arch: 'x64' }), []);
});

test('extraResources ships resources/models; desktop package.json unpacks onnxruntime-node from the asar', () => {
  const mac = extraResources({ root: '/r', desktop: '/r/apps/desktop', platform: 'darwin' });
  assert.ok(mac.some((e) => e.to === 'models' && e.from.endsWith(path.join('resources', 'models'))));
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps', 'desktop', 'package.json'), 'utf8'));
  assert.ok(pkg.build.asarUnpack.includes('**/node_modules/onnxruntime-node/**'));
  assert.ok(pkg.build.extraResources.some((e) => e.to === 'models'));
});
