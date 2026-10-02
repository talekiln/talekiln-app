'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { setSecretStore, UnavailableSecretStore } = require('../src/secrets');
const { buildDiagnosticBundle, redactDiagnosticText, createZip, readZip, submitFeedback } = require('../src/diagnostics');
const diagnosticsRoutes = require('../src/routes/diagnostics');

// 假密钥在运行时拼接，避免源码里出现完整的密钥形状（仓库有密钥扫描）
const j = (...p) => p.join('');
const HOME = path.join(os.tmpdir(), 'fakehome', 'alice');
const PLANTED = {
  skKey: j('sk', '-', 'FAKEFAKEFAKEFAKE1234567890abcd'),
  wsKey: j('sk', '-ws-', 'AbC.dEf.123456789'),
  bearer: j('Bearer ', 'zzzzFAKEtoken1234567890'),
  jwt: j('eyJ', 'hbGciOiJFUzI1NiJ9', '.', 'eyJzdWIiOiJmYWtlIn0', '.', 'c2lnbmF0dXJl'),
  ali: j('LTAI', 'FAKEFAKEFAKE1234'),
  aws: j('AKIA', 'FAKEFAKEFAKE1234'),
  pem: j('-----BEGIN ', 'EC PRIVATE KEY-----\nMHcCAQEEIFAKEFAKEFAKE\n-----END ', 'EC PRIVATE KEY-----'),
  sig: j('Sig', 'nature=abcdef123456'),
  fieldKey: 'fake-field-value-999',
  secretStoreValue: 'exact-store-secret-xyz',
  extra: 'extra-pasted-key-777',
  prompt: '一只在雨夜里弹吉他的猫 PROMPT-BODY-MARKER',
  email: 'alice.fake@example.com',
  user: 'alice',
  oss: j('OSS', 'AccessKeyId=', 'FAKEOSSID1234'),
};

function fakeLog() {
  return [
    '2026-10-01T00:00:00.000Z [INFO] server listening',
    `2026-10-01T00:00:01.000Z [ERROR] upstream failed Authorization: ${PLANTED.bearer}`,
    `request key ${PLANTED.skKey} and ${PLANTED.wsKey}`,
    `jwt ${PLANTED.jwt} ali ${PLANTED.ali} aws ${PLANTED.aws}`,
    `pem ${PLANTED.pem}`,
    `GET https://bucket.oss.example.com/a.png?Expires=1&${PLANTED.oss}&${PLANTED.sig}`,
    `{"api_key":"${PLANTED.fieldKey}","token":"${PLANTED.fieldKey}","ok":true}`,
    `password=${PLANTED.fieldKey}`,
    `{"prompt":"${PLANTED.prompt}","model":"wan2.5","negative_prompt":"${PLANTED.prompt}"}`,
    `contact ${PLANTED.email}`,
    `file ${HOME}${path.sep}AppData${path.sep}talekiln${path.sep}x.png and C:\\Users\\${PLANTED.user}\\Videos\\a.mp4 and /home/${PLANTED.user}/x`,
    `store secret ${PLANTED.secretStoreValue} and ${PLANTED.extra}`,
    'ENCODER_FAIL code=ENCODER_FAIL task 7f1c-ok',
  ].join('\n') + '\n';
}

afterEach(() => setSecretStore(null));

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'diag-')); }

function leaks(text) {
  return Object.entries(PLANTED).filter(([, v]) => text.includes(v)).map(([k]) => k);
}

