'use strict';
// P2-E：剪映草稿 / Premiere xmeml / FCPXML 导出器的结构断言（纯函数）+ 服务层与 REST。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const K = require('@talekiln/kernel');
const store = require('../src/kernel/store');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const ex = require('../src/export/exporters');
const { msToFrames, frameSpan } = require('../src/export/exporters/common');
const { createMediaExporter } = require('../src/export/mediaExport');
const { ExportError } = require('../src/export/service');
const exportRoutes = require('../src/routes/export');
const { ENTRIES } = require('../src/errors');
const { parseXml, child, kids, find } = require('./helpers/xmlLite');
const { sampleRainNight, sampleEdited, sampleSpecial } = require('./helpers/exportSamples');

const ROOT = '/media/我的 素材库'; // 纯函数测试用的假根目录（含中文和空格）
const abs = (ref) => `${ROOT}/${ref}`;

/** 与服务层同样的转换：把投影里的相对 ref 换成绝对路径（纯函数，不碰文件系统）。 */
function resolvedView(g) {
  const v = K.timelineView(g);
  return { ...v, tracks: v.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.asset_ref && t.kind !== 'subtitle' ? { ...c, asset_ref: abs(c.asset_ref) } : c)) })) };
}
const clipsOf = (v, k) => v.tracks.find((t) => t.kind === k).clips;
const SAMPLES = [['雨夜', sampleRainNight], ['剪辑过', sampleEdited], ['特殊字符', sampleSpecial]];

describe('presets', () => {
  it('抖音 9:16 / 视频号 3:4 与 9:16 / 横屏 16:9，宽高为偶数且比例正确', () => {
    const keys = ex.PLATFORM_PRESETS.map((p) => p.key);
    assert.deepEqual(keys, ['douyin-9x16', 'shipinhao-3x4', 'shipinhao-9x16', 'landscape-16x9']);
    for (const p of ex.PLATFORM_PRESETS) {
      assert.equal(p.width % 2, 0);
      assert.equal(p.height % 2, 0);
      const [a, b] = p.aspect.split(':').map(Number);
      assert.equal(p.width * b, p.height * a, p.key);
      assert.ok(p.bitrate_kbps >= 4000 && p.fps >= 24);
    }
    assert.deepEqual([ex.findPreset('shipinhao-3x4').width, ex.findPreset('shipinhao-3x4').height], [1080, 1440]);
    assert.equal(ex.findPreset('nope'), null);
  });
});

describe('path conversion', () => {
  it('剪映：Windows 反斜杠转正斜杠，中文空格原样；POSIX 不变', () => {
    assert.equal(ex.paths.toJianyingPath('D:\\我的 项目\\素材 1.mp4'), 'D:/我的 项目/素材 1.mp4');
    assert.equal(ex.paths.toJianyingPath('/Users/张三/a b.mp4'), '/Users/张三/a b.mp4');
    assert.equal(ex.paths.toJianyingPath('\\\\nas\\共享\\x.mp4'), '//nas/共享/x.mp4');
  });
  it('file URL：逐段 UTF-8 百分号编码，盘符冒号编码', () => {
    assert.equal(ex.paths.toFileUrl('D:\\我的 项目\\素材 1.mp4'), 'file://localhost/D%3A/%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE/%E7%B4%A0%E6%9D%90%201.mp4');
    assert.equal(ex.paths.toFileUrl('/Users/张三/a b#1.mp4'), 'file://localhost/Users/%E5%BC%A0%E4%B8%89/a%20b%231.mp4');
    assert.equal(ex.paths.toFileUrl('\\\\nas\\共享\\x.mp4'), 'file://nas/%E5%85%B1%E4%BA%AB/x.mp4');
    assert.equal(decodeURIComponent(ex.paths.toFileUrl('/a/中 文/b.mp4').replace('file://localhost', '')), '/a/中 文/b.mp4');
  });
  it('safeFolderName：去掉非法字符，保留中文空格，空名回退', () => {
    assert.equal(ex.paths.safeFolderName('特殊 字符/名字:x?'), '特殊 字符_名字_x_');
    assert.equal(ex.paths.safeFolderName('  ...'), 'draft');
  });
});

