'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { STYLES, generatePlaceholder, wavDurationMs } = require('./synth');

const MAX_BYTES = 50 * 1024 * 1024;
const REL_DIR = 'library/music';
const EXT_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac' };

class MusicError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'MusicError';
    this.status = status;
    this.code = code;
  }
}

/** True when the leading bytes plausibly match the extension (guards against renamed non-audio files). */
function sniffMatches(ext, b) {
  if (b.length < 12) return false;
  const s4 = b.toString('latin1', 0, 4);
  switch (ext) {
    case 'wav': return s4 === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE';
    case 'ogg': return s4 === 'OggS';
    case 'flac': return s4 === 'fLaC';
    case 'mp3': return s4.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    case 'm4a': return b.toString('latin1', 4, 8) === 'ftyp';
    case 'aac': return (b[0] === 0xff && (b[1] & 0xf0) === 0xf0) || s4.startsWith('ID3');
    default: return false;
  }
}

/** Probe duration with ffprobe; resolves null when ffprobe is missing or the file is unreadable. */
function ffprobeDuration(file, ffprobePath) {
  return new Promise((resolve) => {
    const bin = ffprobePath || require('../utils/ffmpegPath').getFfprobePath();
    execFile(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 15000 }, (err, out) => {
      if (err) return resolve(null);
      const sec = parseFloat(String(out).trim());
      resolve(Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null);
    });
  });
}

function cleanName(raw, fallback) {
  const base = path.basename(String(raw || ''), path.extname(String(raw || '')));
  const s = base.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
  return s || fallback;
}

function createMusicLibrary(db, { storageRoot, probe = ffprobeDuration, now = () => new Date().toISOString(), newId = () => crypto.randomUUID() } = {}) {
  if (!storageRoot) throw new Error('storageRoot is required');
  const absDir = () => path.join(storageRoot, ...REL_DIR.split('/'));
  const view = (r) => ({ id: r.id, name: r.name, file_path: r.file_path, duration_ms: r.duration_ms, source: r.source, size_bytes: r.size_bytes, created_at: r.created_at });

  /** Write the self-generated placeholders once (idempotent). */
  function ensureBuiltins() {
    for (const style of Object.keys(STYLES)) {
      const id = `builtin-${style}`;
      const rel = `${REL_DIR}/${id}.wav`;
      const abs = path.join(storageRoot, ...rel.split('/'));
      const row = db.prepare('SELECT id FROM music_library WHERE id = ?').get(id);
      if (row && fs.existsSync(abs)) continue;
      fs.mkdirSync(absDir(), { recursive: true });
      const wav = generatePlaceholder(style);
      fs.writeFileSync(abs, wav);
      db.prepare(
        `INSERT INTO music_library (id, name, file_path, duration_ms, source, size_bytes, created_at)
         VALUES (?, ?, ?, ?, 'builtin', ?, ?)
         ON CONFLICT(id) DO UPDATE SET file_path = excluded.file_path, duration_ms = excluded.duration_ms, size_bytes = excluded.size_bytes`
      ).run(id, STYLES[style].name, rel, wavDurationMs(wav), wav.length, now());
    }
  }

  function list() {
    ensureBuiltins();
    return db.prepare(`SELECT * FROM music_library ORDER BY (source = 'builtin'), created_at DESC, name`).all().map(view);
  }

  function get(id) {
    const r = db.prepare('SELECT * FROM music_library WHERE id = ?').get(String(id));
    return r ? view(r) : null;
  }

  function absPathOf(entry) {
    return path.join(storageRoot, ...entry.file_path.split('/'));
  }

  /** Import a user file from memory. durationHintMs is only used when neither ffprobe nor the WAV header gives a length. */
  async function importFile({ buffer, originalName, name, durationHintMs }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new MusicError('文件为空');
    if (buffer.length > MAX_BYTES) throw new MusicError('音乐文件不能超过 50MB', 413, 'FILE_TOO_LARGE');
    const ext = path.extname(String(originalName || '')).slice(1).toLowerCase();
    if (!EXT_MIME[ext]) throw new MusicError('只支持 mp3、wav、m4a、aac、ogg、flac 格式');
    if (!sniffMatches(ext, buffer)) throw new MusicError('文件内容与扩展名不符，可能不是有效的音频文件');
    const id = newId();
    const rel = `${REL_DIR}/${id}.${ext}`;
    const abs = path.join(storageRoot, ...rel.split('/'));
    fs.mkdirSync(absDir(), { recursive: true });
    fs.writeFileSync(abs, buffer);
    let duration = null;
    try {
      duration = (ext === 'wav' ? wavDurationMs(buffer) : null) || (await probe(abs));
      if (!duration && Number.isInteger(durationHintMs) && durationHintMs > 0) duration = durationHintMs;
      if (!duration) throw new MusicError('无法读取音频时长，文件可能已损坏，或本机缺少 ffprobe');
      db.prepare(
        `INSERT INTO music_library (id, name, file_path, duration_ms, source, size_bytes, created_at) VALUES (?, ?, ?, ?, 'user', ?, ?)`
      ).run(id, cleanName(name || originalName, '未命名音乐'), rel, duration, buffer.length, now());
    } catch (e) {
      try { fs.unlinkSync(abs); } catch (_) { /* best effort */ }
      throw e;
    }
    return get(id);
  }

  /** Delete a user-imported track. Refused for placeholders and for tracks a timeline still uses. */
  function remove(id) {
    const entry = get(id);
    if (!entry) throw new MusicError('音乐不存在', 404, 'NOT_FOUND');
    if (entry.source === 'builtin') throw new MusicError('示例配乐不能删除', 403, 'FORBIDDEN');
    const used = db.prepare('SELECT COUNT(*) AS n FROM timeline_clips WHERE asset_ref = ?').get(entry.file_path).n;
    if (used > 0) throw new MusicError(`该音乐正被 ${used} 个时间线片段使用，请先从时间线移除`, 409, 'IN_USE');
    db.prepare('DELETE FROM music_library WHERE id = ?').run(entry.id);
    try { fs.unlinkSync(absPathOf(entry)); } catch (_) { /* already gone */ }
    return entry;
  }

  return { list, get, importFile, remove, ensureBuiltins, absPathOf };
}

module.exports = { createMusicLibrary, MusicError, MAX_BYTES, EXT_MIME, sniffMatches, ffprobeDuration };
