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
  for (const m of ['licence.status', 'render.start']) {
    await assert.rejects(c.call(m, {}), (e) => e.code === -32001 && /not implemented/.test(e.message));
  }
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
  c.close();

  await new Promise((r) => setTimeout(r, 300));
  assert.ok(fs.readdirSync(logDir).some((f) => f.startsWith('lycore.log')), 'log file written');
  console.log('core client integration test: OK');
})().then(() => { child.kill(); process.exit(0); }, (e) => { console.error(e); child.kill(); process.exit(1); });
