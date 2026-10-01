const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createAiTaskStore, createAiTaskQueue, buildQueueProviders, withDownloads, toView } = require('../src/queue');
const { ProviderError, ERROR_CODES } = require('../src/providers/errors');

const MIG = fs.readFileSync(path.join(__dirname, '..', 'migrations', '23_ai_tasks.sql'), 'utf8');
const SECRET = 'sk-test-SECRET-1234567890';

const CONFIGS = {
  image: [{ id: 1, provider: 'dashscope', service_type: 'image', api_key: SECRET, base_url: '', is_active: true, default_model: 'wan2.6-t2i', model: [] }],
  video: [{ id: 2, provider: 'volces', service_type: 'video', api_key: SECRET, base_url: 'https://ark.example/v3', is_active: true, model: ['seedance-x'] }],
  tts: [{ id: 3, provider: 'bailian', service_type: 'tts', api_key: SECRET, is_active: true, model: [] }],
};

function fakeFacadeFactory(calls) {
  return (cfg) => {
    calls.configs.push(Object.values(cfg)[0]);
    return {
      image: { generate: async (p, req) => { calls.image.push({ p, req }); return { urls: ['http://img.example/a.png'] }; } },
      video: {
        submit: async (p, req) => { calls.video.push({ p, req }); return { taskId: 'vt-1' }; },
        poll: async (p, req) => {
          calls.polls++;
          if (calls.polls === 1) return { status: 'running' };
          if (calls.failVideo) return { status: 'failed', error: new ProviderError(ERROR_CODES.MODEL_NOT_ENABLED, 'nope') };
          return { status: 'succeeded', videoUrl: 'http://vid.example/v.mp4' };
        },
      },
      tts: { synthesize: async (p, req) => { calls.tts.push({ p, req }); return { audio: Buffer.from('AUDIO'), format: 'mp3', words: [{ text: 'a', startMs: 0, endMs: 5 }] }; } },
    };
  };
}

function setup({ configs = CONFIGS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padapt-'));
  const db = new Database(path.join(dir, 't.db'));
  db.exec(MIG);
  const calls = { configs: [], image: [], video: [], tts: [], polls: 0, failVideo: false };
  const storageDir = path.join(dir, 'storage');
  const raw = buildQueueProviders({ db, storageDir, listConfigs: (t) => configs[t] || [], createProviders: fakeFacadeFactory(calls) });
  const downloader = { download: async (url) => ({ sha256: 'x'.repeat(64), size: 1, path: `blobs/xx/${path.basename(url)}` }) };
  const store = createAiTaskStore(db);
  const queue = createAiTaskQueue({ store, providers: withDownloads(raw, downloader) });
  return { store, queue, calls, storageDir, db };
}

async function drain(queue, n = 6) { for (let i = 0; i < n; i++) await queue.tick(); }

describe('queue provider adapter', () => {
  it('runs a video task through submit/poll/download with config-derived credentials', async () => {
    const { store, queue, calls } = setup();
    const { task } = store.enqueue({ idempotencyKey: 'v1', provider: 'ark', kind: 'video', params: { prompt: 'hi', _project: 'p1' } });
    await drain(queue);
    const row = store.get(task.id);
    assert.equal(row.state, 'succeeded');
    assert.equal(row.vendor_task_id, 'vt-1');
    assert.equal(JSON.parse(row.result).files[0].url, 'http://vid.example/v.mp4');
    assert.equal(calls.video[0].p, 'ark');
    assert.equal(calls.video[0].req.model, 'seedance-x'); // default model from the config
    assert.equal(calls.video[0].req._project, undefined); // internal metadata never reaches the vendor
    assert.equal(calls.configs[0].apiKey, SECRET);
    assert.equal(calls.configs[0].baseUrl, 'https://ark.example/v3');
  });

  it('maps a failed vendor task to its unified error code', async () => {
    const { store, queue, calls } = setup();
    calls.failVideo = true;
    const { task } = store.enqueue({ idempotencyKey: 'v2', provider: 'ark', kind: 'video', params: { prompt: 'x' } });
    await drain(queue);
    assert.equal(store.get(task.id).state, 'failed');
    assert.equal(store.get(task.id).error_code, 'MODEL_NOT_ENABLED');
  });

  it('image: sync generate inside submit, result survives in the vendor id, files downloaded', async () => {
    const { store, queue, calls } = setup();
    const { task } = store.enqueue({ idempotencyKey: 'i1', provider: 'bailian', kind: 'image', params: { prompt: 'cat' } });
    await drain(queue, 3);
    const row = store.get(task.id);
    assert.equal(row.state, 'succeeded');
    assert.match(row.vendor_task_id, /^sync:/);
    assert.equal(calls.image.length, 1);
    assert.equal(calls.image[0].req.model, 'wan2.6-t2i');
    assert.equal(JSON.parse(row.result).files[0].path, 'blobs/xx/a.png');
  });

  it('tts: audio is written to the content-addressed store, not into the DB', async () => {
    const { store, queue, storageDir } = setup();
    const { task } = store.enqueue({ idempotencyKey: 't1', provider: 'bailian', kind: 'tts', params: { text: '你好', wordTimestamps: true } });
    await drain(queue, 3);
    const res = JSON.parse(store.get(task.id).result);
    assert.equal(store.get(task.id).state, 'succeeded');
    assert.equal(fs.readFileSync(path.join(storageDir, res.path), 'utf8'), 'AUDIO');
    assert.equal(res.format, 'mp3');
    assert.equal(JSON.parse(fs.readFileSync(path.join(storageDir, res.words.path), 'utf8'))[0].endMs, 5);
  });

  it('missing config or key fails readably and the key never appears in task rows or views', async () => {
    const { store, queue, db } = setup({ configs: { ...CONFIGS, video: [] } });
    const bad = store.enqueue({ idempotencyKey: 'n1', provider: 'ark', kind: 'video', params: { prompt: 'x' } }).task;
    const ok = store.enqueue({ idempotencyKey: 'n2', provider: 'bailian', kind: 'image', params: { prompt: 'x' } }).task;
    await drain(queue, 3);
    assert.equal(store.get(bad.id).error_code, 'INVALID_API_KEY');
    assert.match(toView(store.get(bad.id)).error_readable, /API Key/);
    const dump = JSON.stringify(db.prepare('SELECT * FROM ai_tasks').all()) + JSON.stringify(toView(store.get(ok.id)));
    assert.equal(dump.includes(SECRET), false);
  });

  it('ark tts takes the speech token and app id from the saved config', async () => {
    const cfgs = { ...CONFIGS, tts: [{ id: 9, provider: 'volcengine', service_type: 'tts', api_key: 'tok-abc-123456', settings: JSON.stringify({ app_id: 'app1', cluster: 'c1' }), is_active: true, model: [] }] };
    const { store, queue, calls } = setup({ configs: cfgs });
    store.enqueue({ idempotencyKey: 't2', provider: 'ark', kind: 'tts', params: { text: 'a' } });
    await drain(queue, 2);
    assert.deepEqual(calls.configs[0].speech, { appId: 'app1', accessToken: 'tok-abc-123456', cluster: 'c1' });
  });
});
