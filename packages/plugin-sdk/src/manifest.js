'use strict';
const { SDK_VERSION, CAPABILITIES } = require('./constants');

const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// network:<hostname> or network:*.<domain>; never a bare wildcard, never a scheme/port/path.
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PERMISSIONS = Object.freeze(['secret:apiKey']);
const ENTRY_RE = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|cjs)$/;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]{20,}$/;

const parse = (v) => String(v).split(/[-+]/)[0].split('.').map(Number);

/**
 * A path that stays inside the plugin folder: relative, forward slashes, no empty / `.` / `..` segments,
 * no drive letter, no control characters. Used for `files` (signed set) and by the signing helpers.
 */
function safeRelativePath(p) {
  if (typeof p !== 'string' || !p || p.length > 512 || /[\0-\x1f\\]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** @returns {{ok: boolean, errors: string[], manifest: object|null}} */
function validateManifest(input) {
  const errors = [];
  const m = input;
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, errors: ['manifest must be an object'], manifest: null };
  }
  const known = ['name', 'version', 'sdkVersion', 'capabilities', 'permissions', 'entry', 'label', 'description', 'homepage', 'files', 'signature'];
  for (const k of Object.keys(m)) if (!known.includes(k)) errors.push(`unknown field: ${k}`);

  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) errors.push('name must match ^[a-z][a-z0-9-]{1,39}$');
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) errors.push('version must be semver (x.y.z)');

  if (typeof m.sdkVersion !== 'string' || !SEMVER_RE.test(m.sdkVersion)) {
    errors.push('sdkVersion must be semver (x.y.z)');
  } else {
    const [pM, pm] = parse(m.sdkVersion);
    const [hM, hm] = parse(SDK_VERSION);
    if (pM !== hM) errors.push(`sdkVersion major ${pM} is not supported (host SDK ${SDK_VERSION})`);
    else if (pm > hm) errors.push(`sdkVersion ${m.sdkVersion} is newer than host SDK ${SDK_VERSION}`);
  }

  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) {
    errors.push('capabilities must be a non-empty array');
  } else {
    const seen = new Set();
    for (const c of m.capabilities) {
      if (!CAPABILITIES.includes(c)) errors.push(`unknown capability: ${String(c)}`);
      else if (seen.has(c)) errors.push(`duplicate capability: ${c}`);
      seen.add(c);
    }
    if (seen.has('video.submit') !== seen.has('video.poll')) errors.push('video.submit and video.poll must be declared together');
    if (seen.has('video.edit') && !seen.has('video.poll')) errors.push('video.edit requires video.poll (its task is polled the same way)');
  }

  if (!Array.isArray(m.permissions)) {
    errors.push('permissions must be an array');
  } else {
    let hasNet = false;
    for (const p of m.permissions) {
      if (typeof p !== 'string') { errors.push('permission must be a string'); continue; }
      if (p.startsWith('network:')) {
        hasNet = true;
        if (!HOST_RE.test(p.slice(8))) errors.push(`invalid network permission: ${p} (hostname or *.domain, no scheme/port/path)`);
      } else if (!PERMISSIONS.includes(p)) errors.push(`unknown permission: ${p}`);
    }
    if (!hasNet) errors.push('permissions must include at least one network:<host>');
  }

  if (typeof m.entry !== 'string' || !ENTRY_RE.test(m.entry) || m.entry.split('/').includes('..')) {
    errors.push('entry must be a relative .js/.cjs path inside the plugin folder (no .. or absolute path)');
  }
  for (const k of ['label', 'description', 'homepage']) {
    if (m[k] !== undefined && typeof m[k] !== 'string') errors.push(`${k} must be a string`);
  }
  // Signing (optional): `files` = relative paths covered by the signature; `signature` = ES256 over manifest + file hashes.
  if (m.files !== undefined) {
    if (!Array.isArray(m.files)) errors.push('files must be an array of relative paths');
    else {
      const seen = new Set();
      for (const f of m.files) {
        if (!safeRelativePath(f)) errors.push(`invalid file path: ${String(f)} (relative, inside the plugin folder)`);
        else if (seen.has(f)) errors.push(`duplicate file: ${f}`);
        seen.add(f);
      }
    }
  }
  if (m.signature !== undefined) {
    const s = m.signature;
    if (!s || typeof s !== 'object' || Array.isArray(s)) errors.push('signature must be an object {alg, kid, value}');
    else {
      if (s.alg !== 'ES256') errors.push('signature.alg must be ES256');
      if (typeof s.kid !== 'string' || !KID_RE.test(s.kid)) errors.push('signature.kid must be a short key id');
      if (typeof s.value !== 'string' || !B64URL_RE.test(s.value)) errors.push('signature.value must be base64url');
      for (const k of Object.keys(s)) if (!['alg', 'kid', 'value'].includes(k)) errors.push(`unknown signature field: ${k}`);
      if (!Array.isArray(m.files)) errors.push('a signed manifest must list its files');
    }
  }
  return { ok: errors.length === 0, errors, manifest: errors.length ? null : Object.freeze({ ...m }) };
}

/** Allowed host patterns from `network:` permissions. */
function allowedHosts(manifest) {
  return (manifest.permissions || []).filter((p) => p.startsWith('network:')).map((p) => p.slice(8));
}

function hostAllowed(hostname, patterns) {
  const h = String(hostname).toLowerCase();
  return patterns.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p));
}

module.exports = { validateManifest, allowedHosts, hostAllowed, safeRelativePath };
