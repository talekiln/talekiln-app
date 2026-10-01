'use strict';
// 导出器测试用的 3 个样例项目：全部用 packages/kernel/test 的确定性故事夹具（手写，非真实 AI 输出）加编辑构造。
const K = require('@talekiln/kernel');
const { fixtureGraph, apply } = require('../../../kernel/test/helpers');

const I = K.intents;
const rec = (g, node, extra) => apply(g, I.shot.recordGeneration(g, node, extra));

/** 每个镜头都采用视频（真实片长 = 计划时长）与旁白；返回 { g, refs }，refs 是图里出现的全部相对素材路径。 */
function adoptMedia(g, { shots = K.shotOrder(g), narration = true, video = true, noVideo = [], cuesFor = {} } = {}) {
  let cur = g;
  const refs = [];
  for (const s of shots) {
    const p = K.partsOfShot(cur, s);
    const planned = cur.nodes[s].params.duration_ms;
    if (video && !noVideo.includes(s)) {
      const ref = `video/${s}.mp4`;
      refs.push(ref);
      cur = rec(cur, p.video, { asset: { ref, hash: `hv-${s}`, kind: 'video' }, metadata: { duration_ms: planned } });
    }
    if (narration) {
      const ref = `audio/narration/${s}.mp3`;
      refs.push(ref);
      cur = rec(cur, p.narration, { asset: { ref, hash: `hn-${s}`, kind: 'audio' }, metadata: { duration_ms: Math.min(planned - 500, 2500), ...(cuesFor[s] ? { cues: cuesFor[s] } : {}) } });
    }
  }
  return { g: cur, refs };
}

/** 样例 1「雨夜」：4 镜头、整段视频、旁白、一条音乐。 */
function sampleRainNight() {
  let { g, refs } = adoptMedia(fixtureGraph());
  g = apply(g, I.timeline.addMusic(g, { id: 'mus_a', asset_ref: 'library/music/rain.mp3', start_ms: 0, duration_ms: 18000, volume: 0.4 }));
  refs = [...refs, 'library/music/rain.mp3'];
  return { name: '雨夜 样例', g, refs, fps: 30, width: 1920, height: 1080 };
}

/** 样例 2「剪辑过」：切分、裁剪、gap、转场、仅有图片的镜头、词级字幕、两条重叠音乐。 */
function sampleEdited() {
  const cues = { shot_2: [{ start_ms: 0, end_ms: 800, text: '你还是' }, { start_ms: 900, end_ms: 1500, text: '来了' }] };
  let { g, refs } = adoptMedia(fixtureGraph(), { cuesFor: cues, noVideo: ['shot_3'] });
  g = apply(g, I.timeline.splitSegment(g, 'seg_1', 2000));
  g = apply(g, I.timeline.trimSegment(g, 'seg_4', { in_ms: 500, out_ms: 4000 }));
  g = apply(g, I.timeline.moveSegment(g, 'seg_3', { gap_before_ms: 500 }));
  g = apply(g, I.timeline.setTransition(g, 'seg_2', 'fade'));
  // shot_3 没有视频，只有首帧图：时间线用图片做素材
  const p3 = K.partsOfShot(g, 'shot_3');
  g = rec(g, p3.image, { asset: { ref: 'image/shot_3.png', hash: 'hi-3', kind: 'image' } });
  refs.push('image/shot_3.png');
  g = apply(g, I.timeline.addMusic(g, { id: 'mus_a', asset_ref: 'library/music/a.mp3', start_ms: 0, duration_ms: 9000, volume: 0.5 }));
  g = apply(g, I.timeline.addMusic(g, { id: 'mus_b', asset_ref: 'library/music/b.mp3', start_ms: 8000, duration_ms: 9000, src_in_ms: 1000, volume: 1 }));
  refs.push('library/music/a.mp3', 'library/music/b.mp3');
  return { name: '剪辑过', g, refs, fps: 24, width: 1280, height: 720 };
}

/** 样例 3「特殊字符」：删一个镜头、字幕含 XML 特殊字符、无音乐、竖屏 1080×1920、素材在含中文和空格的目录下。 */
function sampleSpecial() {
  let { g, refs } = adoptMedia(fixtureGraph());
  g = apply(g, I.script.rewriteLine(g, 'line_2', { text: 'A & B <tag> "引号" \'单引号\'' }));
  g = apply(g, I.shot.deleteShot(g, 'shot_4'));
  refs = refs.filter((r) => !r.includes('shot_4'));
  return { name: '特殊 字符/名字', g, refs, fps: 30, width: 1080, height: 1920 };
}

module.exports = { sampleRainNight, sampleEdited, sampleSpecial, adoptMedia };
