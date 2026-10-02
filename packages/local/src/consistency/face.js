'use strict';
/**
 * P3-C 人脸级一致性：本地小模型（CPU、不联网），给角色参考图与生成结果算“是不是同一张脸”。
 *
 *   检测  YuNet（face_detection_yunet_2023mar.onnx，MIT）：输入固定 640×640、BGR 0–255（OpenCV blobFromImage 默认），
 *         图片等比缩到长边 640 后右下补黑；三个步长（8/16/32）的 anchor-free 输出按 OpenCV objdetect/face_detect.cpp 解码：
 *         score = sqrt(cls·obj)，cx = (c + bbox[0])·s，w = exp(bbox[2])·s，关键点 (kps + 格点)·s，再做贪心 NMS（IoU 0.3）。
 *   识别  SFace（face_recognition_sface_2021dec_int8.onnx，Apache-2.0；也认 fp32 文件）：按 5 个关键点
 *         （右眼、左眼、鼻尖、右嘴角、左嘴角）做相似变换对齐到 112×112 的 ArcFace 标准点（OpenCV FaceRecognizerSF::alignCrop），
 *         双线性采样、边界补 0；blobFromImage(scale 1, mean 0, swapRB) 即 RGB 0–255 直接喂；输出 128 维，比余弦相似度。
 *         OpenCV 给的同人阈值：余弦 0.363。
 *   运行  onnxruntime-node 惰性 require：模块或模型文件缺失时 available() 为 false、status() 说明原因，服务照常启动
 *         （社区版可以不带模型）。会话只建一次并缓存；所有推理经一个串行队列（CPU 单会话，几个任务同时写回也不互相挤）。
 *   模型目录  env TALEKILN_MODELS_DIR > 配置 consistency.face.models_dir > 打包 <resources>/models/face > 开发 apps/desktop/resources/models/face。
 *   输入  图片用 sharp 解码（含 EXIF 旋转，工作分辨率长边 ≤ 1280）；视频用 ffmpeg 抽帧（utils/ffmpegPath 定位），
 *         与 lycore 一样在 (i + 0.5)·时长/n 处均匀取 sample_frames 帧。
 *
 * 纯函数（decodeYuNet / nms / similarityTransform / warpAffine / faceScore / cosine / letterboxSize）都导出，便于用合成数据单测。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DET_SIZE = 640;
const STRIDES = [8, 16, 32];
const EMB_SIZE = 112;
const EMB_DIM = 128;
const WORK_MAX = 1280; // 工作分辨率上限（长边），检测与对齐都从这张图出发
const MAX_FACES = 5; // 每帧最多给前几大的脸算特征
const DEFAULTS = Object.freeze({ score_threshold: 0.7, nms_iou: 0.3, top_k: 5000, threads: Math.max(1, Math.min(4, os.cpus().length)) });
const MODEL_FILES = Object.freeze({
  detector: 'face_detection_yunet_2023mar.onnx',
  recognizer: ['face_recognition_sface_2021dec_int8.onnx', 'face_recognition_sface_2021dec.onnx'],
});
/** OpenCV FaceRecognizerSF 的 112×112 标准点：右眼、左眼、鼻尖、右嘴角、左嘴角。 */
const ARCFACE_DST = Object.freeze([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]]);
const STILL_FORMATS = ['image2', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'bmp_pipe', 'tiff_pipe', 'gif'];
const REF_CACHE_MAX = 64;

// ---------------------------------------------------------------- 纯函数

