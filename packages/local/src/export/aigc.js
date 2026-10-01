'use strict';
/**
 * G04: AI-generated-content (AIGC) marking for exported video.
 *
 * Explicit label : visible text "AI生成" burned in via the existing subtitle pipeline (an extra subtitle clip
 *                  is added to the timeline copy that is sent to render.start; the stored timeline is untouched).
 * Implicit label : an "AIGC" metadata entry written into the MP4 with a stream-copy ffmpeg pass (-metadata).
 *
 * This implements our reading of the 《人工智能生成合成内容标识办法》 and GB 45438-2025 requirements.
 * It is NOT a compliance statement: see docs/aigc-marking.md for what must be confirmed by legal counsel.
 */
const fs = require('fs');
const { execFile } = require('child_process');
const { getGlobalSetting, setGlobalSetting } = require('../services/settingsService');
const { defaultSubtitleFont } = require('../utils/platformFonts');

const SETTINGS_KEY = 'aigc.settings';
const WATERMARK_TEXT = 'AI生成';
const DEFAULT_PRODUCER = 'Talekiln';
/** Length of the larger "start of video" label; the persistent label follows for the rest of the video. */
const INTRO_MS = 3000;
/** Text heights as a fraction of the frame's shorter side. */
const INTRO_SIZE_RATIO = 0.055;
const PERSISTENT_SIZE_RATIO = 0.03;
/** AIGC.Label value for "confirmed AI-generated/synthesised content". Confirm against the current standard text. */
const LABEL_CONFIRMED = '1';

const DEFAULTS = { watermark: true, metadata: true, producer: DEFAULT_PRODUCER };

class AigcError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AigcError';
  }
}

function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const producer = typeof r.producer === 'string' && r.producer.trim() ? r.producer.trim().slice(0, 100) : DEFAULTS.producer;
  return {
    watermark: typeof r.watermark === 'boolean' ? r.watermark : DEFAULTS.watermark,
    metadata: typeof r.metadata === 'boolean' ? r.metadata : DEFAULTS.metadata,
    producer: producer.replace(/[\u0000-\u001f]/g, ''),
  };
}

function getSettings(db) {
  return normalizeSettings(getGlobalSetting(db, SETTINGS_KEY, null));
}

/** Patch semantics: only boolean toggles and a producer string are accepted; anything else throws. */
function setSettings(db, patch = {}) {
  const cur = getSettings(db);
  const next = { ...cur };
  for (const k of ['watermark', 'metadata']) {
    if (k in patch) {
      if (typeof patch[k] !== 'boolean') throw new AigcError(`${k} 必须是布尔值`);
      next[k] = patch[k];
    }
  }
  if ('producer' in patch) {
    if (typeof patch.producer !== 'string' || !patch.producer.trim()) throw new AigcError('producer 不能为空');
    next.producer = patch.producer.trim().slice(0, 100);
  }
  const norm = normalizeSettings(next);
  setGlobalSetting(db, SETTINGS_KEY, norm);
  return norm;
}

/**
 * Subtitle clips that carry the visible label: a larger one for the first INTRO_MS, then a smaller persistent one.
 * Font sizes are in output pixels (the renderer sets PlayResY to the output height).
 */
function watermarkClips(totalMs, width, height, newId) {
  if (!(totalMs > 0)) return [];
  const short = Math.min(width, height);
  const style = (ratio) => ({
    font: defaultSubtitleFont(), size: Math.max(12, Math.round(short * ratio)), bold: true,
    color: '#FFFFFF', outlineColor: '#000000', outline: 2, position: 'top', marginV: Math.round(short * 0.03),
  });
  const mk = (start, dur, ratio) => ({
    id: newId(), start_ms: start, duration_ms: dur, src_in_ms: null, src_out_ms: null,
    asset_ref: null, asset_kind: null, storyboard_id: null, volume: 1, text: WATERMARK_TEXT, style: style(ratio),
  });
  const intro = Math.min(INTRO_MS, totalMs);
  const out = [mk(0, intro, INTRO_SIZE_RATIO)];
  if (totalMs > intro) out.push(mk(intro, totalMs - intro, PERSISTENT_SIZE_RATIO));
  return out;
}

/** Metadata entries for -metadata: the AIGC JSON string (field names per GB 45438-2025 Annex, to be confirmed) and a readable comment. */
function buildMetadata({ producer, produceId }) {
  const aigc = JSON.stringify({
    Label: LABEL_CONFIRMED,
    ContentProducer: producer || DEFAULT_PRODUCER,
    ProduceID: produceId,
  });
  return { AIGC: aigc, comment: `${WATERMARK_TEXT}（人工智能生成合成内容）· ${producer || DEFAULT_PRODUCER}` };
}

/** ffmpeg arguments for a stream-copy remux that adds the metadata (no re-encode). */
function metadataArgs(input, output, entries) {
  const a = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', input, '-map', '0', '-c', 'copy'];
  for (const [k, v] of Object.entries(entries)) a.push('-metadata', `${k}=${v}`);
  a.push('-movflags', '+faststart+use_metadata_tags', '-f', 'mp4', output);
  return a;
}

/**
 * Rewrite `file` in place with the metadata. Writes to a temp file first, so a failure leaves the original intact.
 * `run(bin, args)` is injectable for tests.
 */
async function injectMetadata(ffmpegPath, file, entries, { run = defaultRun } = {}) {
  const tmp = `${file}.aigc.tmp`;
  try {
    await run(ffmpegPath, metadataArgs(file, tmp, entries));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
    throw new AigcError(`写入 AI 内容标识失败：${String(e.message || e).split('\n').slice(-2).join(' ').slice(0, 300)}`);
  }
}

function defaultRun(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

module.exports = {
  SETTINGS_KEY, WATERMARK_TEXT, INTRO_MS, DEFAULTS, AigcError,
  getSettings, setSettings, normalizeSettings, watermarkClips, buildMetadata, metadataArgs, injectMetadata,
};
