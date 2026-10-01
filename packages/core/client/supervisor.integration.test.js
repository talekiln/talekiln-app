'use strict';
// 守护进程集成测试：用真实 lycore 二进制，强杀后应自动重启并恢复可用。需先 cargo build。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSupervisor } = require('./index');

const exe = process.platform === 'win32' ? 'lycore.exe' : 'lycore';
const root = path.join(__dirname, '..');
const bins = ['release', 'debug'].map((p) => path.join(root, 'target', p, exe)).filter(fs.existsSync);
if (!bins.length) { console.error('lycore binary not built; run cargo build'); process.exit(1); }
const bin = bins.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

const id = `lycore-sup-${process.pid}`;
const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lycore-suplog-'));

(async () => {
  const sup = createSupervisor({ bin, endpoint, logDir, backoff: { baseMs: 50, factor: 2, maxMs: 200 }, healthIntervalMs: 200 });
  const hello = await sup.start();
  assert.strictEqual(hello.name, 'lycore');
  const pid1 = sup.pid;
  assert.ok(pid1);
  process.kill(pid1, 'SIGKILL'); // Windows 下 Node 会映射为 TerminateProcess
  const restarted = new Promise((r) => sup.once('restart', r));
  const info = await restarted;
  assert.strictEqual(info.attempt, 1);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('not running again')), 10000);
    const on = (s) => { if (s === 'running') { clearTimeout(t); sup.off('state', on); resolve(); } };
    sup.on('state', on);
  });
  assert.notStrictEqual(sup.pid, pid1);
  assert.strictEqual((await sup.call('core.hello', { apiVersions: [1] })).name, 'lycore');
  const pid2 = sup.pid;
  await sup.stop();
  assert.strictEqual(sup.state, 'stopped');
  assert.throws(() => process.kill(pid2, 0), 'child terminated');
  console.log('supervisor integration test: OK');
})().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