describe('诊断包脱敏', () => {
  it('植入的假密钥/提示词/邮箱/用户名在 zip 内任何文件中都不出现', () => {
    setSecretStore({ ...new UnavailableSecretStore(), knownSecrets: () => [PLANTED.secretStoreValue] });
    const dir = tmp();
    const logFile = path.join(dir, 'app.log');
    fs.writeFileSync(logFile, fakeLog());
    const mainLog = path.join(dir, 'main.log');
    fs.writeFileSync(mainLog, `uncaughtException: Error: bad ${PLANTED.skKey} at ${HOME}${path.sep}x.js\n`);
    const tasks = [{
      id: 'task-123', provider: 'bailian', kind: 'video', state: 'failed', error_code: 'RATE_LIMIT', vendor_task_id: 'v-1',
      params: JSON.stringify({ prompt: PLANTED.prompt }), result: JSON.stringify({ url: `https://x/y?${PLANTED.sig}` }),
      idempotency_key: PLANTED.skKey, error_message: `failed with ${PLANTED.skKey}`, created_at: 1, updated_at: 2,
    }];
    const { buffer } = buildDiagnosticBundle({
      logFiles: [logFile, mainLog], tasks, versions: { app: '1.2.8' },
      extraSecrets: [PLANTED.extra], homeDir: HOME,
    });
    const files = readZip(buffer);
    assert.deepEqual(Object.keys(files).sort(), ['logs/app.log', 'logs/main.log', 'manifest.json', 'system.json', 'tasks.json', 'versions.json']);
    for (const [name, data] of Object.entries(files)) {
      assert.deepEqual(leaks(data.toString('utf8')), [], `${name} 泄露`);
    }
    // 整个 zip 的解压内容也不含（防止漏掉的新条目）；同时 zip 原始字节里不应出现明文（deflate 之外的文件名等）
    for (const v of Object.values(PLANTED)) assert.equal(buffer.includes(Buffer.from(v)), false);

    // 有用的信息保留：任务号、错误码、版本
    const log = files['logs/app.log'].toString();
    assert.match(log, /ENCODER_FAIL code=ENCODER_FAIL task 7f1c-ok/);
    assert.match(log, /server listening/);
    const t = JSON.parse(files['tasks.json'].toString());
    assert.equal(t[0].id, 'task-123');
    assert.equal(t[0].error_code, 'RATE_LIMIT');
    assert.equal('params' in t[0] || 'result' in t[0] || 'idempotency_key' in t[0], false, '任务只取白名单字段');
    assert.equal(JSON.parse(files['versions.json'].toString()).app, '1.2.8');
    const sys = JSON.parse(files['system.json'].toString());
    assert.ok(sys.platform && sys.arch);
    assert.equal('hostname' in sys || 'username' in sys, false);
  });

  it('自检：未脱敏的原始日志确实包含全部植入项（防止测试空转）', () => {
    const raw = fakeLog();
    assert.equal(leaks(raw).length, Object.keys(PLANTED).length - 0, '原始日志应含全部植入项');
  });

  it('只保留日志末尾并丢弃被截断的首行；缺失文件记录在 manifest', () => {
    const dir = tmp();
    const f = path.join(dir, 'big.log');
    fs.writeFileSync(f, Array.from({ length: 2000 }, (_, i) => `line-${i}-${'x'.repeat(40)}`).join('\n') + '\n');
    const { buffer, manifest } = buildDiagnosticBundle({ logFiles: [f, path.join(dir, 'missing.log')], maxLogBytes: 4096 });
    const log = readZip(buffer)['logs/big.log'].toString();
    assert.ok(log.length <= 4096);
    assert.match(log, /^line-\d+-x+\n/); // 首行完整
    assert.match(log, /line-1999-/);
    assert.ok(manifest.notes.some((n) => n.startsWith('big.log') && n.includes('末尾')));
    assert.ok(manifest.notes.some((n) => n.startsWith('missing.log') && n.includes('无法读取')));
  });

  it('redactDiagnosticText 不破坏普通文本', () => {
    assert.equal(redactDiagnosticText('render done in 3.2s, 12 clips'), 'render done in 3.2s, 12 clips');
  });
});

describe('匿名统计客户端（opt-in）', () => {
  const { createTelemetry } = require('../src/diagnostics');
  const make = (enabled) => {
    const sent = [];
    const state = { enabled };
    const t = createTelemetry({ isEnabled: () => state.enabled, getInstallId: () => 'a1b2c3d4-e5f6-4789-a1b2-c3d4e5f60001', send: async (b) => { sent.push(b); }, appVersion: '1.2.8' });
    return { t, sent, state };
  };

  it('默认关闭时什么都不记录、不发送', async () => {
    const { t, sent } = make(false);
    assert.equal(t.track('app_open'), false);
    assert.equal(t.pending(), 0);
    await t.flush();
    assert.equal(sent.length, 0);
  });

  it('开启后只发送白名单事件与 code/step，丢弃其它字段；中途关闭则清空', async () => {
    const { t, sent, state } = make(true);
    t.track('project_created', { prompt: PLANTED.prompt, path: HOME });
    t.track('task_failed', { code: 'RATE_LIMIT', message: PLANTED.skKey });
    t.track('task_failed', { code: PLANTED.skKey }); // 形状不合法的 code 被丢弃，事件本身保留
    t.track('custom_thing');
    assert.equal(t.pending(), 3);
    await t.flush();
    assert.deepEqual(sent[0].events, [{ name: 'project_created' }, { name: 'task_failed', code: 'RATE_LIMIT' }, { name: 'task_failed' }]);
    assert.equal(JSON.stringify(sent).includes(PLANTED.prompt), false);
    t.track('app_open');
    state.enabled = false;
    await t.flush();
    assert.equal(t.pending(), 0);
    assert.equal(sent.length, 1);
  });
});

