'use strict';
/**
 * P3-S 工作室共享库：对象键布局与清单（manifest.json）的纯函数。不碰数据库、不联网。
 *
 * 桶内布局（与云备份同一个桶、同一个 <prefix>，docs/phase3-backup.md §2 预留的 shared/）：
 *   <prefix>/shared/<studio_id>/characters/<shared_id>/manifest.json
 *   <prefix>/shared/<studio_id>/characters/<shared_id>/files/<role>-<sha256 前 12 位>.<ext>
 *   <prefix>/shared/<studio_id>/templates/<template_id>/manifest.json
 *   <prefix>/shared/<studio_id>/templates/<template_id>/template.json      模板包清单（与 .lytpl 里的 manifest.json 同格式）
 *
 * 清单：{ schema, kind, id, studio_id, version, name, fields, files[{ role, name, key, sha256, size, content_type }], author, source, updated_at, sha256 }
 * 其中 sha256 = sha256(canonicalJson(清单去掉 sha256 字段))；每个文件的 sha256 是文件内容的哈希，拉取时逐个核对。
 */
const crypto = require('crypto');
const path = require('path');
const { canonicalJson } = require('../cloud/jws');

const SCHEMAS = Object.freeze({ character: 'talekiln.shared.character/1', template: 'talekiln.shared.template/1' });
const KINDS = Object.freeze(['character', 'template']);
const FOLDER = Object.freeze({ character: 'characters', template: 'templates' });
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const STUDIO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** 角色图片的角色（role）：主图、四视图、锁定参考图、额外图。 */
const FILE_ROLES = Object.freeze(['main', 'four_view', 'locked_reference', 'extra']);
const CONTENT_TYPES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json' });
/** 角色表里随清单一起共享的文字字段。 */
const CHARACTER_FIELDS = Object.freeze([
  'name', 'role', 'description', 'personality', 'appearance', 'voice_style', 'polished_prompt', 'negative_prompt',
  'identity_anchors', 'style_tokens', 'color_palette', 'stages',
]);

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

