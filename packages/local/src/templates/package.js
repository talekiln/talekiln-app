'use strict';
/**
 * 读取模板包：目录（含 manifest.json）或 zip 压缩包（*.lytpl / *.zip，manifest.json 在根目录或唯一的一级子目录）。
 * 只读清单，不解压其它文件（封面等资源以 URL 形式写在清单里）。
 */
const fs = require('fs');
const path = require('path');
const { TemplateError } = require('./errors');

const MANIFEST = 'manifest.json';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const ZIP_EXT = new Set(['.lytpl', '.zip']);

const invalid = (message, details) => new TemplateError('TEMPLATE_PACKAGE_INVALID', message, 400, details);

function parseManifest(text, where) {
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw invalid(`${where} 超过 2MB`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw invalid(`${where} 不是合法的 JSON：${e.message}`);
  }
}

function fromDirectory(dir) {
  const file = path.join(dir, MANIFEST);
  if (!fs.existsSync(file)) throw invalid(`目录里没有 ${MANIFEST}`);
  return { manifest: parseManifest(fs.readFileSync(file, 'utf8'), MANIFEST), kind: 'dir', root: dir };
}

function fromZip(file) {
  let AdmZip;
  try { AdmZip = require('adm-zip'); } catch (_) { throw invalid('当前环境不支持读取压缩包'); }
  let zip;
  try { zip = new AdmZip(file); } catch (e) { throw invalid(`无法读取压缩包：${e.message}`); }
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const norm = (n) => String(n).replace(/\\/g, '/').replace(/^\.\//, '');
  let hit = entries.find((e) => norm(e.entryName) === MANIFEST);
  if (!hit) {
    const nested = entries.filter((e) => /^[^/]+\/manifest\.json$/.test(norm(e.entryName)));
    if (nested.length === 1) hit = nested[0];
    else if (nested.length > 1) throw invalid('压缩包里有多个 manifest.json');
  }
  if (!hit) throw invalid(`压缩包里没有 ${MANIFEST}`);
  if (hit.header && hit.header.size > MAX_MANIFEST_BYTES) throw invalid(`${MANIFEST} 超过 2MB`);
  return { manifest: parseManifest(hit.getData().toString('utf8'), MANIFEST), kind: 'zip', root: file };
}

/** 从路径读取模板包的清单（未校验）。 */
function loadPackage(p) {
  if (typeof p !== 'string' || !p.trim()) throw invalid('缺少模板包路径');
  const abs = path.resolve(p);
  let st;
  try { st = fs.statSync(abs); } catch (_) { throw invalid(`路径不存在：${p}`); }
  if (st.isDirectory()) return fromDirectory(abs);
  if (!st.isFile()) throw invalid('路径既不是目录也不是文件');
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.json' && path.basename(abs) === MANIFEST) return fromDirectory(path.dirname(abs));
  if (!ZIP_EXT.has(ext)) throw invalid('模板包须为目录、manifest.json 或 .lytpl / .zip 压缩包');
  return fromZip(abs);
}

module.exports = { loadPackage, MANIFEST };
