'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const sdk = require('../src');

const good = () => ({
  name: 'acme', version: '1.2.3', sdkVersion: '1.0.0',
  capabilities: ['llm.chat', 'image.generate'],
  permissions: ['network:api.acme.example', 'secret:apiKey'],
  entry: 'index.js',
});
const errs = (m) => sdk.validateManifest(m).errors.join('|');

test('valid manifest passes and is frozen', () => {
  const r = sdk.validateManifest(good());
  assert.equal(r.ok, true);
  assert.ok(Object.isFrozen(r.manifest));
});

test('rejects non-objects and unknown fields', () => {
  assert.equal(sdk.validateManifest(null).ok, false);
  assert.equal(sdk.validateManifest([]).ok, false);
  assert.match(errs({ ...good(), evil: 1 }), /unknown field: evil/);
});

test('name and version rules', () => {
  assert.match(errs({ ...good(), name: 'Acme' }), /name must match/);
  assert.match(errs({ ...good(), name: 'a' }), /name must match/);
  assert.match(errs({ ...good(), version: '1.2' }), /version must be semver/);
});

test('sdkVersion: same major, minor not newer than the host', () => {
  assert.equal(sdk.validateManifest({ ...good(), sdkVersion: '1.0.7' }).ok, true);
  assert.match(errs({ ...good(), sdkVersion: '2.0.0' }), /major 2 is not supported/);
  assert.match(errs({ ...good(), sdkVersion: '1.9.0' }), /newer than host/);
  assert.match(errs({ ...good(), sdkVersion: 'x' }), /sdkVersion must be semver/);
});

test('capabilities: known, unique, video pair together', () => {
  assert.match(errs({ ...good(), capabilities: [] }), /non-empty/);
  assert.match(errs({ ...good(), capabilities: ['text.stream'] }), /unknown capability: text.stream/);
  assert.match(errs({ ...good(), capabilities: ['llm.chat', 'llm.chat'] }), /duplicate/);
  assert.match(errs({ ...good(), capabilities: ['video.submit'] }), /declared together/);
  assert.equal(sdk.validateManifest({ ...good(), capabilities: ['video.submit', 'video.poll'] }).ok, true);
});

test('permissions: network hosts must be plain hostnames; wildcard-all, schemes, ports rejected', () => {
  for (const bad of ['network:*', 'network:https://a.example', 'network:a.example:8080', 'network:a.example/x', 'network:localhost', 'fs:read']) {
    assert.equal(sdk.validateManifest({ ...good(), permissions: ['network:ok.example', bad] }).ok, false, bad);
  }
  assert.match(errs({ ...good(), permissions: ['secret:apiKey'] }), /at least one network/);
  assert.equal(sdk.validateManifest({ ...good(), permissions: ['network:*.acme.example'] }).ok, true);
});

test('entry must stay inside the plugin folder', () => {
  for (const bad of ['../x.js', '/abs.js', 'a/../../x.js', 'C:/x.js', 'x.ts', 'a//b.js', '']) {
    assert.equal(sdk.validateManifest({ ...good(), entry: bad }).ok, false, bad);
  }
  assert.equal(sdk.validateManifest({ ...good(), entry: 'dist/index.cjs' }).ok, true);
});

test('hostAllowed: exact and *.domain (not the bare domain, not suffix tricks)', () => {
  assert.equal(sdk.hostAllowed('api.acme.example', ['api.acme.example']), true);
  assert.equal(sdk.hostAllowed('x.acme.example', ['*.acme.example']), true);
  assert.equal(sdk.hostAllowed('acme.example', ['*.acme.example']), false);
  assert.equal(sdk.hostAllowed('evilacme.example', ['*.acme.example']), false);
  assert.equal(sdk.hostAllowed('api.acme.example.evil.test', ['api.acme.example']), false);
});

test('validateAdapter: declared and implemented sets must match; mapError required', () => {
  const m = sdk.validateManifest(good()).manifest;
  const fn = async () => ({});
  assert.equal(sdk.validateAdapter({ capabilities: { 'llm.chat': fn, 'image.generate': fn }, mapError: () => {} }, m).ok, true);
  assert.match(sdk.validateAdapter({ capabilities: { 'llm.chat': fn }, mapError: () => {} }, m).errors.join(), /declared in manifest but not implemented/);
  assert.match(sdk.validateAdapter({ capabilities: { 'llm.chat': fn, 'image.generate': fn, 'tts.synthesize': fn }, mapError: () => {} }, m).errors.join(), /not declared/);
  assert.match(sdk.validateAdapter({ capabilities: { 'llm.chat': fn, 'image.generate': fn } }, m).errors.join(), /mapError/);
});

test('guarded fetch blocks http, other hosts, and bad urls; passes permitted https', async () => {
  const m = sdk.validateManifest(good()).manifest;
  const seen = [];
  const f = sdk.createGuardedFetch(async (u, init) => { seen.push([u, init.redirect]); return { ok: true }; }, m);
  await f('https://api.acme.example/x');
  assert.deepEqual(seen, [['https://api.acme.example/x', 'error']]);
  for (const u of ['http://api.acme.example/x', 'https://evil.test/x', 'https://api.acme.example.evil.test/', 'nope']) {
    await assert.rejects(() => f(u), (e) => e.name === 'PluginError');
  }
});

test('loadPlugin reads the example folder; refuses broken folders', () => {
  const p = sdk.loadPlugin(path.join(__dirname, '..', 'examples', 'acme'));
  assert.equal(p.manifest.name, 'acme');
  assert.equal(typeof p.createAdapter, 'function');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-'));
  assert.throws(() => sdk.loadPlugin(dir), /cannot read manifest/);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...good(), entry: '../x.js' }));
  assert.throws(() => sdk.loadPlugin(dir), /invalid manifest/);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(good()));
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};');
  assert.throws(() => sdk.loadPlugin(dir), /createAdapter/);
});

test('apiKey is withheld unless the manifest requests secret:apiKey', () => {
  let seen;
  const m = { ...good(), permissions: ['network:api.acme.example'], capabilities: ['llm.chat'] };
  sdk.instantiate({
    manifest: m,
    createAdapter: (ctx) => { seen = ctx; return { capabilities: { 'llm.chat': async () => ({ text: 'x' }) }, mapError: () => new sdk.PluginError('UNKNOWN') }; },
  }, { apiKey: 'test-key-0123456789' });
  assert.equal(seen.apiKey, undefined);
});
