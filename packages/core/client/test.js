'use strict';
// Integration test: spawns the lycore binary and exercises core.hello. Run: node client/test.js
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectRetry, RpcError } = require('./index');

const exe = process.platform === 'win32' ? 'lycore.exe' : 'lycore';
const root = path.join(__dirname, '..');
const candidates = ['release', 'debug'].map((p) => path.join(root, 'target', p, exe)).filter(fs.existsSync);
if (!candidates.length) { console.error('lycore binary not built; run cargo build'); process.exit(1); }
const bin = candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

const id = `lycore-test-${process.pid}`;
const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lycore-log-'));

// Fake ffmpeg/ffprobe in a temp dir (node script + thin wrapper; .cmd on Windows).
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lycore-fakeff-'));
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lycore-noff-'));
const fixtures = path.join(root, 'src', 'fixtures');
fs.writeFileSync(path.join(fakeDir, 'fake.js'), `
const fs = require('fs');
const [tool, ...a] = process.argv.slice(2);
const fx = ${JSON.stringify(fixtures)};
if (tool === 'ffprobe') {
  const input = a[a.indexOf('-i') + 1];
  if (input === 'hang.mp4') setTimeout(() => {}, 60000);
  else if (input === 'bad.mp4') { console.error('bad.mp4: Invalid data found when processing input'); process.exit(1); }
  else if (input === 'junk.mp4') console.log('this is not json');
  else console.log(fs.readFileSync(fx + '/ffprobe_av.json', 'utf8'));
} else if (a.includes('-encoders')) {
  process.stdout.write(fs.readFileSync(fx + '/ffmpeg_encoders.txt', 'utf8'));
} else if (a.includes('-filters')) {
  process.stdout.write(' T.. subtitles          V->V       Render text subtitles\\n');
} else if (a.includes('-progress')) {
  console.log('out_time_us=100000');
  fs.writeFileSync(a[a.length - 1], 'fake');
} else {
  const enc = a[a.indexOf('-c:v') + 1];
  if (enc === 'libx264' || enc === 'h264_mf') process.exit(0);
  console.error('[' + enc + ' @ 0x55d0c8a1b2c0] Cannot load libcuda.so.1');
  console.error('Error initializing output stream 0:0 -- Error while opening encoder');
  process.exit(1);
}
`);
for (const tool of ['ffmpeg', 'ffprobe']) {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(fakeDir, tool + '.cmd'), `@"${process.execPath}" "%~dp0fake.js" ${tool} %*\r\n`);
  } else {
    const f = path.join(fakeDir, tool);
    fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.js" ${tool} "$@"\n`);
    fs.chmodSync(f, 0o755);
  }
}
const child = spawn(bin, ['--pipe', endpoint, '--log-dir', logDir], {
  stdio: 'inherit',
  env: { ...process.env, LYCORE_FFMPEG_DIR: fakeDir },
});

