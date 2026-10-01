'use strict';
// Integration test: spawns the lycore binary and exercises core.hello. Run: node client/test.js
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectRetry, RpcError } = require('./index');

const exe = process.platform === 'win32' ? 'lycore.exe' : 'lycore';
const root = path.join(__dirname, '..');
const candidates = ['release', 'debug'].map((p) => path.join(root, 'target', p, exe)).filter(fs.existsSync);
if (!candidates.length) { console.error('lycore binary not built; run cargo build'); process.exit(1); }
const bin = candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

const id = `lycore-test-${process.pid}`;
const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lycore-log-'));
const child = spawn(bin, ['--pipe', endpoint, '--log-dir', logDir], { stdio: 'inherit' });

(async () => {
  const c = await connectRetry(endpoint);
  const r = await c.hello([1, 2]);
  assert.strictEqual(r.name, 'lycore');
  assert.strictEqual(r.apiVersion, 1);
  assert.ok(r.version && r.build);

  await assert.rejects(c.hello([99]), (e) => e instanceof RpcError && e.code === -32010 && /incompatible/.test(e.message));
  await assert.rejects(c.call('core.hello', {}), (e) => e.code === -32602);
  for (const m of ['licence.status', 'media.probe', 'render.start']) {
    await assert.rejects(c.call(m, {}), (e) => e.code === -32001 && /not implemented/.test(e.message));
  }
  await assert.rejects(c.call('nope', {}), (e) => e.code === -32601);
  c.close();

  await new Promise((r) => setTimeout(r, 300));
  assert.ok(fs.readdirSync(logDir).some((f) => f.startsWith('lycore.log')), 'log file written');
  console.log('core client integration test: OK');
})().then(() => { child.kill(); process.exit(0); }, (e) => { console.error(e); child.kill(); process.exit(1); });
