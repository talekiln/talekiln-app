'use strict';
// Plugin signing: ES256 over canonical JSON of manifest + file hashes. Keys are generated per test run (never stored).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sdk = require('../src');

const EXAMPLE = path.join(__dirname, '..', 'examples', 'acme');

function keyPair(kid = 'k-test') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, publicKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } };
}

/** Fresh copy of the example plugin in a temp folder (its code is never required here). */
function copyExample() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
}
const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const writeManifest = (dir, m) => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));

test('canonicalJson sorts keys, skips undefined, keeps arrays ordered', () => {
  assert.equal(sdk.canonicalJson({ b: 1, a: [2, { d: undefined, c: 'x' }] }), '{"a":[2,{"c":"x"}],"b":1}');
});

test('sign then verify: official under the signing key, files and entry covered, manifest still valid', () => {
  const dir = copyExample();
  const k = keyPair('k1');
  const { manifest, hash, files } = sdk.signManifest(readManifest(dir), dir, k.privateKey, { kid: 'k1' });
  assert.deepEqual(files, ['index.js']);
  assert.equal(manifest.signature.alg, 'ES256');
  assert.equal(manifest.signature.kid, 'k1');
  assert.ok(sdk.validateManifest(manifest).ok, sdk.validateManifest(manifest).errors.join());
  writeManifest(dir, manifest);

  for (const keys of [{ keys: [k.jwk] }, [k.jwk], k.jwk, k.publicKey, (kid) => (kid === 'k1' ? k.jwk : null)]) {
    const r = sdk.verifySignature(readManifest(dir), dir, keys);
    assert.deepEqual({ ok: r.ok, status: r.status, kid: r.kid, hash: r.hash, reason: r.reason }, { ok: true, status: 'official', kid: 'k1', hash, reason: null });
  }
  assert.match(hash, /^[0-9a-f]{64}$/);
  // the sdk-level reader accepts the signed manifest without running code
  assert.equal(sdk.readPluginManifest(dir).manifest.signature.kid, 'k1');
});

test('tampered file -> invalid (bad signature); missing file -> invalid; restoring the file verifies again', () => {
  const dir = copyExample();
  const k = keyPair();
  writeManifest(dir, sdk.signManifest(readManifest(dir), dir, k.privateKey, { kid: 'k-test' }).manifest);
  const original = fs.readFileSync(path.join(dir, 'index.js'));
  fs.appendFileSync(path.join(dir, 'index.js'), '\n// evil\n');
  let r = sdk.verifySignature(readManifest(dir), dir, [k.jwk]);
  assert.equal(r.status, 'invalid');
  assert.equal(r.reason, 'bad signature');
  fs.unlinkSync(path.join(dir, 'index.js'));
  r = sdk.verifySignature(readManifest(dir), dir, [k.jwk]);
  assert.deepEqual([r.status, r.reason], ['invalid', 'missing file: index.js']);
  fs.writeFileSync(path.join(dir, 'index.js'), original);
  assert.equal(sdk.verifySignature(readManifest(dir), dir, [k.jwk]).status, 'official');
});

test('tampered manifest -> invalid: permissions, capabilities, entry swap and signature edits are all caught', () => {
  const dir = copyExample();
  const k = keyPair();
  const signed = sdk.signManifest(readManifest(dir), dir, k.privateKey, { kid: 'k-test' }).manifest;
  const cases = [
    { ...signed, permissions: [...signed.permissions, 'network:evil.example'] },
    { ...signed, capabilities: ['image.generate'] },
    { ...signed, label: 'Totally official' },
    { ...signed, signature: { ...signed.signature, value: signed.signature.value.slice(0, -2) + 'AA' } },
  ];
  for (const m of cases) {
    const r = sdk.verifySignature(m, dir, [k.jwk]);
    assert.equal(r.status, 'invalid', JSON.stringify(m).slice(0, 80));
    assert.equal(r.reason, 'bad signature');
  }
  // entry replaced by a file the signature does not cover
  fs.writeFileSync(path.join(dir, 'other.js'), 'module.exports = {};');
  const swapped = { ...signed, entry: 'other.js' };
  assert.equal(sdk.verifySignature(swapped, dir, [k.jwk]).reason, 'entry not covered by signature');
  assert.equal(sdk.verifySignature({ ...signed, signature: { alg: 'HS256', kid: 'k-test', value: 'x' } }, dir, [k.jwk]).reason, 'malformed signature');
  assert.equal(sdk.verifySignature({ ...signed, files: ['../x.js', 'index.js'] }, dir, [k.jwk]).reason, 'malformed files list');
});

