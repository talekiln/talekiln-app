const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const svc = require('../src/services/scriptgenService');

const sb = {
  characters: [{ id: 'c1', name: '阿宁', appearance: '' }],
  scenes: [{ id: 's1', name: '古镇', description: '' }],
};

describe('scriptgenService.shotToRow', () => {
  it('maps shot fields to storyboard columns', () => {
    const row = svc.shotToRow({ no: 2, sceneId: 's1', characterIds: ['c1'], visual: '雨中', camera: '近景', dialogue: { speaker: 'c1', text: '走吧' }, durationSec: 4, imagePrompt: 'ip', videoPrompt: 'vp' }, sb);
    assert.equal(row.storyboard_number, 2);
    assert.equal(row.description, '雨中');
    assert.equal(row.dialogue, '阿宁：走吧');
    assert.equal(row.location, '古镇');
    assert.equal(row.characters, '["阿宁"]');
  });
  it('narrator dialogue has no speaker prefix; null dialogue stays null', () => {
    const base = { no: 1, sceneId: 's1', characterIds: [], visual: 'v', durationSec: 3, imagePrompt: 'a', videoPrompt: 'b' };
    assert.equal(svc.shotToRow({ ...base, dialogue: { speaker: 'narrator', text: '旁白' } }, sb).dialogue, '旁白');
    assert.equal(svc.shotToRow({ ...base, dialogue: null }, sb).dialogue, null);
  });
});

describe('scriptgenService.validateRequest', () => {
  it('accepts a valid request with defaults', () => {
    const r = svc.validateRequest({ story: '一个故事', templateId: 'guofeng-drama' });
    assert.equal(r.ok, true);
    assert.equal(r.value.aspectRatio, '9:16');
    assert.equal(r.value.durationSec, 45);
  });
  it('rejects empty story, bad template, ratio and duration', () => {
    const r = svc.validateRequest({ story: ' ', templateId: 'nope', aspectRatio: '4:3', durationSec: 120 });
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 4);
  });
});

describe('scriptgenService.reorderStoryboards', () => {
  function openDb() {
    const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sgen-')), 't.db'));
    // 顺序现在属于项目图：重排经内核提交并物化，所以需要时间线与项目图表和一个剧集
    for (const f of ['01_init.sql', '24_timelines.sql', '26_music_library_and_mix.sql', '27_project_graphs.sql']) {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8'));
    }
    db.prepare("INSERT INTO episodes (id, drama_id, script_content) VALUES (1, 1, '')").run();
    const ins = db.prepare('INSERT INTO storyboards (episode_id, storyboard_number) VALUES (1, ?)');
    [1, 2, 3].forEach((n) => ins.run(n));
    return db;
  }
  it('renumbers by the given order', () => {
    const db = openDb();
    svc.reorderStoryboards(db, 1, [3, 1, 2]);
    const rows = db.prepare('SELECT id, storyboard_number n FROM storyboards ORDER BY id').all();
    assert.deepEqual(rows.map((r) => r.n), [2, 3, 1]);
  });
  it('rejects partial or foreign id lists', () => {
    const db = openDb();
    assert.throws(() => svc.reorderStoryboards(db, 1, [1, 2]), /全部分镜/);
    assert.throws(() => svc.reorderStoryboards(db, 1, [1, 2, 99]), /全部分镜/);
  });
});
