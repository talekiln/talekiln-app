'use strict';
// 手动真实验证：BAILIAN_API_KEY、BAILIAN_BASE_URL 来自环境变量，绝不写入仓库或日志。
// 用法：node scripts/bailian-live.js [text,image,tts,video]（默认 text,image,tts；video 会产生较高费用，需显式指定）
const { createProviders } = require('../src/providers');

const apiKey = process.env.BAILIAN_API_KEY;
if (!apiKey) { console.error('缺少 BAILIAN_API_KEY'); process.exit(2); }
const rawBase = process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com';
const baseUrl = rawBase.replace(/\/(compatible-mode\/v1|api\/v1)\/?$/, '').replace(/\/+$/, '');
const wsUrl = process.env.BAILIAN_WS_URL || baseUrl.replace(/^http/, 'ws') + '/api-ws/v1/inference/';
const want = new Set((process.argv[2] || 'text,image,tts').split(','));

const p = createProviders({ bailian: { apiKey, baseUrl, wsUrl } });
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
    for await (const ev of p.text.stream('bailian', { model: 'qwen-plus', messages: [{ role: 'user', content: '回复一个字：好' }], maxTokens: 5 })) {
      if (ev.delta) text += ev.delta; if (ev.usage) usage = ev.usage;
    }
    return { text, usage };
  });
  await step('image', () => p.image.generate('bailian', { prompt: '一只橘猫坐在窗台上，简笔画', size: '1024*1024', n: 1 }));
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
