'use strict';
/**
 * F01: voice every shot that has dialogue and derive its subtitle cues.
 * Cue times are relative to the shot start; the timeline (F02) adds the shot's offset.
 */
const { splitCues } = require('../subtitles');

const DEFAULT_VOICES = Object.freeze({ narrator: 'longxiaochun_v2' });

/**
 * @param {object} providers   facade from createProviders()
 * @param {object} req
 * @param {string} req.provider
 * @param {Array} req.shots                  storyboard shots (scriptgen schema)
 * @param {Record<string,string>} [req.voices]  speaker id ('narrator' | characterId) -> voice id
 * @param {string} [req.model]
 * @param {string} [req.aspectRatio]
 * @param {number} [req.concurrency=2]
 * @param {AbortSignal} [req.signal]
 * @returns {Promise<Array<{shotNo, speaker, voice, audio, format, durationMs, words, cues, overrunMs}>>}
 *   overrunMs > 0 means the line runs past the shot's durationSec.
 */
async function voiceShots(providers, req) {
  const voices = { ...DEFAULT_VOICES, ...(req.voices || {}) };
  const todo = req.shots.filter((s) => s.dialogue && s.dialogue.text);
  const results = new Array(todo.length);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const i = next++;
      const shot = todo[i];
      const speaker = shot.dialogue.speaker || 'narrator';
      const voice = voices[speaker] || voices.narrator;
      const r = await providers.tts.synthesize(req.provider, {
        model: req.model, text: shot.dialogue.text, voice, wordTimestamps: true, signal: req.signal,
      });
      const words = r.words || [];
      const durationMs = words.length ? words.at(-1).endMs : 0;
      results[i] = {
        shotNo: shot.no,
        speaker,
        voice,
        audio: r.audio,
        format: r.format,
        durationMs,
        words,
        cues: splitCues(words, { aspectRatio: req.aspectRatio }),
        overrunMs: Math.max(0, durationMs - shot.durationSec * 1000),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(req.concurrency || 2, todo.length) }, worker));
  return results;
}

module.exports = { voiceShots, DEFAULT_VOICES };
