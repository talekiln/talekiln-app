const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const express = require('express');
const Database = require('better-sqlite3');
const tl = require('../src/timeline');
const aigc = require('../src/export/aigc');
const { createExportService, ExportError } = require('../src/export/service');
const { resolveAssetRef } = require('../src/export/resolve');
const { createCoreProvider } = require('../src/export/coreProvider');
const exportRoutes = require('../src/routes/export');

const MIG = (f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');

const DETECT = {
  encoders: [
    { name: 'h264_nvenc', available: false, reason: 'Cannot load libcuda' },
    { name: 'h264_mf', available: true },
    { name: 'libx264', available: true },
  ],
  recommended: ['h264_mf', 'libx264'],
  best: 'h264_mf',
};

/** In-memory stand-in for the lycore JSON-RPC client (same method names as packages/core/client). */
function fakeCore() {
  const f = {
    started: [], cancelled: [], statuses: [], detectCalls: 0, detectOpts: null, startError: null,
    async call(method, params, opts) {
      if (method !== 'encoder.detect') throw new Error('unexpected ' + method);
      f.detectCalls++;
      f.detectOpts = opts || null;
      return DETECT;
    },
    async renderStart(params) {
      if (f.startError) throw f.startError;
      f.started.push(params);
      return { jobId: 'job-1' };
    },
    async renderStatus(jobId) {
      assert.equal(jobId, 'job-1');
      const s = f.statuses.length > 1 ? f.statuses.shift() : f.statuses[0];
      return { jobId, encoder: 'h264_mf', error: null, result: null, ...s };
    },
    async renderCancel(jobId) { f.cancelled.push(jobId); return { jobId, status: 'running', cancelRequested: true }; },
  };
  return f;
}

function setup({ watermark } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
  const db = new Database(path.join(dir, 't.db'));
  db.pragma('foreign_keys = ON');
  db.exec(MIG('01_init.sql'));
  db.exec(`CREATE TABLE IF NOT EXISTS global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`);
  db.exec(MIG('24_timelines.sql'));
  db.exec(MIG('26_music_library_and_mix.sql'));
  const storageRoot = path.join(dir, 'storage');
  fs.mkdirSync(path.join(storageRoot, 'v'), { recursive: true });
  fs.mkdirSync(path.join(storageRoot, 'library', 'music'), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'v', '1.mp4'), 'x');
  fs.writeFileSync(path.join(storageRoot, 'v', '2.mp4'), 'x');
  fs.writeFileSync(path.join(storageRoot, 'a.mp3'), 'x');
  fs.writeFileSync(path.join(storageRoot, 'library', 'music', 'm.mp3'), 'x');
  const t = tl.saveTimeline(db, {
    episode_id: 5,
    mix: { ducking: { enabled: true, gain: 0.2, rampMs: 300 }, loudnorm: false },
    tracks: [
      { kind: 'video', volume: 1, clips: [
        { id: 'v1', start_ms: 0, duration_ms: 4000, asset_ref: '/static/v/1.mp4', asset_kind: 'video', src_in_ms: 0, src_out_ms: 4000 },
        { id: 'v2', start_ms: 4000, duration_ms: 6000, asset_ref: 'v/2.mp4', asset_kind: 'video', src_in_ms: 0, src_out_ms: 6000 },
      ] },
      { kind: 'subtitle', volume: 1, clips: [{ id: 's1', start_ms: 0, duration_ms: 2000, text: 'hi' }] },
      { kind: 'narration', volume: 1, clips: [{ id: 'n1', start_ms: 0, duration_ms: 3000, asset_ref: 'a.mp3', asset_kind: 'audio', src_in_ms: 0, src_out_ms: 3000 }] },
      { kind: 'music', volume: 0.5, clips: [{ id: 'm1', start_ms: 0, duration_ms: 10000, asset_ref: 'library/music/m.mp3', asset_kind: 'audio', src_in_ms: 0, src_out_ms: 10000 }] },
    ],
  });
  if (watermark !== undefined) aigc.setSettings(db, { watermark });
  const core = fakeCore();
  const calls = { ffmpeg: [], opened: [] };
  const out = path.join(dir, 'out', 'final.mp4');
  const svc = createExportService(db, {
    getCore: async () => core, storageRoot, ffmpegPath: 'ffmpeg-test',
    runFfmpeg: async (bin, args) => { calls.ffmpeg.push([bin, args]); fs.writeFileSync(args[args.length - 1], 'labelled'); },
    opener: (p) => calls.opened.push(p), newId: (() => { let n = 0; return () => `id-${++n}`; })(),
  });
  return { db, dir, storageRoot, core, svc, calls, out, timelineId: t.id };
}

