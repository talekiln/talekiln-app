'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describeStartupError, isNativeAbiMismatch } = require('../startup-error');

// 真实报错文本（路径改成正斜杠，避免转义噪音）
const abiErr = new Error([
  "The module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
  'was compiled against a different Node.js version using',
  'NODE_MODULE_VERSION 141. This version of Node.js requires',
  'NODE_MODULE_VERSION 140.',
].join('\n'));

test('recognises the better-sqlite3 ABI mismatch', () => {
  assert.equal(isNativeAbiMismatch(abiErr), true);
  assert.equal(isNativeAbiMismatch(new Error('EADDRINUSE')), false);
  assert.equal(isNativeAbiMismatch('plain string'), false);
});

test('dev-mode ABI mismatch message tells the developer which script to run', () => {
  const msg = describeStartupError(abiErr, { logFile: 'C:/log/main.log', packaged: false });
  assert.ok(msg.startsWith('本地服务未能启动，日志：C:/log/main.log'));
  assert.match(msg, /pnpm native:electron/);
  assert.match(msg, /pnpm native:node/);
  assert.match(msg, /NODE_MODULE_VERSION 141/, 'the original stack is kept');
});

test('packaged builds and unrelated errors get no dev hint', () => {
  const packaged = describeStartupError(abiErr, { logFile: 'L', packaged: true });
  assert.doesNotMatch(packaged, /pnpm native/);
  const other = describeStartupError(new Error('listen EADDRINUSE'), { logFile: 'L', packaged: false });
  assert.doesNotMatch(other, /pnpm native/);
  assert.ok(other.startsWith('本地服务未能启动，日志：L\n\nError: listen EADDRINUSE'));
  assert.equal(describeStartupError('boom', { logFile: 'L', packaged: false }), '本地服务未能启动，日志：L\n\nboom');
});
