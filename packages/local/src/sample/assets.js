'use strict';
/**
 * Placeholder media for the bundled sample project. Everything is generated from math at
 * seed time (gradients + a sine tone), so there is no third-party media and no network or API use.
 */
const sharp = require('sharp');

function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Small PNG: vertical two-tone gradient plus a soft moon/sun disc and a ground band. Deterministic per hue. */
async function makeImagePng({ hue, width = 270, height = 480, discY = 0.3 } = {}) {
  const top = hsl(hue, 0.55, 0.22);
  const bottom = hsl((hue + 40) % 360, 0.5, 0.42);
  const disc = hsl((hue + 180) % 360, 0.4, 0.85);
  const ground = hsl(hue, 0.3, 0.1);
  const buf = Buffer.alloc(width * height * 3);
  const cx = width * 0.65;
  const cy = height * discY;
  const r = width * 0.14;
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    for (let x = 0; x < width; x++) {
      let c = [0, 1, 2].map((i) => Math.round(top[i] + (bottom[i] - top[i]) * t));
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) c = disc;
      else if (d < r * 1.6) c = c.map((v, i) => Math.round(v + (disc[i] - v) * (1 - (d - r) / (r * 0.6)) * 0.35));
      if (y > height * 0.82) c = ground;
      const o = (y * width + x) * 3;
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
}

/** Mono 16-bit PCM WAV: a soft two-partial tone with fade in/out. */
function makeWav({ freq = 440, seconds = 1.5, sampleRate = 16000, volume = 0.25 } = {}) {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const data = Buffer.alloc(n * 2);
  const fade = Math.max(1, Math.min(n / 4, sampleRate * 0.15));
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    const v = (Math.sin((2 * Math.PI * freq * i) / sampleRate) + 0.4 * Math.sin((2 * Math.PI * freq * 1.5 * i) / sampleRate)) / 1.4;
    data.writeInt16LE(Math.round(v * env * volume * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

module.exports = { makeImagePng, makeWav };
