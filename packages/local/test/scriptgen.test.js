'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateStoryboard, validateStoryboard, extractJson, spokenLength, listTemplates, buildMessages } = require('../src/scriptgen');

const fxDir = path.join(__dirname, 'fixtures', 'scriptgen');
const samples = JSON.parse(fs.readFileSync(path.join(fxDir, 'samples.json'), 'utf8'));
const recorded = (id) => JSON.parse(fs.readFileSync(path.join(fxDir, 'recorded', `${id}.json`), 'utf8'));

/** Fake providers facade: each text.stream call replays the next scripted reply in small chunks. */
function fakeProviders(replies) {
  const calls = [];
  return {
    calls,
    text: {
      stream(provider, req) {
        calls.push({ provider, req: { ...req, messages: req.messages.map((m) => ({ ...m })) } });
        const text = replies[calls.length - 1];
        return (async function* () {
          for (let i = 0; i < text.length; i += 50) yield { type: 'delta', text: text.slice(i, i + 50) };
          yield { type: 'done', text, usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
        })();
      },
    },
  };
}

const goodBoard = () => ({
  title: '测试', logline: '一句话',
  characters: [{ id: 'c1', name: '甲', appearance: '青衣' }],
  scenes: [{ id: 's1', name: '庙', description: '夜' }],
  shots: [5, 5, 5].map(() => ({ sceneId: 's1', characterIds: ['c1'], visual: '画面', camera: '中景', dialogue: { speaker: 'c1', text: '你好' }, durationSec: 5, imagePrompt: '提示', videoPrompt: '动作' })),
});

test('three phase-1 templates, each producing system + user messages', () => {
  assert.deepEqual(listTemplates().map((t) => t.id), ['guofeng-drama', 'product-seeding', 'knowledge-explainer']);
  const m = buildMessages('product-seeding', { story: '水壶', durationSec: 30 });
  assert.equal(m[0].role, 'system');
  assert.match(m[0].content, /产品种草/);
  assert.match(m[1].content, /目标总时长：30 秒/);
  assert.match(m[1].content, /画幅：9:16/);
});

test('validator accepts a well-formed board and numbers shots', () => {
  const r = validateStoryboard(goodBoard(), { targetDurationSec: 15 });
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual(r.value.shots.map((s) => s.no), [1, 2, 3]);
  assert.equal(r.value.totalDurationSec, 15);
});

test('validator reports each structural problem in Chinese', () => {
  const b = goodBoard();
  b.shots[0].sceneId = 's9';
  b.shots[1].characterIds = ['c9'];
  b.shots[1].dialogue = { speaker: 'c1', text: '这是一句非常非常长的台词，五秒钟根本念不完，必须要缩短或者拆开才行' };
  b.shots[2].durationSec = 30;
  delete b.shots[2].imagePrompt;
  const r = validateStoryboard(b, { targetDurationSec: 15 });
  assert.equal(r.ok, false);
  const all = r.errors.join('\n');
  for (const re of [/第 1 镜 的 sceneId/, /不存在的角色 c9/, /念不完/, /第 3 镜 durationSec/, /第 3 镜 缺少 imagePrompt/, /总时长 40 秒/]) assert.match(all, re);
  assert.equal(validateStoryboard([], {}).ok, false);
});

test('spoken length ignores punctuation and spaces', () => {
  assert.equal(spokenLength('你好，世界！ OK 12'), 8);
});

test('extractJson tolerates fences, chatter and trailing commas', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a": 1,}\n```').value, { a: 1 });
  assert.equal(extractJson('没有 JSON').value, null);
});

test('all 10 recorded real outputs (qwen-plus) validate offline', () => {
  for (const s of samples) {
    const rec = recorded(s.id);
    const r = validateStoryboard(extractJson(rec.attempts.at(-1)).value, { targetDurationSec: s.durationSec });
    assert.equal(r.ok, true, `${s.id}: ${r.errors.join('；')}`);
  }
});

test('repair loop: recorded ke-01 fails once, then passes after the error list is fed back', async () => {
  const s = samples.find((x) => x.id === 'ke-01');
  const rec = recorded('ke-01');
  assert.equal(rec.attempts.length, 2);
  const p = fakeProviders(rec.attempts);
  const events = [];
  const r = await generateStoryboard(p, { provider: 'bailian', ...s, onEvent: (e) => e.type !== 'delta' && events.push(e) });
  assert.equal(r.attempts, 2);
  assert.equal(r.usage.total_tokens, 60);
  assert.deepEqual(events.map((e) => e.type), ['attempt', 'invalid', 'attempt']);
  const second = p.calls[1].req.messages;
  assert.equal(second.at(-2).role, 'assistant');
  assert.match(second.at(-1).content, /durationSec 应在 2-10 秒之间/);
  assert.ok(p.calls[1].req.temperature < p.calls[0].req.temperature);
});

test('gives up after maxAttempts with STORYBOARD_INVALID and every attempt\'s errors', async () => {
  const p = fakeProviders(['不是 JSON', '{"title": "x"}']);
  await assert.rejects(
    () => generateStoryboard(p, { provider: 'bailian', templateId: 'guofeng-drama', story: 'x', durationSec: 30, maxAttempts: 2 }),
    (e) => e.code === 'STORYBOARD_INVALID' && e.errors.length === 2 && /没有找到 JSON/.test(e.errors[0][0]),
  );
  await assert.rejects(() => generateStoryboard(p, { provider: 'bailian', templateId: 'nope', story: 'x', durationSec: 30 }), /未知模板/);
});
