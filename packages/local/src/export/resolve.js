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
  const tracks = timeline.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => {
      if (!c.asset_ref) return { ...c };
      const r = resolveAssetRef(c.asset_ref, storageRoot, opts);
      if (r.error) {
        problems.push({ clip_id: c.id, track: t.kind, asset_ref: c.asset_ref, error: r.error });
        return { ...c };
      }
      return { ...c, asset_ref: r.path };
    }),
  }));
  return { timeline: { ...timeline, tracks }, problems };
}

const PROBLEM_TEXT = { remote: '是网络地址，请先下载到本地', missing: '文件不存在', outside: '路径不在素材目录内' };

function describeProblems(problems) {
  const shown = problems.slice(0, 5).map((p) => `${p.asset_ref}（${PROBLEM_TEXT[p.error] || p.error}）`);
  const more = problems.length > 5 ? `，等共 ${problems.length} 项` : '';
  return `以下素材无法导出：${shown.join('；')}${more}`;
}

module.exports = { resolveAssetRef, resolveTimelineAssets, describeProblems, inside };
