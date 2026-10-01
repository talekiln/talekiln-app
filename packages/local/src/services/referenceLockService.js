'use strict';
/**
 * Locked reference images (P1-07). A character/scene can have one "locked" reference image;
 * shots that use that character/scene automatically send it as a reference image.
 */

const ENTITY_TYPES = new Set(['character', 'scene']);
const MAX_REFS = 9;

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS reference_locks (
    entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, image_url TEXT, local_path TEXT,
    source_image_id INTEGER, locked_at TEXT, PRIMARY KEY (entity_type, entity_id))`);
}

function assertType(type) {
  if (!ENTITY_TYPES.has(type)) throw new Error('entity_type must be character or scene');
}

/** Image reference as sent to video providers: local file via /static/ path, else the remote URL. */
function lockToRefUrl(lock) {
  if (!lock) return '';
  const lp = lock.local_path && String(lock.local_path).trim();
  if (lp) return '/static/' + lp.replace(/^\//, '');
  return (lock.image_url && String(lock.image_url).trim()) || '';
}

function getLock(db, type, id) {
  assertType(type);
  return db.prepare('SELECT * FROM reference_locks WHERE entity_type = ? AND entity_id = ?').get(type, Number(id)) || null;
}

function setLock(db, type, id, { image_url, local_path, source_image_id } = {}) {
  assertType(type);
  if (!(image_url || local_path)) throw new Error('image_url or local_path required');
  db.prepare(
    `INSERT INTO reference_locks (entity_type, entity_id, image_url, local_path, source_image_id, locked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET image_url = excluded.image_url, local_path = excluded.local_path,
       source_image_id = excluded.source_image_id, locked_at = excluded.locked_at`
  ).run(type, Number(id), image_url || null, local_path || null, source_image_id != null ? Number(source_image_id) : null, new Date().toISOString());
  return getLock(db, type, id);
}

function clearLock(db, type, id) {
  assertType(type);
  return db.prepare('DELETE FROM reference_locks WHERE entity_type = ? AND entity_id = ?').run(type, Number(id)).changes > 0;
}

function listLocks(db, type, ids) {
  assertType(type);
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
  if (!list.length) return [];
  return db.prepare(`SELECT * FROM reference_locks WHERE entity_type = ? AND entity_id IN (${list.map(() => '?').join(',')})`).all(type, ...list);
}

function parseCharacterIds(value) {
  let arr = value;
  if (typeof value === 'string') {
    try { arr = JSON.parse(value); } catch (_) { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const c of arr) {
    const n = Number(c && typeof c === 'object' ? c.id : c);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Locked reference URLs for a shot: scene first, then characters in shot order. */
function collectLockedRefsForStoryboard(db, storyboardId) {
  if (!storyboardId) return [];
  const sb = db.prepare('SELECT scene_id, characters FROM storyboards WHERE id = ?').get(Number(storyboardId));
  if (!sb) return [];
  const urls = [];
  const push = (lock) => { const u = lockToRefUrl(lock); if (u && !urls.includes(u)) urls.push(u); };
  if (sb.scene_id) push(getLock(db, 'scene', sb.scene_id));
  for (const cid of parseCharacterIds(sb.characters)) push(getLock(db, 'character', cid));
  return urls;
}

/**
 * Builds the reference part of a video request.
 * - Explicit refs on the row (omni mode) keep priority; locked refs are appended (deduped, capped).
 * - If the row had no explicit refs, locked refs are added but first/last frames are kept
 *   (explicitOmni=false), so a normal first-frame generation is not turned into omni mode.
 */
function mergeLockedReferences(row, lockedUrls) {
  let explicit = [];
  if (row && row.reference_image_urls) {
    try { const p = JSON.parse(row.reference_image_urls); if (Array.isArray(p)) explicit = p.filter(Boolean); } catch (_) {}
  }
  const merged = [...explicit];
  for (const u of lockedUrls || []) if (u && !merged.includes(u)) merged.push(u);
  const reference_urls = merged.slice(0, MAX_REFS);
  return { reference_urls: reference_urls.length ? reference_urls : null, explicitOmni: explicit.length > 0 };
}

module.exports = { ensureSchema, lockToRefUrl, getLock, setLock, clearLock, listLocks, parseCharacterIds, collectLockedRefsForStoryboard, mergeLockedReferences, MAX_REFS };
