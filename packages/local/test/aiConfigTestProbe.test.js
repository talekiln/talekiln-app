'use strict';
/** testConnection 的文本探测：模型为空时按服务商挑一个该家确实有的模型，别拿 gpt-3.5-turbo 去问百炼。 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const aiConfigService = require('../src/services/aiConfigService');

describe('testConnection default probe model', () => {
  const origFetch = globalThis.fetch;
  let calls;
  beforeEach(() => {
    calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }; };
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('bailian text config with no model probes with qwen-plus', async () => {
    await aiConfigService.testConnection({ provider: 'bailian', service_type: 'text', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key: 'k', model: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    assert.equal(calls[0].body.model, 'qwen-plus');
  });

  it('a configured model is used as-is; unknown providers keep the generic default', async () => {
    await aiConfigService.testConnection({ provider: 'bailian', service_type: 'text', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key: 'k', model: ['qwen-max'] });
    assert.equal(calls[0].body.model, 'qwen-max');
    await aiConfigService.testConnection({ provider: 'openai', service_type: 'text', base_url: 'https://example.invalid/v1', api_key: 'k', model: [] });
    assert.equal(calls[1].body.model, 'gpt-3.5-turbo');
  });
});
