'use strict';
/**
 * Plugin package signing and verification. node:crypto only; no host dependency.
 *
 * What is signed: canonicalJson({ manifest: <manifest without `signature`>, files: { "<rel path>": "<sha256 hex>" } })
 *   - `manifest.files` lists every relative path the signature covers; the entry file must be among them.
 *   - canonicalJson = keys sorted, undefined skipped (identical to the host's catalogue canonicalisation).
 * How: ES256 (P-256 + SHA-256, IEEE P1363 `r||s`) over the UTF-8 payload, base64url, tagged with the signer's `kid`.
 *   The host resolves `kid` against the official JWKS (the same keys that sign the cloud catalogue and licences).
 * Result statuses: 'official' (valid under a known key), 'unsigned' (no signature field), 'invalid' (anything else:
 *   malformed, unknown kid, tampered manifest or file, missing or unlisted file).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { safeRelativePath } = require('./manifest');

const SIGNATURE_STATUSES = Object.freeze(['official', 'unsigned', 'invalid']);
const MANIFEST_FILE = 'manifest.json';

function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Every regular file below `dir` (sorted, forward slashes), except the root manifest.json.
 * Symbolic links are reported separately: a signed package must not contain any.
 */
function listPluginFiles(dir) {
  const files = [];
  const symlinks = [];
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) symlinks.push(r);
      else if (ent.isDirectory()) walk(r);
      else if (ent.isFile() && r !== MANIFEST_FILE) files.push(r);
    }
  };
  walk('');
  files.sort();
  symlinks.sort();
  return { files, symlinks };
}

/** sha256 of each listed file. Throws `missing file: <rel>` when one is absent or not a regular file. */
function hashFiles(dir, files) {
  const out = {};
  for (const rel of files) {
    if (!safeRelativePath(rel)) throw new Error(`unsafe path: ${rel}`);
    const abs = path.join(dir, ...rel.split('/'));
    let st;
    try { st = fs.lstatSync(abs); } catch (_) { st = null; }
    if (!st || !st.isFile()) throw new Error(`missing file: ${rel}`);
    out[rel] = sha256Hex(fs.readFileSync(abs));
  }
  return out;
}

function withoutSignature(manifest) {
  const m = { ...manifest };
  delete m.signature;
  return m;
}

/** The exact string that is signed. `hashes` = result of hashFiles for manifest.files. */
function signingPayload(manifest, hashes) {
  return canonicalJson({ manifest: withoutSignature(manifest), files: hashes });
}

/** Display fingerprint of a signed (or to-be-signed) package: sha256 of the signing payload. */
const payloadHash = (payload) => sha256Hex(Buffer.from(payload, 'utf8'));

function toPrivateKey(key) {
  const k = crypto.KeyObject && key instanceof crypto.KeyObject ? key : crypto.createPrivateKey(key);
  if (k.type !== 'private') throw new Error('a private key is required');
  const d = k.asymmetricKeyDetails || {};
  if (k.asymmetricKeyType !== 'ec' || d.namedCurve !== 'prime256v1') throw new Error('signing key must be EC P-256 (ES256)');
  return k;
}

function toPublicKey(k) {
  if (!k) return null;
  if (crypto.KeyObject && k instanceof crypto.KeyObject) return k.type === 'public' ? k : crypto.createPublicKey(k);
  if (typeof k === 'object' && typeof k.kty === 'string') return crypto.createPublicKey({ key: k, format: 'jwk' });
  if (typeof k === 'string') return crypto.createPublicKey(k);
  return null;
}

/**
 * keys: a JWKS `{keys:[...]}`, an array of JWKs, one JWK (with or without kid), a public KeyObject / PEM,
 * or a function `(kid) => JWK | KeyObject | PEM | null`.
 */
function resolveKey(keys, kid) {
  if (typeof keys === 'function') return toPublicKey(keys(kid));
  if (!keys) return null;
  const list = Array.isArray(keys) ? keys : Array.isArray(keys.keys) ? keys.keys : null;
  if (list) return toPublicKey(list.find((k) => k && k.kid === kid) || null);
  if (typeof keys === 'object' && typeof keys.kty === 'string') return keys.kid && keys.kid !== kid ? null : toPublicKey(keys);
  return toPublicKey(keys);
}

