'use strict';
/**
 * P3-K 可选云备份：把整个项目（dramaExportService 的 ZIP，与「导出项目」同一格式）放到 S3 兼容对象存储，
 * 列快照 / 恢复为新项目 / 删除 / 按保留数清理 / 每日自动备份 / 导出成片后自动备份。
 *
 * 存储布局（prefix 默认 talekiln）：
 *   <prefix>/dramas/<drama_id>/<时间戳>.zip     项目 ZIP
 *   <prefix>/dramas/<drama_id>/<时间戳>.json    清单 { drama_id, title, created_at, size, sha256, export_version, app_version }
 *   <prefix>/shared/…                           预留给工作室版共享素材库（本包不建）
 * 时间戳是 ISO 时间把冒号换成连字符：2026-10-02T03-04-05.123Z（对象键和文件名都友好）。
 *
 * 设置在 global_settings 的 `backup` 键（不含任何密钥）；Secret Key 只经密钥存储（ref `backup:s3:secret`），
 * 明文只在内存里，落盘的是 Electron safeStorage 的密文。GET /settings 只返回 has_secret。
 */
const crypto = require('crypto');
const { createS3Client, S3Error, validateEndpoint, BUCKET_RE, DEFAULT_REGION } = require('./s3');
const { getGlobalSetting, setGlobalSetting } = require('../services/settingsService');
const secrets = require('../secrets');

const SETTINGS_KEY = 'backup';
const LAST_DAILY_KEY = 'backup.last_daily_at';
const SECRET_REF = 'backup:s3:secret';
const AUTO_MODES = ['off', 'daily', 'after_export'];
const DAY_MS = 24 * 60 * 60 * 1000;
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3})Z$/;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\/]{0,127}$/;

const DEFAULTS = Object.freeze({
  provider: 's3', endpoint: '', region: DEFAULT_REGION, bucket: '', prefix: 'talekiln', access_key: '', auto: 'off', keep: 10, path_style: true,
});

class BackupError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stampOf = (date) => date.toISOString().replace(/:/g, '-');
/** 时间戳 -> ISO；不匹配返回 null。 */
function isoOfStamp(stamp) {
  const m = STAMP_RE.exec(stamp || '');
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : null;
}

/** 从对象键解析 { drama_id, stamp, created_at, kind: 'zip'|'json' }；不是本布局的键返回 null。 */
function parseKey(key, prefix) {
  const re = new RegExp(`^${escapeRe(prefix)}/dramas/(\\d+)/([^/]+)\\.(zip|json)$`);
  const m = re.exec(String(key || ''));
  if (!m) return null;
  const created = isoOfStamp(m[2]);
  if (!created) return null;
  return { drama_id: Number(m[1]), stamp: m[2], created_at: created, kind: m[3] };
}
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 归一化前缀：去首尾斜杠；空返回默认。 */
function normalizePrefix(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^\/+|\/+$/g, '');
  return s || DEFAULTS.prefix;
}

/**
 * 校验并合并设置。返回 { value, errors: [{ path, message }] }；value 里永远没有密钥字段。
 */
