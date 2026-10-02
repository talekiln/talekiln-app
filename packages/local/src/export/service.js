'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const timeline = require('../timeline');
const aigc = require('./aigc');
const { resolveTimelineAssets, describeProblems } = require('./resolve');
const { PLATFORM_PRESETS } = require('./exporters/presets');

class ExportError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST', details) {
    super(message);
    this.name = 'ExportError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const FINAL = new Set(['done', 'failed', 'cancelled']);
// encoder.detect test-encodes up to 7 candidates one after another, each with lycore's own 15 s probe timeout,
// so the RPC must be allowed far more than the client's 5 s default (seen as "timeout: encoder.detect" on a busy machine).
const ENCODER_DETECT_TIMEOUT_MS = 120 * 1000;
const ENCODER_RE = /^[a-z0-9_]{2,32}$/;
const TRACKS = ['video', 'subtitle', 'narration', 'music'];

/** Resolution presets offered by the export page; width/height are always even. */
const RESOLUTIONS = [
  { key: '1080p', label: '1080p 横屏 (1920×1080)', width: 1920, height: 1080 },
  { key: '720p', label: '720p 横屏 (1280×720)', width: 1280, height: 720 },
  { key: '1080p-v', label: '1080p 竖屏 (1080×1920)', width: 1080, height: 1920 },
  { key: '720p-v', label: '720p 竖屏 (720×1280)', width: 720, height: 1280 },
];
const FPS_OPTIONS = [24, 25, 30, 60];

