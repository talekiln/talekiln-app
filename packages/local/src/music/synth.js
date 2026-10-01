'use strict';
/**
 * Self-generated placeholder music. Everything here is synthesised from sine waves at runtime
 * (no sampled audio, no third-party media), so the placeholders carry no external copyright.
 * Output: 16-bit mono PCM WAV, deterministic for a given style.
 */

const SAMPLE_RATE = 22050;
const DURATION_S = 30;

const TAU = Math.PI * 2;
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Linear fade in/out so every placeholder starts and ends silent. */
function applyFades(buf, fadeS) {
  const n = Math.floor(fadeS * SAMPLE_RATE);
  for (let i = 0; i < n && i < buf.length; i++) {
    const g = i / n;
    buf[i] *= g;
    buf[buf.length - 1 - i] *= g;
  }
}

function normalizePeak(buf, peak = 0.6) {
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  if (max === 0) return;
  const k = peak / max;
  for (let i = 0; i < buf.length; i++) buf[i] *= k;
}

function render(fn) {
  const n = SAMPLE_RATE * DURATION_S;
  const buf = new Float32Array(n);
  fn(buf);
  applyFades(buf, 1);
  normalizePeak(buf);
  return buf;
}

// Slow pad over Am - F - C - G, a few seconds per chord.
function calm(buf) {
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
  const chordLen = 7.5;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const ci = Math.floor(t / chordLen) % chords.length;
    const local = t - Math.floor(t / chordLen) * chordLen;
    const env = Math.min(1, local / 1.5) * Math.min(1, (chordLen - local) / 1.5 + 0.2);
    let v = 0;
    for (const note of chords[ci]) {
      const f = midiHz(note);
      v += Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * f * 2 * t) + 0.1 * Math.sin(TAU * f * 3 * t);
    }
    buf[i] = v * env * (0.85 + 0.15 * Math.sin(TAU * 0.25 * t));
  }
}

// 120 bpm eighth-note arpeggio with plucked decay and a soft kick on every beat.
function upbeat(buf) {
  const beat = 0.5;
  const step = beat / 2;
  const scale = [60, 64, 67, 72, 67, 64, 62, 65, 69, 74, 69, 65];
  for (let i = 0; i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const idx = Math.floor(t / step);
    const local = t - idx * step;
    const f = midiHz(scale[idx % scale.length]);
    const pluck = Math.exp(-local * 9);
    let v = pluck * (Math.sin(TAU * f * t) + 0.4 * Math.sin(TAU * f * 2 * t));
    const kb = t % beat;
    v += 1.2 * Math.exp(-kb * 22) * Math.sin(TAU * (50 + 90 * Math.exp(-kb * 30)) * kb);
    buf[i] = v;
  }
}

// Low drone with slow throb and a rising thin tone.
function tense(buf) {
  for (let i = 0; i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const throb = 0.6 + 0.4 * Math.sin(TAU * 1.5 * t);
    const drone = Math.sin(TAU * 55 * t) + Math.sin(TAU * 55.7 * t) + 0.3 * Math.sin(TAU * 110 * t);
    const rise = 0.25 * (t / DURATION_S) * Math.sin(TAU * (400 + 200 * (t / DURATION_S)) * t);
    buf[i] = drone * throb + rise;
  }
}

const STYLES = {
  calm: { name: '示例配乐 · 舒缓（自动生成）', fn: calm },
  upbeat: { name: '示例配乐 · 轻快（自动生成）', fn: upbeat },
  tense: { name: '示例配乐 · 紧张（自动生成）', fn: tense },
};

function encodeWav(samples) {
  const dataLen = samples.length * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(SAMPLE_RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return b;
}

function generatePlaceholder(style) {
  const s = STYLES[style];
  if (!s) throw new RangeError(`unknown placeholder style: ${style}`);
  return encodeWav(render(s.fn));
}

/** Duration in ms from a PCM WAV header, or null when the buffer is not a simple WAV. */
function wavDurationMs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let byteRate = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 8 + 16 <= buf.length) byteRate = buf.readUInt32LE(pos + 8 + 8);
    if (id === 'data') {
      if (!byteRate) return null;
      const len = Math.min(size, buf.length - pos - 8);
      return Math.round((len / byteRate) * 1000);
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

module.exports = { STYLES, SAMPLE_RATE, DURATION_S, generatePlaceholder, wavDurationMs, encodeWav };
