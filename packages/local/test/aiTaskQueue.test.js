const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createAiTaskStore, createAiTaskQueue, CrashSignal } = require('../src/queue');
const { ProviderError, ERROR_CODES } = require('../src/providers/errors');

const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', '23_ai_tasks.sql'), 'utf8');

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aitasks-')), 'test.db');
}
function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(MIGRATION);
  return db;
}

/** Fake vendor that survives "process restarts" (lives outside the DB). */
function makeVendor({ dedupe = false } = {}) {
  const v = { submits: [], byKey: new Map(), polls: 0, status: 'succeeded', pollError: null, submitError: null };
  v.provider = {
    async submit(task, { idempotencyKey }) {
      v.submits.push(idempotencyKey);
      if (v.submitError) throw v.submitError;
      const id = `vendor-${v.submits.length}`;
      v.byKey.set(idempotencyKey, id);
      return { vendorTaskId: id };
    },
    async poll(task) {
      v.polls++;
      if (v.pollError) throw v.pollError;
      return { status: v.status, result: { url: `http://x/${task.vendor_task_id}` }, errorMessage: 'boom' };
    },
  };
  if (dedupe) v.provider.lookupByKey = async (k) => v.byKey.get(k) || null;
  return v;
}

function boot(file, vendor, opts = {}) {
  const db = openDb(file);
  const store = createAiTaskStore(db, opts.storeOpts);
  const queue = createAiTaskQueue({ store, providers: { fake: vendor.provider }, ...opts.queueOpts });
  return { db, store, queue };
}

function crashAt(point) {
  return (p) => { if (p === point) throw new CrashSignal(p); };
}

