'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('../scripts/lib/redact');

test('redact removes keys, auth headers, workspace hosts and signed URLs', () => {
  const fakeKey = ['sk', 'ws', 'AbC.dEf.123456789'].join('-');
  const host = ['ws', 'abcdefghijklmnop'].join('-') + '.cn-beijing.maas.aliyuncs.com';
  const raw = JSON.stringify({
    headers: { Authorization: `Bearer ${fakeKey}` },
    url: `https://${host}/api/v1/x`,
    image: 'https://bucket.oss-accelerate.aliyuncs.com/a.png?Expires=1&OSSAccessKeyId=LTAI' + 'x'.repeat(16) + '&Signature=abc',
    token: 'o1_' + 'y'.repeat(30),
  });
  const out = redact(raw, ['my-exact-secret']);
  for (const leaked of [fakeKey, host, 'OSSAccessKeyId', 'Signature=', 'o1_yyy']) assert.ok(!out.includes(leaked), leaked);
  assert.match(out, /ws-example\.cn-beijing\.maas\.aliyuncs\.com/);
  assert.equal(redact('a my-exact-secret b', ['my-exact-secret']), 'a REDACTED b');
});
