'use strict';
// P3-C 人脸级一致性（src/consistency/face.js）：
//   纯函数（YuNet 解码、NMS、相似变换、仿射采样、余弦、分数映射、模型目录解析）用合成数据单测，不依赖模型；
//   服务侧的合成规则 combineWithFace 同样纯测；
//   真模型集成测试需要模型文件（node scripts/fetch-face-models.mjs 或 TALEKILN_MODELS_DIR）与能下到的公有领域人像（白宫官方照片，
//   固定 sha256，缓存在系统临时目录），缺任一则跳过并说明原因。不提交任何照片。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const face = require('../src/consistency/face');
const { combineWithFace } = require('../src/consistency');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b} (±${eps})`);

describe('纯函数', () => {
  it('letterboxSize：等比缩到长边 640，另一边按比例', () => {
    assert.deepEqual(face.letterboxSize(1280, 720), { scale: 0.5, width: 640, height: 360 });
    assert.deepEqual(face.letterboxSize(300, 600), { scale: 640 / 600, width: 320, height: 640 });
    assert.equal(face.letterboxSize(0, 0).width, 1);
  });

  it('decodeYuNet：按 OpenCV face_detect.cpp 的公式解码三个步长；分数 = sqrt(clamp(cls)·clamp(obj))，低于阈值丢弃', () => {
    const outputs = {};
    for (const s of face.STRIDES) {
      const n = (face.DET_SIZE / s) ** 2;
      outputs[`cls_${s}`] = new Float32Array(n);
      outputs[`obj_${s}`] = new Float32Array(n);
      outputs[`bbox_${s}`] = new Float32Array(n * 4);
      outputs[`kps_${s}`] = new Float32Array(n * 10);
    }
    // 步长 8，格点 r=3 c=5：cls 0.81 obj 1 -> 0.9；bbox [0.5, 0.25, ln4, ln2] -> 中心 (44, 26)，宽高 (32, 16)；关键点全 0.5
    let idx = 3 * 80 + 5;
    outputs.cls_8[idx] = 0.81; outputs.obj_8[idx] = 1;
    outputs.bbox_8.set([0.5, 0.25, Math.log(4), Math.log(2)], idx * 4);
    outputs.kps_8.fill(0.5, idx * 10, idx * 10 + 10);
    // 步长 16，格点 (0,0)：0.3·0.3 -> 0.3 < 0.7 丢弃
    outputs.cls_16[0] = 0.3; outputs.obj_16[0] = 0.3;
    // 步长 32，格点 r=1 c=1：cls 2 截到 1，obj 0.64 -> 0.8；bbox 全 0 -> 中心 (32,32) 宽高 (32,32)
    idx = 1 * 20 + 1;
    outputs.cls_32[idx] = 2; outputs.obj_32[idx] = 0.64;
    const faces = face.decodeYuNet(outputs, { scoreThreshold: 0.7 });
    assert.equal(faces.length, 2);
    const [a, b] = faces;
    close(a.score, 0.9); close(a.x, 28); close(a.y, 18); close(a.w, 32); close(a.h, 16);
    assert.equal(a.landmarks.length, 5);
    for (const [x, y] of a.landmarks) { close(x, 44); close(y, 28); }
    close(b.score, 0.8); close(b.x, 16); close(b.y, 16); close(b.w, 32); close(b.h, 32);
    for (const [x, y] of b.landmarks) { close(x, 32); close(y, 32); }
    assert.equal(face.decodeYuNet(outputs, { scoreThreshold: 0.95 }).length, 0);
    assert.throws(() => face.decodeYuNet({}), /stride 8 missing/);
  });

  it('nms：重叠框只留分高的；topK 截断', () => {
    const A = { x: 0, y: 0, w: 10, h: 10, score: 0.9 };
    const B = { x: 1, y: 1, w: 10, h: 10, score: 0.8 }; // 与 A 的 IoU ≈ 0.68
    const C = { x: 50, y: 50, w: 10, h: 10, score: 0.7 };
    assert.deepEqual(face.nms([B, C, A]), [A, C]);
    assert.deepEqual(face.nms([B, C, A], { topK: 1 }), [A]);
    close(face.iou(A, B), 81 / 119);
    assert.equal(face.iou(A, C), 0);
  });

  it('similarityTransform：还原已知的旋转 + 等比缩放 + 平移；标准点映到自身是恒等', () => {
    const a = 2 * Math.cos(Math.PI / 6);
    const b = 2 * Math.sin(Math.PI / 6);
    const tx = 10;
    const ty = -5;
    const src = [[0, 0], [10, 0], [0, 10], [10, 10], [5, 3]];
    const dst = src.map(([x, y]) => [a * x - b * y + tx, b * x + a * y + ty]);
    const M = face.similarityTransform(src, dst);
    close(M[0], a, 1e-9); close(M[1], b, 1e-9); close(M[2], tx, 1e-9); close(M[3], ty, 1e-9);
    const I = face.similarityTransform(face.ARCFACE_DST);
    close(I[0], 1, 1e-9); close(I[1], 0, 1e-9); close(I[2], 0, 1e-9); close(I[3], 0, 1e-9);
    assert.throws(() => face.similarityTransform([[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]), /degenerate/);
    assert.throws(() => face.similarityTransform([[0, 0]]), />= 2/);
  });

  it('warpAffine：恒等变换原样复制；平移把像素挪过去，越界补 0', () => {
    const w = 4;
    const h = 4;
    const data = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) data[(y * w + x) * 3 + c] = 10 + x * 40 + y * 10 + c;
    const img = { data, width: w, height: h };
    const same = face.warpAffine(img, [1, 0, 0, 0], w, h);
    assert.deepEqual([...same.data], [...data]);
    const moved = face.warpAffine(img, [1, 0, 1, 0], w, h); // dst.x = src.x + 1
    const px = (o, x, y) => [...o.data.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
    assert.deepEqual(px(moved, 1, 2), px(img, 0, 2));
    assert.deepEqual(px(moved, 3, 0), px(img, 2, 0));
    assert.deepEqual(px(moved, 0, 1), [0, 0, 0]);
    assert.throws(() => face.warpAffine(img, [0, 0, 0, 0]), /singular/);
  });

  it('cosine / faceScore：折线过 (0,0)、(min_similarity, min_score)、(1,100)，两端截断', () => {
    close(face.cosine([1, 0], [1, 0]), 1);
    close(face.cosine([1, 0], [0, 1]), 0);
    close(face.cosine(new Float32Array([3, 4]), new Float32Array([6, 8])), 1);
    assert.equal(face.cosine(null, [1]), null);
    assert.equal(face.cosine([1, 0], [1]), null);
    assert.equal(face.cosine([0, 0], [1, 0]), null);
    assert.equal(face.faceScore(0.363), 60);
    assert.equal(face.faceScore(1), 100);
    assert.equal(face.faceScore(0), 0);
    assert.equal(face.faceScore(-0.2), 0);
    assert.equal(face.faceScore(0.6815), 80);
    assert.equal(face.faceScore(0.1815), 30);
    assert.equal(face.faceScore(NaN), null);
    assert.equal(face.faceScore(0.5, { min_similarity: 0.5, min_score: 70 }), 70);
    assert.equal(face.faceScore(0.25, { min_similarity: 0.5, min_score: 70 }), 35);
  });

  it('sampleTimes 与 lycore 一致：(i + 0.5)·时长/n', () => {
    assert.deepEqual(face.sampleTimes(10, 5), [1, 3, 5, 7, 9]);
    assert.deepEqual(face.sampleTimes(4, 1), [2]);
    assert.deepEqual(face.sampleTimes(4, 0), [2]);
  });

  it('resolveModelsDir：env > 配置 > 随包目录 > resourcesPath > 开发目录（后三者取第一个存在的）', () => {
    const bundled = path.resolve('/bundle/models/face');
    const packaged = path.join(path.resolve('/res'), 'models', 'face');
    const envCfg = { env: { TALEKILN_MODELS_DIR: '/x' }, config: { consistency: { face: { models_dir: '/y' } } }, bundledDir: bundled, resourcesPath: path.resolve('/res') };
    assert.deepEqual(face.resolveModelsDir({ ...envCfg, exists: () => false }), { dir: path.resolve('/x'), source: 'env' });
    assert.deepEqual(face.resolveModelsDir({ ...envCfg, env: { TALEKILN_MODELS_DIR: '  ' }, exists: () => false }), { dir: path.resolve('/y'), source: 'config' });
    const none = { ...envCfg, env: {}, config: { consistency: { face: { models_dir: '' } } } };
    assert.deepEqual(face.resolveModelsDir({ ...none, exists: (d) => d === bundled }), { dir: bundled, source: 'bundled' });
    assert.deepEqual(face.resolveModelsDir({ ...none, exists: (d) => d === packaged }), { dir: packaged, source: 'packaged' });
    const dev = face.resolveModelsDir({ ...none, exists: () => false });
    assert.equal(dev.source, 'dev');
    assert.ok(dev.dir.endsWith(path.join('apps', 'desktop', 'resources', 'models', 'face')));
    assert.equal(face.resolveModelsDir({ env: {}, config: null, resourcesPath: undefined, exists: () => false }).source, 'dev');
  });

  it('findModelFiles：缺文件列出缺哪些；fp32 存在时优先于 int8', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'face-models-'));
    assert.deepEqual(face.findModelFiles(dir).missing, ['face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec_int8.onnx']);
    fs.writeFileSync(path.join(dir, 'face_detection_yunet_2023mar.onnx'), 'x');
    fs.writeFileSync(path.join(dir, 'face_recognition_sface_2021dec_int8.onnx'), 'x');
    let f = face.findModelFiles(dir);
    assert.deepEqual(f.missing, []);
    assert.equal(f.variant, 'int8');
    fs.writeFileSync(path.join(dir, 'face_recognition_sface_2021dec.onnx'), 'x');
    f = face.findModelFiles(dir);
    assert.equal(f.variant, 'fp32');
    assert.ok(f.recognizer.endsWith('face_recognition_sface_2021dec.onnx'));
  });

  it('引擎：onnxruntime 缺失 / 模型缺失时 available() 为 false 并说明原因，embed 抛错；配置里的阈值与线程数有校验', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'face-empty-'));
    const quiet = { warn() {}, error() {}, info() {} };
    const e1 = face.createFaceEngine({ modelsDir: empty, loadOrt: () => { throw new Error("Cannot find module 'onnxruntime-node'"); }, log: quiet });
    assert.equal(await e1.available(), false);
    assert.equal(await e1.available(), false, '结果缓存，不重复加载');
    assert.equal(e1.status().reason, 'module_missing');
    assert.match(e1.status().error, /onnxruntime-node/);
    await assert.rejects(e1.embed(Buffer.alloc(0)), /unavailable: module_missing/);
    await assert.rejects(e1.compare({ reference: 'a', target: 'b' }), /unavailable/);
    const e2 = face.createFaceEngine({ modelsDir: empty, ort: { InferenceSession: {}, Tensor: class {} }, log: quiet });
    assert.equal(await e2.available(), false);
    assert.equal(e2.status().reason, 'models_missing');
    assert.match(e2.status().error, /face_detection_yunet_2023mar\.onnx/);
    assert.equal(e2.status().models_source, 'param');
    const e3 = face.createFaceEngine({ modelsDir: empty, config: { consistency: { face: { score_threshold: 0.5, threads: 2 } } }, ort: {}, log: quiet });
    assert.deepEqual(e3.options, { score_threshold: 0.5, threads: 2 });
    assert.equal(await e3.available(), false);
    assert.equal(e3.status().reason, 'module_missing');
    const e4 = face.createFaceEngine({ modelsDir: empty, config: { consistency: { face: { score_threshold: 7, threads: 0 } } }, ort: {}, log: quiet });
    assert.deepEqual(e4.options, { score_threshold: face.DEFAULTS.score_threshold, threads: face.DEFAULTS.threads });
  });
});

describe('combineWithFace（服务侧合成规则）', () => {
  const opt = { min_score: 60, min_similarity: 0.363 };
  const cmp = (over) => ({ ref_faces: 1, target_faces: 1, matched_frames: 1, similarity: 0.751, frames: [{ t_ms: 0, faces: 1, similarity: 0.751 }], kind: 'image', took_ms: 12, ...over });

  it('参考图没脸（或没结果）-> 原分、原建议不变，parts.face 只记 ref_faces 0', () => {
    const r = combineWithFace({ score: 80, suggestion: 'ok' }, cmp({ ref_faces: 0, target_faces: 0, matched_frames: 0, similarity: null, frames: [] }), opt);
    assert.equal(r.score, 80);
    assert.equal(r.suggestion, 'ok');
    assert.equal(r.face.ref_faces, 0);
    assert.equal(r.face.score, null);
    assert.equal(r.face.similarity, null);
    const n = combineWithFace({ score: 80, suggestion: 'ok' }, null, opt);
    assert.deepEqual(n, { score: 80, suggestion: 'ok', face: null });
  });

  it('双方都有脸 -> 总分 = round(0.6·人脸分 + 0.4·原分)，建议按总分重算', () => {
    const same = combineWithFace({ score: 48, suggestion: 'check' }, cmp(), opt);
    assert.equal(same.face.score, 84.4);
    assert.equal(same.score, 70);
    assert.equal(same.suggestion, 'ok');
    assert.equal(same.face.similarity, 0.751);
    assert.equal(same.face.frames.length, 1);
    assert.equal(same.face.kind, 'image');
    assert.equal(same.face.took_ms, 12);
    const diff = combineWithFace({ score: 48, suggestion: 'check' }, cmp({ similarity: 0.106 }), opt);
    assert.equal(diff.face.score, 17.5);
    assert.equal(diff.score, 30);
    assert.equal(diff.suggestion, 'retry');
    const edge = combineWithFace({ score: 60, suggestion: 'ok' }, cmp({ similarity: 0.363 }), opt);
    assert.equal(edge.face.score, 60);
    assert.equal(edge.score, 60);
    assert.equal(edge.suggestion, 'ok');
    const strict = combineWithFace({ score: 60, suggestion: 'ok' }, cmp({ similarity: 0.363 }), { min_score: 60, min_similarity: 0.5 });
    assert.ok(strict.score < 60);
  });

  it('参考图有脸、目标没脸 -> 人脸分 0，总分 = round(0.4·原分)，建议至少 check', () => {
    const r = combineWithFace({ score: 100, suggestion: 'ok' }, cmp({ target_faces: 0, matched_frames: 0, similarity: null, frames: [{ t_ms: 0, faces: 0, similarity: null }] }), opt);
    assert.equal(r.face.score, 0);
    assert.equal(r.score, 40);
    assert.equal(r.suggestion, 'check');
    const low = combineWithFace({ score: 90, suggestion: 'ok' }, cmp({ target_faces: 0, matched_frames: 0, similarity: null }), opt);
    assert.equal(low.score, 36);
    assert.equal(low.suggestion, 'retry');
    // 有别人的脸但没匹配上也算“没脸”（matched_frames 为 0）
    const other = combineWithFace({ score: 100, suggestion: 'ok' }, cmp({ target_faces: 2, matched_frames: 0, similarity: null }), opt);
    assert.equal(other.score, 40);
    assert.equal(other.suggestion, 'check');
  });
});

describe('真模型集成（需要模型文件与测试人像；缺任一则跳过）', () => {
  const modelsDir = face.resolveModelsDir().dir;
  const pin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'face-models-pin.json'), 'utf8'));
  const cache = path.join(os.tmpdir(), 'talekiln-face-fixtures');
  const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  /** 固定哈希的人像下到临时目录（已有且哈希对就不再下）；任何一张下不到 / 哈希不对 -> null（测试跳过，不失败）。 */
  async function fixtures() {
    fs.mkdirSync(cache, { recursive: true });
    const out = {};
    for (const [name, f] of Object.entries(pin.fixtures)) {
      if (name.startsWith('_')) continue;
      const file = path.join(cache, name);
      try {
        if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === f.sha256) { out[name] = file; continue; }
        const res = await fetch(f.url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (sha256(buf) !== f.sha256) return null;
        fs.writeFileSync(file, buf);
        out[name] = file;
      } catch (_) {
        return null;
      }
    }
    return out;
  }

  it('同人相似度 > 异人相似度 > 无脸；图片与视频的 compare 字段；每帧耗时', { timeout: 180000 }, async (t) => {
    const files = face.findModelFiles(modelsDir);
    if (files.missing.length) return t.skip(`face models not installed in ${modelsDir} (missing ${files.missing.join(', ')}): run node scripts/fetch-face-models.mjs`);
    try { require('onnxruntime-node'); } catch (e) { return t.skip(`onnxruntime-node not loadable: ${e.message}`); }
    const fx = await fixtures();
    if (!fx) return t.skip('fixture photos could not be downloaded (offline?); see scripts/face-models-pin.json fixtures');

    const engine = face.createFaceEngine({ modelsDir });
    assert.equal(await engine.available(), true, JSON.stringify(engine.status()));
    assert.ok(['int8', 'fp32'].includes(engine.status().variant));
    const A = await engine.embed(fx['obama.jpg']);
    const A2 = await engine.embed(fx['obama2.jpg']);
    const B = await engine.embed(fx['biden.jpg']);
    for (const r of [A, A2, B]) {
      assert.equal(r.faces.length, 1, '每张人像恰有一张脸');
      const f = r.faces[0];
      assert.equal(f.embedding.length, face.EMB_DIM);
      assert.equal(f.landmarks.length, 5);
      assert.ok(f.score > 0.7 && f.score <= 1);
      assert.ok(f.box.x >= 0 && f.box.y >= 0 && f.box.x + f.box.w <= r.width + 1 && f.box.y + f.box.h <= r.height + 1, '框在原图坐标里');
      assert.ok(f.box.w > r.width * 0.1, '脸占画面相当比例');
    }
    const same = engine.similarity(A.faces[0].embedding, A2.faces[0].embedding);
    const diff1 = engine.similarity(A.faces[0].embedding, B.faces[0].embedding);
    const diff2 = engine.similarity(A2.faces[0].embedding, B.faces[0].embedding);
    assert.ok(same > 0.363, `同人余弦 ${same} 应高于 0.363`);
    assert.ok(diff1 < 0.363 && diff2 < 0.363, `异人余弦 ${diff1} / ${diff2} 应低于 0.363`);
    assert.ok(same > Math.max(diff1, diff2));
    close(engine.similarity(A.faces[0].embedding, A.faces[0].embedding), 1, 1e-5);

    const sharp = require('sharp');
    const blank = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 40, g: 90, b: 160 } } }).png().toBuffer();
    assert.equal((await engine.embed(blank)).faces.length, 0, '纯色图没有脸');
    const gray = await sharp(fx['obama.jpg']).greyscale().jpeg().toBuffer();
    const G = await engine.embed(gray);
    assert.equal(G.faces.length, 1, '灰度图也能检测');
    assert.ok(engine.similarity(G.faces[0].embedding, A.faces[0].embedding) > 0.363);

    // compare：图片对图片
    const c1 = await engine.compare({ reference: fx['obama.jpg'], target: fx['obama2.jpg'], sample_frames: 3 });
    assert.equal(c1.ref_faces, 1);
    assert.equal(c1.kind, 'image');
    assert.equal(c1.frames.length, 1, '图片只有一帧，不受 sample_frames 影响');
    assert.equal(c1.matched_frames, 1);
    close(c1.similarity, same, 1e-3);
    // 参考图没脸：不抽目标帧
    const blankFile = path.join(cache, 'blank.png');
    fs.writeFileSync(blankFile, blank);
    const c0 = await engine.compare({ reference: blankFile, target: fx['obama.jpg'] });
    assert.deepEqual({ ref_faces: c0.ref_faces, target_faces: c0.target_faces, similarity: c0.similarity, frames: c0.frames.length }, { ref_faces: 0, target_faces: 0, similarity: null, frames: 0 });
    // 目标没脸
    const c2 = await engine.compare({ reference: fx['obama.jpg'], target: blankFile });
    assert.equal(c2.ref_faces, 1);
    assert.equal(c2.target_faces, 0);
    assert.equal(c2.matched_frames, 0);
    assert.equal(c2.similarity, null);
    assert.equal(c2.frames[0].faces, 0);

    // 视频：ffmpeg 把人像循环成 2 秒短片（内置 mpeg4 编码器，不依赖 libx264），均匀抽 3 帧
    const ffmpeg = require('../src/utils/ffmpegPath').getFfmpegPath();
    let hasFfmpeg = true;
    try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); } catch (_) { hasFfmpeg = false; }
    let video = null;
    if (hasFfmpeg) {
      const vid = path.join(cache, 'obama2.mp4');
      execFileSync(ffmpeg, ['-y', '-v', 'error', '-loop', '1', '-i', fx['obama2.jpg'], '-t', '2', '-r', '10', '-vf', 'scale=480:-2', '-pix_fmt', 'yuv420p', '-c:v', 'mpeg4', '-q:v', '3', vid], { stdio: 'ignore' });
      video = await engine.compare({ reference: fx['obama.jpg'], target: vid, sample_frames: 3 });
      assert.equal(video.kind, 'video');
      assert.equal(video.frames.length, 3);
      assert.deepEqual(video.frames.map((f) => f.t_ms), [333, 1000, 1667]);
      assert.equal(video.matched_frames, 3);
      assert.ok(video.similarity > 0.363, `视频里的同人余弦 ${video.similarity}`);
      const other = await engine.compare({ reference: fx['biden.jpg'], target: vid, sample_frames: 2 });
      assert.ok(other.similarity < 0.363, `视频里的异人余弦 ${other.similarity}`);
    }
    t.diagnostic(`face (${engine.status().variant}, ${engine.options.threads} threads): same=${same.toFixed(3)} diff=${diff1.toFixed(3)}/${diff2.toFixed(3)}; embed ${A.took_ms}/${A2.took_ms}/${B.took_ms} ms; compare image ${c1.took_ms} ms${video ? `; video 3 frames ${video.took_ms} ms (sim ${video.similarity})` : '; ffmpeg absent, video part skipped'}`);
  });
});
