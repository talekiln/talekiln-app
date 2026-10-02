'use strict';
/**
 * P3-S 工作室版基础（本机）：工作室身份 + 共享角色库 / 共享模板的发布与拉取。
 *
 * - 身份：本机凭云端登录态调 GET /studios/mine 取「我在哪些工作室、什么角色、席位占用」，缓存在 global_settings 的
 *   `studio.identity`（离线时用缓存）；成员管理（邀请 / 接受 / 移除 / 改角色）只是转发给云端。
 * - 存储：复用云备份的 S3 客户端与设置（packages/local/src/backup）：同一个桶、同一个 <prefix>，对象在 shared/<studio_id>/ 下
 *   （布局与清单见 ./manifest.js）。S3 凭据沿用「云备份」页配置的那一套；每工作室独立凭据是后续工作（docs/phase3-studio.md）。
 * - 权限：发布 / 更新共享素材需要 owner 或 admin；拉取任何 active 成员都可以（对象存储层面的只读策略由服务器配置，见部署手册）。
 * - 记录：studio_shared_items（迁移 36）记本机发布 / 拉取过的条目与版本，用来显示「我发布的」「可更新」并在更新时覆盖同一个本机角色。
 *
 * 不改备份服务本身：只用它的 getSettings()（不含密钥）与 SECRET_REF；S3 客户端在这里按设置自己建。
 */
const fs = require('fs');
const path = require('path');
const { createS3Client, S3Error } = require('../backup/s3');
const { BackupError } = require('../backup/service');
const secrets = require('../secrets');
const referenceLocks = require('../services/referenceLockService');
const { getGlobalSetting, setGlobalSetting } = require('../services/settingsService');
const manifestLib = require('./manifest');
const { StudioError } = require('./errors');

const IDENTITY_KEY = 'studio.identity';
const CURRENT_KEY = 'studio.current';
const MAX_MANIFEST_FETCH = 200;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const WRITER_ROLES = ['owner', 'admin'];

const nowIso = (now) => now().toISOString();
const parseJson = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };

/** 存储目录相对路径 -> 绝对路径（目录外返回 null）。 */
function resolveLocal(storageRoot, ref) {
  if (typeof ref !== 'string' || !ref.trim() || /^(https?:|data:|oss:)/i.test(ref) || !storageRoot) return null;
  const rel = (ref.startsWith('/static/') ? ref.slice('/static/'.length) : ref.replace(/^\/+/, '')) || null;
  if (!rel) return null;
  const root = path.resolve(storageRoot);
  const abs = path.resolve(root, rel);
  const within = path.relative(root, abs);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) return null;
  try { return fs.statSync(abs).isFile() ? { abs, rel } : null; } catch (_) { return null; }
}

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db
 * @param {string} o.storageRoot            本机存储目录（/static 映射到它）
 * @param {object} [o.cloud]                createCloud() 的结果（http + account）
 * @param {object} [o.cloudApi]             { request(method, path, { body, query }) } 已带登录态；缺省由 cloud.account.authed 包装；测试注入假云端
 * @param {object} o.backup                 createBackupService() 的结果：只用 getSettings() 与 SECRET_REF
 * @param {object} [o.templates]            createTemplateService() 的结果：get / install
 * @param {object} [o.log]
 * @param {() => Date} [o.now]
 * @param {Function} [o.fetchImpl]          透传给 S3 客户端
 * @param {object} [o.clientOptions]        透传给 createS3Client（测试调小超时 / 退避）
 */
