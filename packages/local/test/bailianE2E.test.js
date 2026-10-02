'use strict';
// scripts/bailian-e2e.mjs against a local fake DashScope (HTTP + WebSocket). No network, no real key, no spend.
// Covers the orchestration: local service API, queue, shared-key fallback, spend cap abort, timeline, subtitles and (when a built
// lycore + ffmpeg exist) the final export.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { WebSocketServer } = require('ws');

const scriptPath = path.join(__dirname, '..', '..', '..', 'scripts', 'bailian-e2e.mjs');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const skip = hasFfmpeg ? false : 'ffmpeg not available (needed to make fake media)';
const KEY = ['sk', 'test', 'e2e', '1234567890abcdef'].join('-'); // assembled at runtime: no key-like literal in the repo

const board = {
  title: '雨夜古庙', logline: '书生帮女子寻玉佩',
  characters: [{ id: 'c1', name: '阿沅', appearance: '青衣女子，长发，神情清冷' }],
  scenes: [{ id: 's1', name: '古庙', description: '雨夜破庙' }],
  shots: [
    { sceneId: 's1', characterIds: ['c1'], visual: '雨夜古庙远景', camera: '远景', dialogue: { speaker: 'narrator', text: '雨下得很大，古庙里亮着一盏灯。' }, durationSec: 8, imagePrompt: '雨夜古庙，远景', videoPrompt: '镜头缓慢推近古庙' },
    { sceneId: 's1', characterIds: ['c1'], visual: '女子站在殿中', camera: '中景', dialogue: { speaker: 'c1', text: '公子，可愿帮我寻一枚玉佩？' }, durationSec: 8, imagePrompt: '青衣女子站在殿中', videoPrompt: '女子转身望向门外' },
    { sceneId: 's1', characterIds: ['c1'], visual: '两人走入山林', camera: '全景', dialogue: { speaker: 'narrator', text: '两人冒雨走进了山林。' }, durationSec: 8, imagePrompt: '两人背影走入山林', videoPrompt: '两人背影渐行渐远' },
    { sceneId: 's1', characterIds: [], visual: '玉佩特写', camera: '特写', dialogue: null, durationSec: 7, imagePrompt: '玉佩特写', videoPrompt: '玉佩微光' },
  ],
};

