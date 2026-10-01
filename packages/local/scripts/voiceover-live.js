'use strict';
// F01 真实验证：给录制的分镜表逐镜配音，检查逐字时间戳、字幕切分和台词是否超出镜头时长。
// Key 只从环境变量读取：BAILIAN_API_KEY、BAILIAN_BASE_URL。
// 用法：node scripts/voiceover-live.js [样例 id，默认 gf-01] [--out 目录]（--out 时写出 mp3 和 srt）
const fs = require('fs');
const path = require('path');
const { createProviders } = require('../src/providers');
const { extractJson, validateStoryboard } = require('../src/scriptgen');
const { voiceShots } = require('../src/voiceover');
const { toSrt } = require('../src/subtitles');

const apiKey = process.env.BAILIAN_API_KEY;
if (!apiKey) { console.error('缺少 BAILIAN_API_KEY'); process.exit(2); }
const args = process.argv.slice(2);
const id = args[0] && !args[0].startsWith('--') ? args[0] : 'gf-01';
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
const fxDir = path.join(__dirname, '..', 'test', 'fixtures', 'scriptgen');
const rec = JSON.parse(fs.readFileSync(path.join(fxDir, 'recorded', `${id}.json`), 'utf8'));
const board = validateStoryboard(extractJson(rec.attempts.at(-1)).value).value;
const providers = createProviders({ bailian: { apiKey, baseUrl: process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com' } });
// Alternate two stock voices across characters so dialogue is distinguishable.
const stock = ['longwan_v2', 'longcheng_v2', 'longhua_v2'];
const voices = Object.fromEntries(board.characters.map((c, i) => [c.id, stock[i % stock.length]]));

(async () => {
  const t0 = Date.now();
  const res = await voiceShots(providers, { provider: 'bailian', shots: board.shots, voices, aspectRatio: '9:16' });
  let chars = 0;
  for (const r of res) {
    chars += (r.words || []).length;
    console.log(`第 ${r.shotNo} 镜 ${r.speaker}/${r.voice} ${r.durationMs}ms ${r.overrunMs ? `超出 ${r.overrunMs}ms ` : ''}字幕：${r.cues.map((c) => `[${c.startMs}-${c.endMs}]${c.text}`).join(' ')}`);
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `shot${r.shotNo}.${r.format}`), r.audio);
      fs.writeFileSync(path.join(outDir, `shot${r.shotNo}.srt`), toSrt(r.cues));
    }
  }
  console.log(`${res.length} 镜配音，约 ${chars} 字，${Date.now() - t0}ms，超时长 ${res.filter((r) => r.overrunMs).length} 镜`);
})().catch((e) => { console.error(e.code, e.message); process.exit(1); });
