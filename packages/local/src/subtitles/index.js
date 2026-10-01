'use strict';
/**
 * F01: turn TTS word timings into subtitle cues, and write them as SRT or ASS (for libass in lycore).
 *
 * Cues start and end exactly on word boundaries, snapped outward to whole frames, so each cue
 * is within one frame of the speech it shows.
 */

const { defaultSubtitleFont } = require('../utils/platformFonts');

const PUNCT = /^[\s，。！？、；：,.!?;:…—“”"'‘’（）()《》【】「」]+$/u;
const PAUSE = /[，。！？、；：,.!?;:…—]/u;      // a spoken pause: phrase boundary
const BREAK_STRONG = /[。！？!?…；;]/u;           // sentence end: always ends the cue

/** Default line width by aspect ratio: narrow 9:16 frames hold fewer characters. */
const MAX_CHARS = { '9:16': 12, '1:1': 14, '16:9': 18 };

/** Group per-character timings into phrases at pause punctuation; quotes and brackets are dropped. */
function toPhrases(words) {
  const phrases = [];
  let cur = { words: [], strong: false };
  for (const w of words) {
    if (PUNCT.test(w.text)) {
      if (PAUSE.test(w.text) && cur.words.length) {
        cur.strong = BREAK_STRONG.test(w.text);
        phrases.push(cur);
        cur = { words: [], strong: false };
      }
      continue;
    }
    cur.words.push(w);
  }
  if (cur.words.length) phrases.push(cur);
  return phrases;
}

/** Split a phrase that is too wide or too long into near-equal parts rather than a full line plus a stub. */
function splitLong(phrase, maxChars, maxDur) {
  const n = phrase.words.length;
  const dur = phrase.words[n - 1].endMs - phrase.words[0].startMs;
  const parts = Math.max(Math.ceil(n / maxChars), Math.ceil(dur / maxDur));
  if (parts <= 1) return [phrase];
  const size = Math.ceil(n / parts);
  const out = [];
  for (let i = 0; i < n; i += size) out.push({ words: phrase.words.slice(i, i + size), strong: false });
  out[out.length - 1].strong = phrase.strong;
  return out;
}

/**
 * @param {{text:string,startMs:number,endMs:number}[]} words   per-character timings
 * @param {object} [opts]
 * @param {number} [opts.offsetMs=0]   where this voiceover starts on the timeline
 * @param {number} [opts.maxChars]     max visible characters per cue (default from aspectRatio)
 * @param {string} [opts.aspectRatio='9:16']
 * @param {number} [opts.maxDurationMs=4000]
 * @param {number} [opts.fps=30]
 * @returns {{startMs:number,endMs:number,text:string}[]}
 */
function splitCues(words, opts = {}) {
  const maxChars = opts.maxChars || MAX_CHARS[opts.aspectRatio || '9:16'] || 12;
  const maxDur = opts.maxDurationMs || 4000;
  const frame = 1000 / (opts.fps || 30);
  const offset = opts.offsetMs || 0;

  const phrases = toPhrases(words).flatMap((p) => splitLong(p, maxChars, maxDur));
  const cues = [];
  let cur = [];
  const len = (ps) => ps.reduce((a, p) => a + p.words.length, 0);
  const flush = () => {
    if (!cur.length) return;
    const first = cur[0].words[0];
    const last = cur.at(-1).words.at(-1);
    cues.push({
      // Snap outward to whole frames so the cue covers the speech and stays within one frame of it.
      startMs: Math.floor((first.startMs + offset) / frame) * frame,
      endMs: Math.ceil((last.endMs + offset) / frame) * frame,
      // Chinese subtitle convention: no punctuation on screen; a pause inside a cue becomes a space.
      text: cur.map((p) => p.words.map((w) => w.text).join('')).join(' '),
    });
    cur = [];
  };
  for (const p of phrases) {
    if (cur.length) {
      const tooWide = len(cur) + p.words.length > maxChars;
      const tooLong = p.words.at(-1).endMs - cur[0].words[0].startMs > maxDur;
      if (tooWide || tooLong) flush();
    }
    cur.push(p);
    if (p.strong) flush();
  }
  flush();
  // Rounding can make neighbours overlap by a frame; trim the earlier cue.
  for (let i = 1; i < cues.length; i++) if (cues[i - 1].endMs > cues[i].startMs) cues[i - 1].endMs = cues[i].startMs;
  for (const c of cues) { c.startMs = Math.round(c.startMs); c.endMs = Math.round(c.endMs); }
  return cues;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function srtTime(ms) {
  const h = Math.floor(ms / 3600000); const m = Math.floor(ms / 60000) % 60; const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${c.text}\n`).join('\n');
}

/** ASS uses centiseconds: round start down and end up so the cue never shrinks. */
function assTime(ms, up) {
  const cs = up ? Math.ceil(ms / 10) : Math.floor(ms / 10);
  const h = Math.floor(cs / 360000); const m = Math.floor(cs / 6000) % 60; const s = Math.floor(cs / 100) % 60;
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

/** '#RRGGBB' -> ASS '&H00BBGGRR' */
function assColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) throw new Error(`颜色格式应为 #RRGGBB：${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => m[1].slice(i, i + 2));
  return `&H00${b}${g}${r}`.toUpperCase();
}

const RESOLUTION = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };

const DEFAULT_STYLE = Object.freeze({
  fontName: defaultSubtitleFont(), // Windows/Linux: Microsoft YaHei；macOS: PingFang SC
  fontSize: 0,          // 0 = auto: 5.5% of the short side
  color: '#FFFFFF',
  outlineColor: '#000000',
  outline: 3,
  shadow: 0,
  bold: true,
  marginV: 0,           // 0 = auto: 12% of the frame height (above platform UI on 9:16)
});

/**
 * @param {{startMs,endMs,text}[]} cues
 * @param {{aspectRatio?: string, style?: Partial<typeof DEFAULT_STYLE>}} [opts]
 */
function toAss(cues, opts = {}) {
  const [w, h] = RESOLUTION[opts.aspectRatio || '9:16'] || RESOLUTION['9:16'];
  const st = { ...DEFAULT_STYLE, ...(opts.style || {}) };
  const size = st.fontSize || Math.round(Math.min(w, h) * 0.055);
  const marginV = st.marginV || Math.round(h * 0.12);
  const esc = (t) => String(t).replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${st.fontName},${size},${assColor(st.color)},&H000000FF,${assColor(st.outlineColor)},&H64000000,${st.bold ? -1 : 0},0,0,0,100,100,0,0,1,${st.outline},${st.shadow},2,40,40,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map((c) => `Dialogue: 0,${assTime(c.startMs)},${assTime(c.endMs, true)},Default,,0,0,0,,${esc(c.text)}`),
    '',
  ].join('\n');
}

module.exports = { splitCues, toSrt, toAss, assColor, DEFAULT_STYLE, MAX_CHARS };