/** Default "open folder" action: reveal the file in the system file manager (no shell involved). */
function systemOpener(file) {
  let cmd;
  let args;
  if (process.platform === 'win32') { cmd = 'explorer.exe'; args = [`/select,${file}`]; }
  else if (process.platform === 'darwin') { cmd = 'open'; args = ['-R', file]; }
  else { cmd = 'xdg-open'; args = [path.dirname(file)]; }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/**
 * Export (render) service. `getCore()` resolves the lycore JSON-RPC client (see packages/core/client);
 * it is injected so tests can use a fake core.
 */
function createExportService(db, {
  getCore, storageRoot, ffmpegPath = null, ffmpegDir = null, opener = systemOpener,
  runFfmpeg, now = () => Date.now(), newId = () => crypto.randomUUID(), platformHome = os.homedir(),
  onFinished = null, // P3-K：成片导出完成（含 AIGC 标识）后回调一次 { job_id, episode_id, output_path }；云备份的 after_export 挂在这里
} = {}) {
  if (typeof getCore !== 'function') throw new Error('getCore is required');
  if (!storageRoot) throw new Error('storageRoot is required');
  const jobs = new Map();
  const cacheDir = path.join(storageRoot, 'render-cache');
  const exportDir = path.join(storageRoot, 'exports');
  let encoderCache = null;

  const core = async () => {
    try { return await getCore(); } catch (e) {
      throw new ExportError('渲染核心未启动或无法连接，请重启应用后重试', 503, 'CORE_UNAVAILABLE');
    }
  };

  async function detectEncoders({ refresh = false } = {}) {
    if (!refresh && encoderCache && now() - encoderCache.at < 5 * 60 * 1000) return encoderCache.value;
    const c = await core();
    const r = await c.call('encoder.detect', {}, { timeoutMs: ENCODER_DETECT_TIMEOUT_MS });
    encoderCache = { at: now(), value: r };
    return r;
  }

  function defaults(episodeId) {
    const ts = new Date(now()).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return {
      resolutions: RESOLUTIONS,
      platform_presets: PLATFORM_PRESETS,
      fps_options: FPS_OPTIONS,
      default_resolution: '1080p',
      default_fps: 30,
      output_path: path.join(exportDir, `episode-${Number(episodeId) || 0}-${ts}.mp4`),
      aigc: aigc.getSettings(db),
    };
  }

  function validateOutputPath(p) {
    if (typeof p !== 'string' || !p.trim()) throw new ExportError('请填写导出位置');
    const out = p.trim();
    if (!path.isAbsolute(out)) throw new ExportError('导出位置必须是绝对路径');
    if (path.extname(out).toLowerCase() !== '.mp4') throw new ExportError('导出文件必须以 .mp4 结尾');
    if (/[\u0000-\u001f]/.test(out)) throw new ExportError('导出位置包含非法字符');
    try {
      if (fs.existsSync(out) && fs.statSync(out).isDirectory()) throw new ExportError('导出位置是一个文件夹，请填写文件名');
    } catch (e) { if (e instanceof ExportError) throw e; }
    return out;
  }

  /** Validate params, build the render.start request, start the job. Returns { job_id, ... }. */
  async function start(req = {}) {
    const episodeId = Number(req.episode_id);
    if (!Number.isInteger(episodeId) || episodeId <= 0) throw new ExportError('缺少 episode_id');
    const width = Number(req.width);
    const height = Number(req.height);
    const fps = Number(req.fps);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 320 || width > 7680 || height > 7680 || width % 2 || height % 2) {
      throw new ExportError('分辨率无效：宽高必须是 320–7680 之间的偶数');
    }
    if (!(fps >= 1 && fps <= 120)) throw new ExportError('帧率必须在 1–120 之间');
    const outputPath = validateOutputPath(req.output_path);

    const tl = timeline.loadTimelineByEpisode(db, episodeId);
    if (!tl) throw new ExportError('该剧集尚无时间线，请先组装时间线', 404, 'NOT_FOUND');
    const video = tl.tracks.find((t) => t.kind === 'video');
    if (!video || !video.clips.length) throw new ExportError('视频轨为空，没有可导出的内容');

    const detected = await detectEncoders();
    const usable = (detected.encoders || []).filter((e) => e.available).map((e) => e.name);
    let encoder = req.encoder == null || req.encoder === 'auto' ? detected.best : req.encoder;
    if (!encoder) throw new ExportError('没有可用的视频编码器', 500, 'NO_ENCODER');
    if (typeof encoder !== 'string' || !ENCODER_RE.test(encoder)) throw new ExportError('编码器名称无效');
    if (!usable.includes(encoder)) throw new ExportError(`编码器 ${encoder} 在本机不可用`, 400, 'ENCODER_UNAVAILABLE');

    const { timeline: resolved, problems } = resolveTimelineAssets(tl, storageRoot);
    if (problems.length) throw new ExportError(describeProblems(problems), 400, 'EXPORT_ASSETS', { problems });

    const settings = aigc.getSettings(db);
    const produceId = newId();
    const total = timeline.computeDuration(resolved);
    if (settings.watermark) {
      const sub = resolved.tracks.find((t) => t.kind === 'subtitle');
      sub.clips = [...sub.clips, ...aigc.watermarkClips(total, width, height, newId)];
    }

    const params = {
      timeline: { tracks: resolved.tracks.filter((t) => TRACKS.includes(t.kind)) },
      output: { width, height, fps, encoder },
      cacheDir,
      outputPath,
      fallbackEncoders: usable.filter((n) => n !== encoder),
      mix: tl.mix,
      ...(ffmpegDir ? { ffmpegDir } : {}),
    };
    fs.mkdirSync(cacheDir, { recursive: true });
    const c = await core();
    let started;
    try {
      started = await c.renderStart(params);
    } catch (e) {
      throw mapCoreError(e);
    }
    const job = {
      id: started.jobId, episodeId, outputPath, startedAt: now(), params: { width, height, fps, encoder },
      aigc: { watermark: settings.watermark, metadata: settings.metadata, producer: settings.producer, produceId },
      postState: 'pending', // pending -> running -> done | failed (the AIGC metadata pass)
      post: null,
      postError: null,
    };
    jobs.set(job.id, job);
    return { job_id: job.id, output_path: outputPath, encoder, aigc: { watermark: settings.watermark, metadata: settings.metadata } };
  }

  /** Runs once per job after render.status reports done. Sets job.postState to done | failed. */
  async function finishPost(job) {
    if (!job.aigc.metadata) { job.postState = 'done'; return; }
    const entries = aigc.buildMetadata({ producer: job.aigc.producer, produceId: job.aigc.produceId });
    try {
      await aigc.injectMetadata(ffmpegPath || 'ffmpeg', job.outputPath, entries, runFfmpeg ? { run: runFfmpeg } : {});
      job.postState = 'done';
    } catch (e) {
      job.postError = e.message;
      job.postState = 'failed';
      // never leave an unlabelled file behind when the user asked for the label
      try { fs.unlinkSync(job.outputPath); } catch (_) { /* already gone */ }
    }
  }

  function getJob(id) {
    const job = jobs.get(String(id));
    if (!job) throw new ExportError('导出任务不存在（应用可能已重启）', 404, 'NOT_FOUND');
    return job;
  }

  /** Poll: core status, plus the AIGC metadata pass once the render finished. */
  async function status(id) {
    const job = getJob(id);
    const c = await core();
    let s;
    try { s = await c.renderStatus(job.id); } catch (e) { throw mapCoreError(e); }
    const base = { ...s, job_id: job.id, output_path: job.outputPath, aigc: { watermark: job.aigc.watermark, metadata: job.aigc.metadata } };
    if (s.status !== 'done') return base;
    if (job.postState === 'pending') {
      job.postState = 'running';
      job.post = finishPost(job);
    }
    if (job.postState === 'running') return { ...base, status: 'running', stage: 'AI 内容标识', percent: 99.5 };
    if (job.postState === 'failed') {
      return { ...base, status: 'failed', result: null, error: { code: 'AIGC_METADATA_FAILED', message: job.postError } };
    }
    if (!job.notified) {
      job.notified = true;
      if (onFinished) { try { onFinished({ job_id: job.id, episode_id: job.episodeId, output_path: job.outputPath }); } catch (_) { /* 钩子不影响导出结果 */ } }
    }
    return base;
  }

  async function cancel(id) {
    const job = getJob(id);
    const c = await core();
    try { return await c.renderCancel(job.id); } catch (e) { throw mapCoreError(e); }
  }

  /** Reveal the exported file's folder. Only paths of known jobs can be opened. */
  function openFolder(id) {
    const job = getJob(id);
    if (!fs.existsSync(job.outputPath) && !fs.existsSync(path.dirname(job.outputPath))) throw new ExportError('导出文件夹不存在', 404, 'NOT_FOUND');
    opener(job.outputPath);
    return { opened: path.dirname(job.outputPath) };
  }

  return { start, status, cancel, openFolder, detectEncoders, defaults, FINAL };
}

/** Translate lycore RPC errors into user-facing Chinese messages. */
function mapCoreError(e) {
  if (e instanceof ExportError) return e;
  const code = e && e.code;
  const msg = (e && e.message) || String(e);
  switch (code) {
    case -32020: return new ExportError('找不到 ffmpeg，请重新安装或把 ffmpeg 放到 tools/ffmpeg 目录', 500, 'FFMPEG_MISSING');
    case -32030: return new ExportError('当前 ffmpeg 不支持字幕渲染（缺少 libass），请重新安装自带的 ffmpeg', 500, 'SUBTITLES_UNAVAILABLE');
    case -32031: return new ExportError('部分素材文件不存在，请检查时间线素材', 400, 'EXPORT_ASSETS', e.data);
    case -32032: return new ExportError('渲染失败：所有编码器都未能完成导出', 500, 'RENDER_FAILED', e.data);
    case -32602: return new ExportError(`渲染参数无效：${msg}`, 400, 'BAD_PARAMS');
    default: return new ExportError(`渲染核心调用失败：${msg}`, 502, 'CORE_ERROR');
  }
}

module.exports = { createExportService, ExportError, mapCoreError, RESOLUTIONS, FPS_OPTIONS, systemOpener };
