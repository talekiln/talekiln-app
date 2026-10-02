'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ENTRIES, lookup, describe } = require('../src/errors');
const { ERROR_CODES, READABLE } = require('../src/providers/errors');
const response = require('../src/response');

const ROOT = path.join(__dirname, '..', '..', '..');

test('every entry has Chinese message and action', () => {
  for (const [code, e] of Object.entries(ENTRIES)) {
    assert.ok(['provider', 'local', 'cloud', 'core'].includes(e.scope), code);
    assert.match(e.message, /[一-龥]/, code);
    assert.match(e.action, /[一-龥]/, code);
  }
});

test('every ProviderError code is in the table and matches READABLE', () => {
  for (const code of Object.values(ERROR_CODES)) {
    assert.ok(ENTRIES[code], `missing ${code}`);
    assert.equal(ENTRIES[code].scope, 'provider');
    assert.equal(ENTRIES[code].message, READABLE[code], `READABLE drift for ${code}`);
  }
});

test('cloud ErrorCode union is fully covered', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/cloud/src/services/errors.ts'), 'utf8');
  const codes = [...src.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 9);
  for (const c of [...codes, 'bad_request', 'http_error', 'internal_error']) assert.equal(ENTRIES[c] && ENTRIES[c].scope, 'cloud', c);
});

test('core ERR_* constants are fully covered', () => {
  let n = 0;
  for (const f of ['rpc.rs', 'ffmpeg.rs', 'render.rs']) {
    const src = fs.readFileSync(path.join(ROOT, 'packages/core/src', f), 'utf8');
    for (const m of src.matchAll(/pub const (ERR_[A-Z_]+): i64 = (-?\d+);/g)) {
      n++;
      assert.equal(ENTRIES[m[2]] && ENTRIES[m[2]].scope, 'core', `${m[1]} ${m[2]}`);
    }
  }
  assert.ok(n >= 13);
});

test('local response.error(res, status, CODE, ...) literals are covered', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
  const missing = [];
  for (const f of walk(path.join(__dirname, '..', 'src')).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/response\.error\(\s*res,\s*[^,]+,\s*(?:[^,'"]*\|\|\s*)?'([A-Z_]+)'/g)) {
      if (!ENTRIES[m[1]]) missing.push(`${path.basename(f)}:${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('lookup/describe: numbers, unknown fallback, no prototype leakage', () => {
  assert.equal(lookup(-32020).name, 'ERR_FFMPEG_MISSING');
  assert.equal(lookup('__proto__'), null);
  assert.equal(lookup('constructor'), null);
  assert.equal(describe('NOPE').code, 'UNKNOWN');
  assert.equal(describe('NETWORK').message, READABLE.NETWORK);
});

test('response.error adds action and fills missing message', () => {
  let body;
  const res = { status() { return this; }, json(b) { body = b; } };
  response.error(res, 402, 'SPEND_LIMIT', '自定义');
  assert.equal(body.error.message, '自定义');
  assert.equal(body.error.action, ENTRIES.SPEND_LIMIT.action);
  response.error(res, 502, 'NETWORK');
  assert.equal(body.error.message, READABLE.NETWORK);
  response.error(res, 500, 'WHATEVER', 'x');
  assert.equal(body.error.action, undefined);
});