const REQ = (out) => ({ episode_id: 5, width: 1920, height: 1080, fps: 30, encoder: 'libx264', output_path: out });

describe('AIGC settings', () => {
  it('default on, patchable, validated', () => {
    const { db } = setup();
    assert.deepEqual(aigc.getSettings(db), { watermark: true, metadata: true, producer: 'Talekiln' });
    assert.deepEqual(aigc.setSettings(db, { watermark: false }), { watermark: false, metadata: true, producer: 'Talekiln' });
    assert.equal(aigc.getSettings(db).watermark, false);
    assert.equal(aigc.setSettings(db, { producer: '  某某工作室 ' }).producer, '某某工作室');
    assert.throws(() => aigc.setSettings(db, { watermark: 'no' }), aigc.AigcError);
    assert.throws(() => aigc.setSettings(db, { producer: '' }), aigc.AigcError);
  });

  it('watermark clips: larger intro then smaller persistent, in output pixels', () => {
    let n = 0;
    const clips = aigc.watermarkClips(10000, 1920, 1080, () => `w${++n}`);
    assert.equal(clips.length, 2);
    assert.deepEqual(clips.map((c) => [c.start_ms, c.duration_ms, c.text]), [[0, 3000, 'AI生成'], [3000, 7000, 'AI生成']]);
    assert.equal(clips[0].style.size, Math.round(1080 * 0.055));
    assert.ok(clips[0].style.size > clips[1].style.size);
    assert.equal(clips[0].style.position, 'top');
    // portrait uses the shorter side too
    assert.equal(aigc.watermarkClips(10000, 1080, 1920, () => 'x')[0].style.size, Math.round(1080 * 0.055));
    // short video: only the intro, never longer than the video
    assert.deepEqual(aigc.watermarkClips(1500, 1280, 720, () => 'x').map((c) => c.duration_ms), [1500]);
    assert.deepEqual(aigc.watermarkClips(0, 1280, 720, () => 'x'), []);
  });

  it('metadata entries and ffmpeg args', () => {
    const m = aigc.buildMetadata({ producer: '某某', produceId: 'abc' });
    assert.deepEqual(JSON.parse(m.AIGC), { Label: '1', ContentProducer: '某某', ProduceID: 'abc' });
    const a = aigc.metadataArgs('in.mp4', 'out.tmp', m);
    assert.ok(a.includes('-c') && a[a.indexOf('-c') + 1] === 'copy');
    assert.ok(a.some((x) => x.startsWith('AIGC={')));
    assert.ok(a.includes('+faststart+use_metadata_tags'));
  });
});

describe('asset resolution', () => {
  it('maps storage-relative, /static, same-host URL and absolute paths; rejects traversal and remote', () => {
    const root = path.resolve('/srv/store');
    const exists = () => true;
    assert.equal(resolveAssetRef('v/1.mp4', root, { exists }).path, path.join(root, 'v', '1.mp4'));
    assert.equal(resolveAssetRef('/static/v/1.mp4', root, { exists }).path, path.join(root, 'v', '1.mp4'));
    assert.equal(resolveAssetRef('http://127.0.0.1:5679/static/v/a%20b.mp4', root, { exists }).path, path.join(root, 'v', 'a b.mp4'));
    assert.equal(resolveAssetRef('https://cdn.example.com/x.mp4', root, { exists }).error, 'remote');
    assert.equal(resolveAssetRef('../etc/passwd', root, { exists }).error, 'outside');
    assert.equal(resolveAssetRef('/static/../../etc/passwd', root, { exists }).error, 'outside');
    assert.equal(resolveAssetRef('v/1.mp4', root, { exists: () => false }).error, 'missing');
  });
});