/**
 * Sign a plugin folder. Returns { manifest, hash, files }: the manifest to write back (with `files` and `signature`).
 * @param {object} manifest the (unsigned or previously signed) manifest
 * @param {string} dir plugin folder
 * @param {import('node:crypto').KeyObject|string} privateKey EC P-256 private key (KeyObject or PKCS8 PEM)
 * @param {{kid: string, files?: string[]}} opts kid is required; files defaults to manifest.files or every file in the folder
 */
function signManifest(manifest, dir, privateKey, opts = {}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest must be an object');
  const kid = opts.kid;
  if (typeof kid !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(kid)) throw new Error('kid is required (letters, digits, . _ -)');
  const key = toPrivateKey(privateKey);
  let files = opts.files || manifest.files;
  if (!files) {
    const listed = listPluginFiles(dir);
    if (listed.symlinks.length) throw new Error(`symbolic links are not allowed in a signed plugin: ${listed.symlinks[0]}`);
    files = listed.files;
  }
  files = [...new Set(files)].sort();
  if (typeof manifest.entry !== 'string' || !files.includes(manifest.entry)) throw new Error('files must include the entry file');
  const base = { ...withoutSignature(manifest), files };
  const hashes = hashFiles(dir, files);
  const payload = signingPayload(base, hashes);
  const value = crypto.sign('sha256', Buffer.from(payload, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { manifest: { ...base, signature: { alg: 'ES256', kid, value } }, hash: payloadHash(payload), files };
}

const invalid = (reason, extra = {}) => ({ ok: false, status: 'invalid', reason, kid: null, hash: null, files: [], ...extra });

/**
 * Verify a plugin folder against its manifest's signature.
 * @param {object} manifest manifest.json contents (validated or raw)
 * @param {string} dir plugin folder on disk
 * @param {*} keys see resolveKey
 * @param {{strict?: boolean}} [opts] strict (default true): every file in the folder must be covered, no symlinks
 * @returns {{ok: boolean, status: 'official'|'unsigned'|'invalid', reason: string|null, kid: string|null, hash: string|null, files: string[]}}
 */
function verifySignature(manifest, dir, keys, opts = {}) {
  const strict = opts.strict !== false;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return invalid('manifest must be an object');
  const sig = manifest.signature;
  if (sig === undefined || sig === null) {
    // Unsigned: still fingerprint the folder (over the manifest with its file list, exactly what signing would
    // cover) so the UI can show what is installed and the value stays the same once the package gets signed.
    let hash = null;
    try {
      const files = [...new Set(Array.isArray(manifest.files) ? manifest.files : listPluginFiles(dir).files)].sort();
      hash = payloadHash(signingPayload({ ...manifest, files }, hashFiles(dir, files)));
    } catch (_) { /* unreadable folder or bad file list */ }
    return { ok: false, status: 'unsigned', reason: 'no signature', kid: null, hash, files: [] };
  }
  if (!sig || typeof sig !== 'object' || sig.alg !== 'ES256' || typeof sig.kid !== 'string' || !sig.kid || typeof sig.value !== 'string' || !sig.value) {
    return invalid('malformed signature');
  }
  const files = manifest.files;
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string' && safeRelativePath(f))) return invalid('malformed files list', { kid: sig.kid });
  if (typeof manifest.entry !== 'string' || !files.includes(manifest.entry)) return invalid('entry not covered by signature', { kid: sig.kid });
  let hashes;
  try { hashes = hashFiles(dir, files); } catch (e) { return invalid(e.message, { kid: sig.kid }); }
  if (strict) {
    const listed = listPluginFiles(dir);
    if (listed.symlinks.length) return invalid(`symbolic link not allowed: ${listed.symlinks[0]}`, { kid: sig.kid });
    const extra = listed.files.find((f) => !files.includes(f));
    if (extra) return invalid(`unlisted file: ${extra}`, { kid: sig.kid });
  }
  const payload = signingPayload(manifest, hashes);
  const hash = payloadHash(payload);
  let key;
  try { key = resolveKey(keys, sig.kid); } catch (_) { key = null; }
  if (!key) return invalid('unknown kid', { kid: sig.kid, hash });
  let ok = false;
  try {
    ok = crypto.verify('sha256', Buffer.from(payload, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig.value, 'base64url'));
  } catch (_) { ok = false; }
  if (!ok) return invalid('bad signature', { kid: sig.kid, hash });
  return { ok: true, status: 'official', reason: null, kid: sig.kid, hash, files: [...files] };
}

module.exports = {
  SIGNATURE_STATUSES, canonicalJson, listPluginFiles, hashFiles, signingPayload, payloadHash, signManifest, verifySignature, resolveKey,
};
