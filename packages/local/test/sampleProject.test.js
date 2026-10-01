const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const samples = require('../src/services/sampleProjectService');
const { makeImagePng, makeWav } = require('../src/sample/assets');

const log = { info() {}, warn() {}, error() {}, errorw() {}, warnw() {} };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smp-'));
  const db = new Database(path.join(dir, 't.db'));
  runMigrationsAndEnsure(db);
  return { db, storage: path.join(dir, 'storage') };
}

describe('sample media generators', () => {
  it('makes a small valid PNG, deterministically', async () => {
    const a = await makeImagePng({ hue: 100 });
    const b = await makeImagePng({ hue: 100 });
    assert.deepEqual(a.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    assert.ok(a.equals(b));
    assert.ok(a.length < 60 * 1024);
  });
  it('makes a WAV with a correct header and length', () => {
    const w = makeWav({ seconds: 1, sampleRate: 8000 });
    assert.equal(w.toString('ascii', 0, 4), 'RIFF');
    assert.equal(w.toString('ascii', 8, 12), 'WAVE');
    assert.equal(w.readUInt32LE(40), 8000 * 2);
    assert.equal(w.length, 44 + 8000 * 2);
  });
});

describe('sample project seeding', () => {
  it('creates drama, episode, five shots and media files without any network', async () => {
    const { db, storage } = setup();
    assert.equal(samples.listSamples(db)[0].seeded, false);
    const r = await samples.seedSample(db, log, storage);
    assert.equal(r.created, true);
    const shots = db.prepare('SELECT * FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number').all(r.episode_id);
    assert.equal(shots.length, 5);
    for (const s of shots) {
      assert.ok(fs.existsSync(path.join(storage, ...s.local_path.split('/'))), s.local_path);
      assert.equal(s.status, 'completed');
    }
    const withAudio = shots.filter((s) => s.narration_audio_local_path);
    assert.ok(withAudio.length >= 3);
    for (const s of withAudio) assert.ok(fs.existsSync(path.join(storage, ...s.narration_audio_local_path.split('/'))));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM characters WHERE drama_id = ?').get(r.drama_id).n, 2);
    assert.equal(samples.listSamples(db)[0].seeded, true);
  });

  it('exposes media paths through the episode storyboard list the page uses', async () => {
    const { db, storage } = setup();
    const r = await samples.seedSample(db, log, storage);
    const list = require('../src/services/episodeStoryboardService').getStoryboardsForEpisode(db, r.episode_id);
    assert.equal(list.length, 5);
    assert.ok(list.every((s) => /\.png$/.test(s.local_path)));
  });

  it('is idempotent and can be re-seeded after deletion', async () => {
    const { db, storage } = setup();
    const a = await samples.seedSample(db, log, storage);
    const b = await samples.seedSample(db, log, storage);
    assert.equal(b.created, false);
    assert.equal(b.drama_id, a.drama_id);
    assert.equal(b.episode_id, a.episode_id);
    db.prepare('UPDATE dramas SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), a.drama_id);
    const c = await samples.seedSample(db, log, storage);
    assert.equal(c.created, true);
    assert.notEqual(c.drama_id, a.drama_id);
  });

  it('rejects unknown sample ids', async () => {
    const { db, storage } = setup();
    await assert.rejects(samples.seedSample(db, log, storage, 'nope'), (e) => e.status === 404);
  });
});