function normalizeSettings(patch, current = DEFAULTS) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const cur = { ...DEFAULTS, ...(current || {}) };
  const errors = [];
  const out = { ...cur };
  const has = (k) => Object.prototype.hasOwnProperty.call(p, k);

  if (has('provider') && p.provider !== 's3') errors.push({ path: 'provider', message: '目前只支持 s3（S3 兼容对象存储）' });
  out.provider = 's3';

  if (has('endpoint')) {
    const s = String(p.endpoint == null ? '' : p.endpoint).trim();
    if (s) {
      try { out.endpoint = validateEndpoint(s).url.href.replace(/\/+$/, ''); } catch (e) { errors.push({ path: 'endpoint', message: e.message }); }
    } else out.endpoint = '';
  }
  if (has('region')) {
    const s = String(p.region == null ? '' : p.region).trim();
    if (s && !/^[a-z0-9-]{1,32}$/i.test(s)) errors.push({ path: 'region', message: '区域只能是字母、数字和连字符' });
    else out.region = s || DEFAULT_REGION;
  }
  if (has('bucket')) {
    const s = String(p.bucket == null ? '' : p.bucket).trim();
    if (s && !BUCKET_RE.test(s)) errors.push({ path: 'bucket', message: '存储桶名称不合法（3–63 位小写字母、数字、点或连字符）' });
    else out.bucket = s;
  }
  if (has('prefix')) {
    const s = normalizePrefix(p.prefix);
    if (!PREFIX_RE.test(s) || s.includes('..') || s.includes('//')) errors.push({ path: 'prefix', message: '前缀只能用字母、数字、点、下划线、连字符和 /，不能含 ..' });
    else out.prefix = s;
  }
  if (has('access_key')) {
    const s = String(p.access_key == null ? '' : p.access_key).trim();
    if (s.length > 256 || /\s/.test(s)) errors.push({ path: 'access_key', message: 'Access Key 不能含空白字符' });
    else out.access_key = s;
  }
  if (has('auto')) {
    if (!AUTO_MODES.includes(p.auto)) errors.push({ path: 'auto', message: `自动备份只能是 ${AUTO_MODES.join(' / ')}` });
    else out.auto = p.auto;
  }
  if (has('keep')) {
    const n = Number(p.keep);
    if (!Number.isInteger(n) || n < 0 || n > 365) errors.push({ path: 'keep', message: '保留数量必须是 0–365 的整数（0 表示不清理）' });
    else out.keep = n;
  }
  if (has('path_style')) out.path_style = p.path_style !== false && p.path_style !== 'false';
  // 任何密钥字段都不进设置
  delete out.secret_key; delete out.secret; delete out.has_secret;
  return { value: out, errors };
}

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db
 * @param {object} o.config            应用配置（storage.local_path 给导出 / 导入服务用）
 * @param {object} [o.log]
 * @param {Function} [o.exportDrama]   (db, cfg, log, dramaId) => { buffer, title }
 * @param {Function} [o.importDrama]   (db, cfg, log, zipBuffer) => { drama_id, title }
 * @param {Function} [o.fetchImpl]     注入给 S3 客户端
 * @param {Function} [o.now]           () => Date
 * @param {string} [o.appVersion]
 * @param {object} [o.clientOptions]   透传给 createS3Client（测试调小超时 / 退避）
 */
