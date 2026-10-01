'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactText, redactValue, setSecretStore, FileSecretStore, createAesCipher } = require('../src/secrets');
const { redact } = require('../scripts/lib/redact');

// 假数据一律拼接生成，避免仓库里出现匹配 secrets:scan 的字面量。
const j = (...p) => p.join('');
const FAKE_JWT = j('eyJhbGciOiJFUzI1NiJ9', '.', 'eyJsaWMiOiJ0ZXN0LWxpY2VuY2UifQ', '.', 'c2ln', 'bmF0dXJlMTIzNDU2');
const FAKE_SK = j('sk', '-', 'abcdEFGH12345678');
const FAKE_LTAI = j('LTAI', '5tFakeFakeFake12');
const FAKE_RT = j('rt_', 'x'.repeat(24));

test('Bearer tokens (header and bare)', () => {
  const out = redactText(`Authorization: Bearer ${FAKE_SK}; retry with bearer abcdefgh12345`);
  assert.ok(!out.includes('abcdEFGH'));
  assert.ok(!out.includes('abcdefgh12345'));
  assert.match(out, /Bearer \[REDACTED\]/);
});

test('Authorization header without scheme', () => {
  const out = redactText('{"Authorization":"abcdef123456"}');
  assert.ok(!out.includes('abcdef123456'));
});

test('sk- keys without being a known secret', () => {
  const out = redactText(`using key ${FAKE_SK} for request`);
  assert.ok(!out.includes(FAKE_SK));
  assert.match(out, /sk-\[REDACTED\]/);
  assert.match(redactText(j('sk', '-ws-AbC.dEf.123456789')), /REDACTED/);
});

test('LTAI AccessKey ids and AWS AKIA', () => {
  const out = redactText(`ak=${FAKE_LTAI} aws=${j('AKIA', 'ABCDEFGHIJKLMNOP')}`);
  assert.ok(!out.includes('FakeFake'));
  assert.ok(!out.includes('ABCDEFGHIJKLMNOP'));
});

test('signed URL params are masked but the URL stays diagnosable', () => {
  const url = j('https://bucket.oss-cn-beijing.aliyuncs.com/a.png?Expires=1893456000&', 'OSSAccessKeyId', '=', FAKE_LTAI, '&', 'Signature', '=abc%2Bdef%3D');
  const out = redactText(`download failed: ${url}`);
  assert.ok(!out.includes('abc%2Bdef'));
  assert.ok(!out.includes(FAKE_LTAI));
  assert.match(out, /bucket\.oss-cn-beijing\.aliyuncs\.com\/a\.png/);
  const s3 = redactText(j('https://x.tos.cn-beijing.volces.com/o?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F2026&X-Amz-', 'Signature', '=deadbeef01&X-Amz-SignedHeaders=host'));
  assert.ok(!s3.includes('deadbeef01'));
  assert.ok(!s3.includes('AKID%2F2026'));
  assert.match(s3, /X-Amz-SignedHeaders=host/);
});

test('refresh tokens in JSON, querystring and objects', () => {
  assert.ok(!redactText(`{"refresh_token":"${FAKE_RT}","user":"u1"}`).includes(FAKE_RT));
  assert.ok(!redactText(`POST /auth/refresh refresh_token=${FAKE_RT}&device=d1`).includes(FAKE_RT));
  assert.match(redactText(`refresh_token=${FAKE_RT}&device=d1`), /device=d1/);
  const o = redactValue({ refreshToken: FAKE_RT, nested: { refresh_token: FAKE_RT }, ok: 'visible' });
  assert.equal(o.refreshToken, '[REDACTED]');
  assert.equal(o.nested.refresh_token, '[REDACTED]');
  assert.equal(o.ok, 'visible');
});

test('licence JWTs in text and by field name', () => {
  const out = redactText(`licence loaded ${FAKE_JWT} ok`);
  assert.ok(!out.includes(FAKE_JWT));
  assert.ok(!out.includes('eyJsaWMi'));
  assert.match(out, /\[REDACTED_JWT\]/);
  const o = redactValue({ licence: FAKE_JWT, license_key: 'abc', cookie: 'sid=1', signature: 'zz' });
  for (const v of Object.values(o)) assert.equal(v, '[REDACTED]');
  assert.ok(!redactText(`licence=${FAKE_JWT}`).includes('c2ln'));
});

test('known stored secrets are still removed by exact value', () => {
  const store = new FileSecretStore({ cipher: createAesCipher('11'.repeat(32)) });
  store.set('ai_config:1', 'plain-secret-value-xyz');
  setSecretStore(store);
  try {
    assert.equal(redactText('x plain-secret-value-xyz y'), 'x [REDACTED] y');
  } finally {
    setSecretStore(null);
  }
});

test('ordinary log text is left alone', () => {
  const t = 'task 42 succeeded in 1830ms (provider=bailian) https://example.com/path?page=2&size=10';
  assert.equal(redactText(t), t);
  assert.equal(redactText('token usage: 1200 tokens'), 'token usage: 1200 tokens');
});

test('fixture redactor covers JWT and refresh tokens', () => {
  const out = redact(`{"refresh_token":"${FAKE_RT}","licence":"${FAKE_JWT}"}`);
  assert.ok(!out.includes(FAKE_RT));
  assert.ok(!out.includes(FAKE_JWT));
});
