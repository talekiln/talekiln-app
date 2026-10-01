'use strict';
// I2：scriptgen -> 角色库 -> 项目图；配音（估价/确认/写回）；词级字幕；真实片长装配；对白文字唯一事实源。
// 全程用假文本模型与假 TTS，不碰网络，不含任何密钥。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const kernel = require('@talekiln/kernel');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { localTokenGuard } = require('../src/utils/localToken');
const scriptgenRoutes = require('../src/routes/scriptgen');
const kernelRoutes = require('../src/routes/kernel');
const voiceoverRoutes = require('../src/routes/voiceover');
const { createSpendService } = require('../src/spend');
const store = require('../src/kernel/store');
const { log, seededDb } = require('./helpers/kernelDb');
const { assembleFromKernel } = require('../src/timeline/kernelAssemble');

const fx = path.join(__dirname, 'fixtures', 'scriptgen');
const sample = JSON.parse(fs.readFileSync(path.join(fx, 'samples.json'), 'utf8')).find((s) => s.id === 'gf-01');
const reply = JSON.parse(fs.readFileSync(path.join(fx, 'recorded', 'gf-01.json'), 'utf8')).attempts.at(-1);

/** 假文本模型：把录下的回复分块吐出。 */
const fakeText = {
  createProviders: () => ({
    text: {
      stream: () => (async function* () {
        for (let i = 0; i < reply.length; i += 80) yield { type: 'delta', text: reply.slice(i, i + 80) };
        yield { type: 'done', text: reply, usage: { total_tokens: 1 } };
      })(),
    },
  }),
  resolveProvider: () => ({ kind: 'bailian', cfg: { bailian: { apiKey: 'fake' } }, model: 'fake-model' }),
};

/** 假 TTS：每个字 200ms，逐字时间戳；记录调用。 */
function fakeTts() {
  const calls = [];
  return {
    calls,
    tts: {
      async synthesize(provider, req) {
        calls.push({ provider, ...req });
        const words = Array.from(req.text.replace(/\n/g, '')).map((t, i) => ({ text: t, startMs: i * 200, endMs: (i + 1) * 200 }));
        return { audio: Buffer.from(`fake-audio:${req.voice}:${req.text}`), format: 'mp3', words };
      },
    },
  };
}

let server;
let base;
let db;
let dir;
let tts;
let created;