function contentTypeOf(name) {
  return CONTENT_TYPES[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream';
}

/** 新共享 id：角色用 c- 开头的随机串（同一个本机角色重复发布沿用原 id，由服务层查表决定）。 */
function newSharedId(kind, bytes = crypto.randomBytes(8)) {
  return `${kind === 'template' ? 't' : 'c'}-${bytes.toString('hex')}`;
}

/** 对象键。prefix 为云备份设置里的前缀（已去首尾斜杠）。 */
function keysFor(prefix, studioId, kind, sharedId) {
  if (!KINDS.includes(kind)) throw new Error(`bad kind: ${kind}`);
  if (!STUDIO_ID_RE.test(String(studioId))) throw new Error('bad studio id');
  if (!ID_RE.test(String(sharedId))) throw new Error('bad shared id');
  const base = `${prefix ? prefix + '/' : ''}shared/${studioId}/${FOLDER[kind]}/${sharedId}`;
  return {
    base,
    manifest: `${base}/manifest.json`,
    file: (name) => `${base}/files/${name}`,
    template: `${base}/template.json`,
  };
}

/** 列举前缀：<prefix>/shared/<studio_id>/<characters|templates>/ */
function listPrefix(prefix, studioId, kind) {
  if (!KINDS.includes(kind)) throw new Error(`bad kind: ${kind}`);
  if (!STUDIO_ID_RE.test(String(studioId))) throw new Error('bad studio id');
  return `${prefix ? prefix + '/' : ''}shared/${studioId}/${FOLDER[kind]}/`;
}

/** 从 manifest.json 的键还原 { studio_id, kind, shared_id }；不是清单键返回 null。 */
function parseManifestKey(key, prefix) {
  const head = prefix ? prefix + '/' : '';
  if (!String(key).startsWith(head)) return null;
  const m = /^shared\/([A-Za-z0-9-]+)\/(characters|templates)\/([A-Za-z0-9._-]+)\/manifest\.json$/.exec(String(key).slice(head.length));
  if (!m) return null;
  return { studio_id: m[1], kind: m[2] === 'characters' ? 'character' : 'template', shared_id: m[3] };
}

/** 文件在桶里的名字：<role>-<sha256 前 12 位><原扩展名>（同内容同名，重复发布不会堆垃圾）。 */
function fileNameFor(role, sha256, originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
  return `${role}-${String(sha256).slice(0, 12)}${ext}`;
}

/** 清单摘要：去掉 sha256 后的 canonicalJson 哈希。 */
function manifestDigest(m) {
  const { sha256, ...rest } = m || {};
  return sha256Hex(canonicalJson(rest));
}

/** 把摘要写进清单（返回新对象）。 */
function sealManifest(m) {
  const { sha256, ...rest } = m || {};
  return { ...rest, sha256: manifestDigest(rest) };
}

/**
 * 组装角色清单。files: [{ role, name, key, sha256, size, content_type }]。
 */
function buildCharacterManifest({ studioId, sharedId, version, character, files, author, sourceCharacterId, now }) {
  const fields = {};
  for (const k of CHARACTER_FIELDS) if (character && character[k] != null && character[k] !== '') fields[k] = character[k];
  return sealManifest({
    schema: SCHEMAS.character, kind: 'character', id: sharedId, studio_id: String(studioId), version: Number(version) || 1,
    name: (character && character.name) || '', fields, files: files.map(normalizeFile),
    author: normalizeAuthor(author), source: { character_id: sourceCharacterId != null ? Number(sourceCharacterId) : null },
    updated_at: (now || new Date()).toISOString(),
  });
}

/** 组装模板清单：模板包清单本身作为 template.json 单独存放，这里只记它的哈希与版本。 */
function buildTemplateManifest({ studioId, templateManifest, version, templateFile, author, now }) {
  return sealManifest({
    schema: SCHEMAS.template, kind: 'template', id: String(templateManifest.id), studio_id: String(studioId), version: Number(version) || 1,
    name: templateManifest.name || '', fields: { template_version: templateManifest.version, genre: templateManifest.genre || null, tier: templateManifest.tier || null, description: templateManifest.description || '' },
    files: [normalizeFile({ role: 'template', ...templateFile })],
    author: normalizeAuthor(author), source: { template_id: String(templateManifest.id) },
    updated_at: (now || new Date()).toISOString(),
  });
}

function normalizeFile(f) {
  return { role: String(f.role), name: String(f.name), key: String(f.key), sha256: String(f.sha256), size: Number(f.size) || 0, content_type: f.content_type || contentTypeOf(f.name) };
}

function normalizeAuthor(a) {
  const o = a && typeof a === 'object' ? a : {};
  return { account_id: o.account_id ? String(o.account_id) : null, email: o.email ? String(o.email) : null };
}

/**
 * 校验从桶里读回来的清单：结构、kind、摘要一致。返回 { ok, errors[] }。
 */
function validateManifest(m, { kind, studioId, sharedId } = {}) {
  const errors = [];
  const err = (p, msg) => errors.push({ path: p, message: msg });
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: [{ path: '', message: '清单必须是 JSON 对象' }] };
  if (!KINDS.includes(m.kind)) err('kind', 'kind 须为 character 或 template');
  else if (m.schema !== SCHEMAS[m.kind]) err('schema', `不认识的 schema：${m.schema}`);
  if (kind && m.kind !== kind) err('kind', `期望 ${kind}，实际 ${m.kind}`);
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) err('id', 'id 不合法');
  else if (sharedId && m.id !== sharedId) err('id', `清单 id（${m.id}）与对象键（${sharedId}）不一致`);
  if (typeof m.studio_id !== 'string' || !STUDIO_ID_RE.test(m.studio_id)) err('studio_id', 'studio_id 不合法');
  else if (studioId && m.studio_id !== String(studioId)) err('studio_id', '清单属于别的工作室');
  if (!Number.isInteger(m.version) || m.version < 1) err('version', 'version 须为正整数');
  if (typeof m.name !== 'string') err('name', 'name 须为字符串');
  if (!m.fields || typeof m.fields !== 'object' || Array.isArray(m.fields)) err('fields', 'fields 须为对象');
  if (!Array.isArray(m.files)) err('files', 'files 须为数组');
  else {
    m.files.forEach((f, i) => {
      const p = `files[${i}]`;
      if (!f || typeof f !== 'object') return err(p, '文件项须为对象');
      if (typeof f.role !== 'string' || !f.role) err(`${p}.role`, 'role 必填');
      if (typeof f.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(f.name)) err(`${p}.name`, 'name 不合法');
      if (typeof f.key !== 'string' || !f.key || f.key.includes('..')) err(`${p}.key`, 'key 不合法');
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) err(`${p}.sha256`, 'sha256 须为 64 位十六进制');
      if (!Number.isInteger(f.size) || f.size < 0) err(`${p}.size`, 'size 须为非负整数');
    });
  }
  if (typeof m.updated_at !== 'string' || Number.isNaN(Date.parse(m.updated_at))) err('updated_at', 'updated_at 须为 ISO 时间');
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) err('sha256', 'sha256 缺失');
  else if (!errors.length && manifestDigest(m) !== m.sha256) err('sha256', '清单摘要不一致（内容被改动）');
  return { ok: !errors.length, errors };
}

/** 列表条目摘要（不含 fields 全文）。 */
function summaryOf(m) {
  return {
    shared_id: m.id, kind: m.kind, studio_id: m.studio_id, name: m.name, version: m.version, updated_at: m.updated_at, sha256: m.sha256,
    author: m.author || { account_id: null, email: null }, file_count: Array.isArray(m.files) ? m.files.length : 0,
    total_size: Array.isArray(m.files) ? m.files.reduce((n, f) => n + (Number(f.size) || 0), 0) : 0,
    roles: Array.isArray(m.files) ? [...new Set(m.files.map((f) => f.role))] : [],
    fields: m.kind === 'template' ? m.fields : { role: m.fields && m.fields.role ? m.fields.role : null, description: m.fields && m.fields.description ? String(m.fields.description).slice(0, 200) : '' },
  };
}

module.exports = {
  SCHEMAS, KINDS, FILE_ROLES, CHARACTER_FIELDS, sha256Hex, contentTypeOf, newSharedId, keysFor, listPrefix, parseManifestKey, fileNameFor,
  manifestDigest, sealManifest, buildCharacterManifest, buildTemplateManifest, validateManifest, summaryOf,
};