test('unknown kid -> invalid; a different key with the same kid -> invalid', () => {
  const dir = copyExample();
  const k = keyPair('k1');
  const other = keyPair('k1');
  const signed = sdk.signManifest(readManifest(dir), dir, k.privateKey, { kid: 'k1' }).manifest;
  let r = sdk.verifySignature(signed, dir, { keys: [{ ...k.jwk, kid: 'k2' }] });
  assert.deepEqual([r.status, r.reason, r.kid], ['invalid', 'unknown kid', 'k1']);
  assert.ok(r.hash, 'hash is still reported so the UI can show the fingerprint');
  r = sdk.verifySignature(signed, dir, [other.jwk]);
  assert.deepEqual([r.status, r.reason], ['invalid', 'bad signature']);
  assert.equal(sdk.verifySignature(signed, dir, null).reason, 'unknown kid');
  assert.equal(sdk.verifySignature(signed, dir, () => { throw new Error('boom'); }).reason, 'unknown kid');
});

test('unsigned folder -> status unsigned with a content fingerprint that signing does not change', () => {
  const dir = copyExample();
  const r = sdk.verifySignature(readManifest(dir), dir, []);
  assert.deepEqual([r.ok, r.status, r.reason, r.kid], [false, 'unsigned', 'no signature', null]);
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  // the same folder signed later keeps the fingerprint (so a registry entry can be matched before and after signing)
  const k = keyPair('k1');
  const signed = sdk.signManifest(readManifest(dir), dir, k.privateKey, { kid: 'k1' });
  assert.equal(signed.hash, r.hash);
  assert.equal(sdk.verifySignature(signed.manifest, dir, [k.jwk]).hash, r.hash);
  fs.appendFileSync(path.join(dir, 'index.js'), '\n');
  assert.notEqual(sdk.verifySignature(readManifest(dir), dir, []).hash, r.hash);
});

test('strict mode rejects unlisted files and symlinks; strict:false only checks the listed set', () => {
  const dir = copyExample();
  const k = keyPair();
  writeManifest(dir, sdk.signManifest(readManifest(dir), dir, k.privateKey, { kid: 'k-test' }).manifest);
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'extra.js'), '');
  assert.equal(sdk.verifySignature(readManifest(dir), dir, [k.jwk]).reason, 'unlisted file: lib/extra.js');
  assert.equal(sdk.verifySignature(readManifest(dir), dir, [k.jwk], { strict: false }).status, 'official');
  fs.rmSync(path.join(dir, 'lib'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'index.js'), path.join(dir, 'link.js'));
  assert.match(sdk.verifySignature(readManifest(dir), dir, [k.jwk]).reason, /symbolic link/);
  const { files: _f, ...unsignedShape } = readManifest(dir); // no file list -> signManifest walks the folder and sees the symlink
  assert.throws(() => sdk.signManifest(unsignedShape, dir, k.privateKey, { kid: 'k-test' }), /symbolic/);
});

test('signManifest: PEM keys, explicit file lists, nested files, and rejected inputs', () => {
  const dir = copyExample();
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'util.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi');
  const k = keyPair('pem');
  const pem = k.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const all = sdk.signManifest(readManifest(dir), dir, pem, { kid: 'pem' });
  assert.deepEqual(all.files, ['README.md', 'index.js', 'lib/util.js']);
  assert.equal(sdk.verifySignature(all.manifest, dir, k.jwk).status, 'official');
  // A manifest that already carries `files` keeps that set
  const again = sdk.signManifest(all.manifest, dir, pem, { kid: 'pem' });
  assert.deepEqual(again.files, all.files);
  assert.equal(again.hash, all.hash, 'signing the same content twice yields the same fingerprint');
  const partial = sdk.signManifest(readManifest(dir), dir, pem, { kid: 'pem', files: ['index.js', 'lib/util.js'] });
  assert.equal(sdk.verifySignature(partial.manifest, dir, k.jwk, { strict: false }).status, 'official');
  assert.equal(sdk.verifySignature(partial.manifest, dir, k.jwk).reason, 'unlisted file: README.md');

  assert.throws(() => sdk.signManifest(readManifest(dir), dir, pem, { kid: 'bad kid!' }), /kid/);
  assert.throws(() => sdk.signManifest(readManifest(dir), dir, pem, { kid: 'pem', files: ['lib/util.js'] }), /entry/);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.throws(() => sdk.signManifest(readManifest(dir), dir, rsa, { kid: 'pem' }), /P-256/);
  assert.throws(() => sdk.signManifest(readManifest(dir), dir, k.publicKey, { kid: 'pem' }), /private/);
});

