'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { uploadToImageProxy } = require('../src/services/uploadService');

test('without image_proxy.upload_url nothing is uploaded to any third party', async () => {
  const realFetch = global.fetch;
  let called = 0;
  global.fetch = async () => { called++; throw new Error('must not be called'); };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  try {
    const url = await uploadToImageProxy(Buffer.from([1, 2, 3]), 'image/png', log, 'test');
    assert.equal(url, null);
    assert.equal(called, 0);
  } finally { global.fetch = realFetch; }
});

test('the shipped config does not enable the image proxy for video', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const yaml = fs.readFileSync(path.join(__dirname, '../configs/config.yaml'), 'utf8');
  assert.match(yaml, /use_for_video:\s*false/);
  assert.doesNotMatch(yaml.replace(/^\s*#.*$/gm, ''), /zhongzhuan/);
});