async function call(method, p, body) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method, headers: { 'content-type': 'application/json', 'x-talekiln-token': 'tok' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const graph = () => store.openProject(db, created.episode_id).graph;
const timeline = () => kernel.timelineView(graph());
const firstSpokenShot = (g) => kernel.shotOrder(g).find((id) => kernel.spokenLines(g, id).length);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i2-'));
  db = new Database(path.join(dir, 't.db'));
  db.pragma('journal_mode = WAL');
  runMigrationsAndEnsure(db);
  tts = fakeTts();
  const app = express();
  app.use(localTokenGuard('tok'));
  app.use(express.json());
  const r = express.Router();
  const sg = scriptgenRoutes(db, log, fakeText);
  const k = kernelRoutes(db, log);
  const spend = createSpendService(db);
  const vo = voiceoverRoutes(db, log, { spend, storageRoot: path.join(dir, 'storage'), resolve: () => ({ provider: 'bailian', model: 'cosyvoice-v2', facade: tts }) });
  r.post('/scriptgen/projects', sg.createProject);
  r.get('/episodes/:id/views/:view', k.getView);
  r.get('/episodes/:id/graph', k.getGraph);
  r.post('/episodes/:id/intent', k.postIntent);
  r.get('/voiceover/voices', vo.voices);
  r.post('/episodes/:id/voiceover', vo.voiceover);
  r.put('/spend/limits', (req, res) => { spend.setLimits(req.body); res.json({ ok: true }); });
  app.use('/api/v1', r);
  await new Promise((ok) => { server = app.listen(0, '127.0.0.1', ok); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe('scriptgen persistence', () => {
  it('route with a fake text model saves characters and initializes the kernel graph', async () => {
    const r = await call('POST', '/scriptgen/projects', { story: sample.story, templateId: sample.templateId, durationSec: sample.durationSec, aspectRatio: sample.aspectRatio });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    created = r.body.data;
    const chars = db.prepare('SELECT * FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY sort_order').all(created.drama_id);
    assert.ok(chars.length >= 1);
    assert.equal(chars.length, created.character_ids.length);
    for (const c of chars) assert.ok(c.name);
    const links = db.prepare('SELECT character_id FROM episode_characters WHERE episode_id = ?').all(created.episode_id).map((x) => x.character_id);
    assert.deepEqual(links.sort(), chars.map((c) => c.id).sort());
    // 分镜 characters 列里的名字都能在角色表里找到（参考图锁定按名字找）
    const names = new Set(chars.map((c) => c.name));
    for (const row of db.prepare('SELECT characters FROM storyboards WHERE episode_id = ?').all(created.episode_id)) {
      for (const n of JSON.parse(row.characters || '[]')) assert.ok(names.has(n), n);
    }
    assert.equal(created.graph.created, true);
  });

  it('every generated project starts with a graph: groups, shots, script lines, one compose', async () => {
    const g = graph();
    const nShots = db.prepare('SELECT COUNT(*) n FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').get(created.episode_id).n;
    assert.equal(kernel.nodesOfType(g, 'shot').length, nShots);
    assert.ok(kernel.nodesOfType(g, 'script_line').length > 0);
    assert.ok(g.group_order.length > 0);
    assert.equal(kernel.nodesOfType(g, 'compose').length, 1);
    for (const v of ['script', 'shots', 'timeline', 'canvas']) assert.equal((await call('GET', `/episodes/${created.episode_id}/views/${v}`)).status, 200);
  });
});

describe('narration voiceover', () => {
  let shotId;
  let nar;
  before(() => { const g = graph(); shotId = firstSpokenShot(g); nar = kernel.partsOfShot(g, shotId).narration; });

  it('lists voices', async () => {
    const r = await call('GET', '/voiceover/voices');
    assert.equal(r.body.data.default, 'longxiaochun_v2');
    assert.ok(r.body.data.voices.some((v) => v.verified));
  });

  it('validates the request', async () => {
    assert.equal((await call('POST', `/episodes/${created.episode_id}/voiceover`, {})).status, 400);
    assert.equal((await call('POST', `/episodes/${created.episode_id}/voiceover`, { all: true, voice: '../x y' })).status, 400);
    assert.equal((await call('POST', `/episodes/${created.episode_id}/voiceover`, { shots: ['nope'] })).status, 404);
  });

  it('without confirm: estimate only, nothing is synthesized or written', async () => {
    const r = await call('POST', `/episodes/${created.episode_id}/voiceover`, { all: true });
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.equal(d.confirm_required, true);
    assert.ok(d.shots > 0 && d.chars > 0 && d.estimate > 0 && d.max >= d.estimate);
    assert.equal(d.sample_prices, true);
    assert.equal(tts.calls.length, 0);
    assert.equal(graph().adopted[nar], undefined);
  });

  it('spend cap blocks a confirmed run with 402 before any synthesis', async () => {
    await call('PUT', '/spend/limits', { per_run_cap: 0.000001 });
    const r = await call('POST', `/episodes/${created.episode_id}/voiceover`, { all: true, confirm: true });
    assert.equal(r.status, 402);
    assert.equal(r.body.error.code, 'SPEND_LIMIT');
    assert.equal(tts.calls.length, 0);
    await call('PUT', '/spend/limits', { per_run_cap: null });
  });

  it('confirm: synthesizes with the speaker prefix stripped and records the adopted narration version', async () => {
    const r = await call('POST', `/episodes/${created.episode_id}/voiceover`, { shots: [shotId], voice: 'longxiaoxia_v2', confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.done.length, 1);
    assert.equal(tts.calls.length, 1);
    assert.equal(tts.calls[0].voice, 'longxiaoxia_v2');
    assert.equal(tts.calls[0].wordTimestamps, true);
    for (const l of kernel.spokenLines(graph(), shotId)) {
      const p = graph().nodes[l].params;
      if (p.kind === 'dialogue' && p.speaker) assert.ok(!tts.calls[0].text.includes(`${p.speaker}：`), 'speaker prefix must not be read aloud');
    }

    const g = graph();
    assert.equal(g.nodes[nar].params.voice, 'longxiaoxia_v2');
    const v = kernel.adoptedVersion(g, nar);
    assert.equal(v.asset.kind, 'audio');
    assert.ok(v.metadata.words.length > 0);
    assert.ok(v.metadata.cues.length > 0);
    assert.equal(v.metadata.duration_ms, v.metadata.words.at(-1).endMs);
    assert.equal(kernel.nodeState(g, nar), 'fresh');
    assert.ok(fs.existsSync(path.join(dir, 'storage', ...v.asset.ref.split('/'))));
    // 旧列物化
    const row = db.prepare('SELECT narration_audio_local_path p FROM storyboards WHERE id = ?').get(g.nodes[shotId].legacy_id);
    assert.equal(row.p, v.asset.ref);
    // 旧 timelines 表里也有旁白片段
    const clip = db.prepare(`SELECT c.* FROM timeline_clips c JOIN timeline_tracks t ON t.id = c.track_id WHERE t.kind = 'narration' AND c.asset_ref = ?`).get(v.asset.ref);
    assert.ok(clip);
  });

  it('word-level subtitles: several cues aligned to the narration start, text from the words', () => {
    const g = graph();
    const view = kernel.timelineView(g);
    const subs = view.tracks.find((t) => t.kind === 'subtitle').clips.filter((c) => c.id.startsWith(`sub_${shotId}`));
    const v = kernel.adoptedVersion(g, nar);
    assert.equal(subs.length, v.metadata.cues.length);
    assert.ok(subs.every((c) => /^sub_.+_\d+$/.test(c.id)));
    const first = view.tracks.find((t) => t.kind === 'video').clips.find((c) => c.storyboard_id === g.nodes[shotId].legacy_id).start_ms;
    assert.equal(subs[0].start_ms, first + v.metadata.cues[0].start_ms);
    assert.equal(subs[0].text, v.metadata.cues[0].text);
    for (let i = 1; i < subs.length; i++) assert.ok(subs[i].start_ms >= subs[i - 1].start_ms + subs[i - 1].duration_ms - 1);
  });

  it('changing the line text makes the narration stale and subtitles fall back to one text cue', async () => {
    const g = graph();
    const line = kernel.spokenLines(g, shotId)[0];
    const r = await call('POST', `/episodes/${created.episode_id}/intent`, { view: 'script', name: 'rewriteLine', args: { line_id: line, patch: { text: '全新的一句台词' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.stale.includes(nar));
    const subs = timeline().tracks.find((t) => t.kind === 'subtitle').clips.filter((c) => c.id.startsWith(`sub_${shotId}`));
    assert.equal(subs.length, 1);
    assert.equal(subs[0].id, `sub_${shotId}`);
    assert.match(subs[0].text, /全新的一句台词/);
  });

  it('re-voicing regenerates cues from the new text', async () => {
    const r = await call('POST', `/episodes/${created.episode_id}/voiceover`, { shots: [shotId], confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(tts.calls.at(-1).text, /全新的一句台词/);
    const g = graph();
    assert.equal(kernel.nodeState(g, nar), 'fresh');
    const cues = kernel.adoptedVersion(g, nar).metadata.cues;
    assert.equal(cues.map((c) => c.text).join('').replace(/\s/g, ''), '全新的一句台词');
    const subs = timeline().tracks.find((t) => t.kind === 'subtitle').clips.filter((c) => c.id.startsWith(`sub_${shotId}`));
    assert.equal(subs.map((c) => c.text).join('').replace(/\s/g, ''), cues.map((c) => c.text).join('').replace(/\s/g, ''));
    assert.ok(g.versions[nar].length >= 2, 'old version is kept, new one adopted');
  });

  it('all: skips shots whose narration is already fresh', async () => {
    const before = tts.calls.length;
    const r = await call('POST', `/episodes/${created.episode_id}/voiceover`, { all: true, voice: 'longxiaoxia_v2', confirm: true });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.skipped.some((s) => s.shot_id === shotId && s.reason === 'fresh'));
    assert.ok(!tts.calls.slice(before).some((c) => c.text.includes('全新的一句台词')));
    // 全部做完后再做一次：无事可做
    const again = await call('POST', `/episodes/${created.episode_id}/voiceover`, { all: true, voice: 'longxiaoxia_v2' });
    assert.equal(again.body.data.confirm_required, false);
  });

  it('spend_log records the direct synthesis', () => {
    const n = db.prepare(`SELECT COUNT(*) n FROM spend_log WHERE kind = 'tts' AND task_id LIKE 'voiceover:%'`).get().n;
    assert.ok(n >= 2);
  });

  it('a failing provider returns 502 VOICEOVER_FAILED and leaves the graph unchanged', async () => {
    const g0 = graph();
    const target = kernel.shotOrder(g0).find((id) => id !== shotId && kernel.spokenLines(g0, id).length);
    const bad = { tts: { synthesize: async () => { throw Object.assign(new Error('模拟：服务商拒绝'), { code: 'INVALID_API_KEY' }); } } };
    const app2 = express();
    app2.use(express.json());
    const vo = voiceoverRoutes(db, log, { storageRoot: path.join(dir, 'storage'), resolve: () => ({ provider: 'bailian', facade: bad }) });
    app2.post('/episodes/:id/voiceover', vo.voiceover);
    const s2 = await new Promise((ok) => { const s = app2.listen(0, '127.0.0.1', () => ok(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${s2.address().port}/episodes/${created.episode_id}/voiceover`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shots: [target], confirm: true, voice: 'longcheng_v2' }),
      });
      const body = await res.json();
      assert.equal(res.status, 502);
      assert.equal(body.error.code, 'VOICEOVER_FAILED');
      const nar2 = kernel.partsOfShot(graph(), target).narration;
      assert.deepEqual(graph().adopted[nar2], g0.adopted[nar2]);
      assert.equal((graph().versions[nar2] || []).length, (g0.versions[nar2] || []).length);
    } finally { s2.close(); }
  });
});

describe('assembly with real clip durations', () => {
  it('video version metadata.duration_ms drives clip length in the projection and the legacy timeline', () => {
    const ep = created.episode_id;
    const g0 = graph();
    const [s1, s2] = kernel.shotOrder(g0);
    const target1 = g0.nodes[s1].params.duration_ms;
    const real = 3200;
    assert.notEqual(real, target1);
    const vid = kernel.partsOfShot(g0, s1).video;
    const before = kernel.timelineView(g0).tracks.find((t) => t.kind === 'video').clips;
    store.commit(db, ep, (g) => kernel.intents.shot.recordGeneration(g, vid, { asset: { ref: 'videos/real.mp4', hash: 'h1', kind: 'video' }, metadata: { duration_ms: real } }));
    const g = graph();
    const clips = kernel.timelineView(g).tracks.find((t) => t.kind === 'video').clips;
    const c1 = clips.find((c) => c.storyboard_id === g.nodes[s1].legacy_id);
    const c2 = clips.find((c) => c.storyboard_id === g.nodes[s2].legacy_id);
    assert.equal(c1.duration_ms, real);
    assert.equal(c1.src_out_ms, real);
    assert.equal(c1.asset_ref, 'videos/real.mp4');
    // 后面的镜头顺延，不留空洞也不重叠
    assert.equal(c2.start_ms, c1.start_ms + real);
    assert.equal(before.find((c) => c.storyboard_id === g.nodes[s2].legacy_id).start_ms, target1);
    // 存储的 segments 和镜头目标时长不变（投影，不改存储）
    assert.equal(g.nodes[s1].params.duration_ms, target1);
    const sv = kernel.shotView(g).groups.flatMap((x) => x.shots).find((x) => x.id === s1);
    assert.equal(sv.real_ms, real);
    assert.equal(sv.used_ms, real);
    // 物化后的旧时间线表同样用真实时长
    const legacy = db.prepare(`SELECT c.duration_ms d FROM timeline_clips c JOIN timeline_tracks t ON t.id = c.track_id JOIN timelines tl ON tl.id = t.timeline_id WHERE tl.episode_id = ? AND t.kind = 'video' AND c.storyboard_id = ?`).get(ep, g.nodes[s1].legacy_id);
    assert.equal(legacy.d, real);
  });

  it('shots without a recorded real duration fall back to the target duration', () => {
    const g = graph();
    const s2 = kernel.shotOrder(g)[1];
    const c = kernel.timelineView(g).tracks.find((t) => t.kind === 'video').clips.find((x) => x.storyboard_id === g.nodes[s2].legacy_id);
    assert.equal(c.duration_ms, g.nodes[s2].params.duration_ms);
  });
});

describe('single source of truth', () => {
  it('dialogue text exists only in script_line params (graph) and storyboards columns (materialized)', () => {
    const g = graph();
    const texts = kernel.nodesOfType(g, 'script_line').map((id) => g.nodes[id].params.text).filter((t) => t.length >= 4);
    assert.ok(texts.length > 0);
    const others = JSON.stringify({
      nodes: Object.values(g.nodes).filter((n) => n.type !== 'script_line').map((n) => n.params),
      layout: g.layout, edges: g.edges, groups: g.groups,
    });
    for (const t of texts) assert.ok(!others.includes(t), `text leaked outside script_line: ${t}`);
    // 字幕块不是第二份文字：不进 shot / compose 的 params，只在版本产物里
    const comp = g.nodes[kernel.composeId(g)].params;
    assert.deepEqual(comp.subtitle_overrides, {});
  });
});

describe('assembleFromKernel', () => {
  it('assembles from the graph with real clip durations; 409 when it exists; replace resets segments', async () => {
    const { db: d2, episodeId } = await seededDb({ withTimeline: false });
    require('../src/kernel/legacy').importLegacy(d2, episodeId);
    const g0 = store.openProject(d2, episodeId).graph;
    const [s1] = kernel.shotOrder(g0);
    const plain = assembleFromKernel(d2, episodeId);
    assert.equal(plain.tracks.find((t) => t.kind === 'video').clips.length, 5);
    // 之后生成写回：物化把真实片长带进旧时间线表
    store.commit(d2, episodeId, (g) => kernel.intents.shot.recordGeneration(g, kernel.partsOfShot(g, s1).video, { asset: { ref: 'videos/x.mp4', hash: 'x', kind: 'video' }, metadata: { duration_ms: 2400 } }));
    const tl = assembleFromKernel(d2, episodeId, { replace: true });
    const v = tl.tracks.find((t) => t.kind === 'video').clips.sort((a, b) => a.start_ms - b.start_ms);
    assert.equal(v[0].duration_ms, 2400);
    assert.equal(v[1].start_ms, 2400);
    assert.throws(() => assembleFromKernel(d2, episodeId), (e) => e.status === 409);
    // 手工裁剪后 replace -> 回到整段（仍用真实片长）
    const seg = kernel.segmentsOfShot(store.openProject(d2, episodeId).graph, s1)[0];
    store.commit(d2, episodeId, (g) => kernel.intents.timeline.trimSegment(g, seg.id, { in_ms: 500, out_ms: 1500 }));
    const re = assembleFromKernel(d2, episodeId, { replace: true });
    assert.equal(re.tracks.find((t) => t.kind === 'video').clips.sort((a, b) => a.start_ms - b.start_ms)[0].duration_ms, 2400);
  });
});
