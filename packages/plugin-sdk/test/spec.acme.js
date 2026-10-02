'use strict';
/** Contract spec for the example plugin (mocked vendor replies; the vendor is fictional). */
module.exports = {
  apiKey: 'test-key-0123456789',
  requests: {
    'llm.chat': { messages: [{ role: 'user', content: 'hi' }] },
    'image.generate': { prompt: 'a cat', size: '1024*1024' },
    'video.submit': { prompt: 'a cat walks', duration: 5 },
    'video.poll': { taskId: 't-1' },
    'tts.synthesize': { text: 'hello', wordTimestamps: true },
  },
  success: {
    'llm.chat': { status: 200, body: { text: 'hello', usage: { tokens: 3 } } },
    'image.generate': { status: 200, body: { data: [{ url: 'https://cdn.acme.example/i.png' }] } },
    'video.submit': { status: 200, body: { task_id: 't-1' } },
    'video.poll': { status: 200, body: { state: 'done', video_url: 'https://cdn.acme.example/v.mp4' } },
    'tts.synthesize': { status: 200, body: { audio_base64: 'AAEC', format: 'mp3', words: [{ t: 'h', s: 0, e: 80 }, { t: 'i', s: 80, e: 160 }] } },
  },
  errors: {
    INVALID_API_KEY: { status: 401, body: { error: { code: 'invalid_api_key', message: 'bad key' } } },
    MODEL_NOT_ENABLED: { status: 403, body: { error: { code: 'forbidden', message: 'model not enabled' } } },
    INSUFFICIENT_BALANCE: { status: 403, body: { error: { code: 'arrears', message: 'account in arrears' } } },
    RATE_LIMITED: { status: 429, body: { error: { code: 'too_many', message: 'slow down' } } },
    INVALID_PARAMS: { status: 400, body: { error: { code: 'bad_param', message: 'size invalid' } } },
    UNKNOWN: { status: 500, body: { error: { code: 'oops', message: 'internal' } } },
  },
  taskFailed: { status: 200, body: { state: 'failed', reason: 'content rejected' } },
  probe: {
    'image.generate': { status: 400, body: { error: { code: 'bad_param', message: 'empty prompt' } } },
    'llm.chat': { status: 200, body: { text: 'ok' } },
  },
};