describe('export service', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });

  it('builds render.start params from the stored timeline (paths, mix, encoders, watermark)', async () => {
    const r = await ctx.svc.start(REQ(ctx.out));
    assert.equal(r.job_id, 'job-1');
    assert.deepEqual(r.aigc, { watermark: true, metadata: true });
    const p = ctx.core.started[0];
    assert.deepEqual(p.output, { width: 1920, height: 1080, fps: 30, encoder: 'libx264' });
    assert.equal(p.outputPath, ctx.out);
    assert.equal(p.cacheDir, path.join(ctx.storageRoot, 'render-cache'));
    assert.deepEqual(p.fallbackEncoders, ['h264_mf']); // unavailable nvenc is not offered
    assert.deepEqual(p.mix, { ducking: { enabled: true, gain: 0.2, rampMs: 300 }, loudnorm: false });
    const video = p.timeline.tracks.find((t) => t.kind === 'video');
    assert.equal(video.clips[0].asset_ref, path.join(ctx.storageRoot, 'v', '1.mp4'));
    assert.equal(video.clips[1].asset_ref, path.join(ctx.storageRoot, 'v', '2.mp4'));
    assert.equal(p.timeline.tracks.find((t) => t.kind === 'music').volume, 0.5);
    assert.equal(p.timeline.tracks.find((t) => t.kind === 'music').clips[0].asset_ref, path.join(ctx.storageRoot, 'library', 'music', 'm.mp3'));
    const subs = p.timeline.tracks.find((t) => t.kind === 'subtitle').clips;
    assert.equal(subs.length, 3); // user subtitle + intro + persistent label
    assert.deepEqual(subs.slice(1).map((c) => c.text), ['AI生成', 'AI生成']);
    // the stored timeline is not modified by export
    assert.equal(tl.loadTimeline(ctx.db, ctx.timelineId).tracks.find((t) => t.kind === 'subtitle').clips.length, 1);
  });

  it('omits the visible label when the setting is off, and auto picks the detected best encoder', async () => {
    aigc.setSettings(ctx.db, { watermark: false });
    const r = await ctx.svc.start({ ...REQ(ctx.out), encoder: 'auto' });
    assert.equal(r.encoder, 'h264_mf');
    assert.equal(ctx.core.started[0].timeline.tracks.find((t) => t.kind === 'subtitle').clips.length, 1);
    assert.deepEqual(r.aigc, { watermark: false, metadata: true });
  });

  it('validates input before touching the core', async () => {
    const bad = async (patch, re) => {
      await assert.rejects(ctx.svc.start({ ...REQ(ctx.out), ...patch }), (e) => e instanceof ExportError && re.test(e.message), JSON.stringify(patch));
    };
    await bad({ width: 1921 }, /偶数/);
    await bad({ height: 100 }, /偶数/);
    await bad({ fps: 0 }, /帧率/);
    await bad({ fps: 500 }, /帧率/);
    await bad({ output_path: 'relative/out.mp4' }, /绝对路径/);
    await bad({ output_path: path.join(ctx.dir, 'out.mov') }, /\.mp4/);
    await bad({ output_path: ctx.dir + path.sep + 'x.mp4\u0000' }, /非法字符|\.mp4/);
    await bad({ output_path: '' }, /导出位置/);
    await bad({ encoder: 'h264_nvenc' }, /不可用/);
    await bad({ encoder: 'rm -rf' }, /无效/);
    await bad({ episode_id: 0 }, /episode_id/);
    await bad({ episode_id: 99 }, /尚无时间线/);
    assert.equal(ctx.core.started.length, 0);
  });

  it('refuses remote or missing assets with a readable list', async () => {
    tl.addClip(ctx.db, ctx.timelineId, 'narration', { start_ms: 5000, duration_ms: 1000, asset_ref: 'https://cdn.example.com/n.mp3', asset_kind: 'audio' });
    await assert.rejects(ctx.svc.start(REQ(ctx.out)), (e) => e.code === 'EXPORT_ASSETS' && /网络地址/.test(e.message) && e.details.problems.length === 1);
    assert.equal(ctx.core.started.length, 0);
  });

  it('names the shot when a video clip has no asset yet (empty storyboard shot)', async () => {
    // An empty shot (no generated image/video) is projected onto the timeline as a video clip with asset_ref=null;
    // the pre-check must say which shot instead of letting lycore fail with missingAssets: [""].
    const sb = ctx.db.prepare("INSERT INTO storyboards (episode_id, storyboard_number, title) VALUES (5, 3, '')").run().lastInsertRowid;
    tl.addClip(ctx.db, ctx.timelineId, 'video', { start_ms: 10000, duration_ms: 5000, asset_ref: null, asset_kind: 'video', storyboard_id: Number(sb) });
    await assert.rejects(ctx.svc.start(REQ(ctx.out)), (e) => {
      assert.equal(e.code, 'EXPORT_ASSETS');
      assert.match(e.message, /第 3 镜/);
      assert.match(e.message, /画面/);
      assert.equal(e.details.problems.length, 1);
      assert.equal(e.details.problems[0].error, 'no_asset');
      assert.equal(e.details.problems[0].storyboard_id, Number(sb));
      assert.equal(e.details.problems[0].storyboard_number, 3);
      return true;
    });
    assert.equal(ctx.core.started.length, 0);
  });

  it('falls back to the clip id when an empty video clip has no storyboard', async () => {
    tl.addClip(ctx.db, ctx.timelineId, 'video', { start_ms: 10000, duration_ms: 5000, asset_ref: null, asset_kind: 'video' });
    await assert.rejects(ctx.svc.start(REQ(ctx.out)), (e) => e.code === 'EXPORT_ASSETS' && /镜头|片段/.test(e.message) && e.details.problems[0].error === 'no_asset');
    assert.equal(ctx.core.started.length, 0);
  });

  it('still lets subtitle / audio clips without asset_ref through', async () => {
    // subtitle clips are text-only by design; the seeded timeline already has one and must export fine
    await ctx.svc.start(REQ(ctx.out));
    assert.equal(ctx.core.started.length, 1);
  });

  it('maps core errors', async () => {
    ctx.core.startError = Object.assign(new Error('missing'), { code: -32031 });
    await assert.rejects(ctx.svc.start(REQ(ctx.out)), (e) => e.code === 'EXPORT_ASSETS');
    ctx.core.startError = Object.assign(new Error('nope'), { code: -32020 });
    await assert.rejects(ctx.svc.start(REQ(ctx.out)), (e) => e.code === 'FFMPEG_MISSING');
    const dead = createExportService(ctx.db, { getCore: async () => { throw new Error('ECONNREFUSED'); }, storageRoot: ctx.storageRoot });
    await assert.rejects(dead.start(REQ(ctx.out)), (e) => e.status === 503 && e.code === 'CORE_UNAVAILABLE');
  });

  it('polls progress, runs the AIGC metadata pass after done, then reports done', async () => {
    await ctx.svc.start(REQ(ctx.out));
    ctx.core.statuses = [{ status: 'queued', percent: 0 }, { status: 'running', percent: 42.5, stage: 'segment 1/2' }, { status: 'done', percent: 100, stage: 'done', result: { outputPath: ctx.out } }];
    let s = await ctx.svc.status('job-1');
    assert.equal(s.status, 'queued');
    s = await ctx.svc.status('job-1');
    assert.equal(s.status, 'running');
    assert.equal(s.percent, 42.5);
    assert.equal(s.output_path, ctx.out);
    fs.mkdirSync(path.dirname(ctx.out), { recursive: true });
    fs.writeFileSync(ctx.out, 'rendered');
    ctx.svc = createExportService(ctx.db, { ...{}, getCore: async () => ctx.core, storageRoot: ctx.storageRoot, ffmpegPath: 'ffmpeg-test', opener() {},
      runFfmpeg: async (bin, args) => { ctx.calls.ffmpeg.push([bin, args]); await new Promise((r) => setTimeout(r, 30)); fs.writeFileSync(args[args.length - 1], 'labelled'); } });
    await ctx.svc.start(REQ(ctx.out));
    ctx.core.statuses = [{ status: 'done', percent: 100, result: { outputPath: ctx.out } }];
    s = await ctx.svc.status('job-1');
    assert.equal(s.status, 'running'); // metadata pass in flight: not "done" yet
    assert.equal(s.stage, 'AI 内容标识');
    await new Promise((r) => setTimeout(r, 80));
    s = await ctx.svc.status('job-1');
    assert.equal(s.status, 'done');
    assert.equal(ctx.calls.ffmpeg.length, 1);
    const [bin, args] = ctx.calls.ffmpeg[0];
    assert.equal(bin, 'ffmpeg-test');
    assert.ok(args.includes(ctx.out));
    assert.ok(args.some((a) => a.startsWith('AIGC=')));
    assert.equal(fs.readFileSync(ctx.out, 'utf8'), 'labelled');
    assert.equal(fs.existsSync(ctx.out + '.aigc.tmp'), false);
    await ctx.svc.status('job-1'); // idempotent: no second pass
    assert.equal(ctx.calls.ffmpeg.length, 1);
  });

  it('fails the job and removes the unlabelled file when the metadata pass fails', async () => {
    const svc = createExportService(ctx.db, { getCore: async () => ctx.core, storageRoot: ctx.storageRoot, ffmpegPath: 'ff', opener() {},
      runFfmpeg: async () => { throw new Error('Unknown encoder\nboom'); } });
    await svc.start(REQ(ctx.out));
    fs.mkdirSync(path.dirname(ctx.out), { recursive: true });
    fs.writeFileSync(ctx.out, 'rendered');
    ctx.core.statuses = [{ status: 'done', percent: 100 }];
    await svc.status('job-1');
    await new Promise((r) => setTimeout(r, 10));
    const s = await svc.status('job-1');
    assert.equal(s.status, 'failed');
    assert.equal(s.error.code, 'AIGC_METADATA_FAILED');
    assert.match(s.error.message, /AI 内容标识/);
    assert.equal(fs.existsSync(ctx.out), false);
  });

  it('skips the metadata pass when disabled', async () => {
    aigc.setSettings(ctx.db, { metadata: false });
    await ctx.svc.start(REQ(ctx.out));
    ctx.core.statuses = [{ status: 'done', percent: 100 }];
    const s = await ctx.svc.status('job-1');
    assert.equal(s.status, 'done');
    assert.equal(ctx.calls.ffmpeg.length, 0);
  });

  it('passes failed/cancelled through, supports cancel and open-folder, rejects unknown jobs', async () => {
    await ctx.svc.start(REQ(ctx.out));
    ctx.core.statuses = [{ status: 'failed', percent: 10, error: { code: -32032, message: 'x' } }];
    assert.equal((await ctx.svc.status('job-1')).status, 'failed');
    ctx.core.statuses = [{ status: 'cancelled', percent: 10 }];
    assert.equal((await ctx.svc.status('job-1')).status, 'cancelled');
    assert.equal((await ctx.svc.cancel('job-1')).cancelRequested, true);
    assert.deepEqual(ctx.core.cancelled, ['job-1']);
    fs.mkdirSync(path.dirname(ctx.out), { recursive: true });
    assert.deepEqual(ctx.svc.openFolder('job-1'), { opened: path.dirname(ctx.out) });
    assert.deepEqual(ctx.calls.opened, [ctx.out]);
    await assert.rejects(ctx.svc.status('nope'), (e) => e.status === 404);
    assert.throws(() => ctx.svc.openFolder('nope'), (e) => e.status === 404);
  });

  it('caches encoder detection', async () => {
    await ctx.svc.detectEncoders();
    await ctx.svc.detectEncoders();
    assert.equal(ctx.core.detectCalls, 1);
    await ctx.svc.detectEncoders({ refresh: true });
    assert.equal(ctx.core.detectCalls, 2);
  });

  it('gives encoder.detect a long RPC timeout (7 sequential ffmpeg probes can take tens of seconds)', async () => {
    await ctx.svc.detectEncoders();
    assert.ok(ctx.core.detectOpts && ctx.core.detectOpts.timeoutMs >= 60000, `expected timeoutMs >= 60000, got ${JSON.stringify(ctx.core.detectOpts)}`);
  });
});

