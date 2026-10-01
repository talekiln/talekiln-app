'use strict';
// D02 真实验证：用 samples.json 的 10 个样例故事跑分镜生成，统计通过率、修复次数和用量。
// Key 只从环境变量读取：BAILIAN_API_KEY、BAILIAN_BASE_URL。
// 用法：node scripts/storyboard-live.js [--model qwen-plus] [--only gf-01,ke-02] [--record]
//   --record 把模型原始输出存到 test/fixtures/scriptgen/recorded/，供离线测试回放。
const fs = require('fs');
const path = require('path');
const { createProviders } = require('../src/providers');
const { generateStoryboard } = require('../src/scriptgen');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const apiKey = process.env.BAILIAN_API_KEY;
if (!apiKey) { console.error('缺少 BAILIAN_API_KEY'); process.exit(2); }
const providers = createProviders({ bailian: { apiKey, baseUrl: process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com' } });
const model = opt('model', 'qwen-plus');
const only = opt('only') ? new Set(opt('only').split(',')) : null;
const record = args.includes('--record');
const fxDir = path.join(__dirname, '..', 'test', 'fixtures', 'scriptgen');
const samples = JSON.parse(fs.readFileSync(path.join(fxDir, 'samples.json'), 'utf8')).filter((s) => !only || only.has(s.id));

(async () => {
  const rows = [];
  const total = {};
  await Promise.all(samples.map(async (s) => {
    const raw = [];
    let attemptText = '';
    const t0 = Date.now();
    try {
      const r = await generateStoryboard(providers, {
        provider: 'bailian', model, ...s,
        onEvent: (ev) => {
          if (ev.type === 'attempt') { if (attemptText) raw.push(attemptText); attemptText = ''; }
          if (ev.type === 'delta') attemptText += ev.text;
        },
      });
      raw.push(attemptText);
      for (const k in r.usage) total[k] = (total[k] || 0) + r.usage[k];
      rows.push({ id: s.id, ok: true, attempts: r.attempts, shots: r.storyboard.shots.length, sec: r.storyboard.totalDurationSec, target: s.durationSec, ms: Date.now() - t0, firstErrors: r.errors[0] });
    } catch (e) {
      raw.push(attemptText);
      for (const k in e.usage || {}) total[k] = (total[k] || 0) + e.usage[k];
      rows.push({ id: s.id, ok: false, code: e.code, errors: e.errors || [e.message], ms: Date.now() - t0 });
    }
    if (record) {
      fs.mkdirSync(path.join(fxDir, 'recorded'), { recursive: true });
      fs.writeFileSync(path.join(fxDir, 'recorded', `${s.id}.json`), JSON.stringify({ sampleId: s.id, model, attempts: raw }, null, 2));
    }
  }));
  rows.sort((a, b) => a.id.localeCompare(b.id));
  for (const r of rows) {
    console.log(r.ok
      ? `✓ ${r.id} 第 ${r.attempts} 次通过 ${r.shots} 镜 ${r.sec}/${r.target} 秒 ${r.ms}ms${r.attempts > 1 ? ' 首次问题：' + r.firstErrors.join('；') : ''}`
      : `✗ ${r.id} ${r.code} ${JSON.stringify(r.errors)}`);
  }
  console.log(`通过 ${rows.filter((r) => r.ok).length}/${rows.length}，模型 ${model}，用量 ${JSON.stringify(total)}`);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
})();
