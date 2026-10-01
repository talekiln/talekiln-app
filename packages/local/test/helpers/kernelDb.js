'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../../src/db/migrate');
const samples = require('../../src/services/sampleProjectService');

const log = { info() {}, warn() {}, error() {}, errorw() {}, warnw() {} };

/** 迁移完整的临时库 + 种入内置示例项目（5 个镜头）。返回 { db, episodeId, dir }。 */
async function seededDb({ withTimeline = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-'));
  const db = new Database(path.join(dir, 't.db'));
  db.pragma('journal_mode = WAL');
  runMigrationsAndEnsure(db);
  const r = await samples.seedSample(db, log, path.join(dir, 'storage'));
  if (withTimeline) require('../../src/timeline/service').assembleFromStoryboard(db, r.episode_id);
  return { db, episodeId: r.episode_id, dir };
}

const sbRows = (db, ep) => db.prepare('SELECT * FROM storyboards WHERE episode_id = ? ORDER BY id').all(ep);

module.exports = { seededDb, sbRows, log };