function createStudioService({ db, storageRoot, cloud = null, cloudApi = null, backup, templates = null, log = console, now = () => new Date(), fetchImpl, clientOptions = {} } = {}) {
  if (!db) throw new Error('db is required');
  if (!backup || typeof backup.getSettings !== 'function') throw new Error('backup service is required');
  const info = (m, extra) => { try { log && log.info && log.info(m, extra); } catch (_) {} };
  const warn = (m, extra) => { try { (log && (log.warn || log.info) || (() => {}))(m, extra); } catch (_) {} };

  // ---------- 云端 ----------

  const api = cloudApi || {
    request: (method, pathname, opts = {}) => {
      if (!cloud || !cloud.isConfigured()) throw new StudioError('CLOUD_NOT_CONFIGURED', '尚未配置云端地址（config.yaml 的 cloud.base_url）', 503);
      return cloud.account.authed((token) => cloud.http.request(method, pathname, { ...opts, token }));
    },
  };

  /** 云端调用的错误 -> StudioError。 */
  function mapCloudErr(e) {
    if (e instanceof StudioError) return e;
    if (e && e.name === 'AccountError') return new StudioError('STUDIO_NOT_LOGGED_IN', e.code === 'SESSION_EXPIRED' ? '登录已过期，请重新登录' : '工作室功能需要先登录账号', 401);
    if (e && e.name === 'CloudError') {
      if (e.code === 'cloud_not_configured') return new StudioError('CLOUD_NOT_CONFIGURED', '尚未配置云端地址', 503);
      if (e.network) return new StudioError('CLOUD_UNREACHABLE', '无法连接云端，请检查网络后重试', 502);
      if (e.code === 'invalid_token') return new StudioError('STUDIO_NOT_LOGGED_IN', '登录已失效，请重新登录', 401);
      if (e.code === 'seat_limit') return new StudioError('SEAT_LIMIT', '工作室席位已满', 403, { cloud_error: e.code });
      if (e.code === 'forbidden') return new StudioError('STUDIO_FORBIDDEN', '当前角色没有权限做这个操作', 403, { cloud_error: e.code });
      if (e.code === 'not_found') return new StudioError('NOT_FOUND', '云端没有这个对象', 404);
      const status = e.status >= 400 && e.status < 600 ? e.status : 502;
      return new StudioError('CLOUD_ERROR', `云端返回错误：${e.code}`, status, { cloud_error: e.code });
    }
    return new StudioError('CLOUD_ERROR', (e && e.message) || String(e), 502);
  }

  async function call(method, pathname, opts) {
    try { return await api.request(method, pathname, opts); } catch (e) { throw mapCloudErr(e); }
  }

  // ---------- 身份 ----------

  const cached = () => getGlobalSetting(db, IDENTITY_KEY, null);
  const currentId = () => getGlobalSetting(db, CURRENT_KEY, null);

  function identityView(items, { online, fetched_at, error = null }) {
    const list = Array.isArray(items) ? items : [];
    let current = currentId();
    if (!list.some((s) => s.id === current)) current = list.length ? list[0].id : null;
    return { studios: list, current_studio_id: current, online, fetched_at: fetched_at || null, error };
  }

  /** 我所在的工作室。sync=true（或没有缓存）时问云端；连不上就用缓存并标 online:false。 */
  async function identity({ sync = false } = {}) {
    const c = cached();
    if (!sync && c && Array.isArray(c.items)) return identityView(c.items, { online: null, fetched_at: c.fetched_at });
    try {
      const r = await call('GET', '/studios/mine');
      const items = r && Array.isArray(r.items) ? r.items : [];
      const fetched_at = nowIso(now);
      setGlobalSetting(db, IDENTITY_KEY, { items, fetched_at });
      return identityView(items, { online: true, fetched_at });
    } catch (e) {
      if (e.code === 'STUDIO_NOT_LOGGED_IN') { setGlobalSetting(db, IDENTITY_KEY, null); throw e; }
      if (c && Array.isArray(c.items) && (e.code === 'CLOUD_UNREACHABLE' || e.code === 'CLOUD_ERROR')) {
        warn('studio identity offline, using cache', { error: e.message });
        return identityView(c.items, { online: false, fetched_at: c.fetched_at, error: e.code });
      }
      throw e;
    }
  }

  function setCurrent(studioId) {
    const c = cached();
    const items = c && Array.isArray(c.items) ? c.items : [];
    if (!items.some((s) => s.id === String(studioId))) throw new StudioError('STUDIO_NOT_MEMBER', '你不是该工作室的成员', 403);
    setGlobalSetting(db, CURRENT_KEY, String(studioId));
    return identityView(items, { online: null, fetched_at: c.fetched_at });
  }

  /** 解析要操作的工作室（显式 id 或当前选择），不是成员就拒绝；缓存缺失时先同步一次。 */
  async function studioFor(studioId) {
    let c = cached();
    if (!c || !Array.isArray(c.items)) { await identity({ sync: true }); c = cached(); }
    const items = c && Array.isArray(c.items) ? c.items : [];
    const id = studioId != null && studioId !== '' ? String(studioId) : identityView(items, { online: null }).current_studio_id;
    if (!id) throw new StudioError('STUDIO_NOT_MEMBER', '你还没有加入任何工作室', 403);
    const s = items.find((x) => x.id === id);
    if (!s) throw new StudioError('STUDIO_NOT_MEMBER', '你不是该工作室的成员', 403);
    return s;
  }

  function requireWriter(s) {
    if (!WRITER_ROLES.includes(s.my_role)) throw new StudioError('STUDIO_FORBIDDEN', '发布与更新共享素材需要工作室所有者或管理员', 403, { my_role: s.my_role });
    if (s.status && s.status !== 'active') throw new StudioError('STUDIO_FORBIDDEN', '工作室已被停用，只能查看与拉取', 403);
  }

  async function author() {
    try {
      const st = cloud && cloud.account ? await cloud.account.status() : null;
      return { account_id: (st && st.account && st.account.id) || null, email: (st && st.account && st.account.email) || null };
    } catch (_) { return { account_id: null, email: null }; }
  }

  // ---------- 成员管理（转发云端） ----------

  const refresh = async (r) => { try { await identity({ sync: true }); } catch (_) {} return r; };
  const detail = (studioId) => call('GET', `/studios/${encodeURIComponent(studioId)}`);
  const createStudio = (body) => call('POST', '/studios', { body }).then(refresh);
  const invite = (studioId, body) => call('POST', `/studios/${encodeURIComponent(studioId)}/invites`, { body });
  const revokeInvite = (studioId, inviteId) => call('DELETE', `/studios/${encodeURIComponent(studioId)}/invites/${encodeURIComponent(inviteId)}`);
  const accept = (body) => call('POST', '/studios/accept', { body }).then(refresh);
  const removeMember = (studioId, accountId) => call('DELETE', `/studios/${encodeURIComponent(studioId)}/members/${encodeURIComponent(accountId)}`).then(refresh);
  const setRole = (studioId, accountId, body) => call('PUT', `/studios/${encodeURIComponent(studioId)}/members/${encodeURIComponent(accountId)}/role`, { body });

  // ---------- 对象存储（复用云备份的设置与密钥） ----------

  function s3() {
    const s = backup.getSettings();
    if (!s.configured) throw new StudioError('BACKUP_NOT_CONFIGURED', '共享库使用「云备份」页配置的对象存储：请先在那里填写地址、存储桶与访问密钥', 503);
    try {
      return {
        client: createS3Client({
          endpoint: s.endpoint, bucket: s.bucket, region: s.region, accessKey: s.access_key, secretKey: secrets.getSecretStore().get(backup.SECRET_REF),
          pathStyle: s.path_style !== false, fetchImpl, now, ...clientOptions,
        }),
        prefix: s.prefix || '',
      };
    } catch (e) {
      if (e instanceof S3Error) throw new StudioError(e.code, e.message, e.status);
      throw e;
    }
  }

  function mapS3(e, fallback = 'BACKUP_FAILED') {
    if (e instanceof StudioError || e instanceof BackupError) return e;
    if (e instanceof S3Error) return new StudioError(e.code === 'NOT_FOUND' ? 'NOT_FOUND' : e.code, e.message, e.status, e.s3Code ? { s3_code: e.s3Code } : undefined);
    if (e && e.name === 'TemplateError') return e;
    return new StudioError(fallback, (e && e.message) || String(e), 500);
  }

  // ---------- 记录 ----------

  const recordOf = (studioId, kind, sharedId, direction) => db.prepare('SELECT * FROM studio_shared_items WHERE studio_id = ? AND kind = ? AND shared_id = ? AND direction = ?').get(String(studioId), kind, String(sharedId), direction) || null;
  const recordByLocal = (studioId, kind, localId, direction) => db.prepare('SELECT * FROM studio_shared_items WHERE studio_id = ? AND kind = ? AND local_id = ? AND direction = ?').get(String(studioId), kind, String(localId), direction) || null;
  function upsertRecord({ studio_id, kind, shared_id, direction, local_id, version, sha256, manifest_key, title, author: a, remote_updated_at }) {
    const t = nowIso(now);
    db.prepare(`INSERT INTO studio_shared_items (studio_id, kind, shared_id, direction, local_id, version, sha256, manifest_key, title, author, remote_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(studio_id, kind, shared_id, direction) DO UPDATE SET local_id = excluded.local_id, version = excluded.version, sha256 = excluded.sha256,
        manifest_key = excluded.manifest_key, title = excluded.title, author = excluded.author, remote_updated_at = excluded.remote_updated_at, updated_at = excluded.updated_at`)
      .run(String(studio_id), kind, String(shared_id), direction, local_id != null ? String(local_id) : null, Number(version) || 1, sha256 || null, manifest_key || null, title || null, a || null, remote_updated_at || null, t, t);
    return recordOf(studio_id, kind, shared_id, direction);
  }
  function listRecords(studioId, kind) {
    const sql = 'SELECT * FROM studio_shared_items WHERE studio_id = ?' + (kind ? ' AND kind = ?' : '') + ' ORDER BY updated_at DESC, id DESC';
    return (kind ? db.prepare(sql).all(String(studioId), kind) : db.prepare(sql).all(String(studioId)));
  }

  // ---------- 共享库列表 ----------

  /** 远端条目 + 本机状态：mine（我发布的）/ pulled（已拉取且最新）/ update_available / not_pulled。 */
  function annotate(studioId, kind, m) {
    const s = manifestLib.summaryOf(m);
    const pub = recordOf(studioId, kind, m.id, 'published');
    const pulled = recordOf(studioId, kind, m.id, 'pulled');
    let state = 'not_pulled';
    if (pub) state = pub.version >= m.version ? 'mine' : 'mine_outdated';
    else if (pulled) state = pulled.version >= m.version ? 'pulled' : 'update_available';
    return { ...s, state, published_local_id: pub ? pub.local_id : null, published_version: pub ? pub.version : null, pulled_local_id: pulled ? pulled.local_id : null, pulled_version: pulled ? pulled.version : null };
  }

  async function listShared(studioId, kind) {
    if (!manifestLib.KINDS.includes(kind)) throw new StudioError('BAD_REQUEST', 'kind 须为 character 或 template', 400);
    const s = await studioFor(studioId);
    const { client, prefix } = s3();
    try {
      const objects = await client.listAll(manifestLib.listPrefix(prefix, s.id, kind));
      const keys = objects.map((o) => o.key).filter((k) => manifestLib.parseManifestKey(k, prefix)).slice(0, MAX_MANIFEST_FETCH);
      const items = [];
      const invalid = [];
      for (const key of keys) {
        const parsed = manifestLib.parseManifestKey(key, prefix);
        try {
          const r = await client.getObject(key);
          const m = parseJson(r.body.toString('utf8'));
          const v = manifestLib.validateManifest(m, { kind, studioId: s.id, sharedId: parsed.shared_id });
          if (!v.ok) { invalid.push({ key, errors: v.errors }); continue; }
          items.push(annotate(s.id, kind, m));
        } catch (e) {
          if (e instanceof S3Error && e.code === 'NOT_FOUND') continue;
          throw e;
        }
      }
      items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || a.name.localeCompare(b.name));
      return { studio_id: s.id, kind, items, invalid, my_role: s.my_role, can_publish: WRITER_ROLES.includes(s.my_role) && (!s.status || s.status === 'active'), truncated: objects.length > keys.length };
    } catch (e) {
      throw mapS3(e);
    }
  }

  async function getManifest(client, prefix, studioId, kind, sharedId) {
    const keys = manifestLib.keysFor(prefix, studioId, kind, sharedId);
    let r;
    try { r = await client.getObject(keys.manifest); } catch (e) { throw mapS3(e); }
    const m = parseJson(r.body.toString('utf8'));
    const v = manifestLib.validateManifest(m, { kind, studioId, sharedId });
    if (!v.ok) throw new StudioError('STUDIO_INVALID_MANIFEST', `共享清单不合法：${v.errors[0].path ? v.errors[0].path + '：' : ''}${v.errors[0].message}`, 400, { errors: v.errors });
    return { manifest: m, keys };
  }

  /** 下载并校验一个文件（sha256 不符 409）。 */
  async function fetchVerified(client, f) {
    let r;
    try { r = await client.getObject(f.key); } catch (e) { throw mapS3(e); }
    if (r.body.length > MAX_FILE_BYTES) throw new StudioError('STUDIO_CHECKSUM', `文件过大：${f.name}`, 409);
    const got = manifestLib.sha256Hex(r.body);
    if (got !== f.sha256) throw new StudioError('STUDIO_CHECKSUM', `文件 ${f.name} 的内容与清单里的 sha256 不一致`, 409, { file: f.name, expected: f.sha256, actual: got });
    return r.body;
  }

  // ---------- 角色 ----------

  const CHAR_COLS = ['id', 'drama_id', 'name', 'role', 'description', 'personality', 'appearance', 'image_url', 'local_path', 'voice_style', 'polished_prompt', 'negative_prompt',
    'identity_anchors', 'style_tokens', 'color_palette', 'four_view_image_url', 'extra_images', 'stages'];
  const charRow = (id) => db.prepare(`SELECT ${CHAR_COLS.join(', ')} FROM characters WHERE id = ? AND deleted_at IS NULL`).get(Number(id)) || null;

  /** 角色的本机图片：主图、四视图、锁定参考图、extra_images（只收本机存在的文件；远程 URL 跳过并列入 skipped）。 */
  function characterFiles(ch) {
    const files = [];
    const skipped = [];
    const seen = new Set();
    const add = (role, ref) => {
      if (typeof ref !== 'string' || !ref.trim()) return;
      const hit = resolveLocal(storageRoot, ref);
      if (!hit) { skipped.push({ role, ref: ref.slice(0, 200), reason: /^(https?:|data:|oss:)/i.test(ref) ? 'remote' : 'not_local' }); return; }
      const buf = fs.readFileSync(hit.abs);
      const sha256 = manifestLib.sha256Hex(buf);
      const dedupe = `${role}:${sha256}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      files.push({ role, sha256, size: buf.length, buf, original: path.basename(hit.abs), name: manifestLib.fileNameFor(role, sha256, hit.abs) });
    };
    add('main', ch.local_path || ch.image_url);
    add('four_view', ch.four_view_image_url);
    const lock = referenceLocks.getLock(db, 'character', ch.id);
    if (lock) add('locked_reference', lock.local_path || lock.image_url);
    const extras = parseJson(ch.extra_images);
    for (const x of Array.isArray(extras) ? extras : []) add('extra', typeof x === 'string' ? x : x && (x.local_path || x.image_url));
    return { files, skipped };
  }

  /** 发布（或更新）本机角色到共享库。同一个本机角色重复发布沿用同一个 shared_id、版本号 +1。 */
  async function publishCharacter(characterId, { studio_id } = {}) {
    const s = await studioFor(studio_id);
    requireWriter(s);
    const ch = charRow(characterId);
    if (!ch) throw new StudioError('NOT_FOUND', '角色不存在', 404);
    const { files, skipped } = characterFiles(ch);
    const { client, prefix } = s3();
    const existing = recordByLocal(s.id, 'character', ch.id, 'published');
    const sharedId = existing ? existing.shared_id : manifestLib.newSharedId('character');
    const keys = manifestLib.keysFor(prefix, s.id, 'character', sharedId);
    try {
      // 远端已有更高版本（别的机器发的）就在它之上 +1
      let remoteVersion = 0;
      if (existing) {
        try {
          const r = await client.getObject(keys.manifest);
          const m = parseJson(r.body.toString('utf8'));
          if (m && Number.isInteger(m.version)) remoteVersion = m.version;
        } catch (e) { if (!(e instanceof S3Error && e.code === 'NOT_FOUND')) throw e; }
      }
      const version = Math.max(existing ? existing.version : 0, remoteVersion) + 1;
      const uploaded = [];
      for (const f of files) {
        const key = keys.file(f.name);
        await client.putObject(key, f.buf, { contentType: manifestLib.contentTypeOf(f.name), sha256: f.sha256 });
        uploaded.push({ role: f.role, name: f.name, key, sha256: f.sha256, size: f.size, content_type: manifestLib.contentTypeOf(f.name) });
      }
      const manifest = manifestLib.buildCharacterManifest({ studioId: s.id, sharedId, version, character: ch, files: uploaded, author: await author(), sourceCharacterId: ch.id, now: now() });
      await client.putObject(keys.manifest, JSON.stringify(manifest, null, 2), { contentType: 'application/json' });
      const rec = upsertRecord({ studio_id: s.id, kind: 'character', shared_id: sharedId, direction: 'published', local_id: ch.id, version, sha256: manifest.sha256, manifest_key: keys.manifest, title: ch.name, author: manifest.author.email, remote_updated_at: manifest.updated_at });
      info('studio character published', { studio_id: s.id, shared_id: sharedId, character_id: ch.id, version, files: uploaded.length });
      return { shared_id: sharedId, version, manifest, record: rec, files: uploaded.map(({ role, name, sha256, size }) => ({ role, name, sha256, size })), skipped, updated: !!existing };
    } catch (e) {
      throw mapS3(e);
    }
  }

  /**
   * 拉取共享角色到本机：第一次拉取在指定项目里新建角色；再次拉取（更新）覆盖上次拉取建的那个角色（它还在的话）。
   * 图片落到 <storageRoot>/studio/<studio_id>/characters/<shared_id>/，sha256 不符拒绝写入。
   */
  async function pullCharacter(studioId, sharedId, { drama_id } = {}) {
    const s = await studioFor(studioId);
    const { client, prefix } = s3();
    const { manifest: m } = await getManifest(client, prefix, s.id, 'character', String(sharedId));
    const prev = recordOf(s.id, 'character', m.id, 'pulled');
    let target = prev && prev.local_id ? charRow(prev.local_id) : null;
    let dramaId = target ? target.drama_id : Number(drama_id);
    if (!target) {
      if (!Number.isInteger(dramaId) || dramaId <= 0) throw new StudioError('BAD_REQUEST', '第一次拉取需要指定放到哪个项目（drama_id）', 400);
      if (!db.prepare('SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dramaId)) throw new StudioError('NOT_FOUND', '项目不存在', 404);
    }
    // 先全部下载校验，再落盘、再写库：中途失败不留半成品
    const blobs = [];
    for (const f of m.files) blobs.push({ f, body: await fetchVerified(client, f) });
    const relDir = path.posix.join('studio', s.id, 'characters', m.id);
    const absDir = path.join(path.resolve(storageRoot), relDir);
    fs.mkdirSync(absDir, { recursive: true });
    const written = {};
    for (const { f, body } of blobs) {
      const safe = path.basename(f.name);
      fs.writeFileSync(path.join(absDir, safe), body);
      (written[f.role] = written[f.role] || []).push(path.posix.join(relDir, safe));
    }
    const main = (written.main || [])[0] || (written.locked_reference || [])[0] || (written.extra || [])[0] || null;
    const fourView = (written.four_view || [])[0] || null;
    const locked = (written.locked_reference || [])[0] || main;
    const extras = [...(written.extra || []), ...(written.main || []).slice(1)];
    const fl = m.fields || {};
    const t = nowIso(now);
    const txt = (k) => (fl[k] == null ? null : typeof fl[k] === 'string' ? fl[k] : JSON.stringify(fl[k]));
    const cols = {
      name: m.name || fl.name || '共享角色', role: txt('role'), description: txt('description'), personality: txt('personality'), appearance: txt('appearance'),
      voice_style: txt('voice_style'), polished_prompt: txt('polished_prompt'), negative_prompt: txt('negative_prompt'), identity_anchors: txt('identity_anchors'),
      style_tokens: txt('style_tokens'), color_palette: txt('color_palette'), stages: txt('stages'),
      image_url: main ? `/static/${main}` : null, local_path: main, four_view_image_url: fourView ? `/static/${fourView}` : null,
      extra_images: extras.length ? JSON.stringify(extras) : null, updated_at: t,
    };
    let characterId;
    if (target) {
      db.prepare(`UPDATE characters SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(cols), target.id);
      characterId = target.id;
    } else {
      const r = db.prepare(`INSERT INTO characters (drama_id, ${Object.keys(cols).join(', ')}, created_at) VALUES (?, ${Object.keys(cols).map(() => '?').join(', ')}, ?)`).run(dramaId, ...Object.values(cols), t);
      characterId = Number(r.lastInsertRowid);
    }
    if (locked) referenceLocks.setLock(db, 'character', characterId, { image_url: `/static/${locked}`, local_path: locked, source_image_id: null });
    const rec = upsertRecord({ studio_id: s.id, kind: 'character', shared_id: m.id, direction: 'pulled', local_id: characterId, version: m.version, sha256: m.sha256, manifest_key: manifestLib.keysFor(prefix, s.id, 'character', m.id).manifest, title: m.name, author: m.author && m.author.email, remote_updated_at: m.updated_at });
    info('studio character pulled', { studio_id: s.id, shared_id: m.id, character_id: characterId, version: m.version, files: blobs.length, updated: !!target });
    return { character_id: characterId, drama_id: dramaId, shared_id: m.id, version: m.version, updated: !!target, files: blobs.map(({ f }) => ({ role: f.role, name: f.name, sha256: f.sha256, size: f.size })), locked_reference: locked ? `/static/${locked}` : null, record: rec };
  }

  // ---------- 模板 ----------

  async function publishTemplate(templateId, { studio_id } = {}) {
    if (!templates) throw new StudioError('STUDIO_FORBIDDEN', '模板服务不可用', 503);
    const s = await studioFor(studio_id);
    requireWriter(s);
    const t = templates.get(String(templateId)); // 不存在时模板服务抛 NOT_FOUND
    const tm = t.manifest;
    const { client, prefix } = s3();
    const keys = manifestLib.keysFor(prefix, s.id, 'template', tm.id);
    try {
      const existing = recordOf(s.id, 'template', tm.id, 'published');
      let remoteVersion = 0;
      try {
        const r = await client.getObject(keys.manifest);
        const m = parseJson(r.body.toString('utf8'));
        if (m && Number.isInteger(m.version)) remoteVersion = m.version;
      } catch (e) { if (!(e instanceof S3Error && e.code === 'NOT_FOUND')) throw e; }
      const version = Math.max(existing ? existing.version : 0, remoteVersion) + 1;
      const body = Buffer.from(JSON.stringify(tm, null, 2), 'utf8');
      const sha256 = manifestLib.sha256Hex(body);
      await client.putObject(keys.template, body, { contentType: 'application/json', sha256 });
      const manifest = manifestLib.buildTemplateManifest({ studioId: s.id, templateManifest: tm, version, templateFile: { name: 'template.json', key: keys.template, sha256, size: body.length, content_type: 'application/json' }, author: await author(), now: now() });
      await client.putObject(keys.manifest, JSON.stringify(manifest, null, 2), { contentType: 'application/json' });
      const rec = upsertRecord({ studio_id: s.id, kind: 'template', shared_id: tm.id, direction: 'published', local_id: tm.id, version, sha256: manifest.sha256, manifest_key: keys.manifest, title: tm.name, author: manifest.author.email, remote_updated_at: manifest.updated_at });
      info('studio template published', { studio_id: s.id, template_id: tm.id, version });
      return { shared_id: tm.id, version, manifest, record: rec, updated: !!existing };
    } catch (e) {
      throw mapS3(e);
    }
  }

  /** 拉取共享模板：下载 template.json（校验 sha256）后用模板服务安装（source 'local'；内置模板 id 会被模板服务拒绝）。 */
  async function pullTemplate(studioId, sharedId) {
    if (!templates) throw new StudioError('STUDIO_FORBIDDEN', '模板服务不可用', 503);
    const s = await studioFor(studioId);
    const { client, prefix } = s3();
    const { manifest: m } = await getManifest(client, prefix, s.id, 'template', String(sharedId));
    const f = m.files.find((x) => x.role === 'template');
    if (!f) throw new StudioError('STUDIO_INVALID_MANIFEST', '模板清单里没有 template 文件', 400);
    const body = await fetchVerified(client, f);
    const tm = parseJson(body.toString('utf8'));
    if (!tm || tm.id !== m.id) throw new StudioError('STUDIO_INVALID_MANIFEST', '模板包的 id 与共享清单不一致', 400);
    const installed = await templates.install({ manifest: tm, source: 'local' });
    const rec = upsertRecord({ studio_id: s.id, kind: 'template', shared_id: m.id, direction: 'pulled', local_id: tm.id, version: m.version, sha256: m.sha256, manifest_key: manifestLib.keysFor(prefix, s.id, 'template', m.id).manifest, title: m.name, author: m.author && m.author.email, remote_updated_at: m.updated_at });
    info('studio template pulled', { studio_id: s.id, template_id: tm.id, version: m.version });
    return { template_id: tm.id, shared_id: m.id, version: m.version, template: installed, record: rec };
  }

  return {
    identity, setCurrent, studioFor, detail, createStudio, invite, revokeInvite, accept, removeMember, setRole,
    listShared, publishCharacter, pullCharacter, publishTemplate, pullTemplate,
    records: (studioId, kind) => listRecords(studioId, kind),
    IDENTITY_KEY, CURRENT_KEY, WRITER_ROLES,
  };
}

module.exports = { createStudioService, resolveLocal, IDENTITY_KEY, CURRENT_KEY, WRITER_ROLES };
