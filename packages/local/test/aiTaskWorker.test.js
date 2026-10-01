const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
  createAiTaskStore, createAiTaskQueue, createWorker, createDownloader, withDownloads,
  makeJitter, pollDelayFor, nextLoopDelay, queueOptionsFromConfig, resolveOptions, toView, readableError,
} = require('../src/queue');
const { ProviderError, ERROR_CODES } = require('../src/providers/errors');

const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', '23_ai_tasks.sql'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aiworker-'));
function openDb() {
  const db = new Database(path.join(tmp(), 't.db'));
  db.pragma('journal_mode = WAL');
  db.exec(MIGRATION);
  return db;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- local server serving a file; first N requests are cut mid-body; honours Range ----
const FILE = crypto.randomBytes(200 * 1024);
function startServer({ interrupt = 2, ignoreRange = false, corrupt = false } = {}) {
  const log = { requests: [] };
  let cuts = interrupt;
  const server = http.createServer((req, res) => {
    log.requests.push({ url: req.url, range: req.headers.range || null });
    if (req.url === '/limited') { res.writeHead(429, { 'Retry-After': '0' }); return res.end(); }
    const body = corrupt ? Buffer.concat([FILE.subarray(0, FILE.length - 1), Buffer.from([0])]) : FILE;
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (m && !ignoreRange) {
      start = Number(m[1]);
      if (start >= body.length) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }); return res.end(); }
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`, 'Content-Length': body.length - start });
    } else {
      res.writeHead(200, { 'Content-Length': body.length });
    }
    const chunk = body.subarray(start);
    if (cuts > 0) {
      cuts--;
      res.write(chunk.subarray(0, 50 * 1024));
      setTimeout(() => res.destroy(), 20); // interrupted transfer
      return;
    }
    res.end(chunk);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, url: `http://127.0.0.1:${server.address().port}/file` })));
}

describe('downloader', () => {
  it('resumes interrupted transfers with Range and stores by sha256', async () => {
    const s = await startServer({ interrupt: 2 });
    const dir = tmp();
    const d = createDownloader({ storageDir: dir, sleep: async () => {} });
    const out = await d.download(s.url, { expectedSha256: sha(FILE) });
    assert.equal(out.sha256, sha(FILE));
    assert.equal(out.size, FILE.length);
    assert.equal(out.path, `blobs/${sha(FILE).slice(0, 2)}/${sha(FILE)}`);
    assert.ok(fs.readFileSync(path.join(dir, out.path)).equals(FILE));
    const ranges = s.log.requests.map((r) => r.range);
    assert.equal(ranges[0], null);
    assert.ok(ranges.slice(1).every((r) => /^bytes=\d+-$/.test(r)), JSON.stringify(ranges));
    assert.equal(fs.readdirSync(path.join(dir, 'tmp')).length, 0);
    s.server.close();
  });

  it('restarts from zero when the server ignores Range', async () => {
    const s = await startServer({ interrupt: 1, ignoreRange: true });
    const d = createDownloader({ storageDir: tmp(), sleep: async () => {} });
    const out = await d.download(s.url);
    assert.equal(out.sha256, sha(FILE));
    s.server.close();
  });

  it('rejects and discards the file on sha256 mismatch', async () => {
    const s = await startServer({ interrupt: 0 });
    const dir = tmp();
    const d = createDownloader({ storageDir: dir, sleep: async () => {} });
    await assert.rejects(d.download(s.url, { expectedSha256: 'a'.repeat(64) }), (e) => e.code === ERROR_CODES.BAD_RESPONSE && /sha256 mismatch/.test(e.message));
    assert.equal(fs.existsSync(path.join(dir, 'blobs')), false);
    assert.equal(fs.readdirSync(path.join(dir, 'tmp')).length, 0);
    s.server.close();
  });

  it('keeps the partial file when attempts are exhausted so a later call resumes', async () => {
    const s = await startServer({ interrupt: 99 });
    const dir = tmp();
    const d = createDownloader({ storageDir: dir, sleep: async () => {}, maxAttempts: 2 });
    await assert.rejects(d.download(s.url), (e) => e.code === ERROR_CODES.NETWORK);
    assert.ok(fs.readdirSync(path.join(dir, 'tmp')).length === 1);
    s.server.close();
    const s2 = await startServer({ interrupt: 0 });
    // same URL path/port differs, so copy the partial under the new URL key to emulate a retry
    const key = (u) => crypto.createHash('sha1').update(u).digest('hex');
    const partOld = fs.readdirSync(path.join(dir, 'tmp'))[0];
    fs.renameSync(path.join(dir, 'tmp', partOld), path.join(dir, 'tmp', `${key(s2.url)}.part`));
    const out = await createDownloader({ storageDir: dir }).download(s2.url);
    assert.equal(out.sha256, sha(FILE));
    assert.ok(/^bytes=\d+-$/.test(s2.log.requests[0].range));
    s2.server.close();
  });

  it('retries HTTP 429 and gives a rate-limited error at the end', async () => {
    const s = await startServer();
    const d = createDownloader({ storageDir: tmp(), sleep: async () => {}, maxAttempts: 2 });
    await assert.rejects(d.download(s.url.replace('/file', '/limited')), (e) => e.code === ERROR_CODES.RATE_LIMITED);
    assert.equal(s.log.requests.length, 2);
    s.server.close();
  });
});

describe('worker pure helpers', () => {
  it('jitter never goes below the base wait and respects the ratio', () => {
    assert.equal(makeJitter(() => 0, 0.2)(1000), 1000);
    assert.equal(makeJitter(() => 1, 0.2)(1000), 1200);
  });
  it('poll delay grows with task age and is clamped', () => {
    const o = { poll_min_ms: 2000, poll_max_ms: 30000 };
    assert.equal(pollDelayFor(0, o), 2000);
    assert.equal(pollDelayFor(40000, o), 10000);
    assert.equal(pollDelayFor(10 * 60000, o), 30000);
  });
  it('loop delay resets on activity and backs off when idle', () => {
    const o = resolveOptions({});
    assert.equal(nextLoopDelay(4000, true, o), o.idle_min_ms);
    assert.ok(nextLoopDelay(500, false, o) > 500);
    assert.equal(nextLoopDelay(4900, false, o), o.idle_max_ms);
  });
  it('reads per-provider limits from config', () => {
    const q = queueOptionsFromConfig({ ai_queue: { limits: { default: 1, bailian: '4', bad: -1 } } });
    assert.deepEqual(q.limits, { default: 1, bailian: 4 });
  });
});

describe('queue 429 + polling integration', () => {
  it('honors Retry-After (with jitter on top) and spaces polls of running tasks', async () => {
    let t = 1_000_000;
    const now = () => t;
    const db = openDb();
    const store = createAiTaskStore(db, { now });
    let first = true;
    const calls = [];
    const provider = {
      async submit(task) {
        calls.push(['submit', t]);
        if (first) { first = false; throw Object.assign(new ProviderError(ERROR_CODES.RATE_LIMITED, 'x'), { retryAfterMs: 10000 }); }
        return { vendorTaskId: 'v1' };
      },
      async poll() { calls.push(['poll', t]); return { status: 'running' }; },
    };
    const opts = queueOptionsFromConfig({ ai_queue: { jitter_ratio: 0.5 } }, { now, random: () => 1 });
    const queue = createAiTaskQueue({ store, providers: { fake: provider }, now, ...opts });
    store.enqueue({ idempotencyKey: 'k1', provider: 'fake' });
    await queue.tick();
    const row = store.getByKey('k1');
    assert.equal(row.state, 'queued');
    assert.equal(row.next_attempt_at, t + 15000); // 10s Retry-After + 50% jitter
    t += 14000; await queue.tick();
    assert.equal(calls.filter((c) => c[0] === 'submit').length, 1); // still paused
    t += 1500; await queue.tick();
    assert.equal(store.getByKey('k1').state, 'submitted');
    await queue.tick(); // first poll
    const polled = store.getByKey('k1');
    assert.equal(polled.state, 'polling');
    assert.ok(polled.next_attempt_at >= t + 2000);
    const before = calls.length;
    t += 1000; await queue.tick();
    assert.equal(calls.length, before); // not due yet
    t += 5000; await queue.tick();
    assert.equal(calls.length, before + 1);
  });
});

describe('worker end to end (fake provider + local http server)', () => {
  it('runs a task through submit, poll, resumable download and notifies on completion', async () => {
    const s = await startServer({ interrupt: 1 });
    const dir = tmp();
    const db = openDb();
    const store = createAiTaskStore(db);
    const downloader = createDownloader({ storageDir: dir, sleep: async () => {} });
    const provider = {
      async submit() { return { vendorTaskId: 'v-1' }; },
      async poll() { return { status: 'succeeded', result: { url: s.url, sha256: sha(FILE) } }; },
    };
    const queue = createAiTaskQueue({ store, providers: withDownloads({ fake: provider }, downloader), limits: { default: 2 } });
    const finished = [];
    const worker = createWorker({
      queue, store, config: { ai_queue: { idle_min_ms: 5, idle_max_ms: 20 } },
      onTaskFinished: (t) => finished.push(t),
    });
    store.enqueue({ idempotencyKey: 'k', provider: 'fake' });
    assert.equal(worker.unfinishedCount(), 1);
    await worker.start();
    const deadline = Date.now() + 10000;
    while (!finished.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await worker.stop();
    s.server.close();
    assert.equal(finished.length, 1);
    assert.equal(finished[0].state, 'succeeded');
    const result = JSON.parse(finished[0].result);
    assert.equal(result.files[0].sha256, sha(FILE));
    assert.ok(fs.existsSync(path.join(dir, result.files[0].path)));
    assert.equal(worker.unfinishedCount(), 0);
  });

  it('respects the per-provider concurrency limit', async () => {
    const db = openDb();
    const store = createAiTaskStore(db);
    let inflight = 0;
    const provider = {
      async submit() { return { vendorTaskId: `v${Math.random()}` }; },
      async poll() { return { status: 'running' }; },
    };
    const queue = createAiTaskQueue({ store, providers: { fake: provider }, limits: { default: 5, fake: 2 } });
    for (let i = 0; i < 5; i++) store.enqueue({ idempotencyKey: `k${i}`, provider: 'fake' });
    await queue.tick();
    assert.equal(store.countActive('fake'), 2);
    assert.equal(inflight, 0);
  });

  it('reconcileNow runs queue.reconcile and does not overlap ticks', async () => {
    const db = openDb();
    const store = createAiTaskStore(db);
    const order = [];
    const queue = {
      async tick() { order.push('tick-start'); await new Promise((r) => setTimeout(r, 30)); order.push('tick-end'); return {}; },
      async reconcile() { order.push('reconcile'); return { resumed: [] }; },
    };
    const worker = createWorker({ queue, store, config: {} });
    const a = worker.runOnce();
    const b = worker.onResume();
    await Promise.all([a, b]);
    assert.deepEqual(order.slice(0, 3), ['tick-start', 'tick-end', 'reconcile']);
    assert.equal((await b).reason, 'resume');
  });
});

describe('task view', () => {
  it('maps codes to readable Chinese and flags uncertain submits', () => {
    assert.match(readableError('INVALID_API_KEY'), /API Key/);
    assert.match(readableError('UNKNOWN', 'SUBMIT_UNCERTAIN: x'), /不确定/);
    const v = toView({ id: 'a', provider: 'bailian', state: 'failed', error_code: 'INSUFFICIENT_BALANCE', params: '{"a":1}', result: null });
    assert.match(v.error_readable, /余额/);
    assert.equal(v.console_url, 'https://bailian.console.aliyun.com/');
    assert.deepEqual(v.params, { a: 1 });
    assert.equal(toView({ provider: 'zzz', state: 'queued' }).console_url, null);
  });
  it('store retry/list semantics', () => {
    const db = openDb();
    const store = createAiTaskStore(db);
    const a = store.enqueue({ idempotencyKey: 'a', provider: 'p' }).task;
    store.claim(a.id);
    store.fail(a.id, 'NETWORK', 'x');
    assert.equal(store.retry(a.id), true);
    assert.equal(store.get(a.id).state, 'queued');
    const b = store.enqueue({ idempotencyKey: 'b', provider: 'p' }).task;
    store.claim(b.id); store.markSubmitStarted(b.id); store.recordVendorId(b.id, 'V');
    store.transition(b.id, 'submitted', 'polling');
    store.fail(b.id, 'NETWORK', 'dl');
    assert.equal(store.retry(b.id), true);
    assert.equal(store.get(b.id).state, 'submitted'); // never resubmitted
    assert.equal(store.retry(b.id), false);
    assert.equal(store.list({ state: 'queued,submitted' }).total, 2);
    assert.equal(store.list({ provider: 'nope' }).total, 0);
  });
});
