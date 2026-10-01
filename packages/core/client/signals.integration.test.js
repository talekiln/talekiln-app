'use strict';
// Unix（macOS / Linux）信号与残留进程：SIGTERM 干净退出并删除套接字文件；套接字仅属主可访问；
// 父进程消失后（LYCORE_WATCH_PARENT=1）lycore 自行退出。Windows 命名管道无此行为，直接跳过。需先 cargo build。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { connectRetry } = require('./index');

if (process.platform === 'win32') { console.log('signals integration test: skipped on Windows'); process.exit(0); }

const root = path.join(__dirname, '..');
const bins = ['release', 'debug'].map((p) => path.join(root, 'target', p, 'lycore')).filter(fs.existsSync);
if (!bins.length) { console.error('lycore binary not built; run cargo build'); process.exit(1); }
const bin = bins.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lycore-siglog-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + what);
}

(async () => {
  // 1) SIGTERM：退出码 0、套接字被清理、套接字权限 0600
  const ep1 = path.join(os.tmpdir(), `lycore-sig1-${process.pid}.sock`);
  const c1 = spawn(bin, ['--pipe', ep1, '--log-dir', logDir], { stdio: 'ignore' });
  const exited = new Promise((r) => c1.once('exit', (code, signal) => r({ code, signal })));
  const cl = await connectRetry(ep1, 50, 100);
  assert.strictEqual((await cl.hello()).name, 'lycore');
  cl.close();
  assert.strictEqual(fs.statSync(ep1).mode & 0o777, 0o600, 'socket is owner-only');
  c1.kill('SIGTERM');
  const r1 = await exited;
  assert.deepStrictEqual(r1, { code: 0, signal: null }, 'graceful exit on SIGTERM');
  assert.ok(!fs.existsSync(ep1), 'socket file removed on exit');

  // 2) 父进程消失：sh 启动 lycore（后台）后立即退出，lycore 被 init/launchd 收养，应在数秒内自行退出
  const ep2 = path.join(os.tmpdir(), `lycore-sig2-${process.pid}.sock`);
  const sh = spawn('sh', ['-c', `LYCORE_WATCH_PARENT=1 "${bin}" --pipe "${ep2}" --log-dir "${logDir}" >/dev/null 2>&1 & echo $!; sleep 1`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  sh.stdout.on('data', (d) => { out += d; });
  const shExit = new Promise((r) => sh.once('exit', r));
  await until(() => /\d+\n/.test(out), 3000, 'pid printed');
  const pid = Number(out.trim());
  assert.ok(pid > 0, 'got lycore pid');
  await until(() => fs.existsSync(ep2), 5000, 'socket up');
  await shExit; // the parent shell is gone now
  await until(() => !alive(pid), 8000, 'lycore exits after its parent is gone');
  assert.ok(!fs.existsSync(ep2), 'socket removed after orphan exit');

  // 3) 没有 LYCORE_WATCH_PARENT 时不监视父进程（行为不变）
  const ep3 = path.join(os.tmpdir(), `lycore-sig3-${process.pid}.sock`);
  const sh3 = spawn('sh', ['-c', `"${bin}" --pipe "${ep3}" --log-dir "${logDir}" >/dev/null 2>&1 & echo $!; sleep 0.3`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out3 = '';
  sh3.stdout.on('data', (d) => { out3 += d; });
  await new Promise((r) => sh3.once('exit', r));
  const pid3 = Number(out3.trim());
  assert.ok(pid3 > 0);
  await until(() => fs.existsSync(ep3), 5000, 'socket up (3)');
  await sleep(2500);
  assert.ok(alive(pid3), 'still running without the opt-in env');
  process.kill(pid3, 'SIGTERM');
  await until(() => !alive(pid3), 5000, 'stopped by SIGTERM');

  console.log('signals integration test: OK');
})().catch((e) => { console.error(e); process.exit(1); });
