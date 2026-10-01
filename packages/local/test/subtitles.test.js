'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { splitCues, toSrt, toAss, assColor } = require('../src/subtitles');
const { voiceShots } = require('../src/voiceover');
const { createProviders } = require('../src/providers');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'bailian', n), 'utf8');
// Real CosyVoice word timings for "雨下得很大。公子，可愿帮我寻一枚玉佩？我在这里等了三年。"
const liveEvents = JSON.parse(fx('live_tts_word_timestamps.json'));
const liveWords = liveEvents.filter((e) => typeof e !== 'string' && e.payload.output && e.payload.output.type === 'sentence-end')
  .flatMap((e) => e.payload.output.sentence.words).map((w) => ({ text: w.text, startMs: w.begin_time, endMs: w.end_time }));

function fakeWS(script) {
  class FakeWS {
    constructor(url, opts) { FakeWS.last = this; this.sent = []; queueMicrotask(() => this.onopen()); }
    send(s) {
      const m = JSON.parse(s); this.sent.push(m);
      if (m.header.action === 'run-task') setTimeout(() => script.forEach((ev) => this.onmessage({ data: typeof ev === 'string' ? Buffer.from(ev.slice(4)) : JSON.stringify(ev) })), 0);
    }
    close() {}
  }
  return FakeWS;
}

test('tts.synthesize returns real word timings when asked (latest event per sentence wins)', async () => {
  const WS = fakeWS(liveEvents);
  const p = createProviders({ bailian: { apiKey: 'sk-test', WebSocket: WS } });
  const r = await p.tts.synthesize('bailian', { text: 'x', wordTimestamps: true });
  assert.equal(WS.last.sent[0].payload.parameters.word_timestamp_enabled, true);
  assert.equal(r.audio.toString(), 'RIFF-audio');
  assert.deepEqual(r.words, liveWords);
  assert.equal(r.words.length, 28);
  assert.deepEqual(r.usage, { characters: 52 });
  const plain = await createProviders({ bailian: { apiKey: 'sk-test', WebSocket: fakeWS(liveEvents) } }).tts.synthesize('bailian', { text: 'x' });
  assert.equal(plain.words, undefined);
});

test('splitCues breaks at sentence ends and keeps cues within one frame of the speech', () => {
  const cues = splitCues(liveWords, { aspectRatio: '9:16', fps: 30 });
  assert.deepEqual(cues.map((c) => c.text), ['雨下得很大', '公子 可愿帮我寻一枚玉佩', '我在这里等了三年']);
  const frame = 1000 / 30;
  const spoken = liveWords.filter((w) => !/[。，？]/.test(w.text));
  for (const c of cues) {
    const ws = spoken.filter((w) => w.startMs >= c.startMs - frame && w.endMs <= c.endMs + frame);
    assert.equal(ws.map((w) => w.text).join(''), c.text.replace(/ /g, ''));
    assert.ok(Math.abs(c.startMs - ws[0].startMs) <= frame);
    assert.ok(Math.abs(c.endMs - ws.at(-1).endMs) <= frame);
  }
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i - 1].endMs <= cues[i].startMs);
});

test('splitCues honours width, max duration and timeline offset', () => {
  const words = Array.from({ length: 30 }, (_, i) => ({ text: '字', startMs: i * 200, endMs: i * 200 + 180 }));
  const cues = splitCues(words, { maxChars: 10, offsetMs: 5000, fps: 25 });
  assert.equal(cues.length, 3);
  assert.ok(cues.every((c) => c.text.length <= 10));
  assert.equal(cues[0].startMs, 5000);
  const long = splitCues(words, { maxChars: 100, maxDurationMs: 2000 });
  assert.ok(long.every((c) => c.endMs - c.startMs <= 2100));
});

test('SRT and ASS output', () => {
  const cues = [{ startMs: 80, endMs: 900, text: '雨下得很大' }, { startMs: 3723456, endMs: 3724000, text: '{危险}\\字' }];
  assert.equal(toSrt(cues).split('\n').slice(0, 3).join('\n'), '1\n00:00:00,080 --> 00:00:00,900\n雨下得很大');
  assert.match(toSrt(cues), /01:02:03,456 --> 01:02:04,000/);
  const ass = toAss(cues, { aspectRatio: '16:9', style: { color: '#FFD700' } });
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /Style: Default,Microsoft YaHei,59,&H0000D7FF,/);
  assert.match(ass, /Dialogue: 0,0:00:00\.08,0:00:00\.90,Default,,0,0,0,,雨下得很大/);
  assert.match(ass, /Dialogue: 0,1:02:03\.45,1:02:04\.00,Default,,0,0,0,,危险＼字/);
  assert.equal(assColor('#112233'), '&H00332211');
  assert.throws(() => assColor('red'));
});

test('voiceShots voices only shots with dialogue, maps speakers to voices, flags overruns', async () => {
  const calls = [];
  const providers = { tts: { synthesize: async (prov, req) => { calls.push(req); return { audio: Buffer.from('a'), format: 'mp3', words: liveWords }; } } };
  const shots = [
    { no: 1, durationSec: 6, dialogue: { speaker: 'narrator', text: '旁白' } },
    { no: 2, durationSec: 4, dialogue: null },
    { no: 3, durationSec: 4, dialogue: { speaker: 'c2', text: '台词' } },
  ];
  const r = await voiceShots(providers, { provider: 'bailian', shots, voices: { c2: 'longwan_v2' } });
  assert.deepEqual(r.map((x) => [x.shotNo, x.voice]), [[1, 'longxiaochun_v2'], [3, 'longwan_v2']]);
  assert.ok(calls.every((c) => c.wordTimestamps === true));
  assert.equal(r[0].durationMs, 5360);
  assert.equal(r[0].overrunMs, 0);
  assert.equal(r[1].overrunMs, 1360);
  assert.equal(r[0].cues.length, 3);
});
