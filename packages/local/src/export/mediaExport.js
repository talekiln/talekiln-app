'use strict';
// 把内核时间线投影导出到剪映草稿 / Premiere(xmeml) / FCPXML 的服务层：
// 读图（只读） -> 解析素材路径并校验 -> 纯函数导出器 -> 写入用户选的目录。不依赖渲染核心（lycore）。
const fs = require('fs');
const path = require('path');
const kernel = require('@talekiln/kernel');
const store = require('../kernel/store');
const { resolveAssetRef } = require('./resolve');
const { ExportError } = require('./service');
const ex = require('./exporters');

const FORMATS = {
  jianying: { build: ex.buildJianyingDraft, suffix: '' },
  xmeml: { build: ex.buildXmeml, suffix: '_premiere' },
  fcpxml: { build: ex.buildFcpxml, suffix: '_fcpxml' },
};
const PROBLEM_TEXT = { remote: '是网络地址，请先下载到本地', missing: '文件不存在', outside: '路径不在素材目录内', not_generated: '还没有生成素材' };

function resolveOutput(req) {
  const preset = req.preset ? ex.findPreset(req.preset) : null;
  if (req.preset && !preset) throw new ExportError(`未知的尺寸预设：${req.preset}`, 400, 'EXPORT_BAD_FORMAT');
  const width = Number(preset ? preset.width : req.width ?? 1920);
  const height = Number(preset ? preset.height : req.height ?? 1080);
  const fps = Number(preset ? preset.fps : req.fps ?? 30);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 320 || width > 7680 || height > 7680 || width % 2 || height % 2) {
    throw new ExportError('分辨率无效：宽高必须是 320–7680 之间的偶数', 400, 'EXPORT_BAD_FORMAT');
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new ExportError('帧率必须是 1–120 之间的整数', 400, 'EXPORT_BAD_FORMAT');
  return { width, height, fps };
}

function validateDir(p) {
  if (typeof p !== 'string' || !p.trim()) throw new ExportError('请填写导出文件夹', 400, 'EXPORT_BAD_OUTPUT_DIR');
  const dir = p.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(dir)) throw new ExportError('导出文件夹包含非法字符', 400, 'EXPORT_BAD_OUTPUT_DIR');
  if (!path.isAbsolute(dir) && !/^[a-zA-Z]:[\\/]/.test(dir)) throw new ExportError('导出文件夹必须是绝对路径', 400, 'EXPORT_BAD_OUTPUT_DIR');
  try {
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new ExportError('导出位置是一个文件，请填写文件夹', 400, 'EXPORT_BAD_OUTPUT_DIR');
  } catch (e) { if (e instanceof ExportError) throw e; }
  return dir;
}

function createMediaExporter(db, { storageRoot, now = () => Date.now(), exists = fs.existsSync } = {}) {
  if (!storageRoot) throw new Error('storageRoot is required');

  function episodeName(episodeId) {
    try {
      const r = db.prepare('SELECT title FROM episodes WHERE id = ?').get(episodeId);
      if (r && r.title && String(r.title).trim()) return String(r.title).trim();
    } catch (_) { /* 无 episodes 表时用默认名 */ }
    return `episode-${episodeId}`;
  }

  /** 读投影、把 asset_ref 转成本机绝对路径；返回 { view, problems }。不写任何东西。 */
  function load(episodeId) {
    if (!Number.isInteger(episodeId) || episodeId <= 0) throw new ExportError('缺少 episode_id', 400, 'BAD_REQUEST');
    let graph;
    try { graph = store.openProject(db, episodeId).graph; } catch (e) {
      if (e && e.code === 'GRAPH_NOT_FOUND') throw new ExportError('该剧集没有可导出的时间线内容', 404, 'EXPORT_NO_TIMELINE');
      throw e;
    }
    const raw = kernel.timelineView(graph);
    const video = raw.tracks.find((t) => t.kind === 'video');
    if (!video || !video.clips.length) throw new ExportError('该剧集没有可导出的时间线内容', 404, 'EXPORT_NO_TIMELINE');
    const problems = [];
    const tracks = raw.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (t.kind === 'subtitle') return { ...c };
        if (!c.asset_ref) {
          if (t.kind === 'video') problems.push({ clip_id: c.id, track: t.kind, storyboard_id: c.storyboard_id, asset_ref: null, error: 'not_generated' });
          return { ...c };
        }
        const r = resolveAssetRef(c.asset_ref, storageRoot, { exists });
        if (r.error) { problems.push({ clip_id: c.id, track: t.kind, storyboard_id: c.storyboard_id, asset_ref: c.asset_ref, error: r.error }); return { ...c }; }
        return { ...c, asset_ref: r.path };
      }),
    }));
    return { view: { ...raw, tracks }, problems };
  }

  const summary = (problems) => problems.slice(0, 5).map((p) => `${p.asset_ref || `镜头 ${p.storyboard_id ?? p.clip_id}`}（${PROBLEM_TEXT[p.error] || p.error}）`).join('；')
    + (problems.length > 5 ? `，等共 ${problems.length} 项` : '');

  /**
   * @param {'jianying'|'xmeml'|'fcpxml'} format
   * @param {object} req { episode_id, output_dir, name?, preset?|width,height,fps, overwrite?, dry_run? }
   */
  function run(format, req = {}) {
    const f = FORMATS[format];
    if (!f) throw new ExportError(`不支持的导出格式：${format}`, 400, 'EXPORT_BAD_FORMAT');
    const episodeId = Number(req.episode_id);
    const out = resolveOutput(req);
    const dir = validateDir(req.output_dir);
    const { view, problems } = load(episodeId);
    const generated = problems.filter((p) => p.error === 'not_generated');
    const bad = problems.filter((p) => p.error !== 'not_generated');
    // 缺文件优先报：这是用户最可能能直接修的
    if (bad.length) throw new ExportError(`以下素材无法导出：${summary(bad)}`, 400, 'EXPORT_ASSETS', { problems: bad });
    if (generated.length) throw new ExportError(`有 ${generated.length} 个镜头还没有生成视频或图片：${summary(generated)}`, 400, 'EXPORT_MEDIA_NOT_GENERATED', { problems: generated });

    const name = require('./exporters/paths').safeFolderName(req.name || episodeName(episodeId), `episode-${episodeId}`);
    const folder = path.join(dir, name + f.suffix);
    const nowMs = now();
    const built = f.build({ name, ...out, view, draftRoot: dir, nowMs });
    const result = {
      format, name, output_dir: folder, files: Object.keys(built.files), stats: built.stats, warnings: built.warnings,
      width: out.width, height: out.height, fps: out.fps, written: false,
    };
    if (req.dry_run) return result;

    const clash = Object.keys(built.files).filter((n) => exists(path.join(folder, n)));
    if (clash.length && req.overwrite !== true) {
      throw new ExportError(`导出位置已有同名文件：${folder}（${clash.slice(0, 3).join('、')}）。换个名字，或选择覆盖`, 409, 'EXPORT_OUTPUT_EXISTS', { folder, files: clash });
    }
    try {
      fs.mkdirSync(folder, { recursive: true });
      for (const [n, content] of Object.entries(built.files)) {
        const target = path.join(folder, n);
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, target);
      }
    } catch (e) {
      throw new ExportError(`写入导出文件失败：${e.message}`, 500, 'EXPORT_WRITE_FAILED');
    }
    result.written = true;
    return result;
  }

  return { run, load, jianying: (req) => run('jianying', req), fcpxml: (req) => run(req && req.format === 'fcpxml' ? 'fcpxml' : 'xmeml', req) };
}

module.exports = { createMediaExporter, FORMATS };
