'use strict';
// 守护进程单元测试：假子进程 + 假连接，不依赖 lycore 二进制。Run: node client/supervisor.test.js
const assert = require('assert');
const { EventEmitter } = require('events');
const { createSupervisor, backoffDelay } = require('./supervisor');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await sleep(5); }
};

// 假子进程：kill() 后异步触发 exit；crash() 模拟崩溃。
class FakeChild extends EventEmitter {
  constructor(pid) { super(); this.pid = pid; this.killed = []; this.ignoreKill = false; }
  kill(sig = 'SIGTERM') {
    this.killed.push(sig);
    if (this.ignoreKill && sig !== 'SIGKILL') return true;
    setImmediate(() => this.emit('exit', null, sig));
    return true;
  }
  crash(code = 1) { this.emit('exit', code, null); }
}

function harness(opts = {}) {
  const h = { children: [], hellos: 0, closed: 0, helloImpl: async () => ({ name: 'lycore', apiVersion: 1 }), spawnErr: null, connectFail: 0 };
  h.spawn = (bin, args) => {
    if (h.spawnErr) throw h.spawnErr;
    const c = new FakeChild(1000 + h.children.length);
    c.args = args; h.children.push(c); return c;
  };
  h.connect = async () => {
    if (h.connectFail > 0) { h.connectFail--; throw new Error('ECONNREFUSED'); }
    return { hello: () => { h.hellos++; return h.helloImpl(); }, call: async (m) => ({ m }), close: () => { h.closed++; } };
  };
  h.sup = createSupervisor({
    bin: 'lycore', endpoint: 'ep', logDir: 'logs', spawn: h.spawn, connect: h.connect,
    backoff: { baseMs: 10, factor: 2, maxMs: 40 }, healthIntervalMs: 20, healthTimeoutMs: 50, healthFailures: 2,
    resetAfterMs: 60000, stopGraceMs: 50, ...opts,
  });
  return h;
}

(async () => {
  // 退避曲线
  assert.deepStrictEqual([1, 2, 3, 4, 5].map((n) => backoffDelay(n, { baseMs: 500, factor: 2, maxMs: 3000 })), [500, 1000, 2000, 3000, 3000]);

  // 启动：参数、hello、running
  {
    const h = harness();
    const hello = await h.sup.start();
    assert.strictEqual(hello.name, 'lycore');
    assert.strictEqual(h.sup.state, 'running');
    assert.deepStrictEqual(h.children[0].args, ['--pipe', 'ep', '--log-dir', 'logs']);
    assert.strictEqual((await h.sup.call('x')).m, 'x');
    await waitFor(() => h.hellos >= 3); // 健康探测在持续进行
    await h.sup.stop();
    assert.strictEqual(h.sup.state, 'stopped');
    assert.deepStrictEqual(h.children[0].killed, ['SIGTERM']);
    await assert.rejects(h.sup.call('x'), /not running/);
    await h.sup.stop(); // 幂等
  }

  // 崩溃 -> 退避重启 -> 重新 running
  {
    const h = harness();
    const restarts = [];
    h.sup.on('restart', (r) => restarts.push(r));
    await h.sup.start();
    h.children[0].crash(139);
    await waitFor(() => h.children.length === 2 && h.sup.state === 'running');
    assert.strictEqual(restarts.length, 1);
    assert.strictEqual(restarts[0].attempt, 1);
    assert.strictEqual(restarts[0].delayMs, 10);
    assert.match(restarts[0].reason, /code=139/);
    h.children[1].crash();
    await waitFor(() => h.children.length === 3 && h.sup.state === 'running');
    assert.deepStrictEqual(restarts.map((r) => r.delayMs), [10, 20]);
    await h.sup.stop();
    assert.strictEqual(h.children.length, 3, '停止后不再重启');
  }

  // 超过最大重启次数 -> failed 并上报
  {
    const h = harness({ maxRestarts: 2 });
    let failed = null;
    h.sup.on('failed', (f) => { failed = f; });
    await h.sup.start();
    for (let i = 0; i < 2; i++) {
      h.children[i].crash();
      await waitFor(() => h.children.length === i + 2 && h.sup.state === 'running');
    }
    h.children[2].crash(7);
    await waitFor(() => h.sup.state === 'failed');
    assert.strictEqual(failed.restarts, 2);
    assert.match(failed.reason, /code=7/);
    await sleep(80);
    assert.strictEqual(h.children.length, 3, 'failed 后不再拉起');
    await h.sup.stop();
    assert.strictEqual(h.sup.state, 'stopped');
  }

  // 稳定运行足够久后重启计数清零
  {
    const h = harness({ maxRestarts: 1, resetAfterMs: 30 });
    await h.sup.start();
    for (let i = 0; i < 3; i++) {
      await sleep(60);
      h.children[i].crash();
      await waitFor(() => h.children.length === i + 2 && h.sup.state === 'running');
    }
    assert.notStrictEqual(h.sup.state, 'failed');
    await h.sup.stop();
  }

  // 健康探测连续失败 -> 杀掉并重启
  {
    const h = harness();
    await h.sup.start();
    h.helloImpl = () => new Promise(() => {}); // 挂死：永不应答
    await waitFor(() => h.children[0].killed.length > 0);
    h.helloImpl = async () => ({ name: 'lycore', apiVersion: 1 });
    await waitFor(() => h.children.length === 2 && h.sup.state === 'running');
    await h.sup.stop();
  }

  // 偶发一次探测失败不应重启
  {
    const h = harness({ healthFailures: 3 });
    await h.sup.start();
    let n = 0;
    h.helloImpl = async () => { if (n++ === 0) throw new Error('blip'); return { name: 'lycore' }; };
    await sleep(150);
    assert.strictEqual(h.children.length, 1);
    assert.strictEqual(h.sup.state, 'running');
    await h.sup.stop();
  }

  // 首次连接失败（进程起来但连不上）-> 杀掉重试；spawn 抛错 -> 计入重启直到 failed
  {
    const h = harness({ maxRestarts: 3 });
    h.connectFail = 1;
    await h.sup.start();
    assert.strictEqual(h.children.length, 2);
    assert.strictEqual(h.children[0].killed.length, 1);
    await h.sup.stop();

    const h2 = harness({ maxRestarts: 2 });
    h2.spawnErr = new Error('ENOENT');
    await assert.rejects(h2.sup.start(), /ENOENT/);
    assert.strictEqual(h2.sup.state, 'failed');
    assert.strictEqual(h2.sup.restarts, 2);
  }

  // stop 时子进程不响应 SIGTERM -> 强杀
  {
    const h = harness();
    await h.sup.start();
    h.children[0].ignoreKill = true;
    await h.sup.stop();
    assert.deepStrictEqual(h.children[0].killed, ['SIGTERM', 'SIGKILL']);
    assert.strictEqual(h.sup.state, 'stopped');
  }

  // 退避等待期间 stop：不会再拉起
  {
    const h = harness({ backoff: { baseMs: 80, factor: 1, maxMs: 80 } });
    await h.sup.start();
    h.children[0].crash();
    await waitFor(() => h.sup.state === 'backoff');
    await h.sup.stop();
    await sleep(150);
    assert.strictEqual(h.children.length, 1);
    assert.strictEqual(h.sup.state, 'stopped');
  }

  console.log('supervisor unit test: OK');
})().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