/** 等比缩放到长边 DET_SIZE 后右下补黑的尺寸与比例。 */
function letterboxSize(width, height, size = DET_SIZE) {
  const scale = size / Math.max(width, height, 1);
  return { scale, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * YuNet 输出 -> 候选脸（640 坐标系）。outputs：{ cls_8, obj_8, bbox_8, kps_8, ... } 的 Float32Array。
 * 与 OpenCV face_detect.cpp 的 postProcess 一致（NMS 另做）。
 */
function decodeYuNet(outputs, { size = DET_SIZE, scoreThreshold = DEFAULTS.score_threshold } = {}) {
  const faces = [];
  for (const s of STRIDES) {
    const cols = Math.floor(size / s);
    const rows = Math.floor(size / s);
    const cls = outputs[`cls_${s}`];
    const obj = outputs[`obj_${s}`];
    const bbox = outputs[`bbox_${s}`];
    const kps = outputs[`kps_${s}`];
    if (!cls || !obj || !bbox || !kps) throw new Error(`YuNet output for stride ${s} missing`);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const cs = Math.min(Math.max(cls[idx], 0), 1);
        const ob = Math.min(Math.max(obj[idx], 0), 1);
        const score = Math.sqrt(cs * ob);
        if (score < scoreThreshold) continue;
        const cx = (c + bbox[idx * 4]) * s;
        const cy = (r + bbox[idx * 4 + 1]) * s;
        const w = Math.exp(bbox[idx * 4 + 2]) * s;
        const h = Math.exp(bbox[idx * 4 + 3]) * s;
        const landmarks = [];
        for (let n = 0; n < 5; n++) landmarks.push([(kps[idx * 10 + 2 * n] + c) * s, (kps[idx * 10 + 2 * n + 1] + r) * s]);
        faces.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, landmarks });
      }
    }
  }
  return faces;
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** 贪心 NMS：按分数降序，IoU 超过阈值的去掉；最多保留 topK。 */
function nms(faces, { iouThreshold = DEFAULTS.nms_iou, topK = DEFAULTS.top_k } = {}) {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of sorted) {
    if (keep.length >= topK) break;
    if (keep.every((k) => iou(k, f) <= iouThreshold)) keep.push(f);
  }
  return keep;
}

/**
 * 5 点相似变换（旋转 + 等比缩放 + 平移，不含镜像）的最小二乘解：src -> dst。
 * 返回 [a, b, tx, ty]，即 M = [[a, -b, tx], [b, a, ty]]。与 OpenCV getSimilarityTransformMatrix（Umeyama）
 * 求的是同一个目标函数的唯一极小值，所以结果一致；点不共线时无退化。
 */
function similarityTransform(src, dst = ARCFACE_DST) {
  const n = src.length;
  if (n < 2 || dst.length !== n) throw new Error('similarityTransform needs >= 2 point pairs');
  let sx = 0, sy = 0, su = 0, sv = 0, sxx = 0, sxu = 0, sxv = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    sx += x; sy += y; su += u; sv += v;
    sxx += x * x + y * y;
    sxu += x * u + y * v;
    sxv += x * v - y * u;
  }
  const den = n * sxx - sx * sx - sy * sy;
  if (!(den > 1e-9)) throw new Error('similarityTransform: degenerate points');
  const a = (n * sxu - sx * su - sy * sv) / den;
  const b = (n * sxv + sy * su - sx * sv) / den;
  const tx = (su - a * sx + b * sy) / n;
  const ty = (sv - b * sx - a * sy) / n;
  return [a, b, tx, ty];
}

/**
 * 仿射变换 + 双线性采样（OpenCV warpAffine INTER_LINEAR + BORDER_CONSTANT 0 的行为）：
 * M = [a, b, tx, ty] 是 src -> dst，输出 outW×outH 的 3 通道 raw。
 */
