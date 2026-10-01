'use strict';
const crypto = require('crypto');

const TRACK_KINDS = ['video', 'subtitle', 'narration', 'music'];
const OVERLAP_ALLOWED = new Set(['music']);
const DEFAULT_SHOT_MS = 5000;

class TimelineError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'TimelineError';
    this.status = status;
    this.code = code;
  }
}

const newId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const isInt = (n) => Number.isInteger(n);

function emptyTracks() {
  return TRACK_KINDS.map((kind) => ({ id: newId(), kind, name: kind, volume: 1, muted: false, clips: [] }));
}

function normalizeClip(c) {
  let style = c.style;
  if (typeof style === 'string') {
    try { style = JSON.parse(style); } catch (_) { style = null; }
  }
  return {
    id: c.id || newId(),
    start_ms: c.start_ms,
    duration_ms: c.duration_ms,
    src_in_ms: c.src_in_ms ?? null,
    src_out_ms: c.src_out_ms ?? null,
    asset_ref: c.asset_ref ?? null,
    asset_kind: c.asset_kind ?? null,
    storyboard_id: c.storyboard_id ?? null,
    volume: c.volume ?? 1,
    text: c.text ?? null,
    style: style ?? null,
  };
}

function validateClip(kind, c, label) {
  const p = `${label}: `;
  if (!isInt(c.start_ms) || c.start_ms < 0) throw new TimelineError(p + 'start_ms must be an integer >= 0');
  if (!isInt(c.duration_ms) || c.duration_ms <= 0) throw new TimelineError(p + 'duration_ms must be an integer > 0');
  if (typeof c.volume !== 'number' || !(c.volume >= 0 && c.volume <= 4)) throw new TimelineError(p + 'volume must be between 0 and 4');
  const hasIn = c.src_in_ms != null;
  const hasOut = c.src_out_ms != null;
  if (hasIn !== hasOut) throw new TimelineError(p + 'src_in_ms and src_out_ms must be set together');
  if (hasIn) {
    if (kind === 'subtitle') throw new TimelineError(p + 'subtitle clips have no source range');
    if (!isInt(c.src_in_ms) || c.src_in_ms < 0) throw new TimelineError(p + 'src_in_ms must be an integer >= 0');
    if (!isInt(c.src_out_ms) || c.src_out_ms <= c.src_in_ms) throw new TimelineError(p + 'src_out_ms must be greater than src_in_ms');
    if (c.src_out_ms - c.src_in_ms !== c.duration_ms) {
      throw new TimelineError(p + 'source range length must equal duration_ms (speed 1x)');
    }
  }
  if (kind === 'subtitle') {
    if (typeof c.text !== 'string' || !c.text.trim()) throw new TimelineError(p + 'subtitle clips require non-empty text');
  } else if ((kind === 'narration' || kind === 'music') && !c.asset_ref) {
    throw new TimelineError(p + `${kind} clips require asset_ref`);
  }
}

/** Throws TimelineError when the timeline violates the model's invariants. */
function validateTimeline(tl) {
  if (!tl || !Array.isArray(tl.tracks)) throw new TimelineError('timeline.tracks must be an array');
  const seen = new Set();
  const ids = new Set();
  for (const t of tl.tracks) {
    if (!TRACK_KINDS.includes(t.kind)) throw new TimelineError(`unknown track kind: ${t.kind}`);
    if (seen.has(t.kind)) throw new TimelineError(`duplicate track kind: ${t.kind}`);
    seen.add(t.kind);
    if (!Array.isArray(t.clips)) throw new TimelineError(`track ${t.kind}: clips must be an array`);
    for (const c of t.clips) {
      if (ids.has(c.id)) throw new TimelineError(`duplicate clip id: ${c.id}`);
      ids.add(c.id);
      validateClip(t.kind, c, `${t.kind} clip ${c.id}`);
    }
    if (!OVERLAP_ALLOWED.has(t.kind)) {
      const sorted = [...t.clips].sort((a, b) => a.start_ms - b.start_ms);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        if (sorted[i].start_ms < prev.start_ms + prev.duration_ms) {
          throw new TimelineError(`overlap in ${t.kind} track between clips ${prev.id} and ${sorted[i].id}`, 409, 'OVERLAP');
        }
      }
    }
  }
  for (const k of TRACK_KINDS) if (!seen.has(k)) throw new TimelineError(`missing track: ${k}`);
}