function makeMedia(dir) {
  const png = path.join(dir, 'img.png');
  const mp4 = path.join(dir, 'v.mp4');
  const wav = path.join(dir, 'a.wav');
  const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
  ff('-f', 'lavfi', '-i', 'color=c=0x336699:s=320x180', '-frames:v', '1', png);
  ff('-f', 'lavfi', '-i', 'color=c=0x205080:s=320x180:r=15:d=5', '-f', 'lavfi', '-i', 'sine=d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4);
  ff('-f', 'lavfi', '-i', 'sine=frequency=300:d=3', wav);
  return { png: fs.readFileSync(png), mp4: fs.readFileSync(mp4), wav: fs.readFileSync(wav) };
}

async function startMock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-ds-'));
  const media = makeMedia(dir);
  const seen = { auth: new Set(), image: [], video: [], chat: 0, tts: [], paid: 0 };
  const tasks = new Map();
  let n = 0;
  const server = http.createServer((req, res) => {
    seen.auth.add(req.headers.authorization);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') : null;
      const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      const base = `http://127.0.0.1:${server.address().port}`;
      const url = req.url.split('?')[0];
      if (url === '/compatible-mode/v1/chat/completions') {
        seen.chat++;
        res.setHeader('Content-Type', 'text/event-stream');
        const text = JSON.stringify(board);
        for (let i = 0; i < text.length; i += 200) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 200) } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      if (url === '/api/v1/services/aigc/multimodal-generation/generation') {
        seen.paid++; seen.image.push(body);
        return json({ output: { choices: [{ message: { content: [{ type: 'image', image: `${base}/files/img.png` }] } }] } });
      }
      if (url.endsWith('/video-synthesis')) {
        seen.paid++; seen.video.push({ url, body });
        const id = `task-${++n}`;
        tasks.set(id, 0);
        return json({ output: { task_id: id, task_status: 'PENDING' } });
      }
      if (url.startsWith('/api/v1/tasks/')) {
        const id = decodeURIComponent(url.split('/').pop());
        const polls = (tasks.get(id) || 0) + 1;
        tasks.set(id, polls);
        return json(polls < 2 ? { output: { task_id: id, task_status: 'RUNNING' } } : { output: { task_id: id, task_status: 'SUCCEEDED', video_url: `${base}/files/v.mp4` }, usage: { duration: 5, SR: 720 } });
      }
      if (url === '/files/img.png') { res.setHeader('Content-Type', 'image/png'); return res.end(media.png); }
      if (url === '/files/v.mp4') { res.setHeader('Content-Type', 'video/mp4'); return res.end(media.mp4); }
      res.statusCode = 404;
      return res.end('{}');
    });
  });
  const wss = new WebSocketServer({ server, path: '/api-ws/v1/inference/' });
  wss.on('connection', (ws) => {
    let text = '';
    let wordTs = false;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const taskId = m.header.task_id;
      if (m.header.action === 'run-task') {
        wordTs = !!m.payload.parameters.word_timestamp_enabled;
        ws.send(JSON.stringify({ header: { task_id: taskId, event: 'task-started' }, payload: {} }));
      } else if (m.header.action === 'continue-task') {
        text = m.payload.input.text;
      } else if (m.header.action === 'finish-task') {
        seen.paid++; seen.tts.push({ text, wordTs });
        const chars = Array.from(text);
        const words = chars.map((c, i) => ({ text: c, begin_index: i, end_index: i + 1, begin_time: 80 + i * 150, end_time: 80 + (i + 1) * 150 }));
        ws.send(JSON.stringify({ header: { task_id: taskId, event: 'result-generated' }, payload: { output: { sentence: { index: 0, words } } } }));
        ws.send(media.wav);
        ws.send(JSON.stringify({ header: { task_id: taskId, event: 'task-finished' }, payload: { usage: { characters: chars.length } } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { wss.close(); server.closeAllConnections?.(); server.close(r); }) };
}

const fast = { config: { ai_queue: { limits: { default: 3, bailian: 3 }, idle_min_ms: 30, idle_max_ms: 60, poll_min_ms: 30, poll_max_ms: 60, jitter_ratio: 0 } } };

test('fitDialogue fits narration into a 5 second shot', async () => {
  const { fitDialogue } = await import(pathToFileURL(scriptPath));
  assert.equal(fitDialogue('阿沅：雨下得很大，古庙里亮着一盏灯。灯下坐着一个人，一动不动。'), '雨下得很大，古庙里亮着一盏灯。');
  assert.equal(fitDialogue('一二三四五六七八九十一二三四五六七八九十一二三四，五六七'), '一二三四五六七八九十一二三四五六七八九十一二');
  assert.equal(fitDialogue(''), '');
});

test('without a key the script skips with a clear message (exit 0), or exits 2 with --require-key', () => {
  const env = { ...process.env };
  delete env.BAILIAN_API_KEY;
  const a = spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8' });
  assert.equal(a.status, 0);
  assert.match(a.stdout, /SKIP.*BAILIAN_API_KEY/);
  const b = spawnSync(process.execPath, [scriptPath, '--require-key'], { env, encoding: 'utf8' });
  assert.equal(b.status, 2);
});

test('full flow against a fake DashScope: every stage passes, results land on disk, key never leaks', { skip }, async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-out-'));
  const { run } = await import(pathToFileURL(scriptPath));
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let r;
  try {
    r = await run({ apiKey: KEY, baseUrl: mock.base, maxSpend: 5, outDir, pollMs: 30, appOptions: fast });
  } finally { console.log = orig; }
  const table = r.rows.map((x) => `${x.status} ${x.stage} ${x.detail}`).join('\n');
  assert.equal(r.ok, true, table);
  const exportRow = r.rows.find((x) => x.stage.startsWith('export'));
  const hasCore = !!exportRow && exportRow.status === 'PASS';
  assert.ok(['PASS', 'SKIP'].includes(exportRow.status), table);
  const coreDir = path.join(__dirname, '..', '..', 'core', 'target');
  const built = ['release', 'debug'].some((d) => fs.existsSync(path.join(coreDir, d, process.platform === 'win32' ? 'lycore.exe' : 'lycore')));
  if (built) assert.equal(exportRow.status, 'PASS', `lycore is built, export must run: ${table}`);
  for (const row of r.rows) if (!row.stage.startsWith('export')) assert.equal(row.status, 'PASS', table);

  // what went to the vendor: 3 kept shots -> 1 t2v + 2 kf2v, portrait + 2 frames (with the portrait as reference), 3 narrations with timestamps
  assert.equal(mock.seen.chat >= 1, true);
  assert.equal(mock.seen.video.length, 3);
  const t2v = mock.seen.video.filter((v) => v.body.model === 'wan2.6-t2v');
  const kf = mock.seen.video.filter((v) => v.body.model === 'wan2.2-kf2v-flash');
  assert.equal(t2v.length, 1);
  assert.equal(kf.length, 2);
  assert.ok(kf.every((v) => /\/files\/img\.png$/.test(v.body.input.first_frame_url)));
  assert.equal(mock.seen.image.length, 3);
  const withRefs = mock.seen.image.filter((b) => b.model === 'wan2.6-image');
  assert.equal(withRefs.length, 2);
  assert.ok(withRefs.every((b) => b.input.messages[0].content.filter((c) => c.image).length === 1));
  assert.equal(mock.seen.tts.length, 3);
  assert.ok(mock.seen.tts.every((x) => x.wordTs && x.text.length > 0));
  assert.deepEqual([...mock.seen.auth].filter(Boolean), [`Bearer ${KEY}`]);

  // spend is estimated from the price table and stays under the cap
  assert.ok(r.spend.spent > 0 && r.spend.spent <= 5, String(r.spend.spent));
  // downloaded results + the shipped log and result file never contain the key
  const files = fs.readdirSync(outDir);
  for (const f of ['portrait.png', 'shot1_t2v.mp4', 'shot2_kf2v.mp4', 'shot3_kf2v.mp4', 'result.json']) assert.ok(files.includes(f), files.join());
  assert.ok(files.some((f) => f.startsWith('frame_shot')) && files.some((f) => f.startsWith('narration_')));
  if (hasCore) assert.ok(files.includes('final.mp4'));
  assert.equal(logs.join('\n').includes(KEY), false);
  assert.equal(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8').includes(KEY), false);
});

test('a spend cap that is too small aborts before any paid vendor call and skips the rest', { skip }, async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cap-'));
  const { run } = await import(pathToFileURL(scriptPath));
  const orig = console.log;
  console.log = () => {};
  let r;
  try {
    r = await run({ apiKey: KEY, baseUrl: mock.base, maxSpend: 0.05, outDir, pollMs: 30, skipExport: true, appOptions: fast });
  } finally { console.log = orig; }
  assert.equal(r.ok, false);
  assert.equal(r.rows.find((x) => x.stage.startsWith('setup')).status, 'PASS');
  assert.equal(r.rows.find((x) => x.stage.startsWith('script')).status, 'PASS'); // text is not metered by the guard
  assert.equal(r.rows.find((x) => x.stage.startsWith('character')).status, 'FAIL'); // first paid stage: refused at enqueue by the spend guard
  assert.equal(r.rows.find((x) => x.stage.startsWith('video_t2v_submit')).status, 'SKIP'); // not submitted once the image stage failed
  const failed = r.rows.filter((x) => x.status === 'FAIL');
  assert.equal(failed.length, 1, JSON.stringify(r.rows));
  assert.match(failed[0].detail, /SPEND_LIMIT|花费|上限/);
  assert.ok(r.rows.filter((x) => x.status === 'SKIP').length >= 3);
  assert.equal(mock.seen.paid, 0, 'no paid vendor call may be made once the cap would be exceeded');
});
