const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const tl = require('../src/timeline');
const music = require('../src/music');
const musicRoutes = require('../src/routes/music');
const timelineRoutes = require('../src/routes/timelines');

const MIG = (f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-'));
  const db = new Database(path.join(dir, 't.db'));
  db.pragma('foreign_keys = ON');
  db.exec(MIG('01_init.sql'));
  db.exec(MIG('24_timelines.sql'));
  db.exec(MIG('26_music_library_and_mix.sql'));
  db.exec(MIG('27_project_graphs.sql'));
  const storageRoot = path.join(dir, 'storage');
  fs.mkdirSync(storageRoot);
  const library = music.createMusicLibrary(db, { storageRoot, probe: async () => 12000 });
  return { db, storageRoot, library };
}

const mp3Bytes = () => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]);

describe('placeholder synthesis', () => {
  it('generates valid, deterministic, non-silent 30s WAVs', () => {
    for (const style of Object.keys(music.STYLES)) {
      const a = music.generatePlaceholder(style);
      const b = music.generatePlaceholder(style);
      assert.ok(a.equals(b), `${style} is deterministic`);
      assert.equal(a.toString('latin1', 0, 4), 'RIFF');
      assert.equal(music.wavDurationMs(a), 30000);
      let peak = 0;
      for (let i = 44; i < a.length; i += 2) peak = Math.max(peak, Math.abs(a.readInt16LE(i)));
      assert.ok(peak > 5000, `${style} has signal`);
      assert.equal(a.readInt16LE(44), 0); // fade-in starts silent
    }
    assert.throws(() => music.generatePlaceholder('nope'), RangeError);
  });

  it('wavDurationMs rejects non-wav', () => {
    assert.equal(music.wavDurationMs(Buffer.from('hello world, not a wav file at all, padding padding padding')), null);
  });
});

describe('music library', () => {
  it('lists self-generated placeholders on first use, idempotently', () => {
    const { library, storageRoot } = setup();
    const a = library.list();
    assert.equal(a.length, 3);
    assert.ok(a.every((m) => m.source === 'builtin' && m.duration_ms === 30000));
    assert.ok(a.every((m) => fs.existsSync(path.join(storageRoot, m.file_path))));
    assert.equal(library.list().length, 3);
    assert.throws(() => library.remove('builtin-calm'), /不能删除/);
  });

  it('imports user files, validates type/content/size, and cleans up on failure', async () => {
    const { library, storageRoot } = setup();
    const item = await library.importFile({ buffer: mp3Bytes(), originalName: '我的歌.mp3' });
    assert.equal(item.name, '我的歌');
    assert.equal(item.source, 'user');
    assert.equal(item.duration_ms, 12000);
    assert.match(item.file_path, /^library\/music\/[0-9a-f-]+\.mp3$/);
    assert.ok(fs.existsSync(path.join(storageRoot, item.file_path)));

    await assert.rejects(library.importFile({ buffer: mp3Bytes(), originalName: 'x.txt' }), /只支持/);
    await assert.rejects(library.importFile({ buffer: Buffer.from('MZ not audio at all, long enough'), originalName: 'x.mp3' }), /内容与扩展名不符/);
    await assert.rejects(library.importFile({ buffer: Buffer.alloc(0), originalName: 'x.mp3' }), /为空/);

    const noProbe = music.createMusicLibrary(setup().db, { storageRoot, probe: async () => null });
    await assert.rejects(noProbe.importFile({ buffer: mp3Bytes(), originalName: 'y.mp3' }), /无法读取音频时长/);
    assert.equal(fs.readdirSync(path.join(storageRoot, 'library', 'music')).filter((f) => f.endsWith('.mp3')).length, 1); // failed import removed
    const hinted = await noProbe.importFile({ buffer: mp3Bytes(), originalName: 'y.mp3', durationHintMs: 4500 });
    assert.equal(hinted.duration_ms, 4500);
  });

  it('reads WAV length from the header without ffprobe', async () => {
    const { db, storageRoot } = setup();
    const lib = music.createMusicLibrary(db, { storageRoot, probe: async () => null });
    const item = await lib.importFile({ buffer: music.generatePlaceholder('calm'), originalName: 'own.wav' });
    assert.equal(item.duration_ms, 30000);
  });
});