function createBackupService({ db, config, log = console, exportDrama, importDrama, fetchImpl, now = () => new Date(), appVersion = null, clientOptions = {} } = {}) {
  if (!db) throw new Error('db is required');
  const doExport = exportDrama || require('../services/dramaExportService').exportDrama;
  const doImport = importDrama || require('../services/dramaImportService').importDrama;
  const cfg = config || {};
  const info = (m, extra) => { try { log && log.info && log.info(m, extra); } catch (_) {} };
  const warn = (m, extra) => { try { (log && (log.warn || log.warnw || log.info) || (() => {}))(m, extra); } catch (_) {} };

  let chain = Promise.resolve();
  const exclusive = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  let current = null; // 正在跑的 run 视图
  let lastError = null;
  let offlineSince = null;
  const pending = new Set(); // 已排队待跑的 drama_id（after_export 去重）

  // ---------- 设置 ----------

  function rawSettings() {
    const stored = getGlobalSetting(db, SETTINGS_KEY, null);
    const { value } = normalizeSettings(stored && typeof stored === 'object' ? stored : {}, DEFAULTS);
    return value;
  }
  const hasSecret = () => secrets.getSecretStore().has(SECRET_REF);

  /** 对外视图：永远不含密钥，只有 has_secret。 */
  function getSettings() {
    const s = rawSettings();
    return { ...s, has_secret: hasSecret(), configured: isConfiguredWith(s), secret_store_available: secrets.getSecretStore().isAvailable(), auto_modes: AUTO_MODES };
  }

  function isConfiguredWith(s) {
    return !!(s.endpoint && s.bucket && s.access_key && hasSecret());
  }
  const isConfigured = () => isConfiguredWith(rawSettings());

  /**
   * 保存设置。secret_key：非空字符串 -> 写入密钥存储；null -> 删除；缺省或空串 -> 不动（只写字段）。
   */
  function putSettings(patch) {
    const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const { value, errors } = normalizeSettings(p, rawSettings());
    if (errors.length) {
      const endpointErr = errors.find((e) => e.path === 'endpoint');
      if (endpointErr && errors.length === 1) throw new BackupError('BACKUP_ENDPOINT_INVALID', endpointErr.message, 400, { errors });
      throw new BackupError('BAD_REQUEST', errors.map((e) => e.message).join('；'), 400, { errors });
    }
    if (Object.prototype.hasOwnProperty.call(p, 'secret_key')) {
      const store = secrets.getSecretStore();
      if (p.secret_key === null) store.delete(SECRET_REF);
      else if (typeof p.secret_key === 'string' && p.secret_key.trim()) {
        if (!store.isAvailable()) throw new BackupError('SECRET_STORE_UNAVAILABLE', '系统密钥加密不可用，无法保存 Secret Key', 503);
        store.set(SECRET_REF, p.secret_key.trim());
      }
    }
    setGlobalSetting(db, SETTINGS_KEY, value);
    info('backup settings saved', { endpoint: value.endpoint, bucket: value.bucket, auto: value.auto, keep: value.keep });
    return getSettings();
  }

  // ---------- 客户端 ----------

  function clientFor(s, secretKey) {
    try {
      return createS3Client({
        endpoint: s.endpoint, bucket: s.bucket, region: s.region, accessKey: s.access_key, secretKey, pathStyle: s.path_style !== false,
        fetchImpl, now, ...clientOptions,
      });
    } catch (e) {
      if (e instanceof S3Error) throw new BackupError(e.code, e.message, e.status);
      throw e;
    }
  }

  function client() {
    const s = rawSettings();
    if (!isConfiguredWith(s)) throw new BackupError('BACKUP_NOT_CONFIGURED', '尚未配置云备份：需要地址、存储桶、Access Key 与 Secret Key', 503);
    return clientFor(s, secrets.getSecretStore().get(SECRET_REF));
  }

  /** S3Error -> BackupError（NOT_FOUND 保留 404）。 */
  function mapErr(e, fallback = 'BACKUP_FAILED') {
    if (e instanceof BackupError) return e;
    if (e instanceof S3Error) {
      if (e.code === 'BACKUP_UNREACHABLE') offlineSince = offlineSince || now().toISOString();
      return new BackupError(e.code === 'NOT_FOUND' ? 'NOT_FOUND' : e.code, e.message, e.status, e.s3Code ? { s3_code: e.s3Code } : undefined);
    }
    return new BackupError(fallback, (e && e.message) || String(e), 500);
  }
  const online = () => { offlineSince = null; };

  /**
   * 测试连接。overrides 可带表单里尚未保存的值（secret_key 缺省时用已保存的）。
   */
  async function testConnection(overrides) {
    const o = overrides && typeof overrides === 'object' ? overrides : {};
    const { value, errors } = normalizeSettings(o, rawSettings());
    if (errors.length) {
      const endpointErr = errors.find((e) => e.path === 'endpoint');
      throw new BackupError(endpointErr ? 'BACKUP_ENDPOINT_INVALID' : 'BAD_REQUEST', errors.map((e) => e.message).join('；'), 400, { errors });
    }
    const secretKey = typeof o.secret_key === 'string' && o.secret_key.trim() ? o.secret_key.trim() : secrets.getSecretStore().get(SECRET_REF);
    if (!value.endpoint || !value.bucket || !value.access_key || !secretKey) {
      throw new BackupError('BACKUP_NOT_CONFIGURED', '请先填写地址、存储桶、Access Key 与 Secret Key', 503);
    }
    const c = clientFor(value, secretKey);
    const t0 = Date.now();
    try {
      await c.headBucket();
      // 顺带确认有列举权限（最小权限策略至少要能 List / Get / Put / Delete 这个前缀）
      await c.listObjectsV2(`${value.prefix}/dramas/`, { maxKeys: 1 });
    } catch (e) {
      const err = mapErr(e);
      if (err.code === 'NOT_FOUND') throw new BackupError('BACKUP_FAILED', `存储桶 ${value.bucket} 不存在或无权访问`, 404);
      throw err;
    }
    online();
    return { ok: true, endpoint: c.endpoint, bucket: value.bucket, region: value.region, prefix: value.prefix, insecure: c.insecure, latency_ms: Date.now() - t0 };
  }

  // ---------- 运行记录 ----------

  const runRow = (id) => db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id);
  function insertRun({ drama_id, kind, trigger, title }) {
    const r = db.prepare('INSERT INTO backup_runs (drama_id, kind, trigger, title, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(drama_id, kind, trigger, title || null, 'running', now().toISOString());
    return Number(r.lastInsertRowid);
  }
  function finishRun(id, patch) {
    const sets = ['finished_at = ?'];
    const vals = [now().toISOString()];
    for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); vals.push(v); }
    vals.push(id);
    db.prepare(`UPDATE backup_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return runRow(id);
  }

  function listRuns({ dramaId, limit = 50 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
    if (dramaId != null) return db.prepare('SELECT * FROM backup_runs WHERE drama_id = ? ORDER BY id DESC LIMIT ?').all(Number(dramaId), n);
    return db.prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT ?').all(n);
  }

  // ---------- 备份 ----------

  function dramaRow(dramaId) {
    const id = Number(dramaId);
    if (!Number.isInteger(id) || id <= 0) throw new BackupError('BAD_REQUEST', '项目 id 不合法', 400);
    const d = db.prepare('SELECT id, title FROM dramas WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!d) throw new BackupError('NOT_FOUND', `项目不存在：${id}`, 404);
    return d;
  }

  /** 备份一个项目。排队串行执行；返回完成后的 run 行 + 快照。参数错误也以 rejected promise 返回。 */
  async function backupDrama(dramaId, { trigger = 'manual' } = {}) {
    const d = dramaRow(dramaId);
    const c = client(); // 未配置时在排队前就报错
    const s = rawSettings();
    pending.add(d.id);
    return exclusive(async () => {
      pending.delete(d.id);
      const runId = insertRun({ drama_id: d.id, kind: 'backup', trigger, title: d.title });
      current = { ...runRow(runId) };
      try {
        const { buffer, title } = doExport(db, cfg, log, d.id);
        const stamp = stampOf(now());
        const base = `${s.prefix}/dramas/${d.id}/${stamp}`;
        const sha = sha256Hex(buffer);
        const manifest = {
          drama_id: d.id, title, created_at: isoOfStamp(stamp), size: buffer.length, sha256: sha,
          export_version: exportVersionOf(buffer), app_version: appVersion,
        };
        await c.putObject(`${base}.zip`, buffer, { contentType: 'application/zip', sha256: sha });
        await c.putObject(`${base}.json`, Buffer.from(JSON.stringify(manifest), 'utf8'), { contentType: 'application/json' });
        online();
        const row = finishRun(runId, { status: 'done', key: `${base}.zip`, size: buffer.length, sha256: sha, title });
        lastError = null;
        info('drama backed up', { drama_id: d.id, key: row.key, size: row.size, trigger });
        if (s.keep > 0) {
          try { await pruneDrama(c, s, d.id); } catch (e) { warn('backup prune failed', { drama_id: d.id, error: e && e.message }); }
        }
        return { run: row, snapshot: snapshotView(row.key, s.prefix, { size: row.size, sha256: sha, title, manifest: true, source: 's3' }) };
      } catch (e) {
        const err = mapErr(e);
        finishRun(runId, { status: 'failed', error: err.message });
        lastError = { at: now().toISOString(), code: err.code, message: err.message, drama_id: d.id };
        warn('drama backup failed', { drama_id: d.id, code: err.code, error: err.message });
        throw err;
      } finally {
        current = null;
      }
    });
  }

  /** 从 ZIP 的 project.json 读 version（读不到返回 null，不影响备份）。 */
  function exportVersionOf(buffer) {
    try {
      const AdmZip = require('adm-zip');
      const entry = new AdmZip(buffer).getEntry('project.json');
      return entry ? (JSON.parse(entry.getData().toString('utf8')).version || null) : null;
    } catch (_) { return null; }
  }

  function snapshotView(key, prefix, extra = {}) {
    const k = parseKey(key, prefix) || {};
    return {
      key, drama_id: k.drama_id ?? null, created_at: k.created_at ?? null, manifest_key: key.replace(/\.zip$/, '.json'),
      title: extra.title ?? null, size: extra.size ?? null, sha256: extra.sha256 ?? null, manifest: extra.manifest !== false, source: extra.source || 's3',
    };
  }

  // ---------- 快照列表 ----------

  /** 本地记录里按 key 查标题 / sha256（本机做过的备份不用再取清单）。 */
  function localByKey() {
    const map = new Map();
    for (const r of db.prepare("SELECT key, title, size, sha256 FROM backup_runs WHERE kind = 'backup' AND status = 'done' AND key IS NOT NULL").all()) map.set(r.key, r);
    return map;
  }

  /** 列快照：优先对象存储，离线时回落到本地记录（source: 'local'，offline: true）。 */
  async function listSnapshots(dramaId, { maxManifestFetch = 200 } = {}) {
    const s = rawSettings();
    const id = dramaId == null || dramaId === '' ? null : Number(dramaId);
    if (id != null && (!Number.isInteger(id) || id <= 0)) throw new BackupError('BAD_REQUEST', 'drama_id 不合法', 400);
    const local = localByKey();
    let objects;
    let c;
    try {
      c = client();
      objects = await c.listAll(`${s.prefix}/dramas/${id != null ? `${id}/` : ''}`);
      online();
    } catch (e) {
      const err = mapErr(e);
      if (err.code !== 'BACKUP_UNREACHABLE' && err.code !== 'BACKUP_NOT_CONFIGURED') throw err;
      const rows = id != null ? listRuns({ dramaId: id, limit: 500 }) : listRuns({ limit: 500 });
      const items = rows.filter((r) => r.kind === 'backup' && r.status === 'done' && r.key)
        .map((r) => snapshotView(r.key, s.prefix, { title: r.title, size: r.size, sha256: r.sha256, manifest: true, source: 'local' }))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return { items, source: 'local', offline: err.code === 'BACKUP_UNREACHABLE', configured: err.code !== 'BACKUP_NOT_CONFIGURED', error: err.message };
    }
    const manifests = new Set();
    const zips = [];
    for (const o of objects) {
      const k = parseKey(o.key, s.prefix);
      if (!k) continue;
      if (k.kind === 'json') manifests.add(o.key);
      else zips.push({ o, k });
    }
    const items = [];
    let fetched = 0;
    for (const { o, k } of zips) {
      const manifestKey = o.key.replace(/\.zip$/, '.json');
      const known = local.get(o.key);
      const view = snapshotView(o.key, s.prefix, { size: o.size, title: known ? known.title : null, sha256: known ? known.sha256 : null, manifest: manifests.has(manifestKey) });
      if (!known && manifests.has(manifestKey) && fetched < maxManifestFetch) {
        fetched++;
        try {
          const m = JSON.parse((await c.getObject(manifestKey)).body.toString('utf8'));
          view.title = m.title ?? null; view.sha256 = m.sha256 ?? null; view.app_version = m.app_version ?? null; view.export_version = m.export_version ?? null;
        } catch (e) { warn('backup manifest unreadable', { key: manifestKey, error: e && e.message }); }
      }
      void k;
      items.push(view);
    }
    items.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return { items, source: 's3', offline: false, configured: true };
  }

  // ---------- 恢复 ----------

  function validateZipKey(key, prefix) {
    const k = parseKey(key, prefix);
    if (!k || k.kind !== 'zip') throw new BackupError('BAD_REQUEST', '快照 key 不在本应用的备份布局里（<前缀>/dramas/<id>/<时间戳>.zip）', 400);
    return k;
  }

  /** 恢复为新项目：下载 -> 对清单 sha256 校验 -> importDrama（标题重名自动加「导入N」，不会覆盖任何项目）。 */
  async function restore(key, { mode = 'new' } = {}) {
    if (mode !== 'new') throw new BackupError('BAD_REQUEST', '目前只支持恢复为新项目（mode: new），不会覆盖现有项目', 400);
    const s = rawSettings();
    const k = validateZipKey(key, s.prefix);
    const c = client();
    return exclusive(async () => {
      const runId = insertRun({ drama_id: k.drama_id, kind: 'restore', trigger: 'manual' });
      current = { ...runRow(runId), key };
      try {
        const { body } = await c.getObject(key); // 先取 ZIP：不存在时报 NOT_FOUND，而不是「缺少清单」
        let manifest = null;
        try {
          manifest = JSON.parse((await c.getObject(key.replace(/\.zip$/, '.json'))).body.toString('utf8'));
        } catch (e) {
          const err = mapErr(e);
          if (err.code !== 'NOT_FOUND') throw err;
        }
        online();
        const expected = manifest && typeof manifest.sha256 === 'string' && /^[0-9a-f]{64}$/.test(manifest.sha256)
          ? manifest.sha256 : (localByKey().get(key) || {}).sha256 || null;
        if (!expected) throw new BackupError('BACKUP_CHECKSUM', '快照缺少清单（.json），本地也没有它的记录，无法校验完整性，已拒绝恢复', 409);
        const actual = sha256Hex(body);
        if (actual !== expected) throw new BackupError('BACKUP_CHECKSUM', `快照校验失败：清单 sha256 ${expected.slice(0, 12)}… 与下载内容 ${actual.slice(0, 12)}… 不一致`, 409);
        let r;
        try { r = doImport(db, cfg, log, body); } catch (e) { throw new BackupError('BACKUP_FAILED', `恢复失败：${(e && e.message) || e}`, 500); }
        const row = finishRun(runId, { status: 'done', key, size: body.length, sha256: actual, title: r.title });
        info('drama restored from backup', { key, new_drama_id: r.drama_id, title: r.title });
        return { drama_id: r.drama_id, title: r.title, key, size: body.length, sha256: actual, source_drama_id: k.drama_id, run: row };
      } catch (e) {
        const err = mapErr(e);
        finishRun(runId, { status: 'failed', error: err.message, key });
        throw err;
      } finally {
        current = null;
      }
    });
  }

  // ---------- 删除 / 清理 ----------

  async function deleteSnapshot(key) {
    const s = rawSettings();
    validateZipKey(key, s.prefix);
    const c = client();
    try {
      await c.deleteObject(key);
      await c.deleteObject(key.replace(/\.zip$/, '.json'));
      online();
    } catch (e) { throw mapErr(e); }
    info('backup snapshot deleted', { key });
    return { ok: true, key };
  }

  /** 一个项目：保留最新 keep 个，其余删掉。返回删掉的 zip key。 */
  async function pruneDrama(c, s, dramaId) {
    if (!(s.keep > 0)) return [];
    const objects = await c.listAll(`${s.prefix}/dramas/${dramaId}/`);
    const zips = objects.map((o) => ({ o, k: parseKey(o.key, s.prefix) })).filter((x) => x.k && x.k.kind === 'zip')
      .sort((a, b) => (a.k.created_at < b.k.created_at ? 1 : a.k.created_at > b.k.created_at ? -1 : 0));
    const deleted = [];
    for (const { o } of zips.slice(s.keep)) {
      await c.deleteObject(o.key);
      await c.deleteObject(o.key.replace(/\.zip$/, '.json'));
      deleted.push(o.key);
    }
    if (deleted.length) info('backup pruned', { drama_id: dramaId, deleted: deleted.length, keep: s.keep });
    return deleted;
  }

  /** 全部（或某个）项目按保留数清理。 */
  async function prune({ dramaId } = {}) {
    const s = rawSettings();
    const c = client();
    if (!(s.keep > 0)) return { deleted: [], keep: s.keep };
    try {
      let ids;
      if (dramaId != null) ids = [Number(dramaId)];
      else {
        const objects = await c.listAll(`${s.prefix}/dramas/`);
        ids = [...new Set(objects.map((o) => parseKey(o.key, s.prefix)).filter(Boolean).map((k) => k.drama_id))];
      }
      const deleted = [];
      for (const id of ids) deleted.push(...(await pruneDrama(c, s, id)));
      online();
      return { deleted, keep: s.keep };
    } catch (e) { throw mapErr(e); }
  }

  // ---------- 状态 / 自动备份 ----------

  function status() {
    const s = rawSettings();
    const last = db.prepare("SELECT * FROM backup_runs WHERE kind = 'backup' ORDER BY id DESC LIMIT 1").get() || null;
    const lastDaily = getGlobalSetting(db, LAST_DAILY_KEY, null);
    return {
      configured: isConfiguredWith(s), has_secret: hasSecret(), auto: s.auto, keep: s.keep, endpoint: s.endpoint, bucket: s.bucket, prefix: s.prefix,
      running: !!current, current, pending: [...pending], last_run: last, last_error: lastError, offline_since: offlineSince,
      last_daily_at: lastDaily, next_daily_at: s.auto === 'daily' ? (lastDaily ? new Date(Date.parse(lastDaily) + DAY_MS).toISOString() : now().toISOString()) : null,
    };
  }

  /** 该项目在最近 24 小时内已有成功备份？（每日备份断网续跑时跳过已做的） */
  function backedUpWithin(dramaId, ms) {
    const r = db.prepare("SELECT finished_at FROM backup_runs WHERE drama_id = ? AND kind = 'backup' AND status = 'done' ORDER BY id DESC LIMIT 1").get(dramaId);
    return !!(r && r.finished_at && now().getTime() - Date.parse(r.finished_at) < ms);
  }

  /**
   * 调度器每轮调用。auto = daily 且已配置、空闲、距上次整轮完成 >= 24h 时，把所有项目各备一次；
   * 连不上就记日志，下一轮再试（不记为已完成）；单个项目失败不影响其它项目。
   */
  async function tick() {
    const s = rawSettings();
    if (s.auto !== 'daily' || !isConfiguredWith(s)) return { ran: false, reason: 'off' };
    if (current) return { ran: false, reason: 'busy' };
    const lastDaily = getGlobalSetting(db, LAST_DAILY_KEY, null);
    if (lastDaily && now().getTime() - Date.parse(lastDaily) < DAY_MS) return { ran: false, reason: 'done_today' };
    const dramas = db.prepare('SELECT id FROM dramas WHERE deleted_at IS NULL ORDER BY id').all();
    let done = 0;
    let failed = 0;
    for (const d of dramas) {
      if (backedUpWithin(d.id, DAY_MS)) { done++; continue; }
      try {
        await backupDrama(d.id, { trigger: 'daily' });
        done++;
      } catch (e) {
        if (e && e.code === 'BACKUP_UNREACHABLE') {
          warn('daily backup: storage unreachable, will retry next tick', { drama_id: d.id, error: e.message });
          return { ran: true, complete: false, offline: true, done, failed };
        }
        failed++;
        warn('daily backup: drama failed', { drama_id: d.id, error: e && e.message });
      }
    }
    setGlobalSetting(db, LAST_DAILY_KEY, now().toISOString());
    info('daily backup round complete', { done, failed });
    return { ran: true, complete: true, offline: false, done, failed };
  }

  /** 导出成片完成后的钩子（auto = after_export）。返回备份 promise（调用方可以不等）。 */
  function onExportFinished(evt) {
    const s = rawSettings();
    if (s.auto !== 'after_export' || !isConfiguredWith(s)) return null;
    const epId = Number(evt && (evt.episode_id ?? evt.episodeId));
    const ep = Number.isInteger(epId) ? db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(epId) : null;
    const dramaId = ep ? ep.drama_id : Number(evt && evt.drama_id);
    if (!Number.isInteger(dramaId) || dramaId <= 0) return null;
    if (pending.has(dramaId) || (current && current.drama_id === dramaId && current.kind === 'backup')) return null; // 同一项目已在排队
    const p = backupDrama(dramaId, { trigger: 'after_export' }).catch((e) => warn('after-export backup failed', { drama_id: dramaId, error: e && e.message }));
    return p;
  }

  return {
    getSettings, putSettings, testConnection, isConfigured,
    backupDrama, listSnapshots, restore, deleteSnapshot, prune, status, listRuns, tick, onExportFinished,
    SECRET_REF, SETTINGS_KEY, DEFAULTS, AUTO_MODES,
  };
}

/**
 * 每日备份调度器：启动后先等 initialDelayMs（不拖慢启动），之后每 intervalMs 调一次 service.tick()。
 * tick 之间不重叠；setTimer / clearTimer 可注入。与 batch 的 attachToWorker 配合挂到队列 worker 的生命周期上。
 */
function createBackupScheduler({ service, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 15 * 60 * 1000, initialDelayMs = 60 * 1000, onError = () => {} }) {
  if (!service || typeof service.tick !== 'function') throw new Error('service.tick is required');
  let timer = null;
  let running = false;
  let chain = Promise.resolve();
  const exclusive = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const runOnce = () => exclusive(async () => service.tick());
  function schedule(ms) {
    if (!running) return;
    clearTimer(timer);
    timer = setTimer(loop, ms);
    if (timer && timer.unref) timer.unref();
  }
  async function loop() {
    timer = null;
    if (!running) return;
    try { await runOnce(); } catch (e) { onError(e); }
    schedule(intervalMs);
  }
  function start() { if (running) return; running = true; schedule(initialDelayMs); }
  async function stop() { running = false; clearTimer(timer); timer = null; await chain; }
  return { start, stop, runOnce, wake: () => schedule(0), isRunning: () => running, options: { intervalMs, initialDelayMs } };
}

module.exports = {
  createBackupService, createBackupScheduler, BackupError, normalizeSettings, normalizePrefix, parseKey, isoOfStamp, stampOf,
  DEFAULTS, AUTO_MODES, SECRET_REF, SETTINGS_KEY, LAST_DAILY_KEY,
};
