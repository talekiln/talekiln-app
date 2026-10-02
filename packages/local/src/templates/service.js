'use strict';
/**
 * P3-T 模板市场（docs/phase3-templates.md）：
 *   list / get      内置 + 已安装模板（含 tier、use_count、「套用后会得到」摘要）
 *   estimate        逐镜估价：每个镜头出一张图 + 一段视频，走 spend.checkBatch（与生成前估算同一套价格表）
 *   apply           一键套用：建项目（或在已有项目下建下一集）-> 角色槽位映射到已有角色（沿用锁定参考图）
 *                   -> 一个内核事务建好整张项目图（段落、镜头、台词行、参考图哈希）-> use_count+1
 *   install/remove  从目录 / .lytpl 压缩包 / 云端清单安装；带 signature 的用云端 JWKS 验签（官方），签名错误拒绝安装
 *
 * 付费（pro）模板由 entitlement.isPro 按账号状态放行。全部写入都在一个 SQLite 事务里，失败不留半成品。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kernel = require('@talekiln/kernel');
const store = require('../kernel/store');
const legacy = require('../kernel/legacy');
const { Chain } = require('../kernel/compat');
const inputs = require('../kernel/inputs');
const referenceLocks = require('../services/referenceLockService');
const dramaService = require('../services/dramaService');
const { chooseProvider, pickModel } = require('../generation/models');
const { verifyEs256, peekHeader } = require('../cloud/jws');
const { createJwksProvider } = require('../cloud/jwks');
const schema = require('./schema');
const { loadPackage } = require('./package');
const { isPro, proReason } = require('./entitlement');
const { TemplateError } = require('./errors');

const I = kernel.intents;
const DEFAULT_BUILTIN_DIR = path.join(__dirname, '..', '..', 'templates');
const SOURCES = ['builtin', 'cloud', 'local'];
const VIDEO_MIN_SEC = 1;
const VIDEO_MAX_SEC = 15;
const round = (n) => Math.round(n * 1e6) / 1e6;
const nowIso = () => new Date().toISOString();

const CHARACTER_COPY_COLUMNS = [
  'name', 'role', 'description', 'personality', 'appearance', 'image_url', 'local_path', 'extra_images', 'voice_style',
  'identity_anchors', 'style_tokens', 'color_palette', 'four_view_image_url', 'polished_prompt', 'ref_image', 'negative_prompt',
];

function createTemplateService({
  db, spend, log = console, cloud = null, listConfigs = null, catalogModels = () => [],
  builtinDir = DEFAULT_BUILTIN_DIR, getAccountStatus = null, now = () => Date.now(),
} = {}) {
  if (!db || !spend) throw new Error('db and spend are required');
  const warn = (msg, extra) => { try { (log.warn || log.error || (() => {})).call(log, msg, extra); } catch (_) { /* ignore */ } };
  const list = listConfigs || ((type) => require('../services/aiConfigService').listConfigsInternal(db, type));
  const jwks = cloud && cloud.http ? createJwksProvider({ db, http: cloud.http }) : null;
  const accountStatus = getAccountStatus || (cloud && cloud.account ? () => cloud.account.status() : async () => null);

  // ---------- 存取 ----------

  const parse = (row) => ({ ...row, manifest: JSON.parse(row.manifest) });
  const rowOf = (id) => {
    const r = db.prepare('SELECT * FROM installed_templates WHERE id = ?').get(String(id));
    return r ? parse(r) : null;
  };
  const need = (id) => {
    const r = rowOf(id);
    if (!r) throw new TemplateError('NOT_FOUND', `模板不存在：${id}`, 404);
    return r;
  };

  function upsert(manifest, { source, signature_status }) {
    if (!SOURCES.includes(source)) throw new Error(`bad template source: ${source}`);
    db.prepare(`INSERT INTO installed_templates (id, source, version, manifest, signature_status, installed_at, use_count)
      VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET source = excluded.source, version = excluded.version, manifest = excluded.manifest,
        signature_status = excluded.signature_status, installed_at = excluded.installed_at`)
      .run(manifest.id, source, manifest.version, JSON.stringify(manifest), signature_status, nowIso());
  }

  /** 把磁盘上的内置模板写进表（每次启动重写清单；use_count 保留；磁盘上没有的内置行删掉）。 */
  function syncBuiltins() {
    const ids = [];
    if (builtinDir && fs.existsSync(builtinDir)) {
      for (const name of fs.readdirSync(builtinDir).sort()) {
        const file = path.join(builtinDir, name, 'manifest.json');
        if (!fs.existsSync(file)) continue;
        let m;
        try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { warn('builtin template unreadable', { name, error: e.message }); continue; }
        const v = schema.validateManifest(m);
        if (!v.ok) { warn('builtin template invalid', { name, errors: v.errors }); continue; }
        upsert(m, { source: 'builtin', signature_status: 'official' });
        ids.push(m.id);
      }
    }
    const stale = db.prepare("SELECT id FROM installed_templates WHERE source = 'builtin'").all().map((r) => r.id).filter((id) => !ids.includes(id));
    for (const id of stale) db.prepare('DELETE FROM installed_templates WHERE id = ?').run(id);
    return ids;
  }

  const view = (row) => {
    const m = row.manifest;
    return {
      id: row.id, name: m.name, version: row.version, genre: m.genre, tier: m.tier, description: m.description || '',
      cover: m.cover || null, music_hint: m.music_hint || null, style: m.style,
      source: row.source, signature_status: row.signature_status, installed_at: row.installed_at, use_count: row.use_count,
      summary: schema.summaryOf(m),
    };
  };

  async function proState() {
    let status = null;
    try { status = await accountStatus(); } catch (e) { warn('account status failed', { error: e && e.message }); }
    return { available: isPro(status, now()), reason: proReason(status, now()), status };
  }

  /** 全部模板（内置在前，再按类型、名字）。 */
  async function listTemplates() {
    const rows = db.prepare("SELECT * FROM installed_templates ORDER BY CASE source WHEN 'builtin' THEN 0 ELSE 1 END, id").all().map(parse);
    const pro = await proState();
    const items = rows.map(view).sort((a, b) => a.genre.localeCompare(b.genre) || a.name.localeCompare(b.name));
    return { items, pro_available: pro.available, pro_reason: pro.reason };
  }

  function get(id) {
    const row = need(id);
    return { ...view(row), manifest: row.manifest };
  }

  // ---------- 估价 ----------

  /** 逐镜估价：每镜一张图（有角色槽位则按带参考图选模型）+ 一段视频（按首帧模式选模型，时长 1..15 秒）。 */
  function estimate(id) {
    const m = need(id).manifest;
    const catalog = catalogModels() || [];
    const prov = { image: chooseProvider(list, 'image'), video: chooseProvider(list, 'video') };
    const specs = [];
    const shots = m.shots.map((s, index) => {
      const hasRefs = (s.character_slots || []).length > 0;
      const imageModel = pickModel({ provider: prov.image.provider, kind: 'image', hasRefs, listConfigs: list, catalogModels: catalog }) || null;
      const videoModel = pickModel({ provider: prov.video.provider, kind: 'video', hasFrame: true, listConfigs: list, catalogModels: catalog }) || null;
      const seconds = Math.min(VIDEO_MAX_SEC, Math.max(VIDEO_MIN_SEC, Math.round(s.duration_ms / 1000)));
      specs.push({ provider: prov.image.provider, kind: 'image', params: { model: imageModel, n: 1 } });
      specs.push({ provider: prov.video.provider, kind: 'video', params: { model: videoModel, duration: seconds } });
      return { index, title: s.title, duration_ms: s.duration_ms, seconds, image: { provider: prov.image.provider, model: imageModel }, video: { provider: prov.video.provider, model: videoModel } };
    });
    const check = spend.checkBatch(specs);
    const pick = (e) => ({ estimate: e.estimate, max: e.max, known: e.known, basis: e.basis });
    const items = shots.map((s, i) => {
      const ie = check.estimates[2 * i];
      const ve = check.estimates[2 * i + 1];
      return { ...s, image: { ...s.image, ...pick(ie) }, video: { ...s.video, ...pick(ve) }, subtotal: round(ie.estimate + ve.estimate), subtotal_max: round(ie.max + ve.max) };
    });
    return {
      template_id: m.id, items,
      total: round(items.reduce((a, x) => a + x.subtotal, 0)), max: round(items.reduce((a, x) => a + x.subtotal_max, 0)),
      currency: check.currency, known: check.known, sample_prices: check.sample_prices,
      provider_ready: prov.image.ready && prov.video.ready,
      check: { ok: check.ok, reason: check.reason, message: check.message, total: check.total, max: check.max, cap: check.cap },
    };
  }

  // ---------- 套用 ----------

  function normalizeMap(m, characterMap) {
    const slotIds = m.character_slots.map((s) => s.id);
    const out = {};
    for (const [slot, raw] of Object.entries(characterMap || {})) {
      if (!slotIds.includes(slot)) throw new TemplateError('TEMPLATE_INVALID', `未知的角色槽位：${slot}`, 400);
      if (raw === null || raw === undefined || raw === '') continue;
      const cid = Number(raw);
      if (!Number.isInteger(cid) || cid <= 0) throw new TemplateError('TEMPLATE_INVALID', `角色槽位 ${slot} 的角色 id 不合法`, 400);
      out[slot] = cid;
    }
    return out;
  }

  function cloneCharacter(src, dramaId) {
    const cols = CHARACTER_COPY_COLUMNS.filter((c) => src[c] !== undefined);
    const ts = nowIso();
    const info = db.prepare(`INSERT INTO characters (drama_id, ${cols.join(', ')}, sort_order, created_at, updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?, ?)`)
      .run(dramaId, ...cols.map((c) => src[c]), src.sort_order || 0, ts, ts);
    const id = Number(info.lastInsertRowid);
    const lock = referenceLocks.getLock(db, 'character', src.id);
    if (lock && (lock.image_url || lock.local_path)) referenceLocks.setLock(db, 'character', id, { image_url: lock.image_url, local_path: lock.local_path, source_image_id: lock.source_image_id });
    return id;
  }

  /** 槽位 -> 角色行：映射的沿用（新项目时克隆到新项目并复制锁定参考图），没映射的按槽位描述新建占位角色。 */
  function resolveCharacters(m, map, mode, dramaId, episodeId) {
    const ts = nowIso();
    const link = db.prepare('INSERT OR IGNORE INTO episode_characters (episode_id, character_id) VALUES (?, ?)');
    const out = {};
    m.character_slots.forEach((slot, i) => {
      let rec;
      if (map[slot.id]) {
        const src = db.prepare('SELECT * FROM characters WHERE id = ? AND deleted_at IS NULL').get(map[slot.id]);
        if (!src) throw new TemplateError('TEMPLATE_INVALID', `角色 ${map[slot.id]} 不存在`, 400);
        if (mode === 'episode' && Number(src.drama_id) !== Number(dramaId)) throw new TemplateError('TEMPLATE_INVALID', `角色「${src.name}」不属于该项目`, 400);
        const id = mode === 'new' ? cloneCharacter(src, dramaId) : Number(src.id);
        rec = { slot: slot.id, character_id: id, name: src.name, appearance: src.appearance || '', mapped: true, cloned_from: mode === 'new' ? Number(src.id) : null };
      } else {
        const info = db.prepare('INSERT INTO characters (drama_id, name, role, description, appearance, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(dramaId, slot.name, slot.role || '', slot.description || '', slot.appearance || '', i, ts, ts);
        rec = { slot: slot.id, character_id: Number(info.lastInsertRowid), name: slot.name, appearance: slot.appearance || '', mapped: false, cloned_from: null };
      }
      const lock = referenceLocks.getLock(db, 'character', rec.character_id);
      rec.locked_ref = referenceLocks.lockToRefUrl(lock) || null;
      link.run(episodeId, rec.character_id);
      out[slot.id] = rec;
    });
    return out;
  }

  /** 在 chain 上建整张图：段落（按 shot.group 分组，缺省一组）、镜头、台词行、参考图哈希。返回镜头节点 id。 */
  function buildGraph(c, m, chars) {
    const names = {};
    const described = {};
    for (const [slot, r] of Object.entries(chars)) {
      names[slot] = r.name;
      described[slot] = r.appearance ? `${r.name}（${r.appearance}）` : r.name;
    }
    const groups = new Map();
    let gn = 0;
    const groupFor = (title) => {
      const t = (title && String(title).trim()) || m.name;
      if (!groups.has(t)) {
        let gid;
        do { gid = `grp_${++gn}`; } while (c.g.groups[gid]);
        c.raw([{ op: 'addGroup', group: { id: gid, title: t, children: [] } }]);
        groups.set(t, gid);
      }
      return groups.get(t);
    };
    const shotIds = [];
    for (const s of m.shots) {
      const gid = groupFor(s.group);
      const base = { scene: s.scene_slot || '', style: m.style.prompt };
      const description = schema.renderPrompt(s.prompt_template, { ...base, slots: names });
      const image_prompt = [schema.renderPrompt(s.prompt_template, { ...base, slots: described }), m.style.prompt].filter(Boolean).join('，');
      const video_prompt = [s.camera, description].filter(Boolean).join('，');
      const characters = (s.character_slots || []).map((slot) => chars[slot].character_id);
      const params = {
        title: s.title, description, image_prompt, video_prompt, shot_type: s.camera || '', location: s.scene_slot || '',
        characters, duration_ms: s.duration_ms,
      };
      const lineIds = [];
      for (const l of s.lines || []) {
        const at = c.g.groups[gid].children.filter((id) => c.g.nodes[id].type === 'script_line').length;
        const speaker = l.speaker && chars[l.speaker] ? chars[l.speaker].name : '';
        lineIds.push(c.add(I.script.insertLine(c.g, { group: gid, index: at, kind: l.kind, speaker, text: l.text })).line_id);
      }
      const index = c.g.groups[gid].children.filter((id) => c.g.nodes[id].type === 'shot').length;
      const shotId = c.add(I.shot.addShot(c.g, { group: gid, index, params, lines: lineIds })).shot_id;
      // 与 kernel/inputs.js 同一规则：角色按镜头顺序、去重、最多 MAX_REFS 张，哈希进 image.reference_hashes
      const refs = [];
      for (const slot of s.character_slots || []) {
        const u = chars[slot].locked_ref;
        if (u && !refs.includes(u)) refs.push(u);
      }
      if (refs.length) c.add(I.shot.setShotReferences(c.g, shotId, { reference_hashes: refs.slice(0, inputs.MAX_REFS).map(inputs.hashRef) }));
      shotIds.push(shotId);
    }
    return shotIds;
  }

  /**
   * 套用模板。mode 'new'：新建项目 + 第 1 集；'episode'：在 dramaId 下建下一集。
   * characterMap: { slotId: characterId }（新项目时角色被克隆进新项目并带上锁定参考图）。
   */
  async function apply(id, { mode = 'new', dramaId, title, characterMap = {}, tx_id } = {}) {
    const row = need(id);
    const m = row.manifest;
    if (mode !== 'new' && mode !== 'episode') throw new TemplateError('TEMPLATE_INVALID', "mode 须为 'new' 或 'episode'", 400);
    if (mode === 'episode' && !(Number.isInteger(Number(dramaId)) && Number(dramaId) > 0)) throw new TemplateError('TEMPLATE_INVALID', '续集模式需要 drama_id', 400);
    if (title !== undefined && title !== null && (typeof title !== 'string' || title.length > 200)) throw new TemplateError('TEMPLATE_INVALID', '标题须为 200 字以内的字符串', 400);
    const map = normalizeMap(m, characterMap);
    if (m.tier === 'pro') {
      const pro = await proState();
      if (!pro.available) throw new TemplateError('TEMPLATE_PRO_REQUIRED', pro.reason || '当前账号不能使用付费模板', 403, { template_id: m.id });
    }
    const txId = tx_id || `tpl-${m.id}-${crypto.randomUUID()}`;
    const ts = nowIso();
    const cleanTitle = (title || '').trim();

    return db.transaction(() => {
      let drama;
      let episodeNumber;
      if (mode === 'new') {
        drama = dramaService.createDrama(db, log, {
          title: cleanTitle || m.name, description: m.description || '', genre: m.genre, style: (m.style && m.style.preset) || 'realistic',
          metadata: { template: { id: m.id, version: m.version, name: m.name }, music_hint: m.music_hint || null, template_style: m.style },
        });
        episodeNumber = 1;
      } else {
        drama = dramaService.getDramaById(db, Number(dramaId));
        if (!drama) throw new TemplateError('NOT_FOUND', `项目 ${dramaId} 不存在`, 404);
        episodeNumber = Number(db.prepare('SELECT COALESCE(MAX(episode_number), 0) + 1 AS n FROM episodes WHERE drama_id = ? AND deleted_at IS NULL').get(drama.id).n);
      }
      const totalSec = Math.round(m.shots.reduce((a, s) => a + s.duration_ms, 0) / 1000);
      const episodeTitle = mode === 'new' ? `第 1 集 ${cleanTitle || m.name}` : (cleanTitle || `第 ${episodeNumber} 集 ${m.name}`);
      const epInfo = db.prepare(`INSERT INTO episodes (drama_id, episode_number, title, script_content, description, duration, status, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, ?, 'draft', ?, ?)`).run(drama.id, episodeNumber, episodeTitle, m.description || '', totalSec, ts, ts);
      const episodeId = Number(epInfo.lastInsertRowid);
      const chars = resolveCharacters(m, map, mode, drama.id, episodeId);

      legacy.importLegacy(db, episodeId); // 空剧集 -> 只有合成节点的图
      let shotIds = [];
      const r = store.commit(db, episodeId, (g) => {
        const c = new Chain(g);
        shotIds = buildGraph(c, m, chars);
        return c.tx('applyTemplate', txId);
      }, { tx_id: txId });
      kernel.validateGraph(r.graph);

      db.prepare('UPDATE installed_templates SET use_count = use_count + 1 WHERE id = ?').run(m.id);
      db.prepare('UPDATE dramas SET total_episodes = (SELECT COUNT(*) FROM episodes WHERE drama_id = ? AND deleted_at IS NULL), updated_at = ? WHERE id = ?').run(drama.id, ts, drama.id);
      const storyboardIds = shotIds.map((s) => r.graph.nodes[s].legacy_id).filter((x) => x != null);
      log.info && log.info('template applied', { template: m.id, mode, drama_id: drama.id, episode_id: episodeId, shots: shotIds.length });
      return {
        template_id: m.id, template_version: m.version, mode, tx_id: txId,
        drama_id: Number(drama.id), episode_id: episodeId, episode_number: episodeNumber, title: mode === 'new' ? (cleanTitle || m.name) : episodeTitle,
        characters: Object.values(chars).map(({ slot, character_id, name, mapped, cloned_from, locked_ref }) => ({ slot, character_id, name, mapped, cloned_from, locked: !!locked_ref })),
        shots: shotIds.length, shot_ids: shotIds, storyboard_ids: storyboardIds,
        groups: r.graph.group_order.length, use_count: row.use_count + 1,
      };
    })();
  }

  // ---------- 安装 ----------

  /** 验签：没有 signature -> unsigned；有 -> 用 kid 取云端公钥，payload 必须等于清单摘要；取不到公钥（离线且无缓存）-> unsigned。 */
  async function verifySignature(m) {
    if (!m.signature) return { status: 'unsigned', reason: 'no_signature', kid: null };
    const header = peekHeader(m.signature);
    if (!header || header.alg !== 'ES256' || typeof header.kid !== 'string' || !header.kid) throw new TemplateError('TEMPLATE_SIGNATURE_INVALID', '模板签名格式不正确', 400);
    let jwk = jwks ? jwks.cachedKey(header.kid) : null;
    if (!jwk && jwks && cloud.isConfigured()) {
      try {
        jwk = await jwks.getKey(header.kid);
      } catch (e) {
        if (e && e.message === 'unknown kid') throw new TemplateError('TEMPLATE_SIGNATURE_INVALID', '模板签名使用了云端不认识的密钥', 400, { kid: header.kid });
        warn('template jwks unavailable', { kid: header.kid, error: e && e.message });
      }
    }
    if (!jwk) return { status: 'unsigned', reason: 'key_unavailable', kid: header.kid };
    try {
      const { payload } = verifyEs256(m.signature, jwk);
      if (payload.toString('utf8') !== schema.templateDigest(m)) throw new Error('digest mismatch');
    } catch (e) {
      throw new TemplateError('TEMPLATE_SIGNATURE_INVALID', `模板签名无效：${e.message}`, 400, { kid: header.kid });
    }
    return { status: 'official', reason: null, kid: header.kid };
  }

  /** install({ path }) 读目录 / 压缩包；install({ manifest, source:'cloud'|'local' }) 直接装清单。 */
  async function install({ path: p, manifest: given, source } = {}) {
    let manifest;
    let src;
    if (p) { manifest = loadPackage(p).manifest; src = 'local'; }
    else if (given && typeof given === 'object') { manifest = given; src = source === 'cloud' ? 'cloud' : 'local'; }
    else throw new TemplateError('TEMPLATE_PACKAGE_INVALID', '需要 path（目录或 .lytpl）或 manifest', 400);
    const v = schema.validateManifest(manifest);
    if (!v.ok) throw new TemplateError('TEMPLATE_INVALID', `模板清单不合法：${v.errors[0].path ? v.errors[0].path + '：' : ''}${v.errors[0].message}`, 400, { errors: v.errors });
    const existing = rowOf(manifest.id);
    if (existing && existing.source === 'builtin') throw new TemplateError('TEMPLATE_BUILTIN_READONLY', `内置模板 ${manifest.id} 不能被覆盖`, 409);
    const sig = await verifySignature(manifest);
    upsert(manifest, { source: src, signature_status: sig.status });
    log.info && log.info('template installed', { id: manifest.id, version: manifest.version, source: src, signature: sig.status });
    return { ...get(manifest.id), signature: sig, replaced: !!existing };
  }

  function remove(id) {
    const row = need(id);
    if (row.source === 'builtin') throw new TemplateError('TEMPLATE_BUILTIN_READONLY', '内置模板不能删除', 409);
    db.prepare('DELETE FROM installed_templates WHERE id = ?').run(row.id);
    return { id: row.id, removed: true };
  }

  /** 云端模板目录（已签名清单），标注本地是否已安装。 */
  async function cloudCatalog() {
    if (!cloud || !cloud.isConfigured()) throw new TemplateError('CLOUD_NOT_CONFIGURED', '尚未配置云端地址（config.yaml 的 cloud.base_url）', 503);
    const r = await cloud.http.request('GET', '/templates/catalog');
    const items = (r && Array.isArray(r.items)) ? r.items : [];
    const out = [];
    for (const it of items) {
      const m = it && it.manifest;
      if (!m || !schema.validateManifest(m).ok) continue;
      const local = rowOf(m.id);
      out.push({
        id: m.id, name: m.name, version: m.version, genre: m.genre, tier: m.tier, description: m.description || '', cover: m.cover || null,
        summary: schema.summaryOf(m), sha256: it.sha256 || null, kid: it.kid || null, published_at: it.published_at || it.createdAt || null,
        installed: !!local, installed_version: local ? local.version : null, manifest: m,
      });
    }
    return { items: out, issued_at: (r && r.issued_at) || null };
  }

  syncBuiltins();

  return { list: listTemplates, get, estimate, apply, install, remove, cloudCatalog, syncBuiltins, verifySignature, isPro: () => proState() };
}

module.exports = { createTemplateService, TemplateError, DEFAULT_BUILTIN_DIR };
