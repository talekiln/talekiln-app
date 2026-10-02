// 打包前取 ffmpeg：下载固定版本的 LGPL 构建，校验 SHA-256（固定在 scripts/ffmpeg-pin.json 的当前平台条目），
// 解出 ffmpeg / ffprobe（Windows 带 .exe）和许可文本到 apps/desktop/resources/ffmpeg，由 electron-builder 放进
// <安装目录>/resources/lycore/ffmpeg，lycore 按 <exe 目录>/ffmpeg 自动找到。哈希不符直接失败，不写入任何文件。
// 当前平台条目仍是 TODO 占位时：不发任何网络请求，报错退出（退出码 3），不编造哈希。
// 用法：node scripts/fetch-ffmpeg.mjs [--force] [--platform win32-x64|darwin-arm64|darwin-x64]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { platformKey, ffmpegTools, selectPin, classifyEntry, fileMode, PinError } from './platform-lib.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pinFile = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'ffmpeg-pin.json'), 'utf8'));
const outDir = path.join(root, 'apps', 'desktop', 'resources', 'ffmpeg');
const stamp = path.join(outDir, '.pin');

const argPlatform = process.argv.includes('--platform') ? process.argv[process.argv.indexOf('--platform') + 1] : null;
const key = argPlatform || platformKey();
const targetPlatform = key.split('-')[0];
const want = ffmpegTools(targetPlatform);

let pin;
try {
  pin = selectPin(pinFile, key);
} catch (e) {
  if (e instanceof PinError) {
    console.error(`ffmpeg: ${e.message}`);
    process.exit(3);
  }
  throw e;
}

if (!process.argv.includes('--force') && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === pin.sha256 && want.every((f) => fs.existsSync(path.join(outDir, f)))) {
  console.log(`ffmpeg ${pin.version} (${key}) already present`);
  process.exit(0);
}

console.log(`downloading ${pin.url}`);
const res = await fetch(pin.url, { redirect: 'follow' });
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const got = crypto.createHash('sha256').update(buf).digest('hex');
if (got !== pin.sha256.toLowerCase()) throw new Error(`SHA-256 mismatch: expected ${pin.sha256}, got ${got}`);

const require = createRequire(path.join(root, 'packages', 'local', 'package.json'));
const AdmZip = require('adm-zip');
const zip = new AdmZip(buf);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
let n = 0;
for (const e of zip.getEntries()) {
  if (e.isDirectory) continue;
  const kind = classifyEntry(e.entryName, want, pin.layout || 'btbn');
  if (!kind) continue;
  // 只取 basename 写入：不会因 zip 条目里的 ../ 写到目录之外
  fs.writeFileSync(path.join(outDir, path.basename(e.entryName)), e.getData(), { mode: fileMode(kind, targetPlatform) });
  n++;
}
if (!want.every((f) => fs.existsSync(path.join(outDir, f)))) throw new Error(`zip does not contain ${want.join('/')}`);
fs.writeFileSync(stamp, pin.sha256);
console.log(`ok: ${n} files -> ${path.relative(root, outDir)}`);