function warpAffine(rgb, M, outW = EMB_SIZE, outH = EMB_SIZE) {
  const { data, width, height } = rgb;
  const [a, b, tx, ty] = M;
  const det = a * a + b * b;
  if (!(det > 1e-12)) throw new Error('warpAffine: singular transform');
  const out = new Uint8Array(outW * outH * 3);
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const dx = ox - tx;
      const dy = oy - ty;
      const sx = (a * dx + b * dy) / det;
      const sy = (-b * dx + a * dy) / det;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const o = (oy * outW + ox) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const p = (xx, yy) => (xx < 0 || yy < 0 || xx >= width || yy >= height ? 0 : data[(yy * width + xx) * 3 + ch]);
        const v = (1 - fy) * ((1 - fx) * p(x0, y0) + fx * p(x0 + 1, y0)) + fy * ((1 - fx) * p(x0, y0 + 1) + fx * p(x0 + 1, y0 + 1));
        out[o + ch] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

/** 单位化后的余弦相似度（与 FaceRecognizerSF::match 的 FR_COSINE 相同）。 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!(na > 0) || !(nb > 0)) return null;
  return dot / Math.sqrt(na * nb);
}

/**
 * 余弦相似度 -> 0–100 的人脸分：折线过 (0, 0)、(min_similarity, min_score)、(1, 100)，两端截断。
 * 也就是“人脸分 ≥ 阈值 ⇔ 余弦 ≥ min_similarity（默认 0.363，OpenCV 的同人线）”。
 */
function faceScore(sim, { min_similarity = 0.363, min_score = 60 } = {}) {
  if (!Number.isFinite(sim)) return null;
  const t = Math.min(Math.max(min_similarity, 0.01), 0.99);
  if (sim <= 0) return 0;
  if (sim >= 1) return 100;
  const v = sim < t ? (min_score * sim) / t : min_score + ((100 - min_score) * (sim - t)) / (1 - t);
  return Math.round(v * 10) / 10;
}

/** 与 lycore 相同的均匀取帧时刻：(i + 0.5)·时长/n。 */
const sampleTimes = (duration, n) => Array.from({ length: Math.max(1, n) }, (_, i) => ((i + 0.5) * duration) / Math.max(1, n));

/** 模型目录：显式（env / 配置）优先且不检查存在；隐式候选取第一个存在的，都不存在就报开发目录。 */
function resolveModelsDir({ env = process.env, config = null, resourcesPath = process.resourcesPath, exists = fs.existsSync } = {}) {
  const c = (config && config.consistency && config.consistency.face) || {};
  if (env.TALEKILN_MODELS_DIR) return { dir: path.resolve(env.TALEKILN_MODELS_DIR), source: 'env' };
  if (typeof c.models_dir === 'string' && c.models_dir.trim()) return { dir: path.resolve(c.models_dir), source: 'config' };
  const dev = path.join(__dirname, '..', '..', '..', '..', 'apps', 'desktop', 'resources', 'models', 'face');
  const implicit = [];
  if (resourcesPath) implicit.push({ dir: path.join(resourcesPath, 'models', 'face'), source: 'packaged' });
  implicit.push({ dir: dev, source: 'dev' });
  return implicit.find((x) => exists(x.dir)) || implicit[implicit.length - 1];
}

/** 目录里的模型文件：{ detector, recognizer, variant } 或缺哪个就报哪个。 */
function findModelFiles(dir) {
  const det = path.join(dir, MODEL_FILES.detector);
  const rec = MODEL_FILES.recognizer.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  const missing = [];
  if (!fs.existsSync(det)) missing.push(MODEL_FILES.detector);
  if (!rec) missing.push(MODEL_FILES.recognizer[0]);
  return { detector: det, recognizer: rec || null, variant: rec && /int8/.test(path.basename(rec)) ? 'int8' : rec ? 'fp32' : null, missing };
}

// ---------------------------------------------------------------- 引擎

const run = (bin, args, { maxBuffer = 64 * 1024 * 1024 } = {}) => new Promise((resolve) => {
  execFile(bin, args, { encoding: 'buffer', maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : err ? -1 : 0, stdout: stdout || Buffer.alloc(0), stderr: stderr ? stderr.toString('utf8') : '', error: err && !stderr ? err.message : null });
  });
});

/**
 * @param {object} o
 * @param {string} [o.modelsDir]       模型目录（缺省按 resolveModelsDir）
 * @param {object} [o.config]          完整配置（读 consistency.face）
 * @param {object} [o.ort]             注入的 onnxruntime 模块（测试用）；缺省惰性 require('onnxruntime-node')
 * @param {object} [o.log]
 */
