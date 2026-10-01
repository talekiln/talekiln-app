'use strict';
/** ES256 紧凑 JWS 校验（许可证与目录签名共用），只依赖 node:crypto。 */
const crypto = require('crypto');

function decodePart(s) {
  return Buffer.from(s, 'base64url');
}

/** 校验签名，返回 { header, payload(Buffer) }；任何问题抛 Error。 */
function verifyEs256(token, jwk) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !parts[2]) throw new Error('malformed jws');
  const header = JSON.parse(decodePart(parts[0]).toString('utf8'));
  if (header.alg !== 'ES256') throw new Error('unsupported alg');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, decodePart(parts[2]));
  if (!ok) throw new Error('bad signature');
  return { header, payload: decodePart(parts[1]) };
}

function peekHeader(token) {
  try { return JSON.parse(decodePart(String(token).split('.')[0]).toString('utf8')); } catch (_) { return null; }
}

function findKey(jwks, kid) {
  const keys = (jwks && Array.isArray(jwks.keys)) ? jwks.keys : [];
  return keys.find((k) => k && k.kid === kid) || null;
}

/** 与云端 catalog.service.ts 的 canonicalJson 保持一致：键排序、跳过 undefined。 */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function catalogVersion(data) {
  return 'c-' + crypto.createHash('sha256').update(canonicalJson(data)).digest('hex').slice(0, 16);
}

module.exports = { verifyEs256, peekHeader, findKey, canonicalJson, catalogVersion };