describe('export HTTP routes', () => {
  it('serves options/start/status/cancel/open-folder and AIGC settings; 503 without a core', async () => {
    const { db, svc, core, out, dir } = setup();
    const log = { error() {} };
    const app = express();
    app.use(express.json());
    const mount = (exporter) => {
      const e = exportRoutes(db, exporter, log);
      const r = express.Router();
      r.get('/settings/aigc', e.getAigc);
      r.put('/settings/aigc', e.putAigc);
      r.get('/export/options', e.options);
      r.post('/export/start', e.start);
      r.get('/export/:id/status', e.status);
      r.post('/export/:id/cancel', e.cancel);
      r.post('/export/:id/open-folder', e.openFolder);
      return r;
    };
    app.use('/a', mount(svc));
    app.use('/b', mount(null));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const j = (url, method = 'GET', body) => fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
    try {
      let r = await j('/a/export/options?episode_id=5');
      assert.equal(r.status, 200);
      assert.equal(r.body.data.best_encoder, 'h264_mf');
      assert.equal(r.body.data.encoders.length, 3);
      assert.equal(r.body.data.resolutions.length, 4);
      assert.equal(r.body.data.aigc.watermark, true);
      assert.match(r.body.data.output_path, /episode-5-\d{14}\.mp4$/);

      r = await j('/a/export/start', 'POST', { ...REQ(out), width: 3 });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'BAD_REQUEST');
      r = await j('/a/export/start', 'POST', REQ(out));
      assert.equal(r.status, 201);
      assert.equal(r.body.data.job_id, 'job-1');

      core.statuses = [{ status: 'running', percent: 10, stage: 'segment 1/1' }];
      r = await j('/a/export/job-1/status');
      assert.equal(r.body.data.percent, 10);
      assert.equal((await j('/a/export/job-1/cancel', 'POST')).body.data.cancelRequested, true);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      assert.equal((await j('/a/export/job-1/open-folder', 'POST')).body.data.opened, path.dirname(out));
      assert.equal((await j('/a/export/zzz/status')).status, 404);

      assert.equal((await j('/a/settings/aigc')).body.data.metadata, true);
      assert.equal((await j('/a/settings/aigc', 'PUT', { watermark: false })).body.data.watermark, false);
      assert.equal((await j('/a/settings/aigc', 'PUT', { watermark: 3 })).status, 400);

      r = await j('/b/export/options');
      assert.equal(r.status, 503);
      assert.equal(r.body.error.code, 'CORE_UNAVAILABLE');
      assert.equal((await j('/b/settings/aigc')).status, 200); // settings still work
    } finally { server.close(); }
    void dir;
  });
});

