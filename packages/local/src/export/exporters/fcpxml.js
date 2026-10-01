'use strict';
// FCPXML 1.9（Final Cut Pro / DaVinci Resolve 导入）。纯函数。Premiere 请用 xmeml（见 xmeml.js 顶部说明）。
// 结构：spine 里放一个覆盖全长的 gap，所有素材作为 gap 的“连接片段”（lane 1 视频，lane -1 旁白，lane -2 音乐）。
// gap 的 start=0，所以连接片段的 offset 就是序列时间，不用换算父片段时间。
// 时间：有理数秒 "<帧数>/<fps>s"。
const { toFileUrl, baseName, safeFolderName } = require('./paths');
const { xmlEscape: x, frameSpan, mediaFrames, maxUseOf, buildSrt } = require('./common');

function buildFcpxml(input) {
  const { name, width, height, view } = input;
  const fps = Number(input.fps);
  const durations = input.mediaDurations || {};
  const maxUse = maxUseOf(view);
  const warnings = [];
  const t = (frames) => (frames === 0 ? '0s' : `${frames}/${fps}s`);

  const assets = new Map(); // path -> { id, xml }
  const assetOf = (ref, kind, fallbackMs) => {
    if (assets.has(ref)) return assets.get(ref).id;
    const id = `r${assets.size + 2}`; // r1 = format
    const frames = kind === 'image' ? 0 : mediaFrames(ref, durations, maxUse, fps, fallbackMs);
    const attrs = kind === 'audio'
      ? 'hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"'
      : `hasVideo="1" format="r1"`;
    assets.set(ref, { id, xml: `<asset id="${id}" name="${x(baseName(ref))}" uid="${id}" start="0s" duration="${t(frames)}" ${attrs} src="${x(toFileUrl(ref))}"/>` });
    return id;
  };

  const clipsOf = (k) => (view.tracks.find((tr) => tr.kind === k) || { clips: [] }).clips.filter((c) => c.asset_ref);
  const items = [];
  const connect = (c, lane, kind, volume) => {
    const span = frameSpan(c.start_ms, c.duration_ms, fps);
    const image = kind === 'image';
    const inF = image ? 0 : Math.round(((c.src_in_ms || 0) * fps) / 1000);
    const ref = assetOf(c.asset_ref, kind, c.duration_ms);
    const vol = volume !== undefined && Math.abs(volume - 1) > 1e-9
      ? `<adjust-volume amount="${(20 * Math.log10(Math.max(volume, 1e-4))).toFixed(2)}dB"/>` : '';
    if (c.style && c.style.transition) warnings.push(`片段 ${c.id} 的转场未导出`);
    items.push(`<asset-clip ref="${ref}" lane="${lane}" offset="${t(span.start)}" name="${x(baseName(c.asset_ref))}" start="${t(inF)}" duration="${t(span.duration)}"${kind === 'audio' ? '' : ' tcFormat="NDF"'}>${vol}</asset-clip>`);
  };
  clipsOf('video').forEach((c) => connect(c, 1, c.asset_kind === 'image' ? 'image' : 'video'));
  clipsOf('narration').forEach((c) => connect(c, -1, 'audio', c.volume));
  clipsOf('music').forEach((c) => connect(c, -2, 'audio', c.volume));

  const total = frameSpan(0, view.duration_ms || 1, fps).end;
  const subtitleCount = (view.tracks.find((tr) => tr.kind === 'subtitle') || { clips: [] }).clips.filter((c) => c.text).length;
  if (subtitleCount) warnings.push('字幕以 subtitles.srt 附带，没有写进 FCPXML');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.9"><resources>`
    + `<format id="r1" frameDuration="1/${fps}s" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>`
    + [...assets.values()].map((a) => a.xml).join('')
    + `</resources><library><event name="${x(name)}"><project name="${x(name)}">`
    + `<sequence format="r1" duration="${t(total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>`
    + `<gap name="Gap" offset="0s" start="0s" duration="${t(total)}">${items.join('')}</gap>`
    + '</spine></sequence></project></event></library></fcpxml>\n';

  return {
    files: { [`${safeFolderName(name, 'timeline')}.fcpxml`]: xml, 'subtitles.srt': buildSrt(view) },
    stats: {
      duration_frames: total, video_clips: clipsOf('video').length, narration_clips: clipsOf('narration').length, music_clips: clipsOf('music').length,
      subtitle_cues: subtitleCount, track_count: ['video', 'narration', 'music'].filter((k) => clipsOf(k).length).length, files: assets.size,
    },
    warnings,
  };
}

module.exports = { buildFcpxml };
