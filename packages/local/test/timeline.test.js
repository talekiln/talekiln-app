const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const express = require('express');
const tl = require('../src/timeline');
const timelineRoutes = require('../src/routes/timelines');

const MIG = (f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');

function openDb() {
  const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-')), 't.db'));
  db.pragma('foreign_keys = ON');
  db.exec(MIG('01_init.sql'));
  for (const col of ['narration', 'audio_local_path', 'narration_audio_local_path', 'local_path', 'image_url']) {
    db.exec(`ALTER TABLE storyboards ADD COLUMN ${col} TEXT`);
  }
  db.exec(MIG('24_timelines.sql'));
  return db;
}

function seedStoryboards(db, episodeId = 1) {
  const ins = db.prepare(`INSERT INTO storyboards (episode_id, storyboard_number, duration, dialogue, video_url, local_path, narration_audio_local_path, audio_local_path, deleted_at)
    VALUES (@episode_id, @n, @duration, @dialogue, @video_url, @local_path, @narr, @audio, @deleted)`);
  const rows = [
    { n: 2, duration: 3.5, dialogue: 'Hello there', video_url: '/v/2.mp4', local_path: null, narr: null, audio: '/a/2.mp3', deleted: null },
    { n: 1, duration: 4, dialogue: '', video_url: '/v/1.mp4', local_path: null, narr: '/a/1n.mp3', audio: null, deleted: null },
    { n: 3, duration: null, dialogue: 'Bye', video_url: null, local_path: '/i/3.png', narr: null, audio: null, deleted: null },
    { n: 4, duration: 2, dialogue: 'deleted', video_url: '/v/4.mp4', local_path: null, narr: null, audio: null, deleted: '2020-01-01' },
  ];
  for (const r of rows) ins.run({ episode_id: episodeId, ...r });
}

const track = (t, kind) => t.tracks.find((x) => x.kind === kind);

describe('assembleFromStoryboard', () => {
  let db;
  beforeEach(() => { db = openDb(); seedStoryboards(db); });

  it('builds ordered video, subtitle and narration clips', () => {
    const t = tl.assembleFromStoryboard(db, 1);
    assert.deepEqual(t.tracks.map((x) => x.kind), ['video', 'subtitle', 'narration', 'music']);
    const v = track(t, 'video').clips;
    assert.equal(v.length, 3);
    assert.deepEqual(v.map((c) => [c.start_ms, c.duration_ms]), [[0, 4000], [4000, 3500], [7500, 5000]]);
    assert.deepEqual(v.map((c) => c.asset_ref), ['/v/1.mp4', '/v/2.mp4', '/i/3.png']);
    assert.equal(v[2].asset_kind, 'image');
    const s = track(t, 'subtitle').clips;
    assert.deepEqual(s.map((c) => [c.text, c.start_ms, c.duration_ms]), [['Hello there', 4000, 3500], ['Bye', 7500, 5000]]);
    const n = track(t, 'narration').clips;
    assert.deepEqual(n.map((c) => [c.asset_ref, c.start_ms]), [['/a/1n.mp3', 0], ['/a/2.mp3', 4000]]);
    assert.equal(track(t, 'music').clips.length, 0);
    assert.equal(t.duration_ms, 12500);
  });

  it('refuses to overwrite unless replace, and rejects empty storyboards', () => {
    tl.assembleFromStoryboard(db, 1);
    assert.throws(() => tl.assembleFromStoryboard(db, 1), { code: 'CONFLICT' });
    const again = tl.assembleFromStoryboard(db, 1, { replace: true });
    assert.equal(again.version, 2);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM timeline_clips').get().c, 3 + 2 + 2);
    assert.throws(() => tl.assembleFromStoryboard(db, 99), { code: 'NO_STORYBOARDS' });
  });
});

describe('edit ops', () => {
  let db, t;
  beforeEach(() => { db = openDb(); seedStoryboards(db); t = tl.assembleFromStoryboard(db, 1); });

  it('adds music that may overlap, but not overlapping video', () => {
    const r1 = tl.addClip(db, t.id, 'music', { start_ms: 0, duration_ms: 6000, asset_ref: '/m/a.mp3', volume: 0.5 });
    const r2 = tl.addClip(db, t.id, 'music', { start_ms: 3000, duration_ms: 6000, asset_ref: '/m/b.mp3' });
    assert.equal(track(r2.timeline, 'music').clips.length, 2);
    assert.ok(r1.clip_id);
    assert.throws(() => tl.addClip(db, t.id, 'video', { start_ms: 100, duration_ms: 500, asset_ref: '/v/x.mp4' }), { code: 'OVERLAP' });
  });

  it('moves a clip and rejects overlap and negative start', () => {
    const last = track(t, 'video').clips[2];
    assert.throws(() => tl.moveClip(db, t.id, last.id, { start_ms: 5000 }), { code: 'OVERLAP' });
    assert.throws(() => tl.moveClip(db, t.id, last.id, { start_ms: -1 }), /start_ms/);
    const moved = tl.moveClip(db, t.id, last.id, { start_ms: 9000 });
    assert.equal(track(moved, 'video').clips[2].start_ms, 9000);
    assert.equal(moved.duration_ms, 14000);
  });

  it('trims head and tail, keeping the source range in step', () => {
    const c = track(t, 'video').clips[0];
    const out = tl.trimClip(db, t.id, c.id, { start_ms: 500, duration_ms: 2000 });
    const nc = track(out, 'video').clips[0];
    assert.deepEqual([nc.start_ms, nc.duration_ms, nc.src_in_ms, nc.src_out_ms], [500, 2000, 500, 2500]);
    assert.throws(() => tl.trimClip(db, t.id, c.id, { duration_ms: 0 }), /duration_ms/);
    assert.throws(() => tl.trimClip(db, t.id, c.id, { duration_ms: 99999 }), { code: 'OVERLAP' });
  });

  it('splits a clip into two contiguous halves', () => {
    const c = track(t, 'video').clips[0];
    const r = tl.splitClip(db, t.id, c.id, { at_ms: 1500 });
    const v = track(r.timeline, 'video').clips;
    assert.equal(v.length, 4);
    assert.deepEqual([v[0].start_ms, v[0].duration_ms, v[0].src_in_ms, v[0].src_out_ms], [0, 1500, 0, 1500]);
    assert.deepEqual([v[1].start_ms, v[1].duration_ms, v[1].src_in_ms, v[1].src_out_ms], [1500, 2500, 1500, 4000]);
    assert.throws(() => tl.splitClip(db, t.id, c.id, { at_ms: 0 }), /strictly inside/);
    assert.throws(() => tl.splitClip(db, t.id, c.id, { at_ms: 1500 }), /strictly inside/);
  });

  it('deletes a clip and 404s on unknown clips', () => {
    const c = track(t, 'subtitle').clips[0];
    const out = tl.deleteClip(db, t.id, c.id);
    assert.equal(track(out, 'subtitle').clips.length, 1);
    assert.throws(() => tl.deleteClip(db, t.id, 'nope'), { code: 'NOT_FOUND' });
    assert.throws(() => tl.moveClip(db, 9999, c.id, { start_ms: 0 }), { code: 'NOT_FOUND' });
  });

  it('a failed op leaves stored state unchanged', () => {
    const before = JSON.stringify(tl.loadTimeline(db, t.id));
    const last = track(t, 'video').clips[2];
    assert.throws(() => tl.moveClip(db, t.id, last.id, { start_ms: 5000 }));
    assert.equal(JSON.stringify(tl.loadTimeline(db, t.id)), before);
  });
});

describe('validation and save/load', () => {
  let db;
  beforeEach(() => { db = openDb(); seedStoryboards(db); });

  it('round-trips through save and load', () => {
    const t = tl.assembleFromStoryboard(db, 1);
    track(t, 'subtitle').clips[0].style = { font_size: 42, color: '#fff' };
    track(t, 'video').clips[0].volume = 0.25;
    const saved = tl.saveTimeline(db, t);
    assert.equal(saved.version, t.version + 1);
    const loaded = tl.loadTimelineByEpisode(db, 1);
    assert.deepEqual(loaded.tracks, saved.tracks);
    assert.deepEqual(track(loaded, 'subtitle').clips[0].style, { font_size: 42, color: '#fff' });
    assert.equal(track(loaded, 'video').clips[0].volume, 0.25);
  });

  it('save is atomic: invalid timeline changes nothing', () => {
    const t = tl.assembleFromStoryboard(db, 1);
    const before = JSON.stringify(tl.loadTimeline(db, t.id));
    track(t, 'video').clips[1].start_ms = 0; // overlaps clip 0
    assert.throws(() => tl.saveTimeline(db, t), { code: 'OVERLAP' });
    assert.equal(JSON.stringify(tl.loadTimeline(db, t.id)), before);
  });

  it('rejects stale versions', () => {
    const t = tl.assembleFromStoryboard(db, 1);
    tl.saveTimeline(db, t);
    assert.throws(() => tl.saveTimeline(db, t), { code: 'CONFLICT' });
  });

  it('rejects bad clips', () => {
    const base = () => tl.createTimeline(db, 7);
    const bad = (kind, clip, re) => {
      const t = tl.loadTimelineByEpisode(db, 7) || base();
      const copy = JSON.parse(JSON.stringify(t));
      copy.tracks.find((x) => x.kind === kind).clips.push({ id: 'x', volume: 1, ...clip });
      assert.throws(() => tl.saveTimeline(db, copy), re);
    };
    bad('video', { start_ms: 0, duration_ms: 0 }, /duration_ms/);
    bad('video', { start_ms: -5, duration_ms: 10 }, /start_ms/);
    bad('video', { start_ms: 0, duration_ms: 1000, src_in_ms: 0, src_out_ms: 500 }, /source range length/);
    bad('video', { start_ms: 0, duration_ms: 1000, src_in_ms: 800, src_out_ms: 700 }, /src_out_ms/);
    bad('video', { start_ms: 0, duration_ms: 1000, src_in_ms: 0 }, /together/);
    bad('subtitle', { start_ms: 0, duration_ms: 1000, text: '  ' }, /text/);
    bad('narration', { start_ms: 0, duration_ms: 1000 }, /asset_ref/);
    bad('music', { start_ms: 0, duration_ms: 1000, asset_ref: 'm', volume: 9 }, /volume/);
  });

  it('rejects missing, duplicate or unknown tracks', () => {
    const t = tl.createTimeline(db, 8);
    assert.throws(() => tl.saveTimeline(db, { ...t, tracks: t.tracks.slice(1) }), /missing track/);
    assert.throws(() => tl.saveTimeline(db, { ...t, tracks: [...t.tracks, { kind: 'video', clips: [] }] }), /duplicate track/);
    assert.throws(() => tl.saveTimeline(db, { ...t, tracks: [...t.tracks, { kind: 'effects', clips: [] }] }), /unknown track kind/);
  });
});

describe('REST routes', () => {
  let db, server, base;
  const log = { error() {}, info() {}, warn() {} };

  async function call(method, url, body) {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  }

  beforeEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    db = openDb();
    seedStoryboards(db);
    const h = timelineRoutes(db, log);
    const r = express.Router();
    r.get('/timelines/episode/:episode_id', h.getByEpisode);
    r.post('/timelines/episode/:episode_id/assemble', h.assemble);
    r.put('/timelines/:id', h.save);
    r.post('/timelines/:id/clips', h.addClip);
    r.patch('/timelines/:id/clips/:clip_id', h.patchClip);
    const app = express();
    app.use(express.json());
    app.use('/api/v1', r);
    server = http.createServer(app);
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
  });

  it('wires up the routes in the main router', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'index.js'), 'utf8');
    for (const s of ["'/timelines/episode/:episode_id'", "'/timelines/episode/:episode_id/assemble'", "'/timelines/:id/clips/:clip_id'"]) {
      assert.ok(src.includes(s), s);
    }
  });

  it('GET 404, assemble 201, GET, duplicate assemble 409, save, patch ops', async () => {
    assert.equal((await call('GET', '/timelines/episode/1')).status, 404);
    const a = await call('POST', '/timelines/episode/1/assemble');
    assert.equal(a.status, 201);
    assert.equal((await call('POST', '/timelines/episode/1/assemble')).status, 409);
    assert.equal((await call('POST', '/timelines/episode/1/assemble', { replace: true })).status, 200);
    const g = await call('GET', '/timelines/episode/1');
    assert.equal(g.status, 200);
    const t = g.body.data;
    assert.equal(t.tracks.length, 4);

    const vid = track(t, 'video').clips;
    const sp = await call('PATCH', `/timelines/${t.id}/clips/${vid[0].id}`, { op: 'split', at_ms: 1000 });
    assert.equal(sp.status, 200);
    assert.equal(track(sp.body.data.timeline, 'video').clips.length, 4);
    const mv = await call('PATCH', `/timelines/${t.id}/clips/${vid[2].id}`, { op: 'move', start_ms: 0 });
    assert.equal(mv.status, 409);
    assert.equal(mv.body.error.code, 'OVERLAP');
    assert.equal((await call('PATCH', `/timelines/${t.id}/clips/${vid[2].id}`, { op: 'bogus' })).status, 400);
    assert.equal((await call('PATCH', `/timelines/${t.id}/clips/zzz`, { op: 'delete' })).status, 404);
    const add = await call('POST', `/timelines/${t.id}/clips`, { track: 'music', start_ms: 0, duration_ms: 2000, asset_ref: '/m.mp3' });
    assert.equal(add.status, 201);

    const cur = (await call('GET', '/timelines/episode/1')).body.data;
    const put = await call('PUT', `/timelines/${t.id}`, cur);
    assert.equal(put.status, 200);
    assert.equal(put.body.data.version, cur.version + 1);
    track(cur, 'video').clips[0].duration_ms = -1;
    assert.equal((await call('PUT', `/timelines/${t.id}`, { ...cur, version: undefined })).status, 400);
  });

  it('cleanup', async () => {
    await new Promise((r) => server.close(r));
    server = null;
  });
});
