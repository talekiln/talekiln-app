'use strict';
// GET /episodes/:id -> { id, drama_id, episode_number, title }（四视图页面只拿到剧集 id 时反查项目用）。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { setupRouter } = require('../src/routes/index.js');
const { loadConfig } = require('../src/config');
const { seededDb, log } = require('./helpers/kernelDb');

let server;
let base;
let db;
let ep;

async function get(path) {
  const res = await fetch(`${base}/api/v1${path}`);
  return { status: res.status, body: await res.json() };
}

before(async () => {
  ({ db, episodeId: ep } = await seededDb());
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter(loadConfig(), db, log, null, null, {}));
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); });

describe('GET /episodes/:id', () => {
  it('returns id, drama_id, episode_number and title', async () => {
    const row = db.prepare('SELECT id, drama_id, episode_number, title FROM episodes WHERE id = ?').get(ep);
    const r = await get(`/episodes/${ep}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.deepEqual(r.body.data, { id: row.id, drama_id: row.drama_id, episode_number: row.episode_number, title: row.title });
  });

  it('does not shadow the other /episodes/:id/... routes', async () => {
    const r = await get(`/episodes/${ep}/storyboards`);
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
  });

  it('404 with the unified error body when the episode does not exist', async () => {
    const r = await get('/episodes/999999');
    assert.equal(r.status, 404);
    assert.equal(r.body.success, false);
    assert.equal(r.body.error.code, 'NOT_FOUND');
    assert.ok(r.body.error.message);
    assert.ok(r.body.error.action);
  });

  it('404 for a soft-deleted episode and for a non-numeric id', async () => {
    db.prepare('UPDATE episodes SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), ep);
    assert.equal((await get(`/episodes/${ep}`)).status, 404);
    const r = await get('/episodes/abc');
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'NOT_FOUND');
  });
});
