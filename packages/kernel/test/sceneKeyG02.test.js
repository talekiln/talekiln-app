'use strict';
// 内核场景缓存键（sceneKey）对接真实 G02 渲染计划（packages/core/src/plan.rs，lycore 的 render.plan）。
//
// 做法：把内核 timelineView 交给 render.plan（素材换成真实临时文件，内容 = 采用版本的 asset.hash，用 hashContent 模式），
// 对每个编辑比较“哪些镜头的场景变了”：内核按镜头的 sceneKey vs G02 按视频片段的 sceneKey。要求两边完全一致：
// 改变渲染结果的编辑 -> 两边都变；不改变渲染结果的编辑（音乐、画布坐标、转场、镜头标题、镜头顺序、生成输入参数）-> 两边都不变。
//
// lycore 二进制（packages/core/target/{debug,release}/lycore，`cargo build` 得到）存在时用真实 render.plan，
// 并校验下面的 JS 移植（按 plan.rs 文档化的字段）与它逐键一致；没有二进制时只用 JS 移植（移植逻辑见 g02Port）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const K = require('../src');
const O = require('./conformance/oracle');
const S = require('./conformance/stories');

const { script, shot, timeline, canvas } = K.intents;
const CORE_ROOT = path.join(__dirname, '..', '..', 'core');
const OUT = { width: 1080, height: 1920, fps: 30, encoder: 'libx264' };

// ---------- JS 移植：plan.rs 的场景键字段（只用于对照；键值与真实 render.plan 一致时才算移植正确） ----------
const sha = (s) => createHash('sha256').update(s).digest('hex');
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const volUnits = (v) => Math.round((v ?? 1) * 10000);
function g02Port(tl, cacheDir) {
  const track = (k) => tl.tracks.find((t) => t.kind === k);
  const clips = (k) => [...((track(k) || {}).clips || [])].sort((a, b) => a.start_ms - b.start_ms || a.duration_ms - b.duration_ms || String(a.id).localeCompare(String(b.id)));
  const ident = (p) => (fs.existsSync(p) ? { sha256: sha(fs.readFileSync(p)) } : { path: p, missing: true });
  const video = clips('video'); const subs = clips('subtitle'); const narr = clips('narration'); const music = clips('music');
  const total = Math.max(0, ...[...video, ...subs, ...narr, ...music].map((c) => c.start_ms + c.duration_ms));
  const segs = [];
  let cur = 0;
  for (const c of video) {
    const start = Math.max(c.start_ms, cur); const end = c.start_ms + c.duration_ms;
    if (end <= start) continue;
    if (start > cur) segs.push({ start: cur, end: start, v: null });
    segs.push({ start, end, v: { c, srcIn: (c.src_in_ms ?? 0) + (start - c.start_ms) } });
    cur = end;
  }
  if (total > cur) segs.push({ start: cur, end: total, v: null });
  const scenes = segs.map((s, i) => {
    const dur = s.end - s.start;
    const vkey = s.v ? { src: ident(s.v.c.asset_ref || ''), assetKind: s.v.c.asset_kind ?? null, srcInMs: s.v.srcIn, srcOutMs: s.v.srcIn + dur, gain: volUnits(s.v.c.volume) } : null;
    const ov = (c) => { const a = Math.max(c.start_ms, s.start); const b = Math.min(c.start_ms + c.duration_ms, s.end); return b > a ? [a, b] : null; };
    const sub = subs.map((c) => { const o = ov(c); return o && { relStartMs: o[0] - s.start, relEndMs: o[1] - s.start, text: c.text ?? null, style: c.style ?? null }; }).filter(Boolean);
    const nar = narr.map((c) => {
      const o = ov(c);
      return o && { relStartMs: o[0] - s.start, durMs: o[1] - o[0], src: ident(c.asset_ref || ''), srcInMs: (c.src_in_ms ?? 0) + (o[0] - c.start_ms), gain: volUnits(c.volume) };
    }).filter(Boolean);
    const payload = { rendererVersion: 'r1', kind: s.v ? 'video' : 'gap', durMs: dur, output: { width: OUT.width, height: OUT.height, fpsMilli: OUT.fps * 1000, encoder: OUT.encoder }, video: vkey, subtitles: sub, narration: nar };
    return { index: i, kind: payload.kind, clipId: s.v ? s.v.c.id : null, sceneKey: sha(JSON.stringify(canon(payload))) };
  });
  return { scenes };
}

// ---------- lycore ----------
function findBinary() {
  const exe = process.platform === 'win32' ? 'lycore.exe' : 'lycore';
  const found = ['release', 'debug'].map((p) => path.join(CORE_ROOT, 'target', p, exe)).filter(fs.existsSync);
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}
async function openCore() {
  const bin = findBinary();
  if (!bin) return null;
  const id = `lycore-sk-${process.pid}`;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lycore-sk-log-'));
  const child = spawn(bin, ['--pipe', endpoint, '--log-dir', logDir], { stdio: 'ignore' });
  try {
    const client = await require(path.join(CORE_ROOT, 'client')).connectRetry(endpoint);
    return { client, close() { try { client.close(); } catch (_) { /* ignore */ } child.kill(); } };
  } catch (_) {
    child.kill();
    return null;
  }
}

