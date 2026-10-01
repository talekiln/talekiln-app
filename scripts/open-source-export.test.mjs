import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFiles, scanCleanup, checkLicenses, mapPath, PUBLIC_PATHS, PRIVATE_PATHS, CLEANUP_RULES } from './open-source-export.mjs';

test('selectFiles keeps public dirs, drops private dirs and junk inside public dirs', () => {
  const tracked = [
    'apps/renderer/src/a.vue', 'packages/local/src/x.js', 'packages/local/node_modules/z/i.js', 'packages/local/data/app.db',
    'packages/local/.env.local', 'packages/core/src/main.rs', 'packages/cloud/src/a.ts', 'apps/admin/src/a.vue',
    'docs/phase2-plan.md', 'docs/provider-extension.md', '.github/workflows/core.yml', '.github/public-repo/workflows/cla.yml',
    'packages/local-extra/x.js',
  ];
  assert.deepEqual(selectFiles(tracked), ['apps/renderer/src/a.vue', 'packages/local/src/x.js', 'docs/provider-extension.md', '.github/public-repo/workflows/cla.yml']);
});

test('no private path is public, and mapPath rewrites the public .github overlay', () => {
  for (const p of PRIVATE_PATHS) assert.ok(!PUBLIC_PATHS.some((q) => p === q || p.startsWith(`${q}/`)), p);
  assert.equal(mapPath('.github/public-repo/workflows/cla.yml'), '.github/workflows/cla.yml');
  assert.equal(mapPath('apps/desktop/main.js'), 'apps/desktop/main.js');
});

test('scanCleanup reports file:line only, never the matched text', () => {
  const files = { 'a.js': 'x\nsee docs/phase2-plan.md\nfetch("https://api.realvendor.com/v1")\n', 'b.js': 'fine https://cloud.talekiln.example/x', 'logo.png': 'https://real.com' };
  const hits = scanCleanup(Object.keys(files), (f) => files[f]);
  assert.deepEqual(hits['internal-doc-ref'], ['a.js:2']);
  assert.deepEqual(hits['real-host'], ['a.js:3']);
  assert.ok(!JSON.stringify(hits).includes('realvendor'));
  assert.equal(CLEANUP_RULES.length, Object.keys(hits).length);
});

test('checkLicenses fails on placeholder LICENSE and on private deps, warns on license fields', () => {
  const files = { LICENSE: 'TODO placeholder', 'LICENSE-LocalMiniDrama': 'MIT', 'CONTRIBUTING.md': '', 'CLA.md': '', 'SECURITY.md': '', 'CODE_OF_CONDUCT.md': '',
    'packages/plugin-sdk/LICENSE': 'MIT License ...', 'packages/plugin-sdk/package.json': '{"license":"MIT"}',
    'packages/local/package.json': '{"license":"UNLICENSED","dependencies":{"@talekiln/core":"workspace:*"}}' };
  const r = checkLicenses(Object.keys(files), (f) => files[f]);
  const text = r.map((x) => `${x.level} ${x.msg}`).join('\n');
  assert.match(text, /FAIL LICENSE 不是 AGPL/);
  assert.match(text, /FAIL packages\/local\/package.json 依赖私有包 @talekiln\/core/);
  assert.match(text, /WARN packages\/local\/package.json 的 license 字段/);
  assert.match(text, /OK plugin-sdk MIT LICENSE 完整/);
});

test('checkLicenses accepts a full-looking AGPL text', () => {
  const lic = `GNU AFFERO GENERAL PUBLIC LICENSE\n${'x'.repeat(25000)}`;
  const files = { LICENSE: lic, 'LICENSE-LocalMiniDrama': 'MIT', 'CONTRIBUTING.md': '', 'CLA.md': '', 'SECURITY.md': '', 'CODE_OF_CONDUCT.md': '', 'packages/plugin-sdk/LICENSE': 'MIT License' };
  const r = checkLicenses(Object.keys(files), (f) => files[f]);
  assert.ok(r.some((x) => x.level === 'OK' && /AGPL/.test(x.msg)));
  assert.ok(!r.some((x) => x.level === 'FAIL'));
});