describe('attach to timeline and mix settings', () => {
  let ctx;
  let timelineId;
  beforeEach(() => {
    ctx = setup();
    const t = tl.saveTimeline(ctx.db, { episode_id: 1, tracks: [
      { kind: 'video', volume: 1, clips: [{ id: 'v1', start_ms: 0, duration_ms: 70000, asset_ref: 'v/1.mp4', asset_kind: 'video', src_in_ms: 0, src_out_ms: 70000 }] },
      { kind: 'subtitle', volume: 1, clips: [] }, { kind: 'narration', volume: 1, clips: [] }, { kind: 'music', volume: 0.5, clips: [] },
    ] });
    timelineId = t.id;
  });

  it('attaches once, trimmed to the video when the track is longer', async () => {
    const lib = ctx.library;
    lib.list();
    const r = music.attachMusic(ctx.db, lib, timelineId, 'builtin-calm', { start_ms: 60000 });
    const clips = r.timeline.tracks.find((t) => t.kind === 'music').clips;
    assert.equal(clips.length, 1);
    assert.equal(clips[0].duration_ms, 10000);
    assert.equal(clips[0].src_in_ms, 0);
    assert.equal(clips[0].src_out_ms, 10000);
    assert.equal(clips[0].asset_ref, 'library/music/builtin-calm.wav');
  });

  it('loops back to back until the video ends', () => {
    ctx.library.list();
    const r = music.attachMusic(ctx.db, ctx.library, timelineId, 'builtin-calm', { loop: true });
    const clips = r.timeline.tracks.find((t) => t.kind === 'music').clips;
    assert.deepEqual(clips.map((c) => [c.start_ms, c.duration_ms]), [[0, 30000], [30000, 30000], [60000, 10000]]);
    assert.equal(r.timeline.duration_ms, 70000);
  });

  it('rejects unknown music and bad start', () => {
    assert.throws(() => music.attachMusic(ctx.db, ctx.library, timelineId, 'nope'), /音乐不存在/);
    ctx.library.list();
    assert.throws(() => music.attachMusic(ctx.db, ctx.library, timelineId, 'builtin-calm', { start_ms: -1 }), /start_ms/);
  });

  it('refuses to delete a track a timeline uses', async () => {
    const item = await ctx.library.importFile({ buffer: mp3Bytes(), originalName: 'a.mp3' });
    music.attachMusic(ctx.db, ctx.library, timelineId, item.id);
    assert.throws(() => ctx.library.remove(item.id), (e) => e.code === 'IN_USE');
  });

  it('persists mix settings and music volume in the timeline, with defaults and validation', () => {
    const t0 = tl.loadTimeline(ctx.db, timelineId);
    assert.deepEqual(t0.mix, tl.DEFAULT_MIX);
    const saved = tl.saveTimeline(ctx.db, { ...t0, mix: { ducking: { enabled: true, gain: 0.1, rampMs: 400 }, loudnorm: false },
      tracks: t0.tracks.map((t) => (t.kind === 'music' ? { ...t, volume: 0.3 } : t)) });
    assert.deepEqual(saved.mix, { ducking: { enabled: true, gain: 0.1, rampMs: 400 }, loudnorm: false });
    assert.equal(saved.tracks.find((t) => t.kind === 'music').volume, 0.3);
    // clip operations keep the mix
    const after = tl.addClip(ctx.db, timelineId, 'subtitle', { start_ms: 0, duration_ms: 1000, text: 'hi' });
    assert.equal(after.timeline.mix.loudnorm, false);
    // partial mix fills defaults; omitting mix keeps the stored one
    assert.equal(tl.saveTimeline(ctx.db, { ...saved, version: undefined, mix: { ducking: { enabled: false } } }).mix.ducking.gain, 0.25);
    const kept = tl.saveTimeline(ctx.db, { episode_id: 1, id: timelineId, tracks: saved.tracks });
    assert.equal(kept.mix.ducking.enabled, false);
    for (const bad of [{ ducking: { gain: 2 } }, { ducking: { enabled: 'yes' } }, { ducking: { rampMs: -1 } }, { loudnorm: 1 }, 5]) {
      assert.throws(() => tl.saveTimeline(ctx.db, { ...saved, mix: bad }), (e) => e instanceof tl.TimelineError, JSON.stringify(bad));
    }
    assert.throws(() => tl.saveTimeline(ctx.db, { ...saved, tracks: saved.tracks.map((t) => ({ ...t, volume: 9 })) }), /volume/);
  });
});

