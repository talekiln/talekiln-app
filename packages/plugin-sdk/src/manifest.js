'use strict';
const { SDK_VERSION, CAPABILITIES } = require('./constants');

const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// network:<hostname> or network:*.<domain>; never a bare wildcard, never a scheme/port/path.
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PERMISSIONS = Object.freeze(['secret:apiKey']);
const ENTRY_RE = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|cjs)$/;

const parse = (v) => String(v).split(/[-+]/)[0].split('.').map(Number);

/** @returns {{ok: boolean, errors: string[], manifest: object|null}} */
function validateManifest(input) {
  const errors = [];
  const m = input;
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, errors: ['manifest must be an object'], manifest: null };
  }
  const known = ['name', 'version', 'sdkVersion', 'capabilities', 'permissions', 'entry', 'label', 'description', 'homepage'];
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

module.exports = { validateManifest, allowedHosts, hostAllowed };
