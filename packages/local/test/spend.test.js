const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { createAiTaskStore, createAiTaskQueue } = require('../src/queue');
const { createSpendService, createEstimator, loadPrices } = require('../src/spend');
const aiTaskRoutes = require('../src/routes/aiTasks');
const spendRoutes = require('../src/routes/spend');

const mig = (f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');
const T0 = new Date(2026, 9, 15, 12, 0, 0).getTime(); // 2026-10-15 local

function setup({ now = () => T0 } = {}) {
  const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spend-')), 't.db'));
  db.exec(mig('23_ai_tasks.sql'));
  db.exec(mig('25_spend_log.sql'));
  db.exec(mig('28_spend_log_usage.sql'));
  db.exec(`CREATE TABLE global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`);
  const store = createAiTaskStore(db, { now });
  const spend = createSpendService(db, { now });
  return { db, store, spend };
}

const VIDEO = { provider: 'bailian', kind: 'video', params: { prompt: 'p', model: 'wan2.6-t2v', duration: 10, resolution: '720P' } };

describe('price table and estimates', () => {
  it('ships the public 百炼 list prices with their date; unverified entries are flagged', () => {
    const p = loadPrices();
    assert.equal(p.sample, false);
    assert.match(p.price_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(p.version, /bailian-public-/);
    assert.match(p._notice, /百炼/);
    assert.equal(p.providers.bailian.video['wan2.6-t2v'].verified, true);
    assert.equal(p.providers.bailian.tts['cosyvoice-v2'].verified, true);
    const { estimate } = createEstimator();
    assert.equal(estimate({ provider: 'bailian', kind: 'video', params: { model: 'wan2.6-t2v' } }).sample, false);
    assert.equal(estimate({ provider: 'bailian', kind: 'video', params: { model: 'wan2.2-kf2v-flash' } }).sample, true, 'placeholder price shows as sample');
    assert.equal(estimate({ provider: 'bailian', kind: 'video', params: { model: 'wan2.6-t2v' } }).price_date, p.price_date);
  });

  it('estimates per image / second / char with a max above the estimate', () => {
    const { estimate } = createEstimator();
    const v = estimate(VIDEO);
    assert.equal(v.estimate, 6); // 10s x 0.6
    assert.equal(v.max, 7.2);
    assert.equal(estimate({ provider: 'bailian', kind: 'image', params: { model: 'z-image-turbo', n: 3 } }).estimate, 0.3);
    assert.equal(estimate({ provider: 'bailian', kind: 'tts', params: { text: '你好世界' } }).estimate, 0.0016); // 汉字计 2 字符
    assert.equal(estimate({ provider: 'bailian', kind: 'tts', params: { text: 'ab, 你' } }).estimate, 0.0012); // 4 + 2
    assert.equal(estimate({ provider: 'bailian', kind: 'video', params: { model: 'wan2.6-t2v', duration: 10, resolution: '1080P' } }).estimate, 10);
    assert.equal(estimate({ provider: 'bailian', kind: 'video', params: { model: 'wan2.6-t2v', duration: 10, resolution: '1080p' } }).estimate, 10, 'tier match ignores case');
    assert.equal(estimate({ provider: 'bailian', kind: 'image', params: { model: 'unlisted' } }).estimate, 0.2); // _default
    const unknown = estimate({ provider: 'nope', kind: 'image', params: {} });
    assert.equal(unknown.known, false);
    assert.equal(unknown.estimate, 0);
  });

  it('actual cost from reported usage: video seconds x billed tier, tts characters, image count; null when nothing usable', () => {
    const { actual } = createEstimator();
    // 视频：按回传的计费秒数和分辨率，不按请求里的 duration
    assert.deepEqual(actual(VIDEO, { duration: 5, SR: 1080 }), { actual: 5, units: 5, unit: 'second', unit_price: 1, basis: '5 second x 1', resolution: '1080P' });
    assert.equal(actual(VIDEO, { video_duration: 5 }).actual, 3); // 档位取请求里的 720P
    assert.equal(actual(VIDEO, {}), null);
    assert.equal(actual(VIDEO, { duration: 0 }), null);
    // 配音：服务商计的字符数
    assert.equal(actual({ provider: 'bailian', kind: 'tts', params: { model: 'cosyvoice-v2', text: '你好' } }, { characters: 10 }).actual, 0.002);
    assert.equal(actual({ provider: 'bailian', kind: 'tts', params: { text: '你好' } }, {}), null);
    // 图片：usage.images，否则数结果 urls
    assert.equal(actual({ provider: 'bailian', kind: 'image', params: { model: 'wan2.6-t2i', n: 4 } }, { images: 2 }).actual, 0.4);
    assert.equal(actual({ provider: 'bailian', kind: 'image', params: { model: 'wan2.6-t2i' } }, null, { urls: ['a', 'b', 'c'] }).actual, 0.6);
    assert.equal(actual({ provider: 'nope', kind: 'image', params: {} }, { images: 1 }), null);
  });
});

describe('cap enforcement', () => {
  it('per-run cap checks the max estimate', () => {
    const { spend } = setup();
    assert.equal(spend.check(VIDEO).ok, true);
    spend.setLimits({ per_run_cap: 7 });
    const r = spend.check(VIDEO);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'per_run');
    spend.setLimits({ per_run_cap: 7.2 });
    assert.equal(spend.check(VIDEO).ok, true);
    spend.setLimits({ per_run_cap: null });
    assert.deepEqual(spend.getLimits(), { per_run_cap: null, monthly_cap: null });
  });

  it('monthly cap counts logged spend plus in-flight tasks', () => {
    const { spend, store } = setup();
    spend.setLimits({ monthly_cap: 10 });
    assert.equal(spend.check(VIDEO).ok, true); // 7.2 <= 10
    const a = store.enqueue({ idempotencyKey: 'a', ...VIDEO }).task; // in flight, max 7.2
    assert.equal(spend.check(VIDEO).ok, false); // 7.2 + 7.2 > 10
    assert.equal(spend.check(VIDEO).reason, 'monthly');
    assert.equal(spend.check(VIDEO, { exceptId: a.id }).ok, true);
    store.cancel(a.id);
    assert.equal(spend.check(VIDEO).ok, true);
  });

  it('only the current month counts toward the monthly cap', () => {
    const { spend, store, db } = setup();
    spend.setLimits({ monthly_cap: 10 });
    const ins = db.prepare(`INSERT INTO spend_log (task_id, provider, kind, estimated, day, created_at) VALUES (?, 'bailian', 'video', ?, ?, 0)`);
    ins.run('old', 50, '2026-09-30');
    assert.equal(spend.check(VIDEO).ok, true);
    ins.run('cur', 4, '2026-10-02');
    assert.equal(spend.monthSpent(), 4);
    assert.equal(spend.check(VIDEO).ok, false); // 4 + 7.2 > 10
    void store;
  });

  it('queue refuses over-cap tasks with SPEND_LIMIT without calling the provider, and retry works after raising the cap', async () => {
    const { spend, store } = setup();
    let submits = 0;
    const provider = {
      submit: async () => { submits++; return { vendorTaskId: 'v' + submits }; },
      poll: async () => ({ status: 'succeeded', result: { done: true } }),
    };
    const queue = createAiTaskQueue({ store, providers: { bailian: provider }, spendGuard: (t) => spend.guardTask(t) });
    const { task } = store.enqueue({ idempotencyKey: 'big', ...VIDEO });
    spend.setLimits({ per_run_cap: 1 }); // lowered after enqueue: still enforced at submit time
    await queue.tick();
    let row = store.get(task.id);
    assert.equal(row.state, 'failed');
    assert.equal(row.error_code, 'SPEND_LIMIT');
    assert.match(row.error_message, /单次上限/);
    assert.equal(row.attempts, 0);
    assert.equal(submits, 0);
    assert.match(require('../src/queue').toView(row).error_readable, /费用上限/);

    spend.setLimits({ per_run_cap: null });
    assert.equal(store.retry(task.id), true);
    await queue.tick();
    await queue.tick();
    assert.equal(store.get(task.id).state, 'succeeded');
    assert.equal(submits, 1);
  });

  it('rejects bad limit values', () => {
    const { spend } = setup();
    assert.throws(() => spend.setLimits({ monthly_cap: -1 }), RangeError);
    assert.throws(() => spend.setLimits({ per_run_cap: 'abc' }), RangeError);
  });
});

describe('spend_log and aggregation', () => {
  it('records finished tasks once and aggregates by provider, project and day', () => {
    let clock = T0;
    const { spend, store, db } = setup({ now: () => clock });
    const mk = (key, spec, project, day) => {
      clock = new Date(2026, 9, day, 10).getTime();
      const t = store.enqueue({ idempotencyKey: key, provider: spec.provider, kind: spec.kind, params: { ...spec.params, ...(project ? { _project: project } : {}) } }).task;
      store.claim(t.id);
      store.recordVendorId(t.id, 'v');
      store.succeed(t.id, {});
      return store.get(t.id);
    };
    const a = mk('a', VIDEO, 'p1', 3); // 6（无用量回传 -> actual 空，计入预估）
    const b = mk('b', { provider: 'ark', kind: 'image', params: { n: 2 } }, 'p1', 3); // 0.5
    const c = mk('c', { provider: 'ark', kind: 'image', params: {} }, null, 4); // 0.25
    assert.equal(spend.recordFinished(a), true);
    assert.equal(spend.recordFinished(a), false); // idempotent
    spend.recordFinished(b);
    spend.recordFinished(c, { actual: 0.3 });
    assert.equal(spend.recordFinished({ ...c, id: 'x', state: 'failed' }), false);
    const logA = db.prepare('SELECT * FROM spend_log WHERE task_id = ?').get(a.id);
    assert.equal(logA.actual, null);
    assert.equal(logA.usage, null);

    clock = T0;
    const s = spend.summary();
    assert.equal(s.total.count, 3);
    assert.equal(s.total.cost, 6.8); // 6 + 0.5 + actual 0.3
    assert.equal(s.total.estimated, 6.75);
    assert.equal(s.total.actual, 0.3);
    assert.equal(s.total.actual_count, 1);
    assert.equal(s.prices.sample, false);
    assert.ok(s.prices.date);
    const prov = Object.fromEntries(s.by_provider.map((r) => [r.provider, r]));
    assert.equal(prov.bailian.cost, 6);
    assert.equal(prov.ark.cost, 0.8);
    assert.equal(prov.ark.estimated, 0.75);
    assert.equal(prov.ark.actual, 0.3);
    const proj = Object.fromEntries(s.by_project.map((r) => [String(r.project_id), r]));
    assert.equal(proj.p1.cost, 6.5);
    assert.equal(proj.null.cost, 0.3);
    assert.deepEqual(s.by_day.map((d) => [d.day, d.cost]), [['2026-10-03', 6.5], ['2026-10-04', 0.3]]);
    assert.equal(spend.summary({ from: '2026-10-04' }).total.count, 1);
    assert.equal(s.month.spent, 6.8);
    spend.setLimits({ monthly_cap: 10 });
    assert.equal(spend.summary().month.remaining, 3.2);
  });

  it('recordFinished writes actual from the task result usage (billed seconds and tier beat the request)', () => {
    const { spend, store, db } = setup();
    const t = store.enqueue({ idempotencyKey: 'u', provider: 'bailian', kind: 'video', params: { ...VIDEO.params, _project: 'p9' } }).task;
    store.claim(t.id);
    store.recordVendorId(t.id, 'v');
    store.succeed(t.id, { url: 'https://x.invalid/a.mp4', usage: { duration: 8, SR: 1080 } });
    assert.equal(spend.recordFinished(store.get(t.id)), true);
    const row = db.prepare('SELECT * FROM spend_log WHERE task_id = ?').get(t.id);
    assert.equal(row.estimated, 6); // 10s x 0.6 (720P 请求)
    assert.equal(row.actual, 8); // 8s x 1.0 (1080P 实际)
    const u = JSON.parse(row.usage);
    assert.equal(u.units, 8);
    assert.equal(u.resolution, '1080P');
    assert.deepEqual(u.reported, { duration: 8, SR: 1080 });
    assert.equal(spend.listTasks().items[0].usage.units, 8);
    assert.equal(spend.summary().total.cost, 8);
    // tts：计费字符数
    const t2 = store.enqueue({ idempotencyKey: 'u2', provider: 'bailian', kind: 'tts', params: { model: 'cosyvoice-v2', text: '你好' } }).task;
    store.claim(t2.id);
    store.recordVendorId(t2.id, 'v');
    store.succeed(t2.id, { format: 'mp3', sha256: 'x', size: 1, path: 'blobs/x', usage: { characters: 4 } });
    spend.recordFinished(store.get(t2.id));
    assert.equal(db.prepare('SELECT actual FROM spend_log WHERE task_id = ?').get(t2.id).actual, 0.0008);
    assert.equal(spend.actualOf(store.get(t2.id)).units, 4);
  });
});

describe('REST', () => {
  async function boot() {
    const ctx = setup();
    const log = { error() {} };
    let woke = 0;
    const tasks = aiTaskRoutes(ctx.store, log, { wake: () => woke++ }, { spend: ctx.spend });
    const sp = spendRoutes(ctx.spend, log);
    const app = express();
    app.use(express.json());
    app.post('/ai-tasks', tasks.create);
    app.get('/spend/summary', sp.summary);
    app.put('/spend/limits', sp.putLimits);
    app.post('/spend/estimate', sp.estimate);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };
    return { ...ctx, call, server, woke: () => woke };
  }

  it('enqueue is idempotent, validates input and honours caps', async () => {
    const { call, server, store, woke } = await boot();
    try {
      const body = { idempotency_key: 'k1', provider: 'bailian', kind: 'image', params: { prompt: 'cat' }, project_id: 'proj' };
      let r = await call('POST', '/ai-tasks', body);
      assert.equal(r.status, 201);
      assert.equal(r.body.data.created, true);
      assert.equal(r.body.data.state, 'queued');
      assert.equal(r.body.data.params._project, 'proj');
      const again = await call('POST', '/ai-tasks', body);
      assert.equal(again.status, 200);
      assert.equal(again.body.data.created, false);
      assert.equal(again.body.data.id, r.body.data.id);
      assert.equal(store.list().total, 1);
      assert.equal(woke(), 1);

      assert.equal((await call('POST', '/ai-tasks', { ...body, idempotency_key: '' })).status, 400);
      assert.equal((await call('POST', '/ai-tasks', { ...body, idempotency_key: 'k2', kind: 'audio' })).status, 400);
      assert.equal((await call('POST', '/ai-tasks', { ...body, idempotency_key: 'k3', provider: 'openai' })).status, 400);
      assert.equal((await call('POST', '/ai-tasks', { ...body, idempotency_key: 'k4', params: {} })).status, 400);

      assert.equal((await call('PUT', '/spend/limits', { per_run_cap: 0.1 })).status, 200);
      r = await call('POST', '/ai-tasks', { ...body, idempotency_key: 'k5' });
      assert.equal(r.status, 402);
      assert.equal(r.body.error.code, 'SPEND_LIMIT');
      assert.equal(r.body.error.details.max, 0.24);
      assert.equal(store.list().total, 1); // refused, nothing enqueued
      // an existing key still returns its task even when caps would now refuse
      assert.equal((await call('POST', '/ai-tasks', body)).status, 200);
    } finally { server.close(); }
  });

  it('estimate, limits and summary endpoints', async () => {
    const { call, server } = await boot();
    try {
      let r = await call('POST', '/spend/estimate', VIDEO);
      assert.equal(r.status, 200);
      assert.equal(r.body.data.estimate, 6);
      assert.equal(r.body.data.max, 7.2);
      assert.equal(r.body.data.allowed, true);
      assert.equal(r.body.data.sample, false);
      assert.equal((await call('POST', '/spend/estimate', { provider: 'x' })).status, 400);

      r = await call('PUT', '/spend/limits', { per_run_cap: 5, monthly_cap: 100 });
      assert.deepEqual(r.body.data, { per_run_cap: 5, monthly_cap: 100 });
      r = await call('PUT', '/spend/limits', { monthly_cap: null });
      assert.deepEqual(r.body.data, { per_run_cap: 5, monthly_cap: null });
      assert.equal((await call('PUT', '/spend/limits', { monthly_cap: -3 })).status, 400);
      assert.equal((await call('PUT', '/spend/limits', {})).status, 400);

      r = await call('POST', '/spend/estimate', VIDEO);
      assert.equal(r.body.data.allowed, false);
      assert.equal(r.body.data.error_code, 'SPEND_LIMIT');

      r = await call('GET', '/spend/summary');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data.by_provider, []);
      assert.equal(r.body.data.limits.per_run_cap, 5);
      assert.equal((await call('GET', '/spend/summary?from=bad')).status, 400);
    } finally { server.close(); }
  });
});
