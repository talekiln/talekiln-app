'use strict';
// 剪映（JianyingPro）草稿导出：纯函数，输入内核 timelineView 的投影，输出草稿目录里的文件内容（文件名 -> 字符串）。
//
// 重要：剪映草稿没有官方规范，格式随版本变化，6.0 起官方客户端还会加密 draft_content.json。
// 这里按社区公开逆向（pyJianYingDraft 等）的“未加密 5.x 时代”结构实现；字段含义和哪些是推测见 docs/phase2-export.md。
// 所有时间单位：草稿内部用微秒（µs），时间线投影是毫秒，换算 µs = ms * 1000。
const crypto = require('crypto');
const { toJianyingPath, baseName } = require('./paths');

const US = 1000; // 1 ms = 1000 µs
const FORMAT_NOTE = { new_version: '110.0.0', version: 360000, app_version: '5.9.0' };

/** 由种子得到稳定的大写 UUID（剪映的 id 都是大写 UUID）。同输入同输出，便于测试与重复导出比对。 */
function uuidFrom(seed) {
  const h = crypto.createHash('sha1').update(String(seed)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

const speedMaterial = (id) => ({ id, type: 'speed', mode: 0, speed: 1.0, curve_speed: null });
const canvasMaterial = (id) => ({ id, type: 'canvas_color', color: '', blur: 0.0, image: '', image_id: '', image_name: '', album_image: '', source_platform: 0, team_id: '' });
const soundChannel = (id) => ({ id, type: '', audio_channel_mapping: 0, is_config_open: false });
const vocalSeparation = (id) => ({ id, type: 'vocal_separation', choice: 0, production_path: '', removed_sounds: [], time_range: null });

function baseClip() {
  return { alpha: 1.0, flip: { horizontal: false, vertical: false }, rotation: 0.0, scale: { x: 1.0, y: 1.0 }, transform: { x: 0.0, y: 0.0 } };
}

function segmentBase(id, materialId, start, dur, extraRefs, volume) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start: start * US, duration: dur * US },
    source_timerange: null,
    speed: 1.0,
    volume,
    visible: true,
    clip: baseClip(),
    extra_material_refs: extraRefs,
    render_index: 0,
    track_render_index: 0,
    reverse: false,
    is_tone_modify: false,
    last_nonzero_volume: 1.0,
    enable_adjust: true,
    enable_color_curves: true,
    enable_color_wheels: true,
    enable_lut: true,
    keyframe_refs: [],
    common_keyframes: [],
    hdr_settings: null,
    group_id: '',
    intensifies_audio: false,
    cartoon: false,
    uniform_scale: { on: true, value: 1.0 },
  };
}

function textContent(text, style) {
  const size = Number.isFinite(style && style.size) ? style.size : 8;
  const color = parseColor(style && style.color) || [1, 1, 1];
  return JSON.stringify({
    text,
    styles: [{ fill: { content: { solid: { color } } }, range: [0, [...text].length], size, bold: false, italic: false, underline: false }],
  });
}

