'use strict';
/**
 * 假厂商（仅 TALEKILN_FAKE_VENDOR=1 时由 server.js 装配）：给浏览器 e2e 与手工点页面用，不联网、不花钱。
 * 复用 test/batch.test.js、test/consistency.test.js、test/director.test.js 里的假实现思路：
 *   - 队列服务商 bailian：submit 立刻受理，poll 延迟约 1 秒后成功，download 落一张本地合成 PNG（视频用 ffmpeg 合成 2 秒纯色短片，没有 ffmpeg 时落占位字节）；
 *   - 配置列表：一条 dashscope 文本 / 图像 / 视频配置（假 Key），让生成 / 估价 / 批量 / 模板套用都认为“已配好厂商”；
 *   - 一致性评分器：按目标文件名哈希给 30–95 分，让分镜表 / 工作台的芯片三种颜色都能看到；
 *   - 导演模式文本模型：对任何指令都回一份“第一镜改特写”的合法计划（镜头 id 从提示词里的镜头表取），用来干跑 / 执行 / 撤销。
 * 绝不在生产装配里引用本文件。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');
const { blobPath } = require('../queue/download');
const { makeImagePng } = require('../sample/assets');

const FAKE_KEY = 'fake-key-not-real';
const FAKE_CONFIGS = [
  { id: 9001, provider: 'dashscope', api_key: FAKE_KEY, is_active: true, service_type: 'text', model: ['qwen-plus'], default_model: 'qwen-plus', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 9002, provider: 'dashscope', api_key: FAKE_KEY, is_active: true, service_type: 'image', model: ['wan2.5-t2i-preview'], default_model: 'wan2.5-t2i-preview' },
  { id: 9003, provider: 'dashscope', api_key: FAKE_KEY, is_active: true, service_type: 'video', model: ['wan2.6-t2v', 'wan2.6-i2v-flash'], default_model: 'wan2.6-i2v-flash' },
];

const hashOf = (s) => crypto.createHash('sha256').update(String(s)).digest();

/**
 * 用 ffmpeg 合成一段纯色短片；失败返回 null。优先 VP8/WebM：Playwright 自带的开源 Chromium 不带 H.264 解码器，
 * 用 H.264 的话浏览器 e2e 里播放器只会报 MEDIA_ERR_SRC_NOT_SUPPORTED；没有 libvpx 时退回 H.264 mp4。
 */
function makeVideoClip({ seconds = 2, hue = 200 } = {}) {
  const src = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${hslToHex(hue)}:s=270x480:r=12:d=${seconds}`];
  const attempts = [
    { ext: 'webm', args: ['-c:v', 'libvpx', '-b:v', '200k', '-pix_fmt', 'yuv420p'] },
    { ext: 'mp4', args: ['-pix_fmt', 'yuv420p', '-movflags', '+faststart'] },
  ];
  for (const a of attempts) {
    const out = path.join(os.tmpdir(), `talekiln-fake-${process.pid}-${Date.now()}.${a.ext}`);
    const r = spawnSync('ffmpeg', [...src, ...a.args, out], { timeout: 20000 });
    if (r.status === 0) {
      try { const buf = fs.readFileSync(out); fs.rmSync(out, { force: true }); return buf; } catch (_) { /* 下一种 */ }
    }
    fs.rmSync(out, { force: true });
  }
  return null;
}

function hslToHex(h) {
  const s = 0.6; const l = 0.5;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * 队列服务商：接口同 queue/providerAdapter（submit / poll / download）。
 * poll 在 submit 后 delayMs 内返回 running，之后 succeeded；回传用量 = 请求时长，花费与估价一致。
 */
function createFakeQueueProvider({ storageDir, delayMs = 1200 } = {}) {
  const submitted = new Map();
  return {
    async submit(task) {
      submitted.set(task.id, Date.now());
      return { vendorTaskId: `fake-${task.id}` };
    },
    async poll(task) {
      const at = submitted.get(task.id) || 0;
      if (Date.now() - at < delayMs) return { status: 'running' };
      let params = {};
      try { params = JSON.parse(task.params || '{}'); } catch (_) { /* 忽略 */ }
      const seconds = Number(params.duration) || 5;
      return task.kind === 'video'
        ? { status: 'succeeded', result: { url: `https://fake.invalid/${task.id}.mp4`, usage: { duration: seconds } } }
        : { status: 'succeeded', result: { urls: [`https://fake.invalid/${task.id}.png`] } };
    },
    async download(task, result) {
      const hue = hashOf(task.id)[0] * 360 / 256;
      let buf;
      if (task.kind === 'video') buf = makeVideoClip({ hue }) || Buffer.from(`video:${task.id}`);
      else buf = await makeImagePng({ hue, discY: 0.3 + (hashOf(task.id)[1] % 3) * 0.1 });
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const dest = blobPath(storageDir, sha256);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return { ...result, files: [{ url: result.url || result.urls[0], sha256, size: buf.length, path: path.relative(storageDir, dest).split(path.sep).join('/') }] };
    },
  };
}

