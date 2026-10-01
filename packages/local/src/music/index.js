'use strict';
const lib = require('./library');
const synth = require('./synth');
const timeline = require('../timeline');

/**
 * Attach a library track to the timeline's music track.
 * opts: { start_ms = 0, loop = false, volume = 1 }. With loop, the track is repeated back to back until the
 * video track ends (the last repeat is trimmed); without it the clip is min(track length, video length - start).
 */
function attachMusic(db, library, timelineId, musicId, opts = {}) {
  const entry = library.get(musicId);
  if (!entry) throw new lib.MusicError('音乐不存在', 404, 'NOT_FOUND');
  const start = opts.start_ms ?? 0;
  if (!Number.isInteger(start) || start < 0) throw new lib.MusicError('start_ms 必须是大于等于 0 的整数');
  const volume = opts.volume ?? 1;
  const tl = timeline.loadTimeline(db, timelineId);
  if (!tl) throw new timeline.TimelineError('timeline not found', 404, 'NOT_FOUND');
  const video = tl.tracks.find((t) => t.kind === 'video');
  const videoEnd = video ? video.clips.reduce((m, c) => Math.max(m, c.start_ms + c.duration_ms), 0) : 0;
  const room = videoEnd > start ? videoEnd - start : entry.duration_ms;
  const clips = [];
  let at = start;
  let left = opts.loop ? room : Math.min(entry.duration_ms, room);
  while (left > 0 && clips.length < 500) {
    const dur = Math.min(entry.duration_ms, left);
    clips.push({ start_ms: at, duration_ms: dur, asset_ref: entry.file_path, asset_kind: 'audio', volume, text: entry.name });
    at += dur;
    left -= dur;
  }
  return timeline.addClips(db, timelineId, 'music', clips);
}

module.exports = { ...lib, ...synth, attachMusic };