describe('ai_tasks queue', () => {
  it('runs queued -> succeeded and records attempts/timestamps', async () => {
    const file = tmpDbPath();
    const vendor = makeVendor();
    const { db, store, queue } = boot(file, vendor);
    const { task } = queue.enqueue({ idempotencyKey: 'k1', provider: 'fake', params: { a: 1 } });
    assert.equal(task.state, 'queued');
    await queue.tick();
    let row = store.get(task.id);
    assert.equal(row.state, 'submitted');
    assert.equal(row.vendor_task_id, 'vendor-1');
    assert.equal(row.attempts, 1);
    assert.ok(row.submitted_at);
    await queue.tick();
    row = store.get(task.id);
    assert.equal(row.state, 'succeeded');
    assert.ok(row.completed_at);
    assert.deepEqual(JSON.parse(row.result), { url: 'http://x/vendor-1' });
    db.close();
  });

  it('idempotency: same key never submits twice', async () => {
    const file = tmpDbPath();
    const vendor = makeVendor();
    const { db, queue } = boot(file, vendor);
    const a = queue.enqueue({ idempotencyKey: 'same', provider: 'fake' });
    const b = queue.enqueue({ idempotencyKey: 'same', provider: 'fake' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.task.id, b.task.id);
    await queue.tick();
    await queue.tick();
    queue.enqueue({ idempotencyKey: 'same', provider: 'fake' });
    await queue.tick();
    assert.equal(vendor.submits.length, 1);
    db.close();
  });

  it('vendor id write runs with synchronous=FULL and restores the previous level', async () => {
    const file = tmpDbPath();
    const seen = [];
    const vendor = makeVendor();
    const { db, queue } = boot(file, vendor, { storeOpts: { onDurableCommit: (s) => seen.push(s) } });
    queue.enqueue({ idempotencyKey: 'k', provider: 'fake' });
    await queue.tick();
    assert.ok(seen.length >= 2);
    assert.ok(seen.every((s) => s === 2), 'FULL == 2');
    assert.equal(db.pragma('synchronous', { simple: true }), 1, 'restored to NORMAL');
    db.close();
  });

  describe('kill simulation (crash then reopen the DB file)', () => {
    it('crash before submit: provider never called, task not lost, resubmitted exactly once after reconcile', async () => {
      const file = tmpDbPath();
      const vendor = makeVendor();
      let s = boot(file, vendor, { queueOpts: { crash: crashAt('before_submit') } });
      const { task } = s.queue.enqueue({ idempotencyKey: 'k', provider: 'fake' });
      await assert.rejects(s.queue.tick(), CrashSignal);
      s.db.close(); // no cleanup, like a kill
      assert.equal(vendor.submits.length, 0);

      s = boot(file, vendor);
      assert.equal(s.store.get(task.id).state, 'submitting');
      const rec = await s.queue.reconcile();
      assert.deepEqual(rec.requeued, [task.id]);
      assert.equal(vendor.submits.length, 0, 'reconcile never submits');
      await s.queue.tick();
      assert.equal(vendor.submits.length, 1);
      assert.equal(s.store.get(task.id).vendor_task_id, 'vendor-1');
      s.db.close();
    });

    it('crash after submit before id write: never resubmits (uncertain, failed without lookup)', async () => {
      const file = tmpDbPath();
      const vendor = makeVendor();
      let s = boot(file, vendor, { queueOpts: { crash: crashAt('after_submit') } });
      const { task } = s.queue.enqueue({ idempotencyKey: 'k', provider: 'fake' });
      await assert.rejects(s.queue.tick(), CrashSignal);
      s.db.close();
      assert.equal(vendor.submits.length, 1);

      s = boot(file, vendor);
      const rec = await s.queue.reconcile();
      assert.deepEqual(rec.uncertain, [task.id]);
      await s.queue.tick();
      await s.queue.tick();
      assert.equal(vendor.submits.length, 1, 'no duplicate submit');
      const row = s.store.get(task.id);
      assert.equal(row.state, 'failed');
      assert.equal(row.error_code, ERROR_CODES.UNKNOWN);
      assert.match(row.error_message, /SUBMIT_UNCERTAIN/);
      s.db.close();
    });

    it('crash after submit before id write: vendor lookup by idempotency key recovers the id', async () => {
      const file = tmpDbPath();
      const vendor = makeVendor({ dedupe: true });
      let s = boot(file, vendor, { queueOpts: { crash: crashAt('after_submit') } });
      const { task } = s.queue.enqueue({ idempotencyKey: 'k', provider: 'fake' });
      await assert.rejects(s.queue.tick(), CrashSignal);
      s.db.close();

      s = boot(file, vendor);
      const rec = await s.queue.reconcile();
      assert.deepEqual(rec.recovered, [task.id]);
      assert.equal(vendor.submits.length, 1);
      const row = s.store.get(task.id);
      assert.equal(row.vendor_task_id, 'vendor-1');
      assert.equal(row.state, 'succeeded');
      s.db.close();
    });

    it('crash after id write: id survives reopen and reconcile resumes without resubmit', async () => {
      const file = tmpDbPath();
      const vendor = makeVendor();
      let s = boot(file, vendor, { queueOpts: { crash: crashAt('after_id_write') } });
      const { task } = s.queue.enqueue({ idempotencyKey: 'k', provider: 'fake' });
      await assert.rejects(s.queue.tick(), CrashSignal);
      s.db.close();

      s = boot(file, vendor);
      const row0 = s.store.get(task.id);
      assert.equal(row0.vendor_task_id, 'vendor-1');
      assert.equal(row0.state, 'submitted');
      const rec = await s.queue.reconcile();
      assert.deepEqual(rec.resumed, [task.id]);
      await s.queue.tick();
      assert.equal(vendor.submits.length, 1);
      assert.equal(s.store.get(task.id).state, 'succeeded');
      s.db.close();
    });
  });

  describe('reconcile', () => {
    it('resumes submitted and polling tasks, honors running status, never resubmits', async () => {
      const file = tmpDbPath();
      const vendor = makeVendor();
      vendor.status = 'running';
      let s = boot(file, vendor);
      const a = s.queue.enqueue({ idempotencyKey: 'a', provider: 'fake' }).task;
      const b = s.queue.enqueue({ idempotencyKey: 'b', provider: 'fake' }).task;
      await s.queue.tick(); // both submitted
      await s.queue.tick(); // both polling
      assert.equal(s.store.get(a.id).state, 'polling');
      s.db.close();

      vendor.status = 'succeeded';
      s = boot(file, vendor);
      await s.queue.reconcile();
      assert.equal(s.store.get(a.id).state, 'succeeded');
      assert.equal(s.store.get(b.id).state, 'succeeded');
      assert.equal(vendor.submits.length, 2);
      s.db.close();
    });

    it('resumes downloading tasks via provider.download', async () => {
      const file = tmpDbPath();
      const vendor = makeVendor();
      vendor.provider.download = async (task, res) => ({ ...res, local: 'file.mp4' });
      let s = boot(file, vendor);
      const { task } = s.queue.enqueue({ idempotencyKey: 'a', provider: 'fake' });
      await s.queue.tick();
      s.store.transition(task.id, 'submitted', 'downloading', { result: JSON.stringify({ url: 'u' }) });
      s.db.close();
      s = boot(file, vendor);
      await s.queue.reconcile();
      const row = s.store.get(task.id);
      assert.equal(row.state, 'succeeded');
      assert.equal(JSON.parse(row.result).local, 'file.mp4');
      s.db.close();
    });

    it('maps vendor failure to a providers/errors.js code', async () => {
      const file = tmpDbPath();
      const vendor = makeVendor();
      vendor.status = 'failed';
      const s = boot(file, vendor);
      const { task } = s.queue.enqueue({ idempotencyKey: 'a', provider: 'fake' });
      await s.queue.tick();
      await s.queue.reconcile();
      const row = s.store.get(task.id);
      assert.equal(row.state, 'failed');
      assert.equal(row.error_code, ERROR_CODES.TASK_FAILED);
      s.db.close();
    });
  });

  describe('concurrency and rate limiting hooks', () => {
    it('per-provider concurrency limit caps active tasks', async () => {
      const file = tmpDbPath();
      const vendor = makeVendor();
      vendor.status = 'running';
      const s = boot(file, vendor, { queueOpts: { limits: { fake: 2 } } });
      for (const k of ['a', 'b', 'c']) s.queue.enqueue({ idempotencyKey: k, provider: 'fake' });
      await s.queue.tick();
      assert.equal(vendor.submits.length, 2);
      await s.queue.tick();
      assert.equal(vendor.submits.length, 2, 'still at limit while others run');
      vendor.status = 'succeeded';
      await s.queue.tick(); // finishes two
      await s.queue.tick(); // third submits
      assert.equal(vendor.submits.length, 3);
      s.db.close();
    });

    it('429 on submit requeues with Retry-After, fires hook, pauses the provider, then retries', async () => {
      const file = tmpDbPath();
      const vendor = makeVendor();
      let clock = 1_000_000;
      const events = [];
      const s = boot(file, vendor, {
        queueOpts: { now: () => clock, hooks: { onRateLimit: (e) => events.push(e) } },
      });
      const { task } = s.queue.enqueue({ idempotencyKey: 'a', provider: 'fake' });
      const err = new ProviderError(ERROR_CODES.RATE_LIMITED, '429', { provider: 'fake', status: 429 });
      err.retryAfterMs = 7000;
      vendor.submitError = err;
      await s.queue.tick();
      let row = s.store.get(task.id);
      assert.equal(row.state, 'queued');
      assert.equal(row.error_code, ERROR_CODES.RATE_LIMITED);
      assert.equal(row.next_attempt_at, clock + 7000);
      assert.deepEqual(events.map((e) => e.retryAfterMs), [7000]);
      assert.equal(s.queue.isPaused('fake'), true);

      vendor.submitError = null;
      await s.queue.tick();
      assert.equal(vendor.submits.length, 1, 'not retried before Retry-After elapses');
      clock += 7001;
      await s.queue.tick();
      assert.equal(vendor.submits.length, 2);
      row = s.store.get(task.id);
      assert.equal(row.state, 'submitted');
      assert.equal(row.attempts, 2);
      s.db.close();
    });

    it('non-429 submit error fails the task without retry (may have reached vendor)', async () => {
      const file = tmpDbPath();
      const vendor = makeVendor();
      vendor.submitError = new ProviderError(ERROR_CODES.NETWORK, 'reset');
      const s = boot(file, vendor);
      const { task } = s.queue.enqueue({ idempotencyKey: 'a', provider: 'fake' });
      await s.queue.tick();
      await s.queue.tick();
      assert.equal(vendor.submits.length, 1);
      assert.equal(s.store.get(task.id).error_code, ERROR_CODES.NETWORK);
      s.db.close();
    });
  });

  it('cancel moves a queued task to cancelled and it is never submitted', async () => {
    const file = tmpDbPath();
    const vendor = makeVendor();
    const s = boot(file, vendor);
    const { task } = s.queue.enqueue({ idempotencyKey: 'a', provider: 'fake' });
    assert.equal(s.store.cancel(task.id), true);
    await s.queue.tick();
    assert.equal(vendor.submits.length, 0);
    assert.equal(s.store.get(task.id).state, 'cancelled');
    s.db.close();
  });
});
