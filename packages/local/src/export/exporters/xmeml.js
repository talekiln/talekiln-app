'use strict';
// Premiere Pro 导入用的 xmeml（Final Cut Pro 7 XML，version 4）。纯函数。
// 选 xmeml 而不是 FCPXML 的理由：Premiere 的 File > Import 原生支持 xmeml（.xml），不原生支持 FCPXML（.fcpxml，需要第三方转换）。
// 时间单位：帧，timebase = 帧率（只支持整数帧率，ntsc FALSE）。
const { toFileUrl, baseName, safeFolderName } = require('./paths');
const { xmlEscape: x, frameSpan, mediaFrames, maxUseOf, buildSrt } = require('./common');

const rate = (fps) => `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;

function levelFilter(volume) {
  if (volume === undefined || volume === null || Math.abs(volume - 1) < 1e-9) return '';
  return `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>`
    + `<parameter authoringApp="PremierePro"><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${Number(volume)}</value></parameter></effect></filter>`;
}

/** 输入同 buildJianyingDraft；返回 { files:{'<name>.xml', 'subtitles.srt'}, stats, warnings }。 */
function buildXmeml(input) {
  const { name, width, height, view } = input;
  const fps = Number(input.fps);
  const durations = input.mediaDurations || {};
  const maxUse = maxUseOf(view);
  const warnings = [];
  const fileIds = new Map(); // path -> file id（首次完整定义，之后只引用）
  let clipSeq = 0;

  const fileXml = (ref, kind, fallbackMs) => {
    if (fileIds.has(ref)) return `<file id="${fileIds.get(ref)}"/>`;
    const id = `file-${fileIds.size + 1}`;
    fileIds.set(ref, id);
    const frames = kind === 'image' ? Math.round(fps * 10800) : mediaFrames(ref, durations, maxUse, fps, fallbackMs);
    const media = kind === 'audio'
      ? '<media><audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media>'
      : `<media><video><samplecharacteristics>${rate(fps)}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video></media>`;
    return `<file id="${id}"><name>${x(baseName(ref))}</name><pathurl>${x(toFileUrl(ref))}</pathurl>${rate(fps)}<duration>${frames}</duration>${media}</file>`;
  };

  const clipsOf = (k) => (view.tracks.find((t) => t.kind === k) || { clips: [] }).clips.filter((c) => c.asset_ref);

  const videoItems = clipsOf('video').map((c) => {
    const span = frameSpan(c.start_ms, c.duration_ms, fps);
    const image = c.asset_kind === 'image';
    const inF = image ? 0 : Math.round(((c.src_in_ms || 0) * fps) / 1000);
    if (c.style && c.style.transition) warnings.push(`片段 ${c.id} 的转场未导出`);
    const id = `clipitem-${++clipSeq}`;
    return `<clipitem id="${id}"><name>${x(baseName(c.asset_ref))}</name><enabled>TRUE</enabled><duration>${span.duration}</duration>${rate(fps)}`
      + `<start>${span.start}</start><end>${span.end}</end><in>${inF}</in><out>${inF + span.duration}</out>`
      + `${fileXml(c.asset_ref, image ? 'image' : 'video', c.duration_ms)}</clipitem>`;
  });

  const audioTrack = (kind) => clipsOf(kind).map((c) => {
    const span = frameSpan(c.start_ms, c.duration_ms, fps);
    const inF = Math.round(((c.src_in_ms || 0) * fps) / 1000);
    const id = `clipitem-${++clipSeq}`;
    return `<clipitem id="${id}" premiereChannelType="stereo"><name>${x(baseName(c.asset_ref))}</name><enabled>TRUE</enabled><duration>${span.duration}</duration>${rate(fps)}`
      + `<start>${span.start}</start><end>${span.end}</end><in>${inF}</in><out>${inF + span.duration}</out>`
      + `${fileXml(c.asset_ref, 'audio', c.duration_ms)}<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>${levelFilter(c.volume)}</clipitem>`;
  });

  const narr = audioTrack('narration');
  const music = audioTrack('music');
  const total = frameSpan(0, view.duration_ms || 1, fps).end;
  const subtitleCount = (view.tracks.find((t) => t.kind === 'subtitle') || { clips: [] }).clips.filter((c) => c.text).length;
  if (subtitleCount) warnings.push('字幕以 subtitles.srt 附带，没有写进 xmeml；在 Premiere 里用 文件 > 导入 载入后拖到字幕轨');

  const audioTracks = [narr, music].filter((t) => t.length)
    .map((t) => `<track>${t.join('')}</track>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="sequence-1"><name>${x(name)}</name><duration>${total}</duration>${rate(fps)}`
    + `<timecode>${rate(fps)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`
    + `<media><video><format><samplecharacteristics>${rate(fps)}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`
    + `<track>${videoItems.join('')}</track></video>`
    + `<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${audioTracks}</audio>`
    + '</media></sequence></xmeml>\n';

  return {
    files: { [`${safeFolderName(name, 'timeline')}.xml`]: xml, 'subtitles.srt': buildSrt(view) },
    stats: {
      duration_frames: total, video_clips: videoItems.length, narration_clips: narr.length, music_clips: music.length,
      subtitle_cues: subtitleCount, track_count: [videoItems, narr, music].filter((t) => t.length).length, files: fileIds.size,
    },
    warnings,
  };
}

module.exports = { buildXmeml };
