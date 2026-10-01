'use strict';
// ffmpeg 供应模块测试：本地 http 服务 + 小型夹具文件。Run: node client/ffmpeg-provision.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { provision, downloadFile, loadManifest, ProvisionError } = require('./ffmpeg-provision');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// 夹具：确定性伪随机 300KB（假 ffmpeg 二进制）
const fixture = Buffer.alloc(300 * 1024);
for (let i = 0; i < fixture.length; i++) fixture[i] = (i * 31 + (i >> 8)) & 0xff;
const FIX_SHA = sha(fixture);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lycore-prov-'));
const log = []; // 服务器收到的请求
let rangeSupport = true;
const server = http.createServer((req, res) => {
  log.push({ url: req.url, range: req.headers.range || null });
  if (req.url === '/redir/ff') { res.writeHead(302, { Location: '/files/ff' }); return res.end(); }
  if (req.url === '/files/ff' || req.url === '/files/bad') {
    const body = req.url === '/files/bad' ? Buffer.concat([fixture.subarray(0, 100), Buffer.from('tampered')]) : fixture;
    const m = rangeSupport && /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      if (start >= body.length) { res.writeHead(416); return res.end(); }
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`, 'Content-Length': body.length - start });
      return res.end(body.subarray(start));
    }
    res.writeHead(200, { 'Content-Length': body.length });
    return res.end(body);
  }
  res.writeHead(404); res.end();
});

const manifestFor = (files, version = '1.0.0') => ({ version, builds: { 'test-x64': { files } } });

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const entry = (p = 'files/ff', hash = FIX_SHA, extra = {}) => ({ name: 'ffmpeg', path: p, sha256: hash, ...extra });
  const run = (files, o = {}) => provision({ appDataDir: tmp, baseUrl: base, platform: 'test-x64', manifest: manifestFor(files), ...o });

  // 随包清单是占位：不发请求就拒绝
  {
    const n = log.length;
    const m = loadManifest();
    assert.ok(/TODO/.test(m._comment) && /TODO/.test(m.version));
    for (const platform of Object.keys(m.builds)) {
      await assert.rejects(provision({ appDataDir: tmp, baseUrl: base, platform }), (e) => e instanceof ProvisionError && e.code === 'manifest_placeholder');
    }
    assert.strictEqual(log.length, n, '占位清单不得触发网络请求');
    await assert.rejects(run([entry('files/ff', 'TODO_SHA')]), (e) => e.code === 'manifest_placeholder');
    await assert.rejects(provision({ appDataDir: tmp, platform: 'nope-x64', manifest: manifestFor([entry()]) }), (e) => e.code === 'unsupported_platform');
    assert.strictEqual(log.length, n);
  }

  // 全新下载（含重定向）+ 进度
  {
    const prog = [];
    const r = await run([entry('redir/ff')], { onProgress: (p) => prog.push(p) });
    assert.strictEqual(r.dir, path.join(tmp, 'ffmpeg', '1.0.0'));
    assert.ok(fs.readFileSync(r.files[0]).equals(fixture));
    assert.ok(!fs.existsSync(r.files[0] + '.part'));
    assert.ok(prog.length && prog[prog.length - 1].received === fixture.length && prog[0].file === 'ffmpeg');
    if (process.platform !== 'win32') assert.ok(fs.statSync(r.files[0]).mode & 0o100, '可执行');
  }

  // 已存在且哈希一致：不再请求；被篡改则重新下载
  {
    const n = log.length;
    const r = await run([entry()]);
    assert.strictEqual(log.length, n, '已就绪不应联网');
    fs.writeFileSync(r.files[0], 'corrupt');
    await run([entry()]);
    assert.strictEqual(log.length, n + 1);
    assert.ok(fs.readFileSync(r.files[0]).equals(fixture));
  }

  // 断点续传：已有前 100000 字节 -> 带 Range，结果正确
  {
    const dest = path.join(tmp, 'resume', 'ffmpeg');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.part', fixture.subarray(0, 100000));
    log.length = 0;
    const r = await downloadFile(base + 'files/ff', dest, { sha256: FIX_SHA, size: fixture.length });
    assert.strictEqual(r.resumedFrom, 100000);
    assert.strictEqual(log[0].range, 'bytes=100000-');
    assert.ok(fs.readFileSync(dest).equals(fixture));
  }

  // 服务器不支持 Range（回 200）：整体重下仍正确
  {
    rangeSupport = false;
    const dest = path.join(tmp, 'norange', 'ffmpeg');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.part', fixture.subarray(0, 5000));
    const r = await downloadFile(base + 'files/ff', dest, { sha256: FIX_SHA });
    assert.strictEqual(r.resumedFrom, 0);
    assert.ok(fs.readFileSync(dest).equals(fixture));
    rangeSupport = true;
  }

  // .part 已完整（416）：直接校验通过
  {
    const dest = path.join(tmp, 'full', 'ffmpeg');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.part', fixture);
    await downloadFile(base + 'files/ff', dest, { sha256: FIX_SHA });
    assert.ok(fs.readFileSync(dest).equals(fixture));
  }

  // 哈希不一致：拒绝，不留最终文件也不留 .part
  {
    const dest = path.join(tmp, 'bad', 'ffmpeg');
    await assert.rejects(downloadFile(base + 'files/bad', dest, { sha256: FIX_SHA }), (e) => e.code === 'sha256_mismatch' && e.expected === FIX_SHA && e.actual !== FIX_SHA);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.part'));
    // 续传出来的内容拼错同样被拒绝（本地残留的坏前缀 + 服务器的好后缀）
    const dest2 = path.join(tmp, 'badresume', 'ffmpeg');
    fs.mkdirSync(path.dirname(dest2), { recursive: true });
    fs.writeFileSync(dest2 + '.part', Buffer.alloc(1000, 7));
    await assert.rejects(downloadFile(base + 'files/ff', dest2, { sha256: FIX_SHA }), (e) => e.code === 'sha256_mismatch');
    assert.ok(!fs.existsSync(dest2) && !fs.existsSync(dest2 + '.part'));
  }

  // 大小不符；HTTP 错误；非 https 地址
  {
    const dest = path.join(tmp, 'size', 'ffmpeg');
    await assert.rejects(downloadFile(base + 'files/ff', dest, { sha256: FIX_SHA, size: 123 }), (e) => e.code === 'size_mismatch');
    assert.ok(!fs.existsSync(dest));
    await assert.rejects(downloadFile(base + 'nope', path.join(tmp, 'e404', 'f'), { sha256: FIX_SHA }), (e) => e.code === 'http_error' && e.status === 404);
    await assert.rejects(downloadFile('http://example.com/ffmpeg', path.join(tmp, 'ins', 'f'), { sha256: FIX_SHA }), (e) => e.code === 'insecure_url');
  }

  console.log('ffmpeg provision test: OK');
})().then(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); },
  (e) => { console.error(e); server.close(); process.exit(1); });
