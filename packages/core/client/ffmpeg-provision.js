'use strict';
// ffmpeg 二进制供应：从可配置地址下载 LGPL 构建到应用数据目录，按固定清单校验 SHA-256，支持断点续传，不一致即拒绝。
// 无依赖（node:http/https/crypto/fs）。lycore 通过 LYCORE_FFMPEG_DIR（或请求参数 ffmpegDir）使用 provision() 返回的目录。
//
// 安全约束：
// - 校验值只来自随包的 ffmpeg-manifest.json，不信任服务器给的任何哈希；
// - 清单里是 TODO 占位或哈希格式不对 -> 未发网络请求就拒绝；
// - 仅允许 https（回环地址 127.0.0.1/localhost 除外，便于测试）；
// - 哈希不一致：删除下载内容，不落到最终文件名，抛 ProvisionError(code='sha256_mismatch')。
// 下载地址不含任何厂商凭据；默认值是占位域名（.invalid 必然解析失败），必须由配置或环境变量覆盖。

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

/** 占位默认值；真实地址通过选项 baseUrl 或环境变量 LYCORE_FFMPEG_BASE_URL 配置。 */
const DEFAULT_BASE_URL = 'https://example.invalid/talekiln/ffmpeg/';
const MANIFEST_PATH = path.join(__dirname, '..', 'ffmpeg-manifest.json');

class ProvisionError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'ProvisionError';
    this.code = code; // manifest_placeholder | unsupported_platform | http_error | size_mismatch | sha256_mismatch | insecure_url | too_many_redirects
    Object.assign(this, extra);
  }
}

function loadManifest(file = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);

/** 取某平台的构建条目；占位/无效则抛错（在任何网络请求之前）。 */
function resolveBuild(manifest, key = platformKey()) {
  const build = manifest.builds && manifest.builds[key];
  if (!build) throw new ProvisionError('unsupported_platform', `清单中没有平台 ${key} 的构建`);
  if (!build.files || !build.files.length) throw new ProvisionError('unsupported_platform', `平台 ${key} 的文件列表为空`);
  for (const f of build.files) {
    if (!isHex64(f.sha256) || /TODO/i.test(String(manifest.version))) {
      throw new ProvisionError('manifest_placeholder', `ffmpeg 清单仍是占位内容（${f.name}），拒绝下载；请先填入真实版本与 sha256`);
    }
    if (path.basename(f.name) !== f.name) throw new ProvisionError('manifest_placeholder', `非法文件名：${f.name}`);
  }
  return build;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function isLoopback(u) {
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
}

/** 单次 GET（跟随重定向），resolve 响应流。 */
function request(urlStr, headers, redirects = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new ProvisionError('insecure_url', `无效地址：${urlStr}`)); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u))) {
      return reject(new ProvisionError('insecure_url', `只允许 https 下载：${u.origin}`));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new ProvisionError('too_many_redirects', '重定向过多'));
        return resolve(request(new URL(res.headers.location, u).toString(), headers, redirects - 1));
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

/** 下载一个文件到 dest（经 dest.part 续传），校验后原子改名。返回 {path, resumedFrom, skipped}。 */
async function downloadFile(url, dest, { sha256, size, onProgress } = {}) {
  const want = sha256.toLowerCase();
  if (fs.existsSync(dest) && (await sha256File(dest)) === want) return { path: dest, resumedFrom: 0, skipped: true };

  const part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  let resumedFrom = have;

  if (!(size && have >= size)) {
    const res = await request(url, have > 0 ? { Range: `bytes=${have}-` } : {});
    if (res.statusCode === 206) {
      // 续传：追加
    } else if (res.statusCode === 200) {
      have = 0; resumedFrom = 0; // 服务器不支持 Range，整体重下
    } else if (res.statusCode === 416 && have > 0) {
      res.resume(); // 已有数据可能已完整，直接校验
    } else {
      res.resume();
      throw new ProvisionError('http_error', `下载失败：HTTP ${res.statusCode} ${url}`, { status: res.statusCode });
    }
    if (res.statusCode === 200 || res.statusCode === 206) {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
        let got = have;
        res.on('data', (d) => { got += d.length; if (onProgress) onProgress({ received: got, total: size || null }); });
        res.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        res.on('aborted', () => reject(new Error('connection aborted')));
        res.pipe(out);
      });
    }
  }

  const actualSize = fs.statSync(part).size;
  if (size && actualSize !== size) {
    // 大小不符：不到哈希就知道不对。过小可能是中断，保留以便续传；过大说明数据坏了，删除。
    if (actualSize > size) fs.rmSync(part, { force: true });
    throw new ProvisionError('size_mismatch', `大小不符：期望 ${size}，实际 ${actualSize}`, { expected: size, actual: actualSize });
  }
  const got = await sha256File(part);
  if (got !== want) {
    fs.rmSync(part, { force: true }); // 拒绝：不保留可疑内容，下次从头开始
    throw new ProvisionError('sha256_mismatch', `SHA-256 校验失败：${path.basename(dest)} 期望 ${want} 实际 ${got}`, { expected: want, actual: got });
  }
  fs.renameSync(part, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  return { path: dest, resumedFrom, skipped: false };
}

/**
 * 供应当前平台的 ffmpeg/ffprobe。
 * @param {object} o
 * @param {string} o.appDataDir 应用数据目录（Electron 的 app.getPath('userData')）；文件落在 <appDataDir>/ffmpeg/<版本>/
 * @param {string} [o.baseUrl] 默认取环境变量 LYCORE_FFMPEG_BASE_URL，再取占位默认值
 * @param {object} [o.manifest] 默认读取随包清单
 * @param {string} [o.platform] 默认 `${process.platform}-${process.arch}`
 * @returns {Promise<{dir:string, files:string[]}>} dir 可直接作为 LYCORE_FFMPEG_DIR
 */
async function provision(o) {
  const manifest = o.manifest || loadManifest();
  const build = resolveBuild(manifest, o.platform);
  const baseUrl = o.baseUrl || process.env.LYCORE_FFMPEG_BASE_URL || DEFAULT_BASE_URL;
  const dir = path.join(o.appDataDir, 'ffmpeg', String(manifest.version));
  const files = [];
  for (const f of build.files) {
    const url = new URL(f.path, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').toString();
    const r = await downloadFile(url, path.join(dir, f.name), {
      sha256: f.sha256, size: f.size || undefined, onProgress: o.onProgress && ((p) => o.onProgress({ file: f.name, ...p })),
    });
    files.push(r.path);
  }
  return { dir, files };
}

module.exports = { provision, downloadFile, resolveBuild, loadManifest, sha256File, ProvisionError, DEFAULT_BASE_URL, MANIFEST_PATH };
