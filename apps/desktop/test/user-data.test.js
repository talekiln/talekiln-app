const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { resolveUserDataDir, ENV_VAR } = require('../user-data');

const appData = path.resolve('appdata');
const custom = path.resolve('自定义 目录', 'talekiln data');

describe('resolveUserDataDir', () => {
  it('default: <appData>/talekiln', () => {
    assert.deepEqual(resolveUserDataDir({ appDataDir: appData, env: {}, argv: [] }), { dir: path.join(appData, 'talekiln'), source: 'default' });
  });
  it('env var override (absolute path, trimmed, quotes stripped)', () => {
    assert.deepEqual(resolveUserDataDir({ appDataDir: appData, env: { [ENV_VAR]: ` "${custom}" ` }, argv: [] }), { dir: custom, source: 'env' });
  });
  it('--user-data-dir= argument beats the env var', () => {
    const other = path.resolve('other');
    const r = resolveUserDataDir({ appDataDir: appData, env: { [ENV_VAR]: custom }, argv: ['exe', `--user-data-dir=${other}`] });
    assert.deepEqual(r, { dir: other, source: 'arg' });
  });
  it('relative or empty overrides are ignored', () => {
    for (const bad of ['', '   ', 'relative/dir', '.']) {
      assert.equal(resolveUserDataDir({ appDataDir: appData, env: { [ENV_VAR]: bad }, argv: [`--user-data-dir=${bad}`] }).source, 'default');
    }
  });
  it('appDataDir is required', () => {
    assert.throws(() => resolveUserDataDir({ env: {}, argv: [] }), /appDataDir/);
  });
});