function parseColor(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const trackOf = (type, name, segments) => ({ id: uuidFrom(`track:${type}:${name}`), type, name, flag: 0, attribute: 0, is_default_name: true, segments });

/**
 * @param {object} input
 * @param {string} input.name           项目名（草稿名）
 * @param {number} input.width,height,fps
 * @param {object} input.view           kernel timelineView：{ duration_ms, tracks:[{kind, clips:[…]}] }，asset_ref 已是本机绝对路径
 * @param {object} [input.mediaDurations] { <绝对路径>: 毫秒 } 素材真实时长；缺省时用片段用到的最大 src_out_ms 近似
 * @param {string} [input.draftRoot]    草稿所在目录（写进 draft_meta_info.json；缺省空串，导入后剪映会自行修正）
 * @param {number} [input.nowMs]        时间戳（毫秒），测试可注入
 * @returns {{ files: Object<string,string>, stats: object, warnings: string[] }}
 */
function buildJianyingDraft(input) {
  const { name, width, height, fps, view } = input;
  const nowMs = input.nowMs ?? Date.now();
  const durations = input.mediaDurations || {};
  const warnings = [];
  const trackOfKind = (k) => (view.tracks.find((t) => t.kind === k) || { clips: [] }).clips;

  // ---- 素材去重：同一路径只建一份 material ----
  const maxUse = {};
  for (const k of ['video', 'narration', 'music']) {
    for (const c of trackOfKind(k)) if (c.asset_ref) maxUse[c.asset_ref] = Math.max(maxUse[c.asset_ref] || 0, c.src_out_ms ?? (c.src_in_ms || 0) + c.duration_ms);
  }
  const videos = [];
  const audios = [];
  const videoMat = {};
  const audioMat = {};
  const materialOf = (ref, kind) => {
    const isAudio = kind === 'audio';
    const table = isAudio ? audioMat : videoMat;
    if (table[ref]) return table[ref];
    const dur = (durations[ref] || maxUse[ref] || 0) * US;
    const id = uuidFrom(`${isAudio ? 'audio' : 'video'}:${ref}`);
    if (isAudio) {
      audios.push({ id, type: 'extract_music', path: toJianyingPath(ref), name: baseName(ref), duration: dur, category_name: 'local', check_flag: 1, wave_points: [], music_id: uuidFrom(`mid:${ref}`), app_id: 0, intensifies_path: '', is_ai_clone_tone: false, source_platform: 0, team_id: '', text_id: '', tone_type: '', video_id: '' });
    } else {
      const photo = kind === 'image';
      videos.push({ id, type: photo ? 'photo' : 'video', path: toJianyingPath(ref), material_name: baseName(ref), duration: photo ? 10800000000 : dur, width, height, has_audio: false, category_name: 'local', check_flag: 63487, crop_ratio: 'free', crop_scale: 1.0, extra_type_option: 0, freeze: null, source_platform: 0, local_material_id: uuidFrom(`lmid:${ref}`) });
    }
    table[ref] = id;
    return id;
  };

  const speeds = [];
  const canvases = [];
  const channels = [];
  const vocals = [];
  const texts = [];

  // ---- 视频轨 ----
  const videoSegs = [];
  for (const c of trackOfKind('video')) {
    if (!c.asset_ref) { warnings.push(`视频片段 ${c.id} 没有素材，已跳过`); continue; }
    const kind = c.asset_kind === 'image' ? 'image' : 'video';
    const mat = materialOf(c.asset_ref, kind);
    const sp = uuidFrom(`speed:${c.id}`); const cv = uuidFrom(`canvas:${c.id}`); const ch = uuidFrom(`chan:${c.id}`); const vs = uuidFrom(`voc:${c.id}`);
    speeds.push(speedMaterial(sp)); canvases.push(canvasMaterial(cv)); channels.push(soundChannel(ch)); vocals.push(vocalSeparation(vs));
    const seg = segmentBase(uuidFrom(`seg:${c.id}`), mat, c.start_ms, c.duration_ms, [sp, cv, ch, vs], 1.0);
    seg.source_timerange = { start: (kind === 'image' ? 0 : c.src_in_ms || 0) * US, duration: c.duration_ms * US };
    videoSegs.push(seg);
    if (c.style && c.style.transition) warnings.push(`片段 ${c.id} 的转场“${typeof c.style.transition === 'string' ? c.style.transition : c.style.transition.type || '?'}”未导出（剪映转场需要素材库资源 id，无法生成）`);
  }

  // ---- 音频轨：旁白、音乐各一条轨 ----
  const audioTrack = (kind) => {
    const segs = [];
    for (const c of trackOfKind(kind)) {
      if (!c.asset_ref) continue;
      const mat = materialOf(c.asset_ref, 'audio');
      const sp = uuidFrom(`speed:${c.id}`); const ch = uuidFrom(`chan:${c.id}`); const vs = uuidFrom(`voc:${c.id}`);
      speeds.push(speedMaterial(sp)); channels.push(soundChannel(ch)); vocals.push(vocalSeparation(vs));
      const seg = segmentBase(uuidFrom(`seg:${c.id}`), mat, c.start_ms, c.duration_ms, [sp, ch, vs], c.volume ?? 1.0);
      seg.source_timerange = { start: (c.src_in_ms || 0) * US, duration: c.duration_ms * US };
      segs.push(seg);
    }
    return segs;
  };
  const narrationSegs = audioTrack('narration');
  const musicSegs = audioTrack('music');

  // ---- 字幕轨 ----
  const textSegs = [];
  for (const c of trackOfKind('subtitle')) {
    if (!c.text) continue;
    const tid = uuidFrom(`text:${c.id}`);
    const style = c.style || {};
    texts.push({
      id: tid, type: 'subtitle', content: textContent(c.text, style), font_size: Number.isFinite(style.size) ? style.size : 8,
      text_color: '#ffffff', alignment: 1, line_spacing: 0.02, letter_spacing: 0.0, add_type: 0, check_flag: 7, font_path: '', font_name: '', words: { text: [], start_time: [], end_time: [] },
    });
    const seg = segmentBase(uuidFrom(`seg:${c.id}`), tid, c.start_ms, c.duration_ms, [], 1.0);
    seg.clip.transform = { x: 0.0, y: -0.8 }; // 画面下方；坐标约定为推测
    textSegs.push(seg);
  }

  const tracks = [];
  if (videoSegs.length) tracks.push(trackOf('video', 'video', videoSegs));
  if (narrationSegs.length) tracks.push(trackOf('audio', 'narration', narrationSegs));
  if (musicSegs.length) tracks.push(trackOf('audio', 'music', musicSegs));
  if (textSegs.length) tracks.push(trackOf('text', 'subtitle', textSegs));
  // render_index：字幕在最上层（剪映文本层的惯用值 14000，推测），其余 0；track_render_index 为轨道序号
  tracks.forEach((t, i) => t.segments.forEach((s) => { s.track_render_index = i; s.render_index = t.type === 'text' ? 14000 : 0; }));

  let total = 0;
  for (const t of tracks) for (const s of t.segments) total = Math.max(total, s.target_timerange.start + s.target_timerange.duration);

  const draftId = uuidFrom(`draft:${name}:${total}:${width}x${height}`);
  const content = {
    id: draftId,
    name: '',
    fps: Number(fps),
    duration: total,
    canvas_config: { width, height, ratio: 'original' },
    color_space: 0,
    config: { adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null, extract_audio_last_index: 1, lyrics_recognition_id: '', lyrics_sync: true, lyrics_taskinfo: [], maintrack_adsorb: true, material_save_mode: 0, multi_language_current: 'none', multi_language_list: [], multi_language_main: 'none', multi_language_mode: 'none', original_sound_last_index: 1, record_audio_last_index: 1, sticker_max_index: 1, subtitle_keywords_config: null, subtitle_recognition_id: '', subtitle_sync: true, subtitle_taskinfo: [], system_font_list: [], video_mute: false, zoom_info_params: null },
    create_time: 0,
    update_time: 0,
    extra_info: null,
    keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: { app_id: 3704, app_source: 'lv', app_version: FORMAT_NOTE.app_version, device_id: '', hard_disk_id: '', mac_address: '', os: 'windows', os_version: '' },
    platform: { app_id: 3704, app_source: 'lv', app_version: FORMAT_NOTE.app_version, device_id: '', hard_disk_id: '', mac_address: '', os: 'windows', os_version: '' },
    materials: {
      audio_balances: [], audio_effects: [], audio_fades: [], audio_track_indexes: [], audios, beats: [], canvases, chromas: [], color_curves: [], digital_humans: [], drafts: [], effects: [], flowers: [], green_screens: [], handwrites: [], hsl: [], images: [], log_color_wheels: [], loudnesses: [], manual_deformations: [], material_animations: [], material_colors: [], multi_language_refs: [], placeholder_infos: [], placeholders: [], plugin_effects: [], primary_color_wheels: [], realtime_denoises: [], shapes: [], smart_crops: [], smart_relights: [], sound_channel_mappings: channels, speeds, stickers: [], tail_leaders: [], text_templates: [], texts, time_marks: [], transitions: [], video_effects: [], video_trackings: [], videos, vocal_beautifys: [], vocal_separations: vocals,
    },
    mutable_config: null,
    new_version: FORMAT_NOTE.new_version,
    relationships: [],
    render_index_track_mode_on: true,
    retouch_cover: null,
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks,
    version: FORMAT_NOTE.version,
  };

  const metaMaterials = [
    ...videos.map((m) => ({ create_time: Math.floor(nowMs / 1000), duration: m.duration, extra_info: m.material_name, file_Path: m.path, height: height, id: m.id, import_time: Math.floor(nowMs / 1000), import_time_ms: -1, item_source: 1, md5: '', metetype: m.type === 'photo' ? 'photo' : 'video', roughcut_time_range: { duration: m.duration, start: 0 }, sub_time_range: { duration: -1, start: -1 }, type: 0, width: width })),
    ...audios.map((m) => ({ create_time: Math.floor(nowMs / 1000), duration: m.duration, extra_info: m.name, file_Path: m.path, height: 0, id: m.id, import_time: Math.floor(nowMs / 1000), import_time_ms: -1, item_source: 1, md5: '', metetype: 'music', roughcut_time_range: { duration: m.duration, start: 0 }, sub_time_range: { duration: -1, start: -1 }, type: 0, width: 0 })),
  ];
  const meta = {
    draft_id: draftId,
    draft_name: name,
    draft_root_path: input.draftRoot || '',
    draft_fold_path: input.draftRoot ? `${toJianyingPath(input.draftRoot)}/${name}` : '',
    draft_cover: 'draft_cover.jpg',
    draft_is_article_video_draft: false,
    draft_is_from_deeplink: 'false',
    draft_removable_storage_device: '',
    draft_timeline_materials_size_: 0,
    draft_type: '',
    tm_draft_create: nowMs * US,
    tm_draft_modified: nowMs * US,
    tm_draft_removed: 0,
    tm_duration: total,
    draft_materials: [{ type: 0, value: metaMaterials }, { type: 1, value: [] }, { type: 2, value: [] }, { type: 3, value: [] }, { type: 6, value: [] }, { type: 7, value: [] }, { type: 8, value: [] }],
    draft_new_version: '',
    draft_enterprise_info: { draft_enterprise_extra: '', draft_enterprise_id: '', draft_enterprise_name: '', enterprise_material: [] },
  };

  const files = {
    'draft_content.json': JSON.stringify(content),
    'draft_meta_info.json': JSON.stringify(meta),
    'draft_virtual_store.json': JSON.stringify({ draft_materials: [], draft_virtual_store: [{ type: 0, value: [{ creation_time: 0, display_name: '', filter_type: 0, id: '', import_time: 0, import_time_us: 0, sort_sub_type: 0, sort_type: 0, subdraft_filter_type: 0 }] }, { type: 1, value: [] }, { type: 2, value: [] }] }),
    'draft_agency_config.json': JSON.stringify({ marterials: null, use_converter: false, video_resolution: 720 }),
    'key_value.json': '{}',
    'timeline_layout.json': JSON.stringify({ dockItems: [], layoutOrientation: 1 }),
  };

  return {
    files,
    stats: {
      duration_us: total,
      video_segments: videoSegs.length,
      narration_segments: narrationSegs.length,
      music_segments: musicSegs.length,
      subtitle_segments: textSegs.length,
      track_count: tracks.length,
      materials: videos.length + audios.length,
    },
    warnings,
  };
}

module.exports = { buildJianyingDraft, uuidFrom, US };