test('validateManifest: files and signature shapes', () => {
  const base = sdk.readPluginManifest(EXAMPLE).manifest;
  const errs = (m) => sdk.validateManifest(m).errors.join('|');
  assert.equal(sdk.validateManifest({ ...base, files: ['index.js', 'lib/a.js'] }).ok, true);
  assert.match(errs({ ...base, files: 'index.js' }), /files must be an array/);
  assert.match(errs({ ...base, files: ['index.js', 'index.js'] }), /duplicate file/);
  for (const bad of ['../x.js', '/abs.js', 'a//b.js', 'a/./b.js', 'C:/x.js', 'a\\b.js', '']) assert.match(errs({ ...base, files: [bad] }), /invalid file path/, bad);
  assert.match(errs({ ...base, signature: 'x' }), /signature must be an object/);
  assert.match(errs({ ...base, files: ['index.js'], signature: { alg: 'RS256', kid: 'k', value: 'A'.repeat(30) } }), /alg must be ES256/);
  assert.match(errs({ ...base, files: ['index.js'], signature: { alg: 'ES256', kid: 'bad kid', value: 'A'.repeat(30) } }), /kid/);
  assert.match(errs({ ...base, files: ['index.js'], signature: { alg: 'ES256', kid: 'k', value: 'not base64url!' } }), /base64url/);
  assert.match(errs({ ...base, signature: { alg: 'ES256', kid: 'k', value: 'A'.repeat(30) } }), /must list its files/);
  assert.match(errs({ ...base, files: ['index.js'], signature: { alg: 'ES256', kid: 'k', value: 'A'.repeat(30), extra: 1 } }), /unknown signature field/);
});

test('sign-plugin.mjs: signs in place with the key from an env var file; refuses without a key', () => {
  const dir = copyExample();
  const k = keyPair('cli-1');
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'key-')), 'signing.pem');
  fs.writeFileSync(keyFile, k.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const script = path.join(__dirname, '..', 'scripts', 'sign-plugin.mjs');
  const run = (args, env) => execFileSync(process.execPath, [script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const out = run([dir, '--kid', 'cli-1'], { TALEKILN_PLUGIN_SIGNING_KEY_FILE: keyFile });
  assert.match(out, /signed acme@0\.1\.0 kid=cli-1 files=1 hash=[0-9a-f]{64}/);
  const r = sdk.verifySignature(readManifest(dir), dir, [k.jwk]);
  assert.equal(r.status, 'official');
  assert.throws(() => run([dir, '--kid', 'cli-1'], { TALEKILN_PLUGIN_SIGNING_KEY_FILE: '', TALEKILN_PLUGIN_SIGNING_KEY_PEM: '' }), /TALEKILN_PLUGIN_SIGNING_KEY_FILE/);
  assert.throws(() => run([dir], { TALEKILN_PLUGIN_SIGNING_KEY_FILE: keyFile, TALEKILN_PLUGIN_SIGNING_KID: '' }), /--kid/);
  // --out writes elsewhere and --dry-run writes nothing
  const outFile = path.join(dir, '..', `signed-${path.basename(dir)}.json`);
  run([dir, '--kid', 'cli-1', '--out', outFile], { TALEKILN_PLUGIN_SIGNING_KEY_FILE: keyFile });
  assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).signature.kid, 'cli-1');
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  run([dir, '--kid', 'cli-2', '--dry-run'], { TALEKILN_PLUGIN_SIGNING_KEY_FILE: keyFile });
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before);
  // --inspect needs no key: file hashes + fingerprint equal to what a verification computes
  const report = JSON.parse(run([dir, '--inspect'], { TALEKILN_PLUGIN_SIGNING_KEY_FILE: '', TALEKILN_PLUGIN_SIGNING_KEY_PEM: '' }));
  assert.equal(report.name, 'acme');
  assert.deepEqual(report.files, ['index.js']);
  assert.deepEqual(report.fileHashes, sdk.hashFiles(dir, ['index.js']));
  assert.equal(report.hash, r.hash);
  assert.equal(report.signature.status, 'invalid'); // no key resolver: structurally fine, kid unknown
  assert.equal(report.signature.reason, 'unknown kid');
  assert.equal(report.manifest.signature, undefined, 'the inspect manifest is what gets submitted: no signature');
  assert.deepEqual(report.manifest.files, ['index.js']);
  const unsignedDir = copyExample();
  const u = JSON.parse(run([unsignedDir, '--inspect'], {}));
  assert.equal(u.signature.status, 'unsigned');
  assert.equal(u.hash, sdk.verifySignature(readManifest(unsignedDir), unsignedDir, []).hash, 'fingerprint of an unsigned folder matches the verifier');
});
