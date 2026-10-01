'use strict';
const crypto = require('crypto');
const { STATES, ACTIVE, canTransition } = require('./states');

/**
 * Persistence for ai_tasks. Ordinary writes use the connection's current synchronous
 * level. The two writes that guard against duplicate vendor submits (submit_started_at
 * and vendor_task_id) go through durableWrite(), which forces PRAGMA synchronous=FULL
 * so the WAL is fsynced before the call returns.
 */
function createAiTaskStore(db, { now = () => Date.now(), onDurableCommit } = {}) {
  const get = (id) => db.prepare('SELECT * FROM ai_tasks WHERE id = ?').get(id) || null;
  const getByKey = (key) => db.prepare('SELECT * FROM ai_tasks WHERE idempotency_key = ?').get(key) || null;

  function durableWrite(fn) {
    const prev = db.pragma('synchronous', { simple: true });
    db.pragma('synchronous = FULL');
    try {
      const out = db.transaction(fn)();
      if (onDurableCommit) onDurableCommit(db.pragma('synchronous', { simple: true }));
      return out;
    } finally {
      db.pragma(`synchronous = ${prev}`);
    }
  }

  function enqueue({ idempotencyKey, provider, kind = 'generic', params = null }) {
    if (!idempotencyKey || !provider) throw new Error('idempotencyKey and provider are required');
    const t = now();
    const id = crypto.randomUUID();
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO ai_tasks (id, idempotency_key, provider, kind, state, params, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`
      )
      .run(id, idempotencyKey, provider, kind, params == null ? null : JSON.stringify(params), t, t);
    return { task: getByKey(idempotencyKey), created: info.changes === 1 };
  }

  /** Atomic compare-and-set transition. Returns true when this caller won. */
  function transition(id, from, to, fields = {}) {
    if (!canTransition(from, to)) throw new Error(`illegal transition ${from} -> ${to}`);
    const cols = { state: to, updated_at: now(), ...fields };
    const sets = Object.keys(cols).map((c) => `${c} = @${c}`).join(', ');
    const info = db.prepare(`UPDATE ai_tasks SET ${sets} WHERE id = @id AND state = @from`).run({ ...cols, id, from });
    return info.changes === 1;
  }

  /** queued -> submitting, counts the attempt. */
  function claim(id) {
    const info = db
      .prepare(
        `UPDATE ai_tasks SET state='submitting', attempts = attempts + 1, updated_at=?, next_attempt_at=NULL
         WHERE id=? AND state='queued'`
      )
      .run(now(), id);
    return info.changes === 1;
  }

  /** Durable marker written BEFORE the provider is called: from here a submit may have reached the vendor. */
  function markSubmitStarted(id) {
    return durableWrite(
      () => db.prepare(`UPDATE ai_tasks SET submit_started_at=?, updated_at=? WHERE id=? AND state='submitting'`).run(now(), now(), id).changes === 1
    );
  }

  /** Durable write of the vendor task id (fsync'd). Never overwrites an existing id. */
  function recordVendorId(id, vendorTaskId, fromState = STATES.SUBMITTING) {
    if (!vendorTaskId) throw new Error('vendorTaskId required');
    return durableWrite(
      () =>
        db
          .prepare(
            `UPDATE ai_tasks SET vendor_task_id=?, state='submitted', submitted_at=?, updated_at=?, error_code=NULL, error_message=NULL
             WHERE id=? AND state=? AND vendor_task_id IS NULL`
          )
          .run(String(vendorTaskId), now(), now(), id, fromState).changes === 1
    );
  }

  function requeue(id, { nextAttemptAt = null, errorCode = null, errorMessage = null } = {}) {
    return (
      db
        .prepare(
          `UPDATE ai_tasks SET state='queued', next_attempt_at=?, error_code=?, error_message=?, submit_started_at=NULL, updated_at=?
           WHERE id=? AND state='submitting' AND vendor_task_id IS NULL`
        )
        .run(nextAttemptAt, errorCode, errorMessage, now(), id).changes === 1
    );
  }

  function fail(id, errorCode, errorMessage) {
    const row = get(id);
    if (!row || !canTransition(row.state, STATES.FAILED)) return false;
    return transition(id, row.state, STATES.FAILED, {
      error_code: errorCode || 'UNKNOWN',
      error_message: errorMessage || null,
      completed_at: now(),
    });
  }

  function succeed(id, result) {
    const row = get(id);
    if (!row || !canTransition(row.state, STATES.SUCCEEDED)) return false;
    return transition(id, row.state, STATES.SUCCEEDED, {
      result: result === undefined ? null : JSON.stringify(result),
      completed_at: now(),
    });
  }

  function cancel(id) {
    const row = get(id);
    if (!row || !canTransition(row.state, STATES.CANCELLED)) return false;
    return transition(id, row.state, STATES.CANCELLED, { completed_at: now() });
  }

  function listByState(states, { provider, dueAt } = {}) {
    const ph = states.map(() => '?').join(',');
    let sql = `SELECT * FROM ai_tasks WHERE state IN (${ph})`;
    const args = [...states];
    if (provider) { sql += ' AND provider = ?'; args.push(provider); }
    if (dueAt != null) { sql += ' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)'; args.push(dueAt); }
    return db.prepare(sql + ' ORDER BY created_at, rowid').all(...args);
  }

  function countActive(provider) {
    const ph = ACTIVE.map(() => '?').join(',');
    return db.prepare(`SELECT COUNT(*) n FROM ai_tasks WHERE provider=? AND state IN (${ph})`).get(provider, ...ACTIVE).n;
  }

  return {
    get, getByKey, enqueue, claim, markSubmitStarted, recordVendorId, requeue, transition,
    fail, succeed, cancel, listByState, countActive, durableWrite,
  };
}

module.exports = { createAiTaskStore };