describe('time conversion', () => {
  it('毫秒 -> 帧：起点终点各自取整，相邻片段无缝无叠', () => {
    assert.equal(msToFrames(1000, 30), 30);
    assert.equal(msToFrames(500, 24), 12);
    const a = frameSpan(0, 1015, 30);
    const b = frameSpan(1015, 1015, 30);
    assert.equal(a.end, b.start);
    assert.equal(frameSpan(100, 1, 30).duration, 1); // 最短 1 帧
  });
});

for (const [label, make] of SAMPLES) {
  describe(`样例「${label}」`, () => {
    const s = make();
    const view = resolvedView(s.g);
    const input = { name: s.name, width: s.width, height: s.height, fps: s.fps, view, nowMs: 1_700_000_000_000 };
    const v = clipsOf(view, 'video');
    const subs = clipsOf(view, 'subtitle');
    const narr = clipsOf(view, 'narration');
    const music = clipsOf(view, 'music');

    it('投影本身：视频片段首尾衔接（用于后面的对齐断言）', () => {
      assert.ok(v.length >= 3);
      for (let i = 1; i < v.length; i++) assert.ok(v[i].start_ms >= v[i - 1].start_ms + v[i - 1].duration_ms);
    });

    it('剪映草稿：轨道数、片段对齐（µs）、字幕条数、素材路径、引用完整', () => {
      const r = ex.buildJianyingDraft(input);
      assert.deepEqual(Object.keys(r.files).sort(), ['draft_agency_config.json', 'draft_content.json', 'draft_meta_info.json', 'draft_virtual_store.json', 'key_value.json', 'timeline_layout.json']);
      const parsed = Object.fromEntries(Object.entries(r.files).map(([k, t]) => [k, JSON.parse(t)]));
      const c = parsed['draft_content.json'];
      const m = parsed['draft_meta_info.json'];

      // 轨道数：视频 1 + 旁白（有则 1）+ 音乐（有则 1）+ 字幕 1
      const expectTracks = 1 + (narr.length ? 1 : 0) + (music.length ? 1 : 0) + (subs.length ? 1 : 0);
      assert.equal(c.tracks.length, expectTracks);
      assert.equal(r.stats.track_count, expectTracks);
      const byType = (t, name) => c.tracks.find((x) => x.type === t && (!name || x.name === name));
      assert.equal(c.tracks.filter((x) => x.type === 'video').length, 1);

      // 片段起止对齐：µs = ms * 1000，逐条对
      const segsOf = (tr) => tr.segments.map((x) => [x.target_timerange.start, x.target_timerange.duration]);
      assert.deepEqual(segsOf(byType('video')), v.map((x) => [x.start_ms * 1000, x.duration_ms * 1000]));
      if (narr.length) assert.deepEqual(segsOf(byType('audio', 'narration')), narr.map((x) => [x.start_ms * 1000, x.duration_ms * 1000]));
      if (music.length) assert.deepEqual(segsOf(byType('audio', 'music')), music.map((x) => [x.start_ms * 1000, x.duration_ms * 1000]));
      // 素材内取值（裁剪）也对齐
      assert.deepEqual(byType('video').segments.map((x) => x.source_timerange.start), v.map((x) => (x.asset_kind === 'image' ? 0 : x.src_in_ms * 1000)));
      if (music.length) assert.deepEqual(byType('audio', 'music').segments.map((x) => x.source_timerange.start), music.map((x) => x.src_in_ms * 1000));

      // 字幕条数与文字
      assert.equal(subs.length > 0, !!byType('text'));
      assert.equal(c.materials.texts.length, subs.length);
      assert.equal(r.stats.subtitle_segments, subs.length);
      assert.deepEqual(c.materials.texts.map((t) => JSON.parse(t.content).text), subs.map((x) => x.text));
      assert.deepEqual(segsOf(byType('text')), subs.map((x) => [x.start_ms * 1000, x.duration_ms * 1000]));

      // 总时长、画布
      assert.equal(c.duration, view.duration_ms * 1000);
      assert.equal(m.tm_duration, c.duration);
      assert.deepEqual([c.canvas_config.width, c.canvas_config.height, c.fps], [s.width, s.height, s.fps]);

      // 素材路径：转换后进 materials；同一路径只建一份；路径原样保留中文与空格
      const paths = [...c.materials.videos, ...c.materials.audios].map((x) => x.path);
      assert.equal(new Set(paths).size, paths.length);
      const expectPaths = new Set([...v, ...narr, ...music].map((x) => x.asset_ref));
      assert.deepEqual([...paths].sort(), [...expectPaths].sort());
      assert.ok(paths.every((p) => p.startsWith('/media/我的 素材库/')));
      assert.equal(c.materials.videos.filter((x) => x.type === 'photo').length, v.filter((x) => x.asset_kind === 'image').length);

      // 引用完整：片段的 material_id 与 extra_material_refs 都能在 materials 里找到
      const ids = new Set(Object.values(c.materials).flat().filter((x) => x && x.id).map((x) => x.id));
      for (const tr of c.tracks) for (const sg of tr.segments) {
        assert.ok(ids.has(sg.material_id), 'material_id');
        for (const ref of sg.extra_material_refs) assert.ok(ids.has(ref), 'extra ref');
      }
      // 每个素材都在 draft_meta_info 的素材清单里
      const metaPaths = m.draft_materials[0].value.map((x) => x.file_Path);
      assert.deepEqual([...metaPaths].sort(), [...paths].sort());
      // id 全局唯一
      const all = [...ids];
      assert.equal(new Set(all).size, all.length);
      for (const id of all) assert.match(id, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
      // 旁白/音乐音量
      if (music.length) assert.deepEqual(byType('audio', 'music').segments.map((x) => x.volume), music.map((x) => x.volume));
    });

    it('剪映草稿：同输入两次输出逐字节相同（确定性 id）', () => {
      assert.deepEqual(ex.buildJianyingDraft(input).files, ex.buildJianyingDraft(input).files);
    });

    it('xmeml：良构；轨道数、帧对齐、字幕 SRT、路径 URL、file 引用', () => {
      const r = ex.buildXmeml(input);
      const xmlName = Object.keys(r.files).find((k) => k.endsWith('.xml'));
      assert.ok(xmlName && !/[\\/:*?"<>|]/.test(xmlName));
      const root = parseXml(r.files[xmlName]);
      assert.equal(root.name, 'xmeml');
      assert.equal(root.attrs.version, '4');
      const seq = child(root, 'sequence');
      assert.equal(child(seq, 'name').text, s.name);
      const media = child(seq, 'media');
      const vTracks = kids(child(media, 'video'), 'track');
      const aTracks = kids(child(media, 'audio'), 'track');
      assert.equal(vTracks.length, 1);
      assert.equal(aTracks.length, (narr.length ? 1 : 0) + (music.length ? 1 : 0));
      assert.equal(r.stats.track_count, vTracks.length + aTracks.length);

      const fps = s.fps;
      const spec = (cl) => [Number(child(cl, 'start').text), Number(child(cl, 'end').text)];
      const expectSpans = (arr) => arr.map((x) => { const f = frameSpan(x.start_ms, x.duration_ms, fps); return [f.start, f.end]; });
      const vItems = kids(vTracks[0], 'clipitem');
      assert.deepEqual(vItems.map(spec), expectSpans(v));
      // duration = end - start；in/out 与裁剪一致
      for (const [i, cl] of vItems.entries()) {
        const [a, b] = spec(cl);
        assert.equal(Number(child(cl, 'duration').text), b - a);
        const inF = v[i].asset_kind === 'image' ? 0 : msToFrames(v[i].src_in_ms, fps);
        assert.equal(Number(child(cl, 'in').text), inF);
        assert.equal(Number(child(cl, 'out').text), inF + (b - a));
      }
      // 视频衔接：投影里无缝的相邻片段，帧也无缝
      for (let i = 1; i < v.length; i++) {
        if (v[i].start_ms === v[i - 1].start_ms + v[i - 1].duration_ms) assert.equal(spec(vItems[i])[0], spec(vItems[i - 1])[1]);
      }
      let ti = 0;
      if (narr.length) assert.deepEqual(kids(aTracks[ti++], 'clipitem').map(spec), expectSpans(narr));
      if (music.length) assert.deepEqual(kids(aTracks[ti++], 'clipitem').map(spec), expectSpans(music));
      assert.equal(Number(child(seq, 'duration').text), frameSpan(0, view.duration_ms, fps).end);
      assert.equal(child(child(seq, 'rate'), 'timebase').text, String(fps));

      // 路径：所有 file 都有 pathurl，解码后等于素材绝对路径；重复使用的素材只定义一次
      const files = find(root, 'file');
      const defs = files.filter((f) => child(f, 'pathurl'));
      const refs = files.filter((f) => !child(f, 'pathurl'));
      const expectPaths = [...new Set([...v, ...narr, ...music].map((x) => x.asset_ref))];
      assert.deepEqual(defs.map((f) => decodeURIComponent(child(f, 'pathurl').text.replace('file://localhost', ''))).sort(), [...expectPaths].sort());
      const defIds = new Set(defs.map((f) => f.attrs.id));
      assert.equal(defIds.size, defs.length);
      for (const rf of refs) assert.ok(defIds.has(rf.attrs.id));
      assert.equal(r.stats.files, expectPaths.length);

      // 字幕：SRT 条数 = 字幕片段数，时间格式 HH:MM:SS,mmm
      const srt = r.files['subtitles.srt'];
      assert.equal((srt.match(/-->/g) || []).length, subs.length);
      assert.equal(r.stats.subtitle_cues, subs.length);
      if (subs.length) {
        const cue = srt.split('\n\n')[0].split('\n');
        assert.equal(cue[0], '1');
        assert.match(cue[1], /^\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}$/);
        assert.equal(cue.slice(2).join('\n').trim(), subs[0].text);
      }
    });

    it('FCPXML：良构；offset/duration 与帧对齐；asset 引用完整；lane 分配', () => {
      const r = ex.buildFcpxml(input);
      const name = Object.keys(r.files).find((k) => k.endsWith('.fcpxml'));
      const root = parseXml(r.files[name]);
      assert.equal(root.name, 'fcpxml');
      const fmt = find(root, 'format')[0];
      assert.equal(fmt.attrs.frameDuration, `1/${s.fps}s`);
      assert.deepEqual([fmt.attrs.width, fmt.attrs.height], [String(s.width), String(s.height)]);
      const frames = (t) => { if (t === '0s') return 0; const m = /^(\d+)\/(\d+)s$/.exec(t); assert.ok(m, t); assert.equal(Number(m[2]), s.fps); return Number(m[1]); };
      const clips = find(root, 'asset-clip');
      const lane = (n) => clips.filter((c) => c.attrs.lane === String(n));
      const spans = (arr) => arr.map((x) => { const f = frameSpan(x.start_ms, x.duration_ms, s.fps); return [f.start, f.duration]; });
      assert.deepEqual(lane(1).map((c) => [frames(c.attrs.offset), frames(c.attrs.duration)]), spans(v));
      assert.deepEqual(lane(-1).map((c) => [frames(c.attrs.offset), frames(c.attrs.duration)]), spans(narr));
      assert.deepEqual(lane(-2).map((c) => [frames(c.attrs.offset), frames(c.attrs.duration)]), spans(music));
      const assetIds = new Set(find(root, 'asset').map((a) => a.attrs.id));
      for (const c of clips) assert.ok(assetIds.has(c.attrs.ref));
      assert.equal(assetIds.size, r.stats.files);
      assert.equal(frames(find(root, 'sequence')[0].attrs.duration), frameSpan(0, view.duration_ms, s.fps).end);
      for (const a of find(root, 'asset')) assert.ok(a.attrs.src.startsWith('file://localhost/media/%E6%88%91'));
    });
  });
}

describe('样例特有内容', () => {
  it('XML 特殊字符被转义且仍然良构（字幕、素材名）', () => {
    const s = sampleSpecial();
    const view = resolvedView(s.g);
    const r = ex.buildXmeml({ name: 'A&B <x> "q"', width: 1080, height: 1920, fps: 30, view });
    const root = parseXml(Object.entries(r.files).find(([k]) => k.endsWith('.xml'))[1]);
    assert.equal(child(child(root, 'sequence'), 'name').text, 'A&B <x> "q"');
    assert.ok(Object.keys(r.files).some((k) => k === 'A&B _x_ _q_.xml'));
    const d = ex.buildJianyingDraft({ name: 'x', width: 1080, height: 1920, fps: 30, view });
    assert.ok(JSON.parse(d.files['draft_content.json']).materials.texts.some((t) => JSON.parse(t.content).text.includes('A & B <tag> "引号"')));
  });

  it('剪辑过：转场不导出但给出警告；仅有图片的镜头在三种格式里都有对应片段', () => {
    const s = sampleEdited();
    const view = resolvedView(s.g);
    const input = { name: 'e', width: 1280, height: 720, fps: 24, view };
    assert.ok(clipsOf(view, 'video').some((c) => c.asset_kind === 'image'));
    for (const r of [ex.buildJianyingDraft(input), ex.buildXmeml(input), ex.buildFcpxml(input)]) {
      assert.ok(r.warnings.some((w) => w.includes('转场')), 'transition warning');
    }
    const cues = clipsOf(view, 'subtitle').filter((c) => c.id.startsWith('sub_shot_2_'));
    assert.equal(cues.length, 2); // 词级字幕块
  });

  it('只有字幕没有素材的片段会被跳过并警告（剪映）', () => {
    const view = { duration_ms: 3000, tracks: [{ kind: 'video', clips: [{ id: 'c1', start_ms: 0, duration_ms: 3000, asset_ref: null, asset_kind: null }] }, { kind: 'subtitle', clips: [] }, { kind: 'narration', clips: [] }, { kind: 'music', clips: [] }] };
    const r = ex.buildJianyingDraft({ name: 'x', width: 1920, height: 1080, fps: 30, view });
    assert.equal(r.stats.video_segments, 0);
    assert.ok(r.warnings[0].includes('没有素材'));
  });
});

// ---------------------------------------------------------------- 服务层 + REST

function makeEnv(sample, { create = true, skip = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-media-'));
  const db = new Database(path.join(dir, 't.db'));
  runMigrationsAndEnsure(db);
  const storageRoot = path.join(dir, '素材 目录');
  if (create) {
    for (const ref of sample.refs) {
      if (skip.includes(ref)) continue;
      fs.mkdirSync(path.dirname(path.join(storageRoot, ref)), { recursive: true });
      fs.writeFileSync(path.join(storageRoot, ref), 'x');
    }
  }
  const ep = db.prepare("INSERT INTO episodes (drama_id, episode_number, title) VALUES (1, 1, '第一集 雨夜')").run().lastInsertRowid;
  store.initProject(db, Number(ep), sample.g);
  return { dir, db, storageRoot, ep: Number(ep), svc: createMediaExporter(db, { storageRoot }), out: path.join(dir, '导出 文件夹') };
}

describe('mediaExporter 服务', () => {
  it('剪映：写到含中文和空格的目录，文件齐全、JSON 可解析、素材路径是真实绝对路径', () => {
    const s = sampleRainNight();
    const e = makeEnv(s);
    const r = e.svc.jianying({ episode_id: e.ep, output_dir: e.out, preset: 'douyin-9x16' });
    assert.equal(r.written, true);
    assert.equal(r.output_dir, path.join(e.out, '第一集 雨夜'));
    assert.deepEqual([r.width, r.height, r.fps], [1080, 1920, 30]);
    const c = JSON.parse(fs.readFileSync(path.join(r.output_dir, 'draft_content.json'), 'utf8'));
    assert.deepEqual([c.canvas_config.width, c.canvas_config.height], [1080, 1920]);
    for (const m of [...c.materials.videos, ...c.materials.audios]) assert.ok(fs.existsSync(m.path), m.path);
    assert.ok(c.materials.videos[0].path.includes('素材 目录'));
    for (const f of r.files) assert.ok(fs.existsSync(path.join(r.output_dir, f)));
    assert.equal(fs.readdirSync(r.output_dir).filter((n) => n.endsWith('.tmp')).length, 0);
  });

  it('Premiere xmeml 与 fcpxml 各写进独立子文件夹，附 SRT', () => {
    const e = makeEnv(sampleEdited());
    const a = e.svc.fcpxml({ episode_id: e.ep, output_dir: e.out, name: '我的 工程' });
    assert.equal(a.format, 'xmeml');
    assert.equal(a.output_dir, path.join(e.out, '我的 工程_premiere'));
    parseXml(fs.readFileSync(path.join(a.output_dir, '我的 工程.xml'), 'utf8'));
    assert.ok(fs.existsSync(path.join(a.output_dir, 'subtitles.srt')));
    const b = e.svc.fcpxml({ episode_id: e.ep, output_dir: e.out, name: '我的 工程', format: 'fcpxml', width: 1280, height: 720, fps: 24 });
    assert.equal(b.format, 'fcpxml');
    parseXml(fs.readFileSync(path.join(b.output_dir, '我的 工程.fcpxml'), 'utf8'));
    assert.equal(b.fps, 24);
  });

  it('dry_run 只校验与估算，不写文件；同名已存在 -> 409 EXPORT_OUTPUT_EXISTS，overwrite 可覆盖', () => {
    const e = makeEnv(sampleRainNight());
    const d = e.svc.jianying({ episode_id: e.ep, output_dir: e.out, dry_run: true });
    assert.equal(d.written, false);
    assert.equal(d.stats.video_segments, 4);
    assert.equal(fs.existsSync(e.out), false);
    e.svc.jianying({ episode_id: e.ep, output_dir: e.out });
    assert.throws(() => e.svc.jianying({ episode_id: e.ep, output_dir: e.out }), (err) => err instanceof ExportError && err.code === 'EXPORT_OUTPUT_EXISTS' && err.status === 409);
    assert.equal(e.svc.jianying({ episode_id: e.ep, output_dir: e.out, overwrite: true }).written, true);
  });

  it('缺素材文件 -> EXPORT_ASSETS，details 列出缺哪些；不写任何东西', () => {
    const s = sampleRainNight();
    const e = makeEnv(s, { skip: ['audio/narration/shot_2.mp3', 'library/music/rain.mp3'] });
    assert.throws(() => e.svc.jianying({ episode_id: e.ep, output_dir: e.out }), (err) => {
      assert.equal(err.code, 'EXPORT_ASSETS');
      assert.equal(err.status, 400);
      assert.match(err.message, /shot_2\.mp3/);
      assert.deepEqual(err.details.problems.map((p) => p.error), ['missing', 'missing']);
      return true;
    });
    assert.equal(fs.existsSync(e.out), false);
  });

  it('镜头还没生成视频 -> EXPORT_MEDIA_NOT_GENERATED', () => {
    const s = sampleRainNight();
    const { adoptMedia } = require('./helpers/exportSamples');
    const partial = adoptMedia(require('../../kernel/test/helpers').fixtureGraph(), { noVideo: ['shot_2'] });
    const e = makeEnv({ g: partial.g, refs: partial.refs });
    void s;
    assert.throws(() => e.svc.fcpxml({ episode_id: e.ep, output_dir: e.out }), (err) => err.code === 'EXPORT_MEDIA_NOT_GENERATED' && err.details.problems[0].storyboard_id === 102);
  });

  it('其它错误码：无项目图 / 非法预设 / 非法尺寸 / 非法目录 / 目录是文件', () => {
    const e = makeEnv(sampleRainNight());
    const code = (fn) => { try { fn(); } catch (err) { return err.code; } return null; };
    assert.equal(code(() => e.svc.jianying({ episode_id: 9999, output_dir: e.out })), 'EXPORT_NO_TIMELINE');
    assert.equal(code(() => e.svc.jianying({ episode_id: e.ep, output_dir: e.out, preset: 'tiktok' })), 'EXPORT_BAD_FORMAT');
    assert.equal(code(() => e.svc.jianying({ episode_id: e.ep, output_dir: e.out, width: 1081, height: 1920 })), 'EXPORT_BAD_FORMAT');
    assert.equal(code(() => e.svc.jianying({ episode_id: e.ep, output_dir: e.out, fps: 0 })), 'EXPORT_BAD_FORMAT');
    assert.equal(code(() => e.svc.jianying({ episode_id: e.ep, output_dir: 'relative/dir' })), 'EXPORT_BAD_OUTPUT_DIR');
    assert.equal(code(() => e.svc.jianying({ episode_id: e.ep })), 'EXPORT_BAD_OUTPUT_DIR');
    const file = path.join(e.dir, 'afile');
    fs.writeFileSync(file, 'x');
    assert.equal(code(() => e.svc.jianying({ episode_id: e.ep, output_dir: file })), 'EXPORT_BAD_OUTPUT_DIR');
    assert.equal(code(() => e.svc.run('premiere-pro', { episode_id: e.ep, output_dir: e.out })), 'EXPORT_BAD_FORMAT');
  });

  it('导出只读：图的快照与日志不变', () => {
    const e = makeEnv(sampleEdited());
    const snap = () => JSON.stringify([e.db.prepare('SELECT snapshot, snapshot_seq FROM project_graphs').all(), e.db.prepare('SELECT count(*) n FROM graph_ops').get()]);
    const before = snap();
    e.svc.jianying({ episode_id: e.ep, output_dir: e.out });
    e.svc.fcpxml({ episode_id: e.ep, output_dir: e.out });
    assert.equal(snap(), before);
  });

  it('本模块用到的所有 EXPORT_* 错误码都在统一错误码表里，且有中文文案', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'export', 'mediaExport.js'), 'utf8');
    const codes = new Set([...src.matchAll(/'(EXPORT_[A-Z_]+)'/g)].map((m) => m[1]));
    assert.ok(codes.size >= 6);
    for (const c of codes) { assert.ok(ENTRIES[c], c); assert.match(ENTRIES[c].message, /[一-龥]/); }
    assert.ok(ENTRIES.EXPORT_ASSETS);
  });
});