describe('music HTTP routes', () => {
  it('uploads, lists, attaches and deletes through express', async () => {
    const { db, library } = setup();
    // 音乐挂载现在经项目图提交：需要剧集与对应的分镜（视频片段必须属于某个分镜）
    db.prepare("INSERT INTO episodes (id, drama_id, script_content) VALUES (1, 1, '')").run();
    const sb = Number(db.prepare("INSERT INTO storyboards (episode_id, storyboard_number, duration, video_url) VALUES (1, 1, 20, 'v/1.mp4')").run().lastInsertRowid);
    const t = tl.saveTimeline(db, { episode_id: 1, tracks: [
      { kind: 'video', volume: 1, clips: [{ id: 'v1', start_ms: 0, duration_ms: 20000, asset_ref: 'v/1.mp4', asset_kind: 'video', src_in_ms: 0, src_out_ms: 20000, storyboard_id: sb }] },
      { kind: 'subtitle', volume: 1, clips: [] }, { kind: 'narration', volume: 1, clips: [] }, { kind: 'music', volume: 1, clips: [] },
    ] });
    const log = { error() {} };
    const m = musicRoutes(db, library, log);
    const app = express();
    app.use(express.json());
    app.get('/music-library', m.list);
    app.post('/music-library', m.multerSingle, m.import);
    app.delete('/music-library/:id', m.remove);
    app.post('/timelines/:id/music', m.attach);
    app.put('/timelines/:id', timelineRoutes(db, log).save);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const fd = new FormData();
      fd.append('file', new Blob([mp3Bytes()]), '夜曲.mp3');
      let r = await fetch(base + '/music-library', { method: 'POST', body: fd });
      assert.equal(r.status, 201);
      const item = (await r.json()).data;
      assert.equal(item.name, '夜曲');

      const noFile = await fetch(base + '/music-library', { method: 'POST', body: new FormData() });
      assert.equal(noFile.status, 400);
      const bad = new FormData();
      bad.append('file', new Blob(['x'.repeat(50)]), 'a.exe');
      assert.equal((await fetch(base + '/music-library', { method: 'POST', body: bad })).status, 400);

      r = await fetch(base + '/music-library');
      assert.equal((await r.json()).data.items.length, 4);

      r = await fetch(`${base}/timelines/${t.id}/music`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ music_id: item.id, loop: true }) });
      assert.equal(r.status, 201);
      assert.equal((await fetch(`${base}/timelines/${t.id}/music`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
      assert.equal((await fetch(`${base}/timelines/${t.id}/music`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ music_id: 'zzz' }) })).status, 404);

      assert.equal((await fetch(`${base}/music-library/${item.id}`, { method: 'DELETE' })).status, 409);
      assert.equal((await fetch(`${base}/music-library/builtin-calm`, { method: 'DELETE' })).status, 403);

      // mix travels with the normal timeline save
      const cur = tl.loadTimeline(db, t.id);
      r = await fetch(`${base}/timelines/${t.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...cur, mix: { ducking: { gain: 0.4 } } }) });
      assert.equal((await r.json()).data.mix.ducking.gain, 0.4);
      r = await fetch(`${base}/timelines/${t.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...cur, mix: { ducking: { gain: 3 } } }) });
      assert.equal(r.status, 400);
    } finally { server.close(); }
  });
});
