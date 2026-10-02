// End-to-end: real lycore binary + real ffmpeg + the real JS client. Skipped when the binary or ffmpeg is missing.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const tl = require('../src/timeline');
const aigc = require('../src/export/aigc');
const { createExportService } = require('../src/export/service');

const coreRoot = path.join(__dirname, '..', '..', 'core');
const exe = process.platform === 'win32' ? 'lycore.exe' : 'lycore';
const bins = ['release', 'debug'].map((p) => path.join(coreRoot, 'target', p, exe)).filter(fs.existsSync);
const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
const skip = !bins.length ? 'lycore binary not built' : hasFfmpeg.status !== 0 || !/subtitles/.test(hasFfmpeg.stdout) ? 'ffmpeg with libass not available' : false;
const MIG = (f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');

describe('export through the real core', { skip }, () => {
  let child;
  let client;
  let dir;
  let db;
  let storageRoot;
  const frameHash = (file, t) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'md5', '-'], { encoding: 'utf8' }).trim();

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-e2e-'));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\export-e2e-${process.pid}` : path.join(dir, 'core.sock');
    const bin = bins.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    child = spawn(bin, ['--pipe', endpoint, '--log-dir', path.join(dir, 'log')], { stdio: 'ignore' });
    client = await require(path.join(coreRoot, 'client')).connectRetry(endpoint);
    db = new Database(path.join(dir, 't.db'));
    db.pragma('foreign_keys = ON');
    db.exec(MIG('01_init.sql'));
    db.exec(`CREATE TABLE IF NOT EXISTS global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`);
    db.exec(MIG('24_timelines.sql'));
    db.exec(MIG('26_music_library_and_mix.sql'));
    storageRoot = path.join(dir, 'storage');
    fs.mkdirSync(path.join(storageRoot, 'v'), { recursive: true });
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x205080:s=320x180:r=15:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(storageRoot, 'v', 'a.mp4')]);
    const music = require('../src/music');
    fs.mkdirSync(path.join(storageRoot, 'library', 'music'), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, 'library', 'music', 'bgm.wav'), music.generatePlaceholder('calm'));
    tl.saveTimeline(db, {
      episode_id: 1, mix: { ducking: { enabled: true, gain: 0.3, rampMs: 100 }, loudnorm: true },
      tracks: [
        { kind: 'video', volume: 1, clips: [{ id: 'v1', start_ms: 0, duration_ms: 2000, asset_ref: 'v/a.mp4', asset_kind: 'video', src_in_ms: 0, src_out_ms: 2000 }] },
        { kind: 'subtitle', volume: 1, clips: [] },
        { kind: 'narration', volume: 1, clips: [] },
        { kind: 'music', volume: 0.5, clips: [{ id: 'm1', start_ms: 0, duration_ms: 2000, asset_ref: 'library/music/bgm.wav', asset_kind: 'audio', src_in_ms: 0, src_out_ms: 2000 }] },
      ],
    });
  });

  after(() => { try { client && client.close(); } catch (_) { /* closed */ } if (child) child.kill(); });

  async function run(name) {
    const svc = createExportService(db, { getCore: async () => client, storageRoot, ffmpegPath: 'ffmpeg', opener() {} });
    const out = path.join(dir, `${name}.mp4`);
    const { job_id: id } = await svc.start({ episode_id: 1, width: 640, height: 360, fps: 15, encoder: 'libx264', output_path: out });
    let s;
    for (let i = 0; i < 300; i++) {
      s = await svc.status(id);
      if (['done', 'failed', 'cancelled'].includes(s.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { s, out };
  }

  it('renders with music, visible label and AIGC metadata; label setting changes the picture', async () => {
    aigc.setSettings(db, { watermark: true, metadata: true });
    const on = await run('on');
    assert.equal(on.s.status, 'done', JSON.stringify(on.s.error));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags:stream=codec_name,width,height', '-of', 'json', on.out], { encoding: 'utf8' }));
    assert.equal(probe.streams.find((x) => x.codec_name === 'h264').width, 640);
    assert.ok(probe.streams.some((x) => x.codec_name === 'aac'));
    assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.3);
    assert.equal(JSON.parse(probe.format.tags.AIGC).Label, '1');

    aigc.setSettings(db, { watermark: false, metadata: false });
    const off = await run('off');
    assert.equal(off.s.status, 'done');
    const offProbe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', off.out], { encoding: 'utf8' }));
    assert.equal((offProbe.format.tags || {}).AIGC, undefined);
    assert.notEqual(frameHash(on.out, 0.5), frameHash(off.out, 0.5)); // the burned-in label is visible
    if (process.env.KEEP_E2E_FRAMES) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0.5', '-i', on.out, '-frames:v', '1', path.join(process.env.KEEP_E2E_FRAMES, 'label-intro.png')]);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1.5', '-i', on.out, '-frames:v', '1', path.join(process.env.KEEP_E2E_FRAMES, 'label-persistent.png')]);
    }
  });
});