function computeDuration(tl) {
  let end = 0;
  for (const t of tl.tracks) for (const c of t.clips) end = Math.max(end, c.start_ms + c.duration_ms);
  return end;
}

function normalizeTimeline(input) {
  const rank = (k) => (TRACK_KINDS.includes(k) ? TRACK_KINDS.indexOf(k) : TRACK_KINDS.length);
  const tracks = (input.tracks || [])
    .map((t) => ({
      id: t.id || newId(),
      kind: t.kind,
      name: t.name ?? t.kind,
      volume: t.volume ?? 1,
      muted: !!t.muted,
      clips: (t.clips || []).map(normalizeClip).sort((x, y) => x.start_ms - y.start_ms),
    }))
    .sort((x, y) => rank(x.kind) - rank(y.kind));
  return { ...input, tracks };
}

function getTimelineIdByEpisode(db, episodeId) {
  const row = db.prepare('SELECT id FROM timelines WHERE episode_id = ?').get(Number(episodeId));
  return row ? row.id : null;
}

function loadTimeline(db, timelineId) {
  const row = db.prepare('SELECT * FROM timelines WHERE id = ?').get(Number(timelineId));
  if (!row) return null;
  const tracks = db.prepare('SELECT * FROM timeline_tracks WHERE timeline_id = ? ORDER BY position').all(row.id);
  const clips = db.prepare('SELECT * FROM timeline_clips WHERE timeline_id = ? ORDER BY start_ms, position').all(row.id);
  return {
    id: row.id,
    episode_id: row.episode_id,
    version: row.version,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tracks: tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      volume: t.volume,
      muted: !!t.muted,
      clips: clips.filter((c) => c.track_id === t.id).map((c) => normalizeClip(c)),
    })),
  };
}

function loadTimelineByEpisode(db, episodeId) {
  const id = getTimelineIdByEpisode(db, episodeId);
  return id == null ? null : loadTimeline(db, id);
}

/**
 * Persist a timeline in one transaction (replace tracks/clips wholesale).
 * Creates the timelines row when none exists for the episode. If input.version is
 * given it must match the stored version. Returns the reloaded timeline.
 */