function createFaceEngine({ modelsDir = null, config = null, ort: ortModule = null, log = console, ffmpegPath = null, ffprobePath = null } = {}) {
  const c = (config && config.consistency && config.consistency.face) || {};
  const opts = {
    score_threshold: Number.isFinite(Number(c.score_threshold)) && c.score_threshold > 0 && c.score_threshold < 1 ? Number(c.score_threshold) : DEFAULTS.score_threshold,
    threads: Number.isInteger(c.threads) && c.threads >= 1 && c.threads <= 64 ? c.threads : DEFAULTS.threads,
  };
  const resolved = modelsDir ? { dir: path.resolve(modelsDir), source: 'param' } : resolveModelsDir({ config });
  const state = { loaded: null, loading: null, reason: null, error: null, variant: null, files: null };
  let ort = ortModule;
  let sharp = null;
  let det = null;
  let rec = null;
  let chain = Promise.resolve();
  const refCache = new Map();
  const warn = (msg, extra) => { try { (log.warn || log.error || (() => {})).call(log, msg, extra); } catch (_) { /* ignore */ } };

  /** 串行队列：推理一个接一个跑（也把 ffmpeg 抽帧放外面并行无妨）。 */
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  async function load() {
    if (state.loaded != null) return state.loaded;
    if (state.loading) return state.loading;
    state.loading = (async () => {
      try {
        if (!ort) {
          try { ort = require('onnxruntime-node'); } catch (e) { state.reason = 'module_missing'; state.error = e && e.message; return false; }
        }
        try { sharp = require('sharp'); } catch (e) { state.reason = 'module_missing'; state.error = `sharp: ${e && e.message}`; return false; }
        const files = findModelFiles(resolved.dir);
        state.files = files;
        if (files.missing.length) { state.reason = 'models_missing'; state.error = `${resolved.dir}: ${files.missing.join(', ')}`; return false; }
        const so = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: opts.threads, logSeverityLevel: 3 };
        det = await ort.InferenceSession.create(files.detector, so);
        rec = await ort.InferenceSession.create(files.recognizer, so);
        state.variant = files.variant;
        return true;
      } catch (e) {
        state.reason = 'load_failed';
        state.error = e && e.message;
        warn('face model load failed', { dir: resolved.dir, error: state.error });
        return false;
      }
    })().then((ok) => { state.loaded = ok; state.loading = null; return ok; });
    return state.loading;
  }

  const available = () => load();
  const status = () => ({ available: state.loaded, reason: state.loaded ? null : state.reason || 'not_loaded', error: state.error, models_dir: resolved.dir, models_source: resolved.source, variant: state.variant, threads: opts.threads });

  // ---- 图像输入
  const isRaw = (x) => x && typeof x === 'object' && !Buffer.isBuffer(x) && x.data && Number.isInteger(x.width) && Number.isInteger(x.height);
  const rawSharp = (r) => sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } });

  /** 任意输入 -> 工作分辨率 raw RGB（长边 ≤ WORK_MAX）+ 原图尺寸。 */
  async function loadWorking(input) {
    if (isRaw(input)) {
      if (Math.max(input.width, input.height) <= WORK_MAX) return { rgb: input, orig: { width: input.width, height: input.height } };
      const { data, info } = await rawSharp(input).resize({ width: WORK_MAX, height: WORK_MAX, fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
      return { rgb: { data, width: info.width, height: info.height }, orig: { width: input.width, height: input.height } };
    }
    const img = sharp(input, { failOn: 'none', limitInputPixels: 1 << 28 });
    const meta = await img.metadata();
    const swap = (meta.orientation || 1) >= 5;
    const orig = { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height };
    const { data, info } = await img.rotate().removeAlpha().toColourspace('srgb').resize({ width: WORK_MAX, height: WORK_MAX, fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error(`unexpected channel count ${info.channels}`);
    return { rgb: { data, width: info.width, height: info.height }, orig };
  }

  /** 工作图 -> 640×640 BGR float 张量（右下补黑）。 */
  async function detectorInput(rgb) {
    const lb = letterboxSize(rgb.width, rgb.height);
    const { data } = await rawSharp(rgb)
      .resize(lb.width, lb.height, { fit: 'fill' })
      .extend({ top: 0, left: 0, right: DET_SIZE - lb.width, bottom: DET_SIZE - lb.height, background: { r: 0, g: 0, b: 0 } })
      .raw().toBuffer({ resolveWithObject: true });
    const n = DET_SIZE * DET_SIZE;
    const t = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { t[i] = data[i * 3 + 2]; t[n + i] = data[i * 3 + 1]; t[2 * n + i] = data[i * 3]; }
    return { tensor: new ort.Tensor('float32', t, [1, 3, DET_SIZE, DET_SIZE]), scale: lb.scale };
  }

  /** 对齐后的 112×112 RGB -> 张量（RGB 0–255，不减均值）。 */
  function recognizerInput(aligned) {
    const n = EMB_SIZE * EMB_SIZE;
    const t = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { t[i] = aligned.data[i * 3]; t[n + i] = aligned.data[i * 3 + 1]; t[2 * n + i] = aligned.data[i * 3 + 2]; }
    return new ort.Tensor('float32', t, [1, 3, EMB_SIZE, EMB_SIZE]);
  }

  /** 工作图上的脸（工作坐标）：检测 + NMS，按面积降序。 */
  async function detect(rgb) {
    const { tensor, scale } = await detectorInput(rgb);
    const out = await serial(() => det.run({ input: tensor }));
    const flat = {};
    for (const k of Object.keys(out)) flat[k] = out[k].data;
    const faces = nms(decodeYuNet(flat, { scoreThreshold: opts.score_threshold }));
    const clamp = (v, max) => Math.min(Math.max(v, 0), max);
    return faces.map((f) => {
      const x1 = clamp(f.x / scale, rgb.width);
      const y1 = clamp(f.y / scale, rgb.height);
      const x2 = clamp((f.x + f.w) / scale, rgb.width);
      const y2 = clamp((f.y + f.h) / scale, rgb.height);
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, score: f.score, landmarks: f.landmarks.map(([x, y]) => [x / scale, y / scale]) };
    }).filter((f) => f.w > 1 && f.h > 1).sort((p, q) => q.w * q.h - p.w * p.h);
  }

  async function embedFace(rgb, face) {
    const M = similarityTransform(face.landmarks);
    const aligned = warpAffine(rgb, M);
    const out = await serial(() => rec.run({ data: recognizerInput(aligned) }));
    const v = out.fc1.data;
    const emb = new Float32Array(EMB_DIM);
    let norm = 0;
    for (let i = 0; i < EMB_DIM; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < EMB_DIM; i++) emb[i] = v[i] / norm;
    return emb;
  }

  /**
   * 一张图里的脸：{ width, height, faces: [{ box: {x,y,w,h}, landmarks, score, embedding }], took_ms }，
   * 坐标按原图像素，按面积降序；最多给前 MAX_FACES 张脸算特征。模型不可用时抛错（先 available()）。
   */
  async function embed(input) {
    if (!(await load())) throw new Error(`face engine unavailable: ${state.reason}`);
    const t0 = Date.now();
    const { rgb, orig } = await loadWorking(input);
    const k = orig.width / rgb.width;
    const faces = (await detect(rgb)).slice(0, MAX_FACES);
    const out = [];
    for (const f of faces) {
      out.push({
        box: { x: f.x * k, y: f.y * k, w: f.w * k, h: f.h * k }, score: f.score,
        landmarks: f.landmarks.map(([x, y]) => [x * k, y * k]), embedding: await embedFace(rgb, f),
      });
    }
    return { width: orig.width, height: orig.height, faces: out, took_ms: Date.now() - t0 };
  }

  const similarity = (a, b) => cosine(a, b);

  /** 参考图的脸按 路径 + mtime + 大小 缓存（同一参考图会对很多版本评分）。 */
  async function embedCached(file) {
    let key = null;
    try { const st = fs.statSync(file); key = `${path.resolve(file)}|${st.mtimeMs}|${st.size}`; } catch (_) { /* 让 embed 自己报错 */ }
    if (key && refCache.has(key)) return refCache.get(key);
    const r = await embed(file);
    if (key) {
      refCache.set(key, r);
      if (refCache.size > REF_CACHE_MAX) refCache.delete(refCache.keys().next().value);
    }
    return r;
  }

  // ---- 视频抽帧
  const ffmpeg = () => ffmpegPath || require('../utils/ffmpegPath').getFfmpegPath();
  const ffprobe = () => ffprobePath || require('../utils/ffmpegPath').getFfprobePath();

  async function probe(file) {
    const r = await run(ffprobe(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=duration,format_name', '-of', 'json', file]);
    if (!r.ok) throw new Error(`ffprobe failed for ${file}: ${(r.stderr || r.error || '').trim().slice(-300)}`);
    let j;
    try { j = JSON.parse(r.stdout.toString('utf8')); } catch (e) { throw new Error(`ffprobe output invalid for ${file}`); }
    const s = (j.streams && j.streams[0]) || {};
    const f = j.format || {};
    const duration = Number(f.duration);
    const fmt = String(f.format_name || '');
    const still = !s.width || STILL_FORMATS.some((x) => fmt.split(',').includes(x)) || !(duration >= 0.2);
    return { width: Number(s.width) || 0, height: Number(s.height) || 0, duration: Number.isFinite(duration) ? duration : 0, still };
  }

  async function grabFrame(file, at, size) {
    const args = ['-hide_banner', '-v', 'error', '-nostdin'];
    if (at != null) args.push('-ss', at.toFixed(3));
    args.push('-i', file, '-an', '-sn', '-frames:v', '1', '-vf', `scale=${size.width}:${size.height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
    const r = await run(ffmpeg(), args);
    const want = size.width * size.height * 3;
    if (!r.ok || r.stdout.length < want) throw new Error(`ffmpeg could not decode ${file}${at != null ? ` at ${at.toFixed(3)}s` : ''}: ${(r.stderr || r.error || '').trim().slice(-300)}`);
    return { data: r.stdout.subarray(0, want), width: size.width, height: size.height };
  }

  /**
   * 目标 -> 要评的帧 [{ t_ms, input }]：图片一帧（sharp 读得了就直接用文件）；视频按 times（秒）或均匀 n 帧用 ffmpeg 抽。
   */
  async function sampleFrames(file, { n = 5, times = null } = {}) {
    let isImage = false;
    try { const m = await sharp(file, { failOn: 'none' }).metadata(); isImage = !!(m && m.width && m.height && (m.pages || 1) === 1); } catch (_) { isImage = false; }
    if (isImage) return { kind: 'image', frames: [{ t_ms: 0, input: file }] };
    const p = await probe(file);
    if (!p.width || !p.height) throw new Error(`no video stream in ${file}`);
    const k = Math.min(1, WORK_MAX / Math.max(p.width, p.height));
    const size = { width: Math.max(1, Math.round(p.width * k)), height: Math.max(1, Math.round(p.height * k)) };
    if (p.still) return { kind: 'image', frames: [{ t_ms: 0, input: await grabFrame(file, null, size) }] };
    const ts = Array.isArray(times) && times.length ? times.filter((t) => Number.isFinite(t) && t >= 0) : sampleTimes(p.duration, n);
    const frames = [];
    for (const t of ts) frames.push({ t_ms: Math.round(t * 1000), input: await grabFrame(file, t, size) });
    return { kind: 'video', frames };
  }

  /**
   * 参考图（取最大的脸）对目标每帧的脸：每帧取与参考最像的那张（多角色同框时才不会拿错脸），对有脸的帧取平均。
   * 返回 { ref_faces, target_faces, matched_frames, similarity|null, frames: [{ t_ms, faces, similarity }], kind, took_ms }。
   */
  async function compare({ reference, target, sample_frames = 5, times = null }) {
    const t0 = Date.now();
    const ref = await embedCached(reference);
    const out = { ref_faces: ref.faces.length, target_faces: 0, matched_frames: 0, similarity: null, frames: [], kind: null, took_ms: 0 };
    if (!ref.faces.length) { out.took_ms = Date.now() - t0; return out; }
    const refEmb = ref.faces[0].embedding;
    const { kind, frames } = await sampleFrames(target, { n: sample_frames, times });
    out.kind = kind;
    let sum = 0;
    for (const f of frames) {
      const e = await embed(f.input);
      let best = null;
      for (const face of e.faces) { const s = similarity(refEmb, face.embedding); if (s != null && (best == null || s > best)) best = s; }
      out.frames.push({ t_ms: f.t_ms, faces: e.faces.length, similarity: best == null ? null : Math.round(best * 10000) / 10000 });
      out.target_faces += e.faces.length;
      if (best != null) { sum += best; out.matched_frames++; }
    }
    if (out.matched_frames) out.similarity = Math.round((sum / out.matched_frames) * 10000) / 10000;
    out.took_ms = Date.now() - t0;
    return out;
  }

  return { available, status, embed, similarity, compare, sampleFrames, probe, modelsDir: resolved.dir, options: opts };
}

module.exports = {
  createFaceEngine, resolveModelsDir, findModelFiles,
  decodeYuNet, nms, iou, similarityTransform, warpAffine, cosine, faceScore, letterboxSize, sampleTimes,
  DET_SIZE, EMB_SIZE, EMB_DIM, STRIDES, MODEL_FILES, ARCFACE_DST, DEFAULTS, WORK_MAX,
};
