'use strict';
const fs = require('fs');
const path = require('path');

/** Is `child` inside `root` (after resolution)? */
function inside(root, child) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Map a timeline asset_ref to a real file path.
 * Accepts: relative storage paths, "/static/<rel>", same-host "http(s)://host/static/<rel>", absolute file paths.
 * Returns { path } or { error: 'remote' | 'missing' | 'outside' }.
 */
function resolveAssetRef(ref, storageRoot, { exists = fs.existsSync } = {}) {
  const raw = String(ref || '').trim();
  let rel = null;
  if (/^https?:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch (_) { return { error: 'remote' }; }
    if (!u.pathname.startsWith('/static/')) return { error: 'remote' };
    rel = decodeURIComponent(u.pathname.slice('/static/'.length));
  } else if (/^(blob:|data:)/i.test(raw)) {
    return { error: 'remote' };
  } else if (raw.startsWith('/static/')) {
    rel = raw.slice('/static/'.length);
  } else if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    return exists(raw) ? { path: raw } : { error: 'missing' };
  } else {
    rel = raw;
  }
  const abs = path.join(storageRoot, ...rel.split(/[\\/]+/));
  if (!inside(storageRoot, abs)) return { error: 'outside' };
  return exists(abs) ? { path: abs } : { error: 'missing' };
}

/**
 * Copy of the timeline with every asset_ref turned into a real path, ready for render.start.
 * Returns { timeline, problems: [{ clip_id, track, asset_ref, error }] }.
 */
function resolveTimelineAssets(timeline, storageRoot, opts) {
  const problems = [];
  const placeholders = [];
  const tracks = timeline.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => {
      if (!c.asset_ref) {
        // Subtitle / narration / music clips may legitimately carry no asset (text-only, muted). A video clip
        // without one is an empty storyboard shot projected onto the timeline: lycore renders it as a gap scene
        // (black + silence, subtitles and narration still on top). List it so the caller can tell the user
        // which shots are black.
        if (t.kind === 'video') placeholders.push({ clip_id: c.id, track: t.kind, storyboard_id: c.storyboard_id ?? null, start_ms: c.start_ms, duration_ms: c.duration_ms });
        return { ...c };
      }
      const r = resolveAssetRef(c.asset_ref, storageRoot, opts);
      if (r.error) {
        problems.push({ clip_id: c.id, track: t.kind, asset_ref: c.asset_ref, error: r.error });
        return { ...c };
      }
      return { ...c, asset_ref: r.path };
    }),
  }));
  return { timeline: { ...timeline, tracks }, problems, placeholders };
}

const PROBLEM_TEXT = {
  remote: '是网络地址，请先下载到本地',
  missing: '文件不存在',
  outside: '路径不在素材目录内',
};

/** 条目的名字：有素材路径用路径；空镜头用「第 N 镜」（service 层补的 storyboard_number），再退到镜头 id / 片段 id。 */
function problemLabel(p) {
  if (p.asset_ref) return p.asset_ref;
  if (p.storyboard_number != null) return `第 ${p.storyboard_number} 镜`;
  if (p.storyboard_id != null) return `镜头 ${p.storyboard_id}`;
  return `片段 ${p.clip_id}`;
}

/** 空镜头黑场占位的提示；list 条目同 placeholders（service 层已补 storyboard_number）。没有则返回空串。 */
function describePlaceholders(list) {
  if (!list || !list.length) return '';
  const names = list.slice(0, 5).map(problemLabel).join('、');
  const more = list.length > 5 ? `等共 ${list.length} 个镜头` : '';
  return `${names}${more}还没有画面素材，已用黑场占位；要补上画面，请在分镜页生成后重新导出`;
}

function describeProblems(problems) {
  const shown = problems.slice(0, 5).map((p) => `${problemLabel(p)}（${PROBLEM_TEXT[p.error] || p.error}）`);
  const more = problems.length > 5 ? `，等共 ${problems.length} 项` : '';
  return `以下素材无法导出：${shown.join('；')}${more}`;
}

module.exports = { resolveAssetRef, resolveTimelineAssets, describeProblems, describePlaceholders, problemLabel, inside };
