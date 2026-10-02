// 打包 / 测试前取人脸模型：按 scripts/face-models-pin.json 的固定条目下载 YuNet（检测，MIT）与 SFace int8（识别，Apache-2.0）
// 的 ONNX 文件及其许可文本，校验 SHA-256 与大小后才写入 apps/desktop/resources/models/face（git 忽略；electron-builder 放进
// <安装目录>/resources/models/face，本机服务按 TALEKILN_MODELS_DIR > 配置 consistency.face.models_dir > 该目录 > 开发目录找到）。
// 哈希或大小不符直接失败，不写入任何文件；文件齐全且 .pin 戳记与清单一致时跳过（--force 重下）。
// 用法：node scripts/fetch-face-models.mjs [--force] [--out <目录>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { faceModelEntries, faceModelsStamp, verifyPinnedBuffer, PinError } from './platform-lib.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'face-models-pin.json'), 'utf8'));
const argv = process.argv.slice(2);
const outDir = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]) : path.join(root, 'apps', 'desktop', 'resources', 'models', 'face');
const force = argv.includes('--force');
const stampFile = path.join(outDir, '.pin');

let entries;
try {
  entries = faceModelEntries(pin);
} catch (e) {
  if (e instanceof PinError) { console.error(`face models: ${e.message}`); process.exit(3); }
  throw e;
}
const stamp = faceModelsStamp(pin);
const present = () => entries.every((e) => fs.existsSync(path.join(outDir, e.name)) && fs.existsSync(path.join(outDir, e.license_file)));
if (!force && present() && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp) {
  console.log(`face models already present in ${path.relative(root, outDir) || outDir}`);
  process.exit(0);
}

/** 下载并校验；LFS 媒体偶尔断流，最多试 3 次。只有通过校验的内容才返回。 */
async function fetchPinned(url, want) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return verifyPinnedBuffer(Buffer.from(await res.arrayBuffer()), want, url);
    } catch (e) {
      lastErr = e;
      if (e instanceof PinError) throw e; // 哈希 / 大小不符不是网络问题，重试无意义
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(stampFile, { force: true });
for (const e of entries) {
  console.log(`downloading ${e.url}`);
  const model = await fetchPinned(e.url, { sha256: e.sha256, size: e.size });
  const license = await fetchPinned(e.license_url, { sha256: e.license_sha256 });
  // 先写临时名再改名：中途失败不会留下半个模型文件
  const tmp = path.join(outDir, `${e.name}.part`);
  fs.writeFileSync(tmp, model);
  fs.renameSync(tmp, path.join(outDir, e.name));
  fs.writeFileSync(path.join(outDir, e.license_file), license);
  console.log(`ok: ${e.name} (${e.license}, ${(e.size / 1024 / 1024).toFixed(1)} MB)`);
}
fs.writeFileSync(stampFile, stamp);
console.log(`ok: ${entries.length} models -> ${path.relative(root, outDir) || outDir}`);