describe('core provider', () => {
  it('returns null without an endpoint and reconnects once after a dropped connection', async () => {
    assert.equal(createCoreProvider({}), null);
    let connects = 0;
    const mk = () => {
      const n = ++connects;
      return { call: async () => { if (n === 1) throw new Error('connection closed'); return `ok${n}`; }, renderStart: async () => 'start', renderStatus: async () => 's', renderCancel: async () => 'c' };
    };
    const p = createCoreProvider({ endpoint: 'x', connect: async () => mk() });
    const c = await p.getCore();
    assert.equal(await c.call('m'), 'ok2');
    assert.equal(connects, 2);
    assert.equal(await c.renderStart({}), 'start');
    assert.equal(connects, 2);
  });
});

describe('real ffmpeg metadata pass', { skip: spawnSync('ffprobe', ['-version']).status !== 0 && 'ffmpeg/ffprobe not installed' }, () => {
  it('writes AIGC and comment tags by stream copy and keeps the streams', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-real-'));
    const f = path.join(dir, 'in.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=1:s=160x120:r=10', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', f]);
    const entries = aigc.buildMetadata({ producer: '测试工作室', produceId: 'pid-1' });
    await aigc.injectMetadata('ffmpeg', f, entries);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream=codec_name', '-of', 'json', f]).toString());
    assert.deepEqual(JSON.parse(probe.format.tags.AIGC), { Label: '1', ContentProducer: '测试工作室', ProduceID: 'pid-1' });
    assert.match(probe.format.tags.comment, /AI生成/);
    assert.deepEqual(probe.streams.map((s) => s.codec_name).sort(), ['aac', 'h264']);
    assert.equal(fs.existsSync(f + '.aigc.tmp'), false);
    // failure leaves the original intact and cleans up
    const before = fs.readFileSync(f);
    await assert.rejects(aigc.injectMetadata('ffmpeg', path.join(dir, 'missing.mp4'), entries), /写入 AI 内容标识失败/);
    assert.ok(fs.readFileSync(f).equals(before));
  });
});
