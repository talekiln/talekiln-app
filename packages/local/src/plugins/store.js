'use strict';
/** installed_plugins rows (migration 32). The row id is the plugin name (= provider id). */

const SIGNATURE_STATUSES = Object.freeze(['official', 'unsigned', 'invalid']);

function rowToRecord(r) {
  if (!r) return null;
  let manifest = null;
  let permissions = [];
  try { manifest = JSON.parse(r.manifest); } catch (_) { manifest = null; }
  try { permissions = JSON.parse(r.permissions) || []; } catch (_) { permissions = []; }
  return {
    id: r.id, name: r.name, version: r.version, dir: r.dir, manifest, permissions,
    signature_status: SIGNATURE_STATUSES.includes(r.signature_status) ? r.signature_status : 'invalid',
    signature_kid: r.signature_kid || null, signature_hash: r.signature_hash || null,
    enabled: r.enabled === 1 || r.enabled === true, reviewed_at: r.reviewed_at || null,
    installed_at: r.installed_at, updated_at: r.updated_at,
  };
}

function listRows(db) {
  return db.prepare('SELECT * FROM installed_plugins ORDER BY name').all().map(rowToRecord);
}

function getRow(db, id) {
  return rowToRecord(db.prepare('SELECT * FROM installed_plugins WHERE id = ?').get(String(id)));
}

/**
 * Insert or refresh a row. `enabled` and `installed_at` of an existing row are kept unless `patch.enabled`
 * is given explicitly (re-scans must not flip a switch the user set).
 */
function upsertRow(db, p, now = new Date().toISOString()) {
  const cur = getRow(db, p.id);
  const enabled = p.enabled !== undefined ? (p.enabled ? 1 : 0) : (cur ? (cur.enabled ? 1 : 0) : 1);
  db.prepare(`INSERT INTO installed_plugins (id, name, version, dir, manifest, signature_status, signature_kid, signature_hash, permissions, enabled, reviewed_at, installed_at, updated_at)
    VALUES (@id, @name, @version, @dir, @manifest, @signature_status, @signature_kid, @signature_hash, @permissions, @enabled, @reviewed_at, @installed_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, dir = excluded.dir, manifest = excluded.manifest,
      signature_status = excluded.signature_status, signature_kid = excluded.signature_kid, signature_hash = excluded.signature_hash,
      permissions = excluded.permissions, enabled = excluded.enabled, reviewed_at = excluded.reviewed_at, updated_at = excluded.updated_at`).run({
    id: p.id, name: p.name, version: p.version, dir: p.dir, manifest: JSON.stringify(p.manifest),
    signature_status: p.signature_status, signature_kid: p.signature_kid || null, signature_hash: p.signature_hash || null,
    permissions: JSON.stringify(p.permissions || []), enabled,
    reviewed_at: p.reviewed_at !== undefined ? p.reviewed_at : (cur ? cur.reviewed_at : null),
    installed_at: cur ? cur.installed_at : now, updated_at: now,
  });
  return getRow(db, p.id);
}

function setEnabled(db, id, enabled, now = new Date().toISOString()) {
  return db.prepare('UPDATE installed_plugins SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now, String(id)).changes === 1;
}

function setReviewedAt(db, id, reviewedAt, now = new Date().toISOString()) {
  return db.prepare('UPDATE installed_plugins SET reviewed_at = ?, updated_at = ? WHERE id = ?').run(reviewedAt || null, now, String(id)).changes === 1;
}

function deleteRow(db, id) {
  return db.prepare('DELETE FROM installed_plugins WHERE id = ?').run(String(id)).changes === 1;
}

module.exports = { SIGNATURE_STATUSES, listRows, getRow, upsertRow, setEnabled, setReviewedAt, deleteRow, rowToRecord };