// ---------- 图 -> 真实素材 -> 两种场景键 ----------
function planFor(g, dir, core) {
  const tl = K.timelineView(g);
  const hashOfRef = {};
  for (const [id, list] of Object.entries(g.versions)) for (const v of list) if (v.asset && v.asset.ref) hashOfRef[v.asset.ref] = v.asset.hash ?? v.asset.ref;
  const tracks = tl.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => {
      if (!c.asset_ref || !hashOfRef[c.asset_ref]) return { ...c };
      const file = path.join(dir, createHash('sha1').update(c.asset_ref).digest('hex'));
      fs.writeFileSync(file, hashOfRef[c.asset_ref]); // 内容 = 采用版本的 asset.hash
      return { ...c, asset_ref: file };
    }),
  }));
  const timelineJson = { tracks: tracks.map((t) => ({ kind: t.kind, volume: t.volume, muted: t.muted, clips: t.clips })) };
  return { tl: timelineJson, core, cache: path.join(dir, 'cache') };
}

async function snapshot(g, dir, core) {
  const { tl, cache } = planFor(g, dir, core);
  const port = g02Port(tl, cache);
  let scenes = port.scenes;
  if (core) {
    const real = await core.client.call('render.plan', { timeline: tl, output: OUT, cacheDir: cache, hashContent: true });
    assert.deepEqual(real.scenes.map((s) => s.sceneKey), port.scenes.map((s) => s.sceneKey), 'the JS port of plan.rs agrees with the real lycore render.plan, key by key');
    assert.deepEqual(real.scenes.map((s) => s.clipId), port.scenes.map((s) => s.clipId));
    scenes = real.scenes;
  }
  const segShot = Object.fromEntries(g.nodes[O.composeNode(g)].params.segments.map((s) => [s.id, s.shot_id]));
  const g02 = {};
  for (const sc of scenes) if (sc.kind === 'video') (g02[segShot[sc.clipId]] = g02[segShot[sc.clipId]] || []).push(sc.sceneKey);
  return { kernel: K.sceneKeys(g), g02, all: scenes.map((s) => s.sceneKey).sort(), scenes };
}

const apply = (g, tx) => K.applyTx(g, tx).graph;
const gen = (g, ids) => apply(g, S.generateTx(g, ids));

// ---------- 用例 ----------
const story = S.loadStories().find((s) => s.id === 'gf-01');
const base = () => S.prepared(story);
const pickShot = (g) => O.shotsInOrder(g).find((s) => K.spokenLines(g, s).length && O.linesOf(g, s).length) || O.shotsInOrder(g)[0];

