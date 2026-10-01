// 打包前取 ffmpeg：下载固定版本的 LGPL win64 构建，校验 SHA-256（固定在 scripts/ffmpeg-pin.json），
// 解出 ffmpeg.exe / ffprobe.exe 和许可文本到 apps/desktop/resources/ffmpeg，由 electron-builder 放进 <安装目录>/resources/lycore/ffmpeg，
// lycore 按 <exe 目录>/ffmpeg 自动找到。哈希不符直接失败，不写入任何文件。
// 用法：node scripts/fetch-ffmpeg.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'ffmpeg-pin.json'), 'utf8'));
const outDir = path.join(root, 'apps', 'desktop', 'resources', 'ffmpeg');
const stamp = path.join(outDir, '.pin');
const want = ['ffmpeg.exe', 'ffprobe.exe'];

if (!process.argv.includes('--force') && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === pin.sha256 && want.every((f) => fs.existsSync(path.join(outDir, f)))) {
  console.log(`ffmpeg ${pin.version} already present`);
  process.exit(0);
}

console.log(`downloading ${pin.url}`);
const res = await fetch(pin.url, { redirect: 'follow' });
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const got = crypto.createHash('sha256').update(buf).digest('hex');
if (got !== pin.sha256) throw new Error(`SHA-256 mismatch: expected ${pin.sha256}, got ${got}`);

const require = createRequire(path.join(root, 'packages', 'local', 'package.json'));
const AdmZip = require('adm-zip');
const zip = new AdmZip(buf);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
let n = 0;
for (const e of zip.getEntries()) {
  const base = path.basename(e.entryName);
  const inBin = /\/bin\/[^/]+$/.test(e.entryName);
  if (e.isDirectory) continue;
  if ((inBin && want.includes(base)) || /^[^/]+\/(LICENSE|COPYING)[^/]*$/i.test(e.entryName)) {
    fs.writeFileSync(path.join(outDir, base), e.getData());
    n++;
  }
}
if (!want.every((f) => fs.existsSync(path.join(outDir, f)))) throw new Error('zip does not contain ffmpeg.exe/ffprobe.exe');
fs.writeFileSync(stamp, pin.sha256);
console.log(`ok: ${n} files -> ${path.relative(root, outDir)}`);