function saveTimeline(db, input) {
  if (!input || !isInt(Number(input.episode_id))) throw new TimelineError('episode_id is required');
  const tl = normalizeTimeline(input);
  validateTimeline(tl);
  const duration = computeDuration(tl);
  const ts = nowIso();
  const run = db.transaction(() => {
    let id = tl.id != null ? Number(tl.id) : getTimelineIdByEpisode(db, tl.episode_id);
    if (id != null) {
      const cur = db.prepare('SELECT * FROM timelines WHERE id = ?').get(id);
      if (!cur) throw new TimelineError('timeline not found', 404, 'NOT_FOUND');
      if (cur.episode_id !== Number(tl.episode_id)) throw new TimelineError('episode_id mismatch');
      if (input.version != null && input.version !== cur.version) {
        throw new TimelineError(`stale version (have ${cur.version}, got ${input.version})`, 409, 'CONFLICT');
      }
      db.prepare('UPDATE timelines SET version = version + 1, duration_ms = ?, updated_at = ? WHERE id = ?').run(duration, ts, id);
      db.prepare('DELETE FROM timeline_clips WHERE timeline_id = ?').run(id);
      db.prepare('DELETE FROM timeline_tracks WHERE timeline_id = ?').run(id);
    } else {
      id = Number(db.prepare('INSERT INTO timelines (episode_id, version, duration_ms, created_at, updated_at) VALUES (?, 1, ?, ?, ?)')
        .run(Number(tl.episode_id), duration, ts, ts).lastInsertRowid);
    }
    const insTrack = db.prepare('INSERT INTO timeline_tracks (id, timeline_id, kind, name, position, volume, muted) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insClip = db.prepare(`INSERT INTO timeline_clips
      (id, track_id, timeline_id, position, start_ms, duration_ms, src_in_ms, src_out_ms, asset_ref, asset_kind, storyboard_id, volume, text, style)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    tl.tracks.forEach((t, ti) => {
      insTrack.run(t.id, id, t.kind, t.name, ti, t.volume, t.muted ? 1 : 0);
      t.clips.forEach((c, ci) => insClip.run(c.id, t.id, id, ci, c.start_ms, c.duration_ms, c.src_in_ms, c.src_out_ms,
        c.asset_ref, c.asset_kind, c.storyboard_id, c.volume, c.text, c.style == null ? null : JSON.stringify(c.style)));
    });
    return id;
  });
  return loadTimeline(db, run());
}

function createTimeline(db, episodeId) {
  if (getTimelineIdByEpisode(db, episodeId) != null) throw new TimelineError('timeline already exists for episode', 409, 'CONFLICT');
  return saveTimeline(db, { episode_id: Number(episodeId), tracks: emptyTracks() });
}

// ---------- clip operations (each = load, mutate, validate, save in one transaction) ----------

function mutate(db, timelineId, fn) {
  return db.transaction(() => {
    const tl = loadTimeline(db, timelineId);
    if (!tl) throw new TimelineError('timeline not found', 404, 'NOT_FOUND');
    const extra = fn(tl);
    const saved = saveTimeline(db, { ...tl, version: undefined });
    return extra ? { timeline: saved, ...extra } : saved;
  })();
}

function findClip(tl, clipId) {
  for (const track of tl.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  throw new TimelineError(`clip not found: ${clipId}`, 404, 'NOT_FOUND');
}

function addClip(db, timelineId, kind, data) {
  return mutate(db, timelineId, (tl) => {
    const track = tl.tracks.find((t) => t.kind === kind);
    if (!track) throw new TimelineError(`unknown track kind: ${kind}`);
    const clip = normalizeClip({ ...data, id: undefined });
    if (kind !== 'subtitle' && clip.asset_ref && clip.src_in_ms == null && clip.src_out_ms == null && isInt(clip.duration_ms)) {
      clip.src_in_ms = 0;
      clip.src_out_ms = clip.duration_ms;
    }
    track.clips.push(clip);
    return { clip_id: clip.id };
  });
}

function moveClip(db, timelineId, clipId, { start_ms } = {}) {
  return mutate(db, timelineId, (tl) => {
    if (!isInt(start_ms)) throw new TimelineError('start_ms must be an integer');
    findClip(tl, clipId).clip.start_ms = start_ms;
  });
}

/** Trim to a new window; the source range follows (head trim shifts src_in). Either field may be omitted. */
function trimClip(db, timelineId, clipId, { start_ms, duration_ms } = {}) {
  return mutate(db, timelineId, (tl) => {
    const { clip } = findClip(tl, clipId);
    const newStart = start_ms ?? clip.start_ms;
    const newDur = duration_ms ?? clip.duration_ms;
    if (!isInt(newStart) || !isInt(newDur)) throw new TimelineError('start_ms and duration_ms must be integers');
    if (newDur <= 0) throw new TimelineError('duration_ms must be > 0');
    if (clip.src_in_ms != null) {
      const srcIn = clip.src_in_ms + (newStart - clip.start_ms);
      if (srcIn < 0) throw new TimelineError('trim moves the source in-point before 0');
      clip.src_in_ms = srcIn;
      clip.src_out_ms = srcIn + newDur;
    }
    clip.start_ms = newStart;
    clip.duration_ms = newDur;
  });
}

function splitClip(db, timelineId, clipId, { at_ms } = {}) {
  return mutate(db, timelineId, (tl) => {
    const { track, clip } = findClip(tl, clipId);
    if (!isInt(at_ms) || at_ms <= clip.start_ms || at_ms >= clip.start_ms + clip.duration_ms) {
      throw new TimelineError('at_ms must fall strictly inside the clip');
    }
    const firstDur = at_ms - clip.start_ms;
    const second = { ...clip, id: newId(), start_ms: at_ms, duration_ms: clip.duration_ms - firstDur };
    if (clip.src_in_ms != null) {
      second.src_in_ms = clip.src_in_ms + firstDur;
      second.src_out_ms = clip.src_out_ms;
      clip.src_out_ms = clip.src_in_ms + firstDur;
    }
    clip.duration_ms = firstDur;
    track.clips.push(second);
    return { clip_ids: [clip.id, second.id] };
  });
}

function deleteClip(db, timelineId, clipId) {
  return mutate(db, timelineId, (tl) => {
    const { track } = findClip(tl, clipId);
    track.clips = track.clips.filter((c) => c.id !== clipId);
  });
}

// ---------- storyboard assembly ----------

/**
 * Build (or rebuild with opts.replace) an initial timeline from storyboard rows:
 * one video clip per shot in order, a subtitle clip per non-empty dialogue,
 * and a narration-track clip per shot that has voiceover audio
 * (narration audio preferred, else dialogue audio).
 */
function assembleFromStoryboard(db, episodeId, opts = {}) {
  const rows = db.prepare(
    'SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id'
  ).all(Number(episodeId));
  if (!rows.length) throw new TimelineError('episode has no storyboards', 400, 'NO_STORYBOARDS');
  const existing = getTimelineIdByEpisode(db, episodeId);
  if (existing != null && !opts.replace) throw new TimelineError('timeline already exists for episode', 409, 'CONFLICT');

  const tracks = emptyTracks();
  const by = Object.fromEntries(tracks.map((t) => [t.kind, t]));
  let cursor = 0;
  for (const sb of rows) {
    const dur = sb.duration > 0 ? Math.round(sb.duration * 1000) : DEFAULT_SHOT_MS;
    const start = cursor;
    const asset = sb.video_url || sb.local_path || sb.image_url || null;
    by.video.clips.push({
      id: newId(), start_ms: start, duration_ms: dur,
      src_in_ms: asset ? 0 : null, src_out_ms: asset ? dur : null,
      asset_ref: asset, asset_kind: sb.video_url ? 'video' : asset ? 'image' : null,
      storyboard_id: sb.id, volume: 1, text: null, style: null,
    });
    const dialogue = typeof sb.dialogue === 'string' ? sb.dialogue.trim() : '';
    if (dialogue) {
      by.subtitle.clips.push({
        id: newId(), start_ms: start, duration_ms: dur, src_in_ms: null, src_out_ms: null,
        asset_ref: null, asset_kind: null, storyboard_id: sb.id, volume: 1, text: dialogue, style: null,
      });
    }
    const voice = sb.narration_audio_local_path || sb.audio_local_path || null;
    if (voice) {
      by.narration.clips.push({
        id: newId(), start_ms: start, duration_ms: dur, src_in_ms: 0, src_out_ms: dur,
        asset_ref: voice, asset_kind: 'audio', storyboard_id: sb.id, volume: 1, text: null, style: null,
      });
    }
    cursor += dur;
  }
  return saveTimeline(db, { id: existing, episode_id: Number(episodeId), tracks });
}

module.exports = {
  TRACK_KINDS, TimelineError, validateTimeline, createTimeline, loadTimeline, loadTimelineByEpisode,
  saveTimeline, addClip, moveClip, trimClip, splitClip, deleteClip, assembleFromStoryboard,
};