describe('zip', () => {
  it('往返一致，且拒绝路径穿越条目名', () => {
    const z = createZip([{ name: 'a/b.txt', data: '你好' }, { name: 'c.bin', data: Buffer.from([0, 1, 2]) }]);
    const r = readZip(z);
    assert.equal(r['a/b.txt'].toString(), '你好');
    assert.deepEqual([...r['c.bin']], [0, 1, 2]);
    assert.equal(z.readUInt32LE(0), 0x04034b50);
    for (const bad of ['../x', '/abs', 'a\\b']) assert.throws(() => createZip([{ name: bad, data: '' }]));
  });
});

describe('POST /diagnostics/feedback 客户端', () => {
  const okFetch = (calls) => async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 201, json: async () => ({ id: 'fb1' }) }; };

  it('发送文字、任务号与 base64 诊断包', async () => {
    const calls = [];
    const bundle = createZip([{ name: 'a.txt', data: 'x' }]);
    const r = await submitFeedback({ baseUrl: 'https://cloud.example/', message: ' 导出失败 ', taskId: 'task-1', bundle, fetchImpl: okFetch(calls) });
    assert.equal(r.id, 'fb1');
    assert.equal(calls[0].url, 'https://cloud.example/feedback');
    assert.equal(calls[0].body.message, '导出失败');
    assert.equal(calls[0].body.taskId, 'task-1');
    assert.deepEqual(Buffer.from(calls[0].body.diagnostic, 'base64'), bundle);
  });

  it('本地先行校验：空描述、过长、诊断包过大、无云端地址；云端 429 映射为 RATE_LIMITED', async () => {
    const f = okFetch([]);
    const code = (p) => p.then(() => null, (e) => e.code);
    assert.equal(await code(submitFeedback({ baseUrl: 'https://c', message: '  ', fetchImpl: f })), 'EMPTY_MESSAGE');
    assert.equal(await code(submitFeedback({ baseUrl: 'https://c', message: 'x'.repeat(4001), fetchImpl: f })), 'MESSAGE_TOO_LONG');
    assert.equal(await code(submitFeedback({ baseUrl: 'https://c', message: 'x', bundle: Buffer.alloc(11), maxBundleBytes: 10, fetchImpl: f })), 'BUNDLE_TOO_LARGE');
    assert.equal(await code(submitFeedback({ message: 'x', fetchImpl: f })), 'NO_CLOUD_URL');
    const limited = async () => ({ ok: false, status: 429, json: async () => ({ error: 'rate_limited' }) });
    assert.equal(await code(submitFeedback({ baseUrl: 'https://c', message: 'x', fetchImpl: limited })), 'RATE_LIMITED');
  });
});

describe('/api/v1/diagnostics 路由', () => {
  it('GET /diagnostics/bundle 返回已脱敏 zip', async () => {
    const dir = tmp();
    const logFile = path.join(dir, 'app.log');
    fs.writeFileSync(logFile, fakeLog());
    const h = diagnosticsRoutes({ log: { error() {} }, logFiles: () => [logFile], versions: { app: '9.9.9' } });
    const app = express();
    app.get('/diagnostics/bundle', h.exportBundle);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/diagnostics/bundle`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/zip');
      const files = readZip(Buffer.from(await res.arrayBuffer()));
      // 这两项只有注册进密钥库/传入 extraSecrets 才能被识别，路由里没有
      const left = leaks(files['logs/app.log'].toString()).filter((k) => !['secretStoreValue', 'extra', 'user'].includes(k)); // user：测试用的假 home 目录不是本机真实 home
      assert.deepEqual(left, []);
    } finally { server.close(); }
  });
});
