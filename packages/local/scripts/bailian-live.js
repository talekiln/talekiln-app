'use strict';
// 手动真实验证：BAILIAN_API_KEY、BAILIAN_BASE_URL 来自环境变量，绝不写入仓库或日志。
// 用法：node scripts/bailian-live.js [text,image,tts,video]（默认 text,image,image-edit,tts,errors；video 会产生较高费用，需显式指定）
const { createProviders } = require('../src/providers');

const apiKey = process.env.BAILIAN_API_KEY;
if (!apiKey) { console.error('缺少 BAILIAN_API_KEY'); process.exit(2); }
const baseUrl = process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com';
const wsUrl = process.env.BAILIAN_WS_URL; // default: derived from baseUrl by the adapter
const want = new Set((process.argv[2] || 'text,image,image-edit,tts,errors').split(','));

const p = createProviders({ bailian: { apiKey, baseUrl, ...(wsUrl ? { wsUrl } : {}) } });
const results = [];
const short = (v) => JSON.stringify(v).slice(0, 300);

async function step(name, fn) {
  if (!want.has(name)) return;
  const t0 = Date.now();
  try {
    const out = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, out });
    console.log(`✓ ${name} ${Date.now() - t0}ms ${short(out)}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, code: e.code, message: e.message });
    console.log(`✗ ${name} code=${e.code} message=${String(e.message).slice(0, 300)} status=${e.status || ''}`);
  }
}

(async () => {
  await step('text', async () => {
    let text = ''; let usage;
    for await (const ev of p.text.stream('bailian', { model: 'qwen-flash', messages: [{ role: 'user', content: '回复一个字：好' }], maxTokens: 5 })) {
      if (ev.type === 'delta') text += ev.text; if (ev.usage) usage = ev.usage;
    }
    return { text, usage };
  });
  let imageUrl;
  await step('image', async () => {
    const r = await p.image.generate('bailian', { prompt: '一只橘猫坐在窗台上，简笔画', size: '1024*1024' });
    imageUrl = r.urls[0];
    return r;
  });
  await step('image-edit', async () => {
    if (!imageUrl) throw new Error('需要先成功生成图片');
    return p.image.generate('bailian', { prompt: '把猫改成黑色', size: '1024*1024', referenceImages: [imageUrl] });
  });
  await step('errors', async () => {
    const bad = createProviders({ bailian: { apiKey: 'sk-invalid', baseUrl } });
    const codes = {};
    try { await bad.image.generate('bailian', { prompt: 'x' }); } catch (e) { codes.imageBadKey = e.code; }
    try { await bad.tts.synthesize('bailian', { text: 'x' }); } catch (e) { codes.ttsBadKey = e.code; }
    try { await p.image.generate('bailian', { model: 'wan-nonexist-9', prompt: 'x' }); } catch (e) { codes.unknownModel = e.code; }
    try { await p.tts.synthesize('bailian', { model: 'cosyvoice-nonexist', text: 'x' }); } catch (e) { codes.ttsUnknownModel = e.code; }
    const expect = { imageBadKey: 'INVALID_API_KEY', ttsBadKey: 'INVALID_API_KEY', unknownModel: 'MODEL_NOT_ENABLED', ttsUnknownModel: 'MODEL_NOT_ENABLED' };
    if (JSON.stringify(codes) !== JSON.stringify(expect)) throw new Error('错误码不符 ' + JSON.stringify(codes));
    return codes;
  });
  await step('tts', async () => {
    const r = await p.tts.synthesize('bailian', { text: '你好，欢迎使用。' });
    return { bytes: r && (r.audio ? r.audio.length : r.byteLength || 0), format: r && r.format };
  });
  await step('video', async () => {
    const sub = await p.video.submit('bailian', { prompt: '一只橘猫在窗台上伸懒腰', duration: 2 });
    const id = sub.taskId || sub.id;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const st = await p.video.poll('bailian', { taskId: id });
      if (st.status === 'succeeded' || st.status === 'failed') return st;
    }
    return { status: 'timeout', taskId: id };
  });
  require('fs').writeFileSync('bailian-live-result.json', JSON.stringify(results, null, 2));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