/** 一致性评分器：接口同 consistency/index.js 的 scorer（available / score / pickReference）。按目标文件名哈希给分。 */
function createFakeScorer() {
  const scoreOf = (p) => 30 + (hashOf(path.basename(String(p)))[0] % 66); // 30..95
  return {
    available: async () => true,
    async score({ target, min_score = 60 }) {
      const score = scoreOf(target);
      const suggestion = score >= min_score ? 'ok' : (score < min_score - 20 ? 'retry' : 'check');
      return { score, parts: { phash: score, histogram: score, palette: score }, suggestion, kind: /\.mp4$/i.test(String(target)) ? 'video' : 'image', frames: [] };
    },
    async pickReference({ candidates, anchor = null }) {
      const ranked = candidates.map((p) => ({ path: p, score: scoreOf(p), sharpness: 1, width: 512, height: 512, similarity: anchor ? 80 : null })).sort((a, b) => b.score - a.score);
      return { anchor, ranked, skipped: [] };
    },
  };
}

/**
 * 导演模式依赖：resolveProvider 永远给一个假的百炼文本配置；createProviders 的 text.stream 回一份固定计划。
 * 计划只用 setShotField（内核已有意图），镜头 id 取提示词里镜头表的第一个 `"id": "shot_xxx"`，取不到用 shot_1。
 */
function createFakeDirectorDeps() {
  const provider = { kind: 'bailian', cfg: { bailian: { apiKey: FAKE_KEY } }, model: 'qwen-plus' };
  const facade = {
    text: {
      stream(_provider, req) {
        const joined = (req.messages || []).map((m) => String(m.content || '')).join('\n');
        const m = joined.match(/"id":\s*"(shot_[A-Za-z0-9_-]+)"/);
        const shotId = m ? m[1] : 'shot_1';
        const plan = {
          summary: `把 ${shotId} 改成特写并补一句画面描述（假厂商固定回复）`,
          steps: [{ view: 'shot', name: 'setShotField', args: { shot_id: shotId, patch: { shot_type: '特写', description: '假厂商回复：镜头改为人物面部特写，其余不变。' } }, reason: '用户要求改景别' }],
          untouched: ['其余镜头不变'],
        };
        const text = '执行计划如下：\n```json\n' + JSON.stringify(plan, null, 2) + '\n```';
        return (async function* () {
          for (let i = 0; i < text.length; i += 64) yield { type: 'delta', text: text.slice(i, i + 64) };
          yield { type: 'done', text, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
        })();
      },
    },
  };
  return { resolveProvider: () => provider, createProviders: () => facade };
}

/** server.js 用：按配置算出存储目录，组装 createApp 的注入项。 */
function fakeAppOptions(config) {
  const local = config.storage && config.storage.local_path;
  const storageDir = local ? (path.isAbsolute(local) ? local : path.join(process.cwd(), local)) : path.join(process.cwd(), 'data', 'storage');
  return {
    queueProviders: { bailian: createFakeQueueProvider({ storageDir }) },
    listConfigs: (type) => (type ? FAKE_CONFIGS.filter((c) => c.service_type === type) : FAKE_CONFIGS),
    consistencyScorer: createFakeScorer(),
    faceEngine: null,
    directorDeps: createFakeDirectorDeps(),
  };
}

module.exports = { FAKE_CONFIGS, createFakeQueueProvider, createFakeScorer, createFakeDirectorDeps, fakeAppOptions };
