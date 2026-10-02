const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const locks = require('../src/services/referenceLockService');
const videoService = require('../src/services/videoService');

function makeDb() {
  const db = new Database(':memory:');
  locks.ensureSchema(db);
  db.exec(`
    CREATE TABLE storyboards (id INTEGER PRIMARY KEY, scene_id INTEGER, characters TEXT, video_url TEXT, local_path TEXT, adopted_video_id INTEGER, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE video_generations (id INTEGER PRIMARY KEY AUTOINCREMENT, storyboard_id INTEGER, status TEXT, video_url TEXT, local_path TEXT, prompt TEXT, model TEXT, deleted_at TEXT);
  `);
  return db;
}

describe('locked reference images in video requests', () => {
  it('collects scene then character locks for a shot, deduped', () => {
    const db = makeDb();
    db.prepare('INSERT INTO storyboards (id, scene_id, characters) VALUES (1, 7, ?)').run(JSON.stringify([{ id: 3 }, 4, 3]));
    locks.setLock(db, 'scene', 7, { local_path: 'img/scene7.png' });
    locks.setLock(db, 'character', 3, { image_url: 'https://cdn/x/c3.png' });
    locks.setLock(db, 'character', 99, { image_url: 'https://cdn/unused.png' });
    assert.deepEqual(locks.collectLockedRefsForStoryboard(db, 1), ['/static/img/scene7.png', 'https://cdn/x/c3.png']);
    assert.deepEqual(locks.collectLockedRefsForStoryboard(db, 404), []);
  });

  it('re-locking replaces and clearing removes', () => {
    const db = makeDb();
    locks.setLock(db, 'character', 1, { image_url: 'a' });
    locks.setLock(db, 'character', 1, { image_url: 'b' });
    assert.equal(locks.getLock(db, 'character', 1).image_url, 'b');
    assert.equal(locks.clearLock(db, 'character', 1), true);
    assert.equal(locks.getLock(db, 'character', 1), null);
    assert.throws(() => locks.setLock(db, 'prop', 1, { image_url: 'a' }), /entity_type/);
    assert.throws(() => locks.setLock(db, 'scene', 1, {}), /required/);
  });

  it('keeps first frame when refs come only from locks', () => {
    const row = { prompt: 'p', model: 'm', image_url: 'first.png', first_frame_url: 'first.png', last_frame_url: null, storyboard_id: 1, drama_id: 2 };
    const merge = locks.mergeLockedReferences(row, ['/static/a.png', '/static/b.png']);
    assert.equal(merge.explicitOmni, false);
    const opts = videoService.buildVideoRequestOpts(row, { reference_urls: merge.reference_urls, explicitOmni: merge.explicitOmni, effectiveDuration: 5 });
    assert.deepEqual(opts.reference_urls, ['/static/a.png', '/static/b.png']);
    assert.equal(opts.first_frame_url, 'first.png');
    assert.equal(opts.image_url, 'first.png');
    assert.equal(opts.storyboard_id, 1);
  });

  it('explicit omni refs come first, locks appended, frames dropped, cap 9', () => {
    const explicit = Array.from({ length: 8 }, (_, i) => `e${i}.png`);
    const row = { reference_image_urls: JSON.stringify(explicit), first_frame_url: 'f.png', image_url: 'f.png' };
    const merge = locks.mergeLockedReferences(row, ['e0.png', 'L1.png', 'L2.png']);
    assert.equal(merge.explicitOmni, true);
    assert.equal(merge.reference_urls.length, 9);
    assert.equal(merge.reference_urls[8], 'L1.png');
    assert.equal(merge.reference_urls.filter((u) => u === 'e0.png').length, 1);
    const opts = videoService.buildVideoRequestOpts(row, { reference_urls: merge.reference_urls, explicitOmni: true });
    assert.equal(opts.first_frame_url, undefined);
    assert.equal(opts.image_url, undefined);
  });

  it('no refs at all yields null reference_urls', () => {
    assert.equal(locks.mergeLockedReferences({}, []).reference_urls, null);
  });
});

describe('shot video candidates and adoption', () => {
  it('lists the latest 4 as V1..V4 and adopts a completed one', () => {
    const db = makeDb();
    db.prepare('INSERT INTO storyboards (id) VALUES (1)').run();
    const ins = db.prepare('INSERT INTO video_generations (storyboard_id, status, video_url, local_path) VALUES (1, ?, ?, ?)');
    for (let i = 0; i < 5; i++) ins.run(i === 4 ? 'processing' : 'completed', i === 4 ? null : `http://v/${i}.mp4`, `videos/${i}.mp4`);
    const out = videoService.listCandidates(db, 1);
    assert.equal(out.items.length, 4);
    assert.deepEqual(out.items.map((c) => c.label), ['V1', 'V2', 'V3', 'V4']);
    assert.equal(out.items[0].id, 2);
    assert.equal(out.adopted_video_id, null);

    assert.equal(videoService.adoptCandidate(db, 1, 5).status, 400); // still processing
    assert.equal(videoService.adoptCandidate(db, 2, 3).status, 404); // wrong shot
    const ok = videoService.adoptCandidate(db, 1, 3);
    assert.equal(ok.ok, true);
    assert.equal(ok.adopted_video_id, 3);
    assert.equal(ok.items.find((c) => c.adopted).id, 3);
    const sb = db.prepare('SELECT * FROM storyboards WHERE id = 1').get();
    assert.equal(sb.video_url, 'http://v/2.mp4');
    assert.equal(videoService.listCandidates(db, 99), null);
  });
});