/** 每个编辑：{ name, run(g) -> g', changes(g) -> 应当变化的镜头 id 列表, wholePlanSame?: 整个计划的键集合不变 } */
const cases = [
  { name: '改一行对白文字（字幕烧进画面）', changes: (g) => O.shotsOfLine(g, K.spokenLines(g, pickShot(g))[0]), run: (g) => apply(g, script.rewriteLine(g, K.spokenLines(g, pickShot(g))[0], { text: '完全不同的字幕文字' })) },
  { name: '对白行改成动作行（字幕消失）', changes: (g) => O.shotsOfLine(g, K.spokenLines(g, pickShot(g))[0]), run: (g) => apply(g, script.rewriteLine(g, K.spokenLines(g, pickShot(g))[0], { kind: 'action' })) },
  {
    name: '字幕样式（subtitle_overrides）', changes: (g) => [pickShot(g)],
    run: (g) => apply(g, { tx_id: 't', ops: [{ op: 'setParam', node: O.composeNode(g), path: ['subtitle_overrides'], value: { [K.spokenLines(g, pickShot(g))[0]]: { font_size: 52 } } }] }),
  },
  { name: '裁剪片段', changes: (g) => [pickShot(g)], run: (g) => { const sid = g.nodes[O.composeNode(g)].params.segments.find((s) => s.shot_id === pickShot(g)).id; return apply(g, timeline.trimSegment(g, sid, { in_ms: 500 })); } },
  { name: '切分片段', changes: (g) => [pickShot(g)], run: (g) => { const s = g.nodes[O.composeNode(g)].params.segments.find((x) => x.shot_id === pickShot(g)); return apply(g, timeline.splitSegment(g, s.id, s.in_ms + 1000)); } },
  { name: '改镜头时长（片段跟随）', changes: (g) => [pickShot(g)], run: (g) => apply(g, shot.setShotField(g, pickShot(g), { duration_ms: g.nodes[pickShot(g)].params.duration_ms + 1000 })) },
  {
    name: '重新生成视频（新素材）', changes: (g) => [pickShot(g)],
    run: (g) => { const g1 = apply(g, shot.regenerateShot(g, pickShot(g), { seed: 4242 })); const c = O.chain(g1, pickShot(g1)); return gen(g1, [c.image, c.video]); },
  },
  {
    name: '换音色并重新配音（新旁白素材）', changes: (g) => [pickShot(g)],
    run: (g) => { const g1 = apply(g, shot.setVoice(g, pickShot(g), { voice: '另一个声音' })); return gen(g1, [O.chain(g1, pickShot(g1)).narration]); },
  },
  { name: '加音乐', changes: () => [], same: true, run: (g) => apply(g, timeline.addMusic(g, { asset_ref: 'm.mp3', start_ms: 0, duration_ms: 1000 })) },
  { name: '画布移动节点', changes: () => [], same: true, run: (g) => apply(g, canvas.moveNode(g, pickShot(g), { x: 5, y: 6 })) },
  { name: '设置转场（G02 不渲染转场）', changes: () => [], same: true, run: (g) => apply(g, timeline.setTransition(g, g.nodes[O.composeNode(g)].params.segments[0].id, 'fade')) },
  { name: '改镜头标题（不进渲染）', changes: () => [], same: true, run: (g) => apply(g, shot.setShotField(g, pickShot(g), { title: '换个标题' })) },
  { name: '改生成输入参数（参考图/尾帧/模型：只让节点过期，不改已有成片）', changes: () => [], same: true, run: (g) => apply(g, shot.setShotReferences(g, pickShot(g), { image_model: 'm-x', reference_hashes: ['r'], tail_frame_hash: 't' })) },
  { name: '改配音语速参数但未重新配音', changes: () => [], same: true, run: (g) => apply(g, shot.setVoice(g, pickShot(g), { speed: 1.25 })) },
  {
    name: '重排两个相邻镜头（场景键是相对场景的，各镜头键不变）', changes: () => [], sameSet: true,
    run: (g) => { const gid = g.group_order.find((x) => g.groups[x].children.filter((c) => g.nodes[c].type === 'shot').length >= 2); const ids = g.groups[gid].children.filter((c) => g.nodes[c].type === 'shot'); return apply(g, shot.reorderShots(g, gid, [ids[1], ids[0], ...ids.slice(2)])); },
  },
  {
    name: '改另一个镜头的片段前空隙（只改 gap 场景，镜头场景不变）', changes: () => [],
    run: (g) => { const T = pickShot(g); const other = O.shotsInOrder(g).find((s) => s !== T); return apply(g, timeline.moveSegment(g, g.nodes[O.composeNode(g)].params.segments.find((s) => s.shot_id === other).id, { gap_before_ms: 700 })); },
  },
  { name: '删除另一个镜头（该镜头的场景键不变）', changes: () => [], onlyShotsKept: true, run: (g) => { const other = O.shotsInOrder(g).filter((s) => s !== pickShot(g)).pop(); return apply(g, shot.deleteShot(g, other)); } },
];

test('sceneKey 与 G02 render.plan：改变渲染的编辑两边都变，不改变渲染的编辑两边都不变', async (t) => {
  const core = await openCore();
  t.after(() => core && core.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenekey-g02-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g0 = base();
  const before = await snapshot(g0, dir, core);
  const shots0 = O.shotsInOrder(g0);
  assert.ok(Object.keys(before.g02).length === shots0.length, 'every shot has video scenes in the real plan');
  const report = [];
  for (const c of cases) {
    const g1 = c.run(g0);
    const after = await snapshot(g1, dir, core);
    const want = new Set(c.changes(g0));
    for (const s of O.shotsInOrder(g1)) {
      if (!before.g02[s]) continue;
      const kernelChanged = before.kernel[s] !== after.kernel[s];
      const g02Changed = JSON.stringify(before.g02[s]) !== JSON.stringify(after.g02[s]);
      assert.equal(kernelChanged, g02Changed, `${c.name}: shot ${s}: kernel sceneKey changed=${kernelChanged} but G02 scene keys changed=${g02Changed}`);
      assert.equal(g02Changed, want.has(s), `${c.name}: shot ${s}: expected changed=${want.has(s)}`);
    }
    if (c.same) assert.deepEqual(after.all, before.all, `${c.name}: the whole G02 plan (every scene key) is unchanged`);
    if (c.sameSet) assert.deepEqual(after.all, before.all, `${c.name}: same scenes, just in a different order`);
    report.push(`${c.name}: ${want.size ? `变(${[...want].length} 个镜头)` : '不变'}`);
  }
  t.diagnostic(`${core ? '真实 lycore render.plan' : 'JS 移植（没有 lycore 二进制）'}；${report.length} 个编辑：\n${report.join('\n')}`);
});

test('素材身份取内容 hash：同 hash、不同路径的新版本两边都不变', async (t) => {
  const core = await openCore();
  t.after(() => core && core.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenekey-g02b-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g0 = base();
  const T = pickShot(g0);
  const a = await snapshot(g0, dir, core);
  // 重新生成但 hash 不变（同内容）：两边都不变
  const c = O.chain(g0, T);
  const g1 = apply(g0, K.intents.shot.recordGeneration(g0, c.video, { version_id: 'same', asset: { ref: 'asset/other-path.bin', hash: g0.versions[c.video][0].asset.hash, kind: 'video' } }));
  const b = await snapshot(g1, dir, core);
  assert.equal(a.kernel[T], b.kernel[T]);
  assert.deepEqual(a.g02[T], b.g02[T]);
});