(async () => {
  const c = await connectRetry(endpoint);
  const r = await c.hello([1, 2]);
  assert.strictEqual(r.name, 'lycore');
  assert.strictEqual(r.apiVersion, 1);
  assert.ok(r.version && r.build);

  await assert.rejects(c.hello([99]), (e) => e instanceof RpcError && e.code === -32010 && /incompatible/.test(e.message));
  await assert.rejects(c.call('core.hello', {}), (e) => e.code === -32602);
  await assert.rejects(c.call('licence.status', {}), (e) => e.code === -32001 && /not implemented/.test(e.message));
  await assert.rejects(c.call('render.start', {}), (e) => e.code === -32602);
  await assert.rejects(c.call('nope', {}), (e) => e.code === -32601);

  // media.probe via fake ffprobe
  const p = await c.call('media.probe', { path: 'clip.mp4' });
  assert.strictEqual(p.video.codec, 'h264');
  assert.strictEqual(p.video.width, 1920);
  assert.strictEqual(p.video.fps, 29.97);
  assert.strictEqual(p.audio.sampleRate, 48000);
  assert.strictEqual(p.durationSec, 63.52);
  await assert.rejects(c.call('media.probe', {}), (e) => e.code === -32602);
  await assert.rejects(c.call('media.probe', { path: 'bad.mp4' }), (e) => e.code === -32021 && /Invalid data/.test(e.data.stderr));
  await assert.rejects(c.call('media.probe', { path: 'junk.mp4' }), (e) => e.code === -32023);
  await assert.rejects(c.call('media.probe', { path: 'hang.mp4', timeoutSec: 1 }), (e) => e.code === -32022);

  // encoder.detect via fake ffmpeg
  const d = await c.call('encoder.detect', {});
  assert.deepStrictEqual(d.recommended, ['h264_mf', 'libx264']);
  assert.strictEqual(d.best, 'h264_mf');
  const nv = d.encoders.find((x) => x.name === 'h264_nvenc');
  assert.strictEqual(nv.available, false);
  assert.strictEqual(nv.reason, 'Cannot load libcuda.so.1');
  assert.strictEqual(d.encoders.find((x) => x.name === 'libx264').available, true);

  // missing toolchain -> recoverable error
  for (const m of ['media.probe', 'encoder.detect']) {
    await assert.rejects(c.call(m, { path: 'clip.mp4', ffmpegDir: emptyDir }), (e) =>
      e.code === -32020 && e.data.recoverable === true && e.data.action === 'reinstall' && /reinstall/.test(e.message));
  }
  // render.plan: scenes, keys, cache hits
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lycore-plan-'));
    const cache = path.join(dir, 'cache');
    fs.mkdirSync(cache);
    for (const n of ['a.mp4', 'b.mp4']) fs.writeFileSync(path.join(dir, n), n);
    const tl = { tracks: [
      { kind: 'video', clips: [
        { id: 'v1', start_ms: 0, duration_ms: 3000, src_in_ms: 0, src_out_ms: 3000, asset_ref: path.join(dir, 'a.mp4'), volume: 1 },
        { id: 'v2', start_ms: 4000, duration_ms: 2000, src_in_ms: 0, src_out_ms: 2000, asset_ref: path.join(dir, 'b.mp4'), volume: 1 } ] },
      { kind: 'subtitle', clips: [{ id: 's1', start_ms: 100, duration_ms: 500, text: 'hi', style: null }] },
      { kind: 'narration', clips: [] },
      { kind: 'music', clips: [] },
    ] };
    const output = { width: 1280, height: 720, fps: 30, encoder: 'libx264' };
    const p1 = await c.renderPlan({ timeline: tl, output, cacheDir: cache });
    assert.strictEqual(p1.durationMs, 6000);
    assert.deepStrictEqual(p1.scenes.map((s) => s.kind), ['video', 'gap', 'video']);
    assert.deepStrictEqual(p1.toRender, [0, 1, 2]);
    assert.ok(p1.scenes.every((s) => /^[0-9a-f]{64}$/.test(s.sceneKey) && !s.cacheHit));
    fs.writeFileSync(path.join(cache, p1.scenes[0].sceneKey + '.mp4'), 'x');
    tl.tracks[1].clips[0].text = 'changed';
    const p2 = await c.renderPlan({ timeline: tl, output, cacheDir: cache });
    assert.notStrictEqual(p2.scenes[0].sceneKey, p1.scenes[0].sceneKey);
    assert.strictEqual(p2.scenes[0].cacheHit, false);
    assert.strictEqual(p2.scenes[2].sceneKey, p1.scenes[2].sceneKey);
    tl.tracks[1].clips[0].text = 'hi';
    const p3 = await c.renderPlan({ timeline: tl, output, cacheDir: cache });
    assert.deepStrictEqual(p3.scenes.map((s) => s.cacheHit), [true, false, false]);
    assert.deepStrictEqual(p3.toRender, [1, 2]);
    await assert.rejects(c.renderPlan({ timeline: tl }), (e) => e.code === -32602);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // render.start / status / cancel with the fake ffmpeg: job id, progress notifications, final state
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lycore-render-'));
    for (const n of ['a.mp4', 'n.wav']) fs.writeFileSync(path.join(dir, n), n);
    const tl = { tracks: [
      { kind: 'video', clips: [{ id: 'v1', start_ms: 0, duration_ms: 2000, src_in_ms: 0, src_out_ms: 2000, asset_ref: path.join(dir, 'a.mp4'), volume: 1 }] },
      { kind: 'subtitle', clips: [{ id: 's1', start_ms: 100, duration_ms: 500, text: 'hi' }] },
      { kind: 'narration', clips: [{ id: 'n1', start_ms: 0, duration_ms: 1000, asset_ref: path.join(dir, 'n.wav'), volume: 1 }] },
    ] };
    const params = { timeline: tl, output: { width: 640, height: 360, fps: 30, encoder: 'libx264' },
      cacheDir: path.join(dir, 'cache'), outputPath: path.join(dir, 'out', 'final.mp4') };
    const events = [];
    const off = c.onNotification((m) => { if (m.method === 'render.progress') events.push(m.params); });
    const { jobId } = await c.renderStart(params);
    assert.ok(/^job-/.test(jobId));
    const final = await c.renderWait(jobId);
    assert.strictEqual(final.status, 'done', JSON.stringify(final));
    assert.strictEqual(final.percent, 100);
    assert.ok(events.length >= 2 && events.every((e) => e.jobId === jobId), 'progress notifications received');
    assert.strictEqual(events[events.length - 1].status, 'done');
    assert.ok(fs.existsSync(params.outputPath));
    const st = await c.renderStatus(jobId);
    assert.strictEqual(st.result.scenesRendered, 1);
    assert.strictEqual((await c.renderCancel(jobId)).cancelRequested, false);
    await assert.rejects(c.renderStatus('nope'), (e) => e.code === -32602);
    off();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  c.close();

  await new Promise((r) => setTimeout(r, 300));
  assert.ok(fs.readdirSync(logDir).some((f) => f.startsWith('lycore.log')), 'log file written');
  console.log('core client integration test: OK');
})().then(() => { child.kill(); process.exit(0); }, (e) => { console.error(e); child.kill(); process.exit(1); });
