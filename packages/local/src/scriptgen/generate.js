'use strict';
/**
 * D02: story -> storyboard table, with structured-output validation and repair retries.
 * Calls only the `text.stream` capability, so it works with any phase-1 provider.
 */
const { jsonrepair } = require('jsonrepair');
const { buildMessages, getTemplate } = require('./templates');
const { validateStoryboard } = require('./schema');

const DEFAULT_MAX_ATTEMPTS = 3;

/** Pull the outermost JSON object out of model text (tolerates code fences and chatter). */
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { value: null, error: '没有找到 JSON 对象' };
  const body = s.slice(start, end + 1);
  try { return { value: JSON.parse(body) }; } catch (_) { /* try repair */ }
  try { return { value: JSON.parse(jsonrepair(body)), repaired: true }; } catch (e) {
    return { value: null, error: `JSON 无法解析：${e.message}` };
  }
}

function addUsage(acc, u) {
  if (!u) return acc;
  for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) acc[k] = (acc[k] || 0) + (u[k] || 0);
  return acc;
}

/**
 * @param {object} providers   facade from createProviders()
 * @param {object} req
 * @param {string} req.provider        e.g. 'bailian'
 * @param {string} [req.model]
 * @param {string} req.templateId      'guofeng-drama' | 'product-seeding' | 'knowledge-explainer'
 * @param {string} req.story
 * @param {string} [req.style]
 * @param {string} [req.aspectRatio]   '9:16' | '16:9' | '1:1'
 * @param {number} req.durationSec     30-60 in phase 1
 * @param {number} [req.maxAttempts]
 * @param {AbortSignal} [req.signal]
 * @param {(ev: object) => void} [req.onEvent]  progress: {type:'attempt'|'delta'|'invalid', ...}
 * @returns {Promise<{storyboard, attempts, usage, errors: string[][]}>}
 *   On failure after all attempts, throws Error with .code = 'STORYBOARD_INVALID' and .errors.
 */
async function generateStoryboard(providers, req) {
  getTemplate(req.templateId);
  const maxAttempts = req.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const messages = buildMessages(req.templateId, req);
  const usage = {};
  const history = [];
  const emit = req.onEvent || (() => {});

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    emit({ type: 'attempt', attempt });
    let text = '';
    for await (const ev of providers.text.stream(req.provider, {
      model: req.model,
      messages,
      temperature: attempt === 1 ? 0.8 : 0.3,
      signal: req.signal,
    })) {
      if (ev.type === 'delta') { text += ev.text; emit({ type: 'delta', attempt, text: ev.text }); }
      if (ev.type === 'done') addUsage(usage, ev.usage);
    }
    const parsed = extractJson(text);
    const result = parsed.value
      ? validateStoryboard(parsed.value, { targetDurationSec: req.durationSec })
      : { ok: false, errors: [parsed.error] };
    history.push(result.errors);
    if (result.ok) return { storyboard: result.value, attempts: attempt, usage, errors: history };
    emit({ type: 'invalid', attempt, errors: result.errors });
    // Repair turn: show the model its own output and the exact problems; ask for the full object again.
    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content: `上面的 JSON 有以下问题，请修正后重新输出完整 JSON（只输出 JSON）：\n${result.errors.slice(0, 15).map((e) => `- ${e}`).join('\n')}`,
    });
  }
  const e = new Error(`分镜表生成 ${maxAttempts} 次仍不合法`);
  e.code = 'STORYBOARD_INVALID';
  e.errors = history;
  e.usage = usage;
  throw e;
}

module.exports = { generateStoryboard, extractJson };
