'use strict';
/**
 * P3-R 降级路径用到的 ffmpeg / ffprobe 封装：探测、截帧、拼接。
 * 可执行路径沿用 utils/ffmpegPath.js 的查找规则；`run(bin, args)` 可注入（测试里用假命令或真 ffmpeg）。
 * 参数构造（spliceArgs / frameArgs / probeArgs）是纯函数，便于测试。
 */
const { execFile } = require('child_process');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const { retimeRatio } = require('./prompt');

class FfmpegError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'FfmpegError';
    this.code = 'REGION_EDIT_FFMPEG';
    if (detail) this.detail = detail;
  }
}

const sec = (ms) => (Math.max(0, Number(ms) || 0) / 1000).toFixed(3);
const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };
/** "25/1" -> 25；"30000/1001" -> 29.97。 */
function parseRate(r) {
  if (!r || typeof r !== 'string') return null;
  const [a, b] = r.split('/').map(Number);
  if (!Number.isFinite(a) || !a) return null;
  if (b === undefined) return a;
  return Number.isFinite(b) && b ? a / b : null;
}

function probeArgs(file) {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
}
/** ffprobe JSON -> { duration_ms, width, height, fps, has_audio }。没有视频流抛错。 */
function parseProbe(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json || {};
  const streams = Array.isArray(o.streams) ? o.streams : [];
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) throw new FfmpegError('文件里没有视频流');
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 25;
  const dur = num(o.format && o.format.duration) ?? num(v.duration);
  if (!(dur > 0)) throw new FfmpegError('无法读取视频时长');
  return {
    duration_ms: Math.round(dur * 1000), width: Number(v.width) || 0, height: Number(v.height) || 0, fps,
    has_audio: streams.some((s) => s.codec_type === 'audio'),
  };
}

/** 截取某一时刻的一帧为 PNG（-ss 放在输入前：快速定位，现代 ffmpeg 仍精确到帧）。 */
function frameArgs(input, ms, output) {
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', sec(ms), '-i', input, '-frames:v', '1', '-update', '1', '-f', 'image2', '-vcodec', 'png', output];
}

/**
 * 拼接：[0, t0) 取原片 + 生成的新片段缩放到 (t1 - t0) + [t1, end) 取原片，统一到原片的尺寸与帧率后重新编码。
 * 新片段按 setpts 缩放时长（厂商按整秒出片，和入出点差一点），再按原帧率重采样、裁到精确时长。
 * 原片的音轨（若有）原样铺在整条时间线上（画面改动不碰声音）。
 */
function spliceArgs({ base, insert, output, t0_ms, t1_ms, base_ms, insert_ms, width, height, fps, has_audio }) {
  const D = Number(t1_ms) - Number(t0_ms);
  if (!(D > 0)) throw new FfmpegError('出点必须晚于入点');
  const ratio = retimeRatio(D, insert_ms);
  const common = `format=yuv420p,setsar=1,fps=${fps}`;
  const chain = [];
  const labels = [];
  if (Number(t0_ms) > 0) {
    chain.push(`[0:v]trim=end=${sec(t0_ms)},setpts=PTS-STARTPTS,${common}[h]`);
    labels.push('[h]');
  }
  chain.push(`[1:v]setpts=(PTS-STARTPTS)*${ratio.toFixed(6)},scale=${width}:${height}:flags=bicubic,${common},trim=duration=${sec(D)},setpts=PTS-STARTPTS[m]`);
  labels.push('[m]');
  if (Number(t1_ms) < Number(base_ms)) {
    chain.push(`[0:v]trim=start=${sec(t1_ms)},setpts=PTS-STARTPTS,${common}[t]`);
    labels.push('[t]');
  }
  chain.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[v]`);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', base, '-i', insert, '-filter_complex', chain.join(';'), '-map', '[v]'];
  if (has_audio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}

function defaultRun(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new FfmpegError(String(stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'ffmpeg failed', { code: err.code }));
      resolve(String(stdout));
    });
  });
}

function createFfmpeg({ ffmpegPath = null, ffprobePath = null, run = defaultRun } = {}) {
  const ffmpeg = () => ffmpegPath || getFfmpegPath();
  const ffprobe = () => ffprobePath || getFfprobePath();
  return {
    async probe(file) { return parseProbe(await run(ffprobe(), probeArgs(file))); },
    async extractFrame(file, ms, output) { await run(ffmpeg(), frameArgs(file, ms, output)); return output; },
    async splice(opts) { await run(ffmpeg(), spliceArgs(opts)); return opts.output; },
    paths: () => ({ ffmpeg: ffmpeg(), ffprobe: ffprobe() }),
  };
}

module.exports = { FfmpegError, createFfmpeg, probeArgs, parseProbe, parseRate, frameArgs, spliceArgs, defaultRun };
