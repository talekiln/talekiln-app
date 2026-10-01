const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { createAiTaskStore } = require('../src/queue');
const aiTaskRoutes = require('../src/routes/aiTasks');
// 方舟代码保留但默认隐藏（providers.enabled 默认只有 bailian）；本文件测试方舟，所以显式开启。
require('../src/providers/enablement').configureEnabled(['bailian', 'ark']);

const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', '23_ai_tasks.sql'), 'utf8');

async function setup() {
  const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aitr-')), 't.db'));
  db.exec(MIGRATION);
  const store = createAiTaskStore(db);
  let woke = 0;
  const h = aiTaskRoutes(store, { error() {} }, { wake: () => woke++ });
  const app = express();
  app.use(express.json());
  app.get('/ai-tasks', h.list);
  app.get('/ai-tasks/:id', h.get);
  app.post('/ai-tasks/:id/retry', h.retry);
  app.post('/ai-tasks/:id/cancel', h.cancel);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { store, call, server, woke: () => woke };
}

describe('/api/v1/ai-tasks routes', () => {
  it('lists, gets, cancels and retries', async () => {
    const { store, call, server, woke } = await setup();
    const a = store.enqueue({ idempotencyKey: 'a', provider: 'bailian' }).task;
    const b = store.enqueue({ idempotencyKey: 'b', provider: 'ark' }).task;
    let r = await call('GET', '/ai-tasks');
    assert.equal(r.body.data.pagination.total, 2);
    r = await call('GET', '/ai-tasks?provider=ark');
    assert.equal(r.body.data.items[0].id, b.id);
    assert.equal(r.body.data.items[0].console_url, 'https://console.volcengine.com/ark');
    assert.equal((await call('GET', '/ai-tasks/nope')).status, 404);

    r = await call('POST', `/ai-tasks/${a.id}/cancel`);
    assert.equal(r.body.data.state, 'cancelled');
    assert.equal((await call('POST', `/ai-tasks/${a.id}/cancel`)).status, 409);
    assert.equal((await call('POST', `/ai-tasks/${a.id}/retry`)).status, 409); // cancelled is not retryable

    store.claim(b.id);
    store.fail(b.id, 'INVALID_API_KEY', 'bad');
    r = await call('GET', `/ai-tasks/${b.id}`);
    assert.match(r.body.data.error_readable, /API Key/);
    r = await call('POST', `/ai-tasks/${b.id}/retry`);
    assert.equal(r.body.data.state, 'queued');
    assert.equal(woke(), 1);

    const c = store.enqueue({ idempotencyKey: 'c', provider: 'ark' }).task;
    store.claim(c.id);
    store.fail(c.id, 'UNKNOWN', 'SUBMIT_UNCERTAIN: maybe');
    assert.equal((await call('POST', `/ai-tasks/${c.id}/retry`)).body.error.code, 'SUBMIT_UNCERTAIN');
    assert.equal((await call('POST', `/ai-tasks/${c.id}/retry`, { force: true })).body.data.state, 'queued');
    server.close();
  });
});