describe('REST /export/jianying 与 /export/fcpxml', () => {
  it('成功、校验失败、缺素材的状态码与错误码；没有渲染核心时照样可用', async () => {
    const e = makeEnv(sampleRainNight());
    const log = { info() {}, warn() {}, error() {} };
    const app = express();
    app.use(express.json());
    const h = exportRoutes(e.db, null, log, e.svc);
    app.post('/export/jianying', h.jianying);
    app.post('/export/fcpxml', h.fcpxml);
    const bare = express();
    bare.use(express.json());
    const h2 = exportRoutes(e.db, null, log, null);
    bare.post('/export/jianying', h2.jianying);
    const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const srv2 = await new Promise((r) => { const x = bare.listen(0, '127.0.0.1', () => r(x)); });
    const post = async (s, p, body) => { const r = await fetch(`http://127.0.0.1:${s.address().port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    try {
      let r = await post(srv, '/export/jianying', { episode_id: e.ep, output_dir: e.out, preset: 'shipinhao-3x4' });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.written, true);
      assert.equal(r.body.data.height, 1440);
      assert.ok(fs.existsSync(path.join(r.body.data.output_dir, 'draft_content.json')));

      r = await post(srv, '/export/jianying', { episode_id: e.ep, output_dir: e.out });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'EXPORT_OUTPUT_EXISTS');

      r = await post(srv, '/export/fcpxml', { episode_id: e.ep, output_dir: e.out, dry_run: true });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.format, 'xmeml');
      assert.equal(r.body.data.written, false);

      r = await post(srv, '/export/fcpxml', { episode_id: 424242, output_dir: e.out });
      assert.equal(r.status, 404);
      assert.equal(r.body.error.code, 'EXPORT_NO_TIMELINE');

      fs.rmSync(path.join(e.storageRoot, 'video'), { recursive: true });
      r = await post(srv, '/export/fcpxml', { episode_id: e.ep, output_dir: e.out, name: 'other' });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'EXPORT_ASSETS');
      assert.ok(r.body.error.details.problems.length >= 4);
      for (const c of ['EXPORT_ASSETS', 'EXPORT_NO_TIMELINE', 'EXPORT_OUTPUT_EXISTS']) assert.ok(ENTRIES[c]);

      r = await post(srv2, '/export/jianying', { episode_id: 1 });
      assert.equal(r.status, 503);
    } finally { srv.close(); srv2.close(); }
  });
});
