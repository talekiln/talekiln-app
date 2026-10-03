'use strict';
// 四视图统一补的旧接口缺口（docs/superpowers/plans/2026-10-03-four-view-unification.md Task 3）：
//   GET  /dramas/:id/scenes · POST /characters/:id/add-to-team-library · POST /episodes/:id/characters/extract
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { setupRouter } = require('../src/routes/index.js');
const { loadConfig } = require('../src/config');
const { StudioError } = require('../src/studio/errors');
const aiClient = require('../src/services/aiClient');
const taskService = require('../src/services/taskService');
const sceneService = require('../src/services/sceneService');
const { seededDb, log } = require('./helpers/kernelDb');

let db;
let ep;
let dramaId;
let studioCalls;
let studioImpl;
const realGenerateText = aiClient.generateText;
const servers = [];

async function mount(extras) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter(loadConfig(), db, log, null, null, extras));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
}
async function waitTask(id, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const t = taskService.getTask(db, id);
    if (t && (t.status === 'completed' || t.status === 'failed')) return t;
    if (Date.now() - t0 > ms) throw new Error(`task ${id} did not finish: ${t && t.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const resultOf = (t) => (typeof t.result === 'string' ? JSON.parse(t.result) : t.result);

let api;
let apiNoStudio;
before(async () => {
  ({ db, episodeId: ep } = await seededDb());
  dramaId = db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(ep).drama_id;
  const studio = { publishCharacter: async (id, opts) => { studioCalls.push([id, opts]); return studioImpl(id, opts); } };
  api = await mount({ studio });
  apiNoStudio = await mount({});
});
after(() => { for (const s of servers) s.close(); aiClient.generateText = realGenerateText; });
beforeEach(() => {
  studioCalls = [];
  studioImpl = async (id) => ({ shared_id: `char_${id}`, version: 1 });
});

describe('GET /dramas/:id/scenes', () => {
  it('lists the drama scenes and is not swallowed by /dramas/:id', async () => {
    sceneService.createScene(db, log, dramaId, { location: '站台', time: '夜', prompt: '雨夜站台' });
    sceneService.createScene(db, log, dramaId, { location: '车内', time: '夜', prompt: '空荡车厢' });
    const r = await api('GET', `/dramas/${dramaId}/scenes`);
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    const list = r.body.data;
    assert.ok(Array.isArray(list));
    assert.deepEqual(list.map((s) => s.location), ['站台', '车内']);
    assert.ok(list.every((s) => s.drama_id === dramaId && s.id));
  });

  it('returns an empty list for a drama without scenes and 404 for an unknown drama', async () => {
    const other = db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)').run('空项目', 'x', 'x').lastInsertRowid;
    const r = await api('GET', `/dramas/${other}/scenes`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, []);
    const miss = await api('GET', '/dramas/999999/scenes');
    assert.equal(miss.status, 404);
    assert.equal(miss.body.error.code, 'NOT_FOUND');
  });
});

describe('POST /characters/:id/add-to-team-library', () => {
  it('publishes the character to the team library through the studio service', async () => {
    const r = await api('POST', '/characters/7/add-to-team-library', { studio_id: 's1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.deepEqual(r.body.data, { shared_id: 'char_7', version: 1 });
    assert.deepEqual(studioCalls, [[7, { studio_id: 's1' }]]);
  });

  it('works without a body (studio_id falls back to the current studio)', async () => {
    const r = await api('POST', '/characters/3/add-to-team-library');
    assert.equal(r.status, 200);
    assert.deepEqual(studioCalls, [[3, { studio_id: undefined }]]);
  });

  it('passes studio errors through with their status and code', async () => {
    studioImpl = async () => { throw new StudioError('STUDIO_NOT_LOGGED_IN', undefined, 401); };
    const r = await api('POST', '/characters/7/add-to-team-library', {});
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'STUDIO_NOT_LOGGED_IN');
    studioImpl = async () => { throw new StudioError('NOT_FOUND', '角色不存在', 404); };
    const r2 = await api('POST', '/characters/99/add-to-team-library', {});
    assert.equal(r2.status, 404);
    assert.equal(r2.body.error.code, 'NOT_FOUND');
  });

  it('answers 501 with an explicit code when there is no studio service', async () => {
    const r = await apiNoStudio('POST', '/characters/7/add-to-team-library', {});
    assert.equal(r.status, 501);
    assert.equal(r.body.success, false);
    assert.equal(r.body.error.code, 'CAPABILITY_NOT_SUPPORTED');
  });
});

describe('POST /episodes/:id/characters/extract', () => {
  it('extracts characters from the episode script via the character generation service', async () => {
    const script = db.prepare('SELECT script_content FROM episodes WHERE id = ?').get(ep).script_content;
    let prompt = '';
    aiClient.generateText = async (_db, _log, _type, userPrompt) => {
      prompt = userPrompt;
      return JSON.stringify([{ name: '提取甲', role: 'main', description: '测试角色一' }, { name: '提取乙', role: 'supporting', description: '测试角色二' }]);
    };
    const r = await api('POST', `/episodes/${ep}/characters/extract`, {});
    assert.equal(r.status, 200);
    assert.ok(r.body.data.task_id);
    const task = await waitTask(r.body.data.task_id);
    assert.equal(task.status, 'completed', task.error);
    const res = resultOf(task);
    assert.equal(res.count, 2);
    assert.deepEqual(res.characters.map((c) => c.name), ['提取甲', '提取乙']);
    if (script) assert.ok(prompt.includes(String(script).slice(0, 20)), 'the episode script is the model input');
    const linked = db.prepare('SELECT c.name FROM episode_characters ec JOIN characters c ON c.id = ec.character_id WHERE ec.episode_id = ? ORDER BY c.id').all(ep).map((x) => x.name);
    assert.deepEqual(linked, ['提取甲', '提取乙']);
  });

  it('404 with the unified error body for an unknown episode', async () => {
    const r = await api('POST', '/episodes/999999/characters/extract', {});
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'NOT_FOUND');
  });
});
