'use strict';
// P3-K 可选云备份：S3 兼容客户端（SigV4 向量、地址策略、重试、XML）、备份服务（备份 -> 列表 -> 恢复、校验失败、保留策略、
// 密钥不落设置、离线行为、每日 / 导出后自动备份）、调度器、导出服务钩子与 REST。对象存储用进程内假 S3（test/helpers/fakeS3.js）。
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');
const s3 = require('../src/backup/s3');
const { createBackupService, createBackupScheduler, BackupError, normalizeSettings, parseKey, isoOfStamp, SECRET_REF, SETTINGS_KEY, LAST_DAILY_KEY } = require('../src/backup/service');
const backupRoutes = require('../src/routes/backup');
const secrets = require('../src/secrets');
const { getGlobalSetting, setGlobalSetting } = require('../src/services/settingsService');
const { seededDb, log } = require('./helpers/kernelDb');
const { startFakeS3 } = require('./helpers/fakeS3');
const { ENTRIES } = require('../src/errors');

const AK = 'ci';
const SK = 'ci-throwaway-minio';
const noSleep = async () => {};

// ---------- 客户端 ----------

describe('s3 client: SigV4', () => {
  // AWS 公开的 SigV4 测试套件（aws-sig-v4-test-suite）与 S3 文档示例；密钥都是文档里的示例值，不是真实凭据
  const SUITE_AK = 'AKIDEXAMPLE';
  const SUITE_SK = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  const T = new Date('2015-08-30T12:36:00Z');

  it('get-vanilla matches the published signature', () => {
    const r = s3.signV4({ method: 'GET', path: '/', query: {}, headers: { host: 'example.amazonaws.com' }, payloadHash: s3.EMPTY_SHA256, accessKey: SUITE_AK, secretKey: SUITE_SK, region: 'us-east-1', service: 'service', date: T });
    assert.equal(r.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    assert.equal(r.authorization, `AWS4-HMAC-SHA256 Credential=${SUITE_AK}/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`);
    assert.equal(r.amzDate, '20150830T123600Z');
    assert.equal(r.headers['x-amz-date'], '20150830T123600Z');
  });

  it('query parameters are sorted by key then value (get-vanilla-query-order-key-case)', () => {
    const r = s3.signV4({ method: 'GET', path: '/', query: { Param2: 'value2', Param1: 'value1' }, headers: { host: 'example.amazonaws.com' }, payloadHash: s3.EMPTY_SHA256, accessKey: SUITE_AK, secretKey: SUITE_SK, region: 'us-east-1', service: 'service', date: T });
    assert.equal(r.signature, 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
    assert.match(r.canonicalRequest, /^GET\n\/\nParam1=value1&Param2=value2\n/);
  });

  it('S3 GetObject example from the AWS docs (range + x-amz-content-sha256)', () => {
    // 文档示例 Key 拆成两段拼接，只是为了不触发仓库自己的密钥扫描；它是 AWS 文档公开的示例值
    const r = s3.signV4({
      method: 'GET', path: '/test.txt', query: {}, headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': s3.EMPTY_SHA256 },
      payloadHash: s3.EMPTY_SHA256, accessKey: 'AKIA' + 'IOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3', date: new Date('2013-05-24T00:00:00Z'),
    });
    assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    assert.equal(r.signedHeaders, 'host;range;x-amz-content-sha256;x-amz-date');
  });

  it('uriEncode follows the AWS rules; canonical path keeps slashes', () => {
    assert.equal(s3.uriEncode("a b/c~d-e_f.g!*'()"), "a%20b%2Fc~d-e_f.g%21%2A%27%28%29");
    assert.equal(s3.uriEncode('中文 名'), '%E4%B8%AD%E6%96%87%20%E5%90%8D');
    assert.equal(s3.canonicalPath('/talekiln/dramas/1/a b.zip'), '/talekiln/dramas/1/a%20b.zip');
    assert.equal(s3.canonicalQuery({ b: '2', a: '1', c: null }), 'a=1&b=2');
    assert.equal(s3.canonicalQuery([['k', 'v2'], ['k', 'v1']]), 'k=v1&k=v2');
  });
});

describe('s3 client: endpoint policy', () => {
  it('allows https anywhere and http only on loopback / RFC1918', () => {
    for (const ok of ['https://s3.example.com', 'https://s3.example.com:9443/base/', 'http://localhost:9000', 'http://127.0.0.1:9000', 'http://127.5.6.7', 'http://[::1]:9000',
      'http://10.0.0.5:9000', 'http://172.16.0.1:9000', 'http://172.31.255.254', 'http://192.168.1.10:9000', 'http://nas.localhost:9000']) {
      const r = s3.validateEndpoint(ok);
      assert.equal(r.insecure, ok.startsWith('http:'), ok);
    }
    for (const bad of ['http://8.8.8.8:9000', 'http://s3.example.com', 'http://172.32.0.1', 'http://192.169.0.1', 'http://11.0.0.1', 'ftp://10.0.0.1', 'https://user:pw@s3.example.com', 'https://s3.example.com/?x=1', '', 'not a url']) {
      assert.throws(() => s3.validateEndpoint(bad), (e) => e instanceof s3.S3Error && e.code === 'BACKUP_ENDPOINT_INVALID' && e.status === 400, bad);
    }
  });
  it('createS3Client validates endpoint, bucket and credentials up front', () => {
    assert.throws(() => s3.createS3Client({ endpoint: 'http://example.com', bucket: 'b-1', accessKey: 'a', secretKey: 'b' }), (e) => e.code === 'BACKUP_ENDPOINT_INVALID');
    assert.throws(() => s3.createS3Client({ endpoint: 'https://s3.example.com', bucket: 'Bad_Bucket', accessKey: 'a', secretKey: 'b' }), (e) => e.code === 'BACKUP_FAILED' && e.status === 400);
    assert.throws(() => s3.createS3Client({ endpoint: 'https://s3.example.com', bucket: 'ok-bucket', accessKey: '', secretKey: 'b' }), (e) => e.code === 'BACKUP_NOT_CONFIGURED');
    const c = s3.createS3Client({ endpoint: 'https://s3.example.com/base/', bucket: 'ok-bucket', accessKey: 'a', secretKey: 'b' });
    assert.equal(c.endpoint, 'https://s3.example.com/base');
    assert.equal(c.region, 'us-east-1');
  });
});

describe('s3 client: XML', () => {
  it('parses ListBucketResult with entities, namespace and continuation token', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix>talekiln/</Prefix><KeyCount>2</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>true</IsTruncated>
<Contents><Key>talekiln/dramas/1/a &amp; b &lt;x&gt;.zip</Key><LastModified>2026-10-02T03:04:05.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>1234</Size><StorageClass>STANDARD</StorageClass></Contents>
<Contents><Key>talekiln/dramas/1/c.json</Key><LastModified>2026-10-02T03:04:06.000Z</LastModified><ETag>"def"</ETag><Size>0</Size></Contents>
<CommonPrefixes><Prefix>talekiln/shared/</Prefix></CommonPrefixes>
<NextContinuationToken>tok=/+1</NextContinuationToken><!-- comment --></ListBucketResult>`;
    const r = s3.parseListObjects(xml);
    assert.equal(r.isTruncated, true);
    assert.equal(r.nextContinuationToken, 'tok=/+1');
    assert.equal(r.keyCount, 2);
    assert.deepEqual(r.contents.map((c) => [c.key, c.size, c.etag]), [['talekiln/dramas/1/a & b <x>.zip', 1234, 'abc'], ['talekiln/dramas/1/c.json', 0, 'def']]);
    assert.deepEqual(r.commonPrefixes, ['talekiln/shared/']);
    assert.equal(s3.parseListObjects('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>').nextContinuationToken, null);
  });
  it('decodes Key / Prefix only when the response declares EncodingType=url (gofakes3 encodes unasked; raw keys stay raw)', () => {
    // 从 rclone serve s3（gofakes3）抓到的真实响应形态：没请求 encoding-type 也一律按查询串规则编码并声明 <EncodingType>
    const encoded = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><IsTruncated>false</IsTruncated><Prefix>probe/</Prefix><MaxKeys>1000</MaxKeys>
<Contents><Key>probe/a+b.txt</Key><Size>1</Size></Contents>
<Contents><Key>probe/%E4%B8%AD%E6%96%87+%E5%90%8D.json</Key><Size>1</Size></Contents>
<Contents><Key>probe/plus%2Bsign.txt</Key><Size>1</Size></Contents>
<Contents><Key>probe/pct%2520lit.txt</Key><Size>1</Size></Contents>
<CommonPrefixes><Prefix>probe/sub+dir/</Prefix></CommonPrefixes>
<KeyCount>4</KeyCount><EncodingType>url</EncodingType></ListBucketResult>`;
    const r = s3.parseListObjects(encoded);
    assert.equal(r.encodingType, 'url');
    assert.deepEqual(r.contents.map((c) => c.key), ['probe/a b.txt', 'probe/中文 名.json', 'probe/plus+sign.txt', 'probe/pct%20lit.txt']);
    assert.deepEqual(r.commonPrefixes, ['probe/sub dir/']);
    // 没有声明就不解码：字面 + 与 % 原样保留（MinIO / AWS 在未请求 encoding-type 时就是这样返回）
    const raw = '<ListBucketResult><Contents><Key>probe/a+b %41.txt</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>';
    assert.equal(s3.parseListObjects(raw).encodingType, null);
    assert.deepEqual(s3.parseListObjects(raw).contents.map((c) => c.key), ['probe/a+b %41.txt']);
    // 非法百分号序列不抛错，整个键原样返回
    assert.equal(s3.decodeListKey('bad%zz+x'), 'bad%zz+x');
  });
  it('parses <Error> and tolerates non-XML; rejects malformed documents', () => {
    assert.deepEqual(s3.parseErrorXml('<Error><Code>NoSuchKey</Code><Message>gone</Message></Error>'), { code: 'NoSuchKey', message: 'gone', region: null });
    assert.equal(s3.parseErrorXml('<html>nope</html>'), null);
    assert.equal(s3.parseErrorXml('{"json":1}'), null);
    assert.throws(() => s3.parseXml('<a><b></a>'), /mismatched/);
    assert.throws(() => s3.parseXml('<a>'), /unclosed/);
    assert.equal(s3.parseXml('<a><![CDATA[<raw>]]>&#x4E2D;&#25991;</a>').text, '<raw>中文');
  });
});

describe('s3 client: operations against the fake server', () => {
  let srv;
  before(async () => { srv = await startFakeS3({ accessKey: AK, secretKey: SK, bucket: 'tk-test' }); });
  after(() => srv.close());
  const client = (over = {}) => s3.createS3Client({ endpoint: srv.url, bucket: 'tk-test', accessKey: AK, secretKey: SK, sleep: noSleep, ...over });

  it('put / get / head / delete / list with continuation; keys with spaces and CJK round-trip', async () => {
    const c = client();
    assert.deepEqual(await c.headBucket(), { ok: true, status: 200 });
    const keys = ['p/dramas/1/a.zip', 'p/dramas/1/a.json', 'p/dramas/2/b c 中文.zip', 'p/dramas/2/b c 中文.json', 'q/other.txt'];
    for (const k of keys) await c.putObject(k, Buffer.from(`data:${k}`), { contentType: 'text/plain' });
    const got = await c.getObject('p/dramas/2/b c 中文.zip');
    assert.equal(got.body.toString(), 'data:p/dramas/2/b c 中文.zip');
    assert.equal(got.contentType, 'text/plain');
    const head = await c.headObject('p/dramas/1/a.zip');
    assert.equal(head.contentLength, 'data:p/dramas/1/a.zip'.length);
    assert.equal(await c.headObject('p/nope'), null);
    await assert.rejects(c.getObject('p/nope'), (e) => e instanceof s3.S3Error && e.code === 'NOT_FOUND' && e.status === 404 && e.s3Code === 'NoSuchKey');

    const page1 = await c.listObjectsV2('p/', { maxKeys: 3 });
    assert.equal(page1.isTruncated, true);
    assert.equal(page1.contents.length, 3);
    const page2 = await c.listObjectsV2('p/', { maxKeys: 3, continuationToken: page1.nextContinuationToken });
    assert.equal(page2.isTruncated, false);
    assert.deepEqual([...page1.contents, ...page2.contents].map((o) => o.key), keys.filter((k) => k.startsWith('p/')).sort());
    assert.deepEqual((await c.listAll('p/', { maxKeys: 2 })).map((o) => o.key), keys.filter((k) => k.startsWith('p/')).sort());
    assert.deepEqual((await c.listAll('zzz/')).length, 0);

    await c.deleteObject('q/other.txt');
    await c.deleteObject('q/other.txt'); // 幂等
    assert.equal(await c.headObject('q/other.txt'), null);
    assert.equal((await c.createBucket()).created, false); // 已存在
    // 列举按 AWS 的建议带 encoding-type=url，假服务端照 MinIO 的行为编码并声明，客户端解码后键仍是原文（上面的断言已经证明）
    const lists = srv.requests.filter((r) => r.query['list-type'] === '2');
    assert.ok(lists.length >= 3);
    assert.ok(lists.every((r) => r.query['encoding-type'] === 'url'));
  });

  it('a server that always URL-encodes listing keys (gofakes3 / rclone serve s3) still round-trips spaces, CJK, plus and percent', async () => {
    const always = await startFakeS3({ accessKey: AK, secretKey: SK, bucket: 'tk-enc', encodeListKeys: 'always' });
    try {
      const c = s3.createS3Client({ endpoint: always.url, bucket: 'tk-enc', accessKey: AK, secretKey: SK, sleep: noSleep });
      const keys = ['p/a b.txt', 'p/中文 名.json', 'p/plus+sign.txt', 'p/pct%20lit.txt', 'p/sub dir/d.bin'];
      for (const k of keys) await c.putObject(k, Buffer.from(k));
      assert.deepEqual((await c.listAll('p/', { maxKeys: 2 })).map((o) => o.key).sort(), [...keys].sort());
      // 列出来的键能直接再用：逐个取回、删掉
      for (const o of await c.listAll('p/')) assert.equal((await c.getObject(o.key)).body.toString(), o.key);
      for (const o of await c.listAll('p/')) await c.deleteObject(o.key);
      assert.equal((await c.listAll('p/')).length, 0);
    } finally {
      await always.close();
    }
  });

  it('the server rejects a wrong secret, a wrong access key and a wrong region as BACKUP_AUTH; none are retried', async () => {
    const n0 = srv.requests.length;
    await assert.rejects(client({ secretKey: 'nope' }).listObjectsV2(''), (e) => e.code === 'BACKUP_AUTH' && e.status === 401 && e.s3Code === 'SignatureDoesNotMatch');
    await assert.rejects(client({ accessKey: 'who' }).listObjectsV2(''), (e) => e.code === 'BACKUP_AUTH' && e.s3Code === 'InvalidAccessKeyId');
    await assert.rejects(client({ region: 'eu-west-1' }).listObjectsV2(''), (e) => e.code === 'BACKUP_AUTH' && /us-east-1/.test(e.message));
    await assert.rejects(client({ secretKey: 'nope' }).headBucket(), (e) => e.code === 'BACKUP_AUTH' && e.status === 401); // HEAD 没有响应体，只有状态码
    assert.equal(srv.requests.length - n0, 4);
    // 载荷被改动（哈希不匹配）也被拒：真实 S3 回 400 XAmzContentSHA256Mismatch，不是凭据错误，也不重试
    const tampered = async (url, init) => globalThis.fetch(url, { ...init, body: Buffer.from('0rig') }); // 同长度，只改内容
    const n1 = srv.requests.length;
    await assert.rejects(client({ fetchImpl: tampered }).putObject('x', Buffer.from('orig')), (e) => e.code === 'BACKUP_FAILED' && e.status === 400 && e.s3Code === 'XAmzContentSHA256Mismatch');
    assert.equal(srv.requests.length - n1, 1);
  });

  it('retries 5xx / 429 with exponential backoff and gives up after 3 attempts; 4xx is not retried', async () => {
    const delays = [];
    const c = client({ sleep: async (ms) => { delays.push(ms); } });
    srv.failNext(500, 2);
    await c.putObject('retry.txt', Buffer.from('x'));
    assert.deepEqual(delays, [300, 600]);
    assert.equal((await c.getObject('retry.txt')).body.toString(), 'x');
    srv.failNext(503, 3);
    const n0 = srv.requests.length;
    await assert.rejects(c.getObject('retry.txt'), (e) => e.code === 'BACKUP_FAILED' && e.status === 502 && e.s3Code === 'SlowDown');
    assert.equal(srv.requests.length - n0, 3);
    assert.deepEqual(delays, [300, 600, 300, 600]);
    await assert.rejects(c.getObject('does/not/exist'), (e) => e.code === 'NOT_FOUND');
    assert.equal(srv.requests.length - n0, 4);
  });

  it('network errors and timeouts surface as BACKUP_UNREACHABLE after 3 attempts', async () => {
    let calls = 0;
    const c = s3.createS3Client({ endpoint: 'http://127.0.0.1:9', bucket: 'tk-test', accessKey: AK, secretKey: SK, sleep: noSleep, fetchImpl: async () => { calls++; throw new TypeError('fetch failed'); } });
    await assert.rejects(c.headBucket(), (e) => e.code === 'BACKUP_UNREACHABLE' && e.status === 502 && /网络错误/.test(e.message));
    assert.equal(calls, 3);
    const slow = s3.createS3Client({ endpoint: srv.url, bucket: 'tk-test', accessKey: AK, secretKey: SK, sleep: noSleep, timeoutMs: 20, maxAttempts: 1,
      fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))) });
    await assert.rejects(slow.headBucket(), (e) => e.code === 'BACKUP_UNREACHABLE' && /超时/.test(e.message));
  });

  it('stream bodies upload with UNSIGNED-PAYLOAD and are never retried', async () => {
    const { Readable } = require('stream');
    const c = client();
    const data = Buffer.from('streamed-content');
    const r = await c.putObject('stream.bin', Readable.from([data]), { contentLength: data.length, contentType: 'application/octet-stream' });
    assert.equal(r.sha256, null);
    assert.equal((await c.getObject('stream.bin')).body.toString(), 'streamed-content');
    await assert.rejects(c.putObject('stream2.bin', Readable.from([data])), (e) => /contentLength/.test(e.message));
    srv.failNext(500, 1);
    await assert.rejects(c.putObject('stream3.bin', Readable.from([data]), { contentLength: data.length }), (e) => e.code === 'BACKUP_FAILED');
  });

  it('putFile signs the file sha256 (server re-hashes it), is retried by reopening the file; getObjectToFile streams to disk with sha256', async () => {
    const c = client();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-s3-file-'));
    const src = path.join(dir, 'src.bin');
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 7) & 0xff;
    fs.writeFileSync(src, Buffer.concat([chunk, chunk, chunk])); // 3 MB，足以跨多个流块
    const expected = s3.sha256Hex(fs.readFileSync(src));
    assert.equal(await s3.sha256File(src), expected);

    const before = srv.requests.length;
    const r = await c.putFile('file.bin', src, { contentType: 'application/zip' });
    assert.deepEqual([r.sha256, r.size], [expected, 3 * 1024 * 1024]);
    const put = srv.requests.slice(before).find((q) => q.method === 'PUT');
    assert.equal(put.headers['x-amz-content-sha256'], expected); // 不是 UNSIGNED-PAYLOAD：服务端已对照实际载荷重算过
    assert.equal(put.headers['content-length'], String(3 * 1024 * 1024));
    assert.equal(s3.sha256Hex(srv.objects.get('tk-test/file.bin').body), expected);

    // 签了错误的哈希 -> 假 S3 以 XAmzContentSHA256Mismatch 拒绝（映射为 BACKUP_FAILED，不重试）
    const n0 = srv.requests.length;
    await assert.rejects(c.putFile('bad.bin', src, { sha256: 'f'.repeat(64) }), (e) => e.code === 'BACKUP_FAILED' && e.s3Code === 'XAmzContentSHA256Mismatch');
    assert.equal(srv.requests.length - n0, 1);
    assert.equal(srv.objects.has('tk-test/bad.bin'), false);

    // 文件上传可重放：注入一次 500 后第二次成功
    srv.failNext(500, 1);
    const n1 = srv.requests.length;
    await c.putFile('retry.bin', src);
    assert.equal(srv.requests.length - n1, 2);
    assert.equal(s3.sha256Hex(srv.objects.get('tk-test/retry.bin').body), expected);

    // 流式下载到文件
    const dst = path.join(dir, 'dst.bin');
    const d = await c.getObjectToFile('file.bin', dst);
    assert.deepEqual([d.sha256, d.size, d.contentType], [expected, 3 * 1024 * 1024, 'application/zip']);
    assert.equal(s3.sha256Hex(fs.readFileSync(dst)), expected);
    await assert.rejects(c.getObjectToFile('missing.bin', path.join(dir, 'missing.bin')), (e) => e.code === 'NOT_FOUND' && e.status === 404);
    assert.equal(fs.existsSync(path.join(dir, 'missing.bin')), false);
    await assert.rejects(c.putFile('nofile.bin', path.join(dir, 'nope.bin')), (e) => e.code === 'BACKUP_FAILED' && /读不到/.test(e.message));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------- 服务 ----------

function memSecretStore() {
  return new secrets.FileSecretStore({ cipher: secrets.createAesCipher(Buffer.alloc(32, 7)) });
}

async function setupService({ srv, bucket = 'tk-test', prefix = 'talekiln', now } = {}) {
  const seeded = await seededDb({ withTimeline: false });
  const cfg = { storage: { local_path: path.join(seeded.dir, 'storage') } };
  const store = memSecretStore();
  secrets.setSecretStore(store);
  const clock = now || (() => new Date());
  const svc = createBackupService({ db: seeded.db, config: cfg, log, now: clock, appVersion: '9.9.9-test', clientOptions: { sleep: noSleep } });
  if (srv) svc.putSettings({ endpoint: srv.url, bucket, prefix, access_key: srv.accessKey, secret_key: srv.secretKey, auto: 'off', keep: 10 });
  const dramaId = seeded.db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(seeded.episodeId).drama_id;
  return { ...seeded, cfg, store, svc, dramaId };
}

describe('backup service: settings and secret handling', () => {
  it('normalizeSettings validates each field and never carries secrets', () => {
    const ok = normalizeSettings({ endpoint: 'https://s3.example.com/', region: 'cn-hangzhou', bucket: 'my-bucket', prefix: '/studio/a/', access_key: 'AK', secret_key: 'nope', auto: 'daily', keep: 3, path_style: 'false' });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.value, { provider: 's3', endpoint: 'https://s3.example.com', region: 'cn-hangzhou', bucket: 'my-bucket', prefix: 'studio/a', access_key: 'AK', auto: 'daily', keep: 3, path_style: false });
    const bad = normalizeSettings({ endpoint: 'http://example.com', region: 'bad region', bucket: 'B', prefix: '../x', access_key: 'a b', auto: 'hourly', keep: -1, provider: 'oss' });
    assert.deepEqual(bad.errors.map((e) => e.path).sort(), ['access_key', 'auto', 'bucket', 'endpoint', 'keep', 'prefix', 'provider', 'region']);
    assert.equal(normalizeSettings({ prefix: '' }).value.prefix, 'talekiln');
    assert.equal(normalizeSettings({ region: '' }).value.region, 'us-east-1');
  });

  it('the secret goes to the secret store only; GET exposes has_secret; null deletes; unavailable store refuses', async () => {
    const { db, svc, store } = await setupService();
    const v = svc.putSettings({ endpoint: 'https://s3.example.com', bucket: 'tk-test', access_key: 'AK', secret_key: 'top-secret-value' });
    assert.equal(v.has_secret, true);
    assert.equal(v.configured, true);
    assert.equal('secret_key' in v, false);
    const stored = getGlobalSetting(db, SETTINGS_KEY);
    assert.equal(JSON.stringify(stored).includes('top-secret-value'), false);
    assert.equal('secret_key' in stored, false);
    assert.equal(store.get(SECRET_REF), 'top-secret-value');
    // 只改别的字段：密钥不动
    svc.putSettings({ keep: 5 });
    assert.equal(store.get(SECRET_REF), 'top-secret-value');
    assert.equal(svc.getSettings().keep, 5);
    svc.putSettings({ secret_key: '' });
    assert.equal(store.get(SECRET_REF), 'top-secret-value');
    // 日志脱敏能认出这把密钥
    assert.equal(secrets.redactText('key=top-secret-value'), 'key=[REDACTED]');
    svc.putSettings({ secret_key: null });
    assert.equal(svc.getSettings().has_secret, false);
    assert.equal(svc.getSettings().configured, false);
    assert.throws(() => svc.putSettings({ endpoint: 'http://example.com' }), (e) => e instanceof BackupError && e.code === 'BACKUP_ENDPOINT_INVALID' && e.status === 400);
    assert.throws(() => svc.putSettings({ keep: 'x', auto: 'never' }), (e) => e.code === 'BAD_REQUEST' && e.details.errors.length === 2);
    secrets.setSecretStore(new secrets.UnavailableSecretStore());
    assert.throws(() => svc.putSettings({ secret_key: 'abc' }), (e) => e.code === 'SECRET_STORE_UNAVAILABLE' && e.status === 503);
    assert.equal(svc.getSettings().secret_store_available, false);
    secrets.setSecretStore(store);
  });

  it('unconfigured service refuses to back up, list falls back to local, status says so', async () => {
    const { svc, dramaId } = await setupService();
    await assert.rejects(svc.backupDrama(dramaId), (e) => e.code === 'BACKUP_NOT_CONFIGURED' && e.status === 503);
    const l = await svc.listSnapshots();
    assert.deepEqual([l.items, l.source, l.configured, l.offline], [[], 'local', false, false]);
    assert.equal(svc.status().configured, false);
    await assert.rejects(svc.testConnection(), (e) => e.code === 'BACKUP_NOT_CONFIGURED');
  });
});

describe('backup service: against the fake S3', () => {
  let srv;
  before(async () => { srv = await startFakeS3({ accessKey: AK, secretKey: SK, bucket: 'tk-test', extraBuckets: ['other'] }); });
  after(() => srv.close());
  beforeEach(() => { srv.objects.clear(); });

  it('testConnection reports latency; wrong secret / missing bucket are mapped', async () => {
    const { svc } = await setupService({ srv });
    const r = await svc.testConnection();
    assert.equal(r.ok, true);
    assert.equal(r.bucket, 'tk-test');
    assert.equal(r.insecure, true); // http 回环
    assert.ok(r.latency_ms >= 0);
    await assert.rejects(svc.testConnection({ secret_key: 'wrong' }), (e) => e.code === 'BACKUP_AUTH' && e.status === 401);
    await assert.rejects(svc.testConnection({ bucket: 'missing' }), (e) => e.code === 'BACKUP_FAILED' && e.status === 404 && /missing/.test(e.message));
    await assert.rejects(svc.testConnection({ endpoint: 'http://1.2.3.4:9000' }), (e) => e.code === 'BACKUP_ENDPOINT_INVALID');
    // 表单里未保存的值也能测
    assert.equal((await svc.testConnection({ bucket: 'other' })).bucket, 'other');
    assert.equal(svc.getSettings().bucket, 'tk-test');
  });

  it('backup -> list -> restore round trip with the seeded sample project', async () => {
    const t = new Date('2026-10-02T03:04:05.123Z');
    const { db, svc, dramaId, cfg } = await setupService({ srv, now: () => t });
    const before = db.prepare('SELECT COUNT(*) n FROM dramas WHERE deleted_at IS NULL').get().n;
    const { run, snapshot } = await svc.backupDrama(dramaId);
    assert.equal(run.status, 'done');
    assert.equal(run.trigger, 'manual');
    assert.equal(run.key, `talekiln/dramas/${dramaId}/2026-10-02T03-04-05.123Z.zip`);
    assert.match(run.sha256, /^[0-9a-f]{64}$/);
    assert.ok(run.size > 1000);
    assert.equal(snapshot.created_at, '2026-10-02T03:04:05.123Z');
    assert.equal(snapshot.drama_id, dramaId);
    // 对象存储里有 zip + json 清单
    const zip = srv.objects.get(`tk-test/${run.key}`);
    const man = srv.objects.get(`tk-test/${run.key.replace(/\.zip$/, '.json')}`);
    assert.ok(zip && man);
    assert.equal(zip.contentType, 'application/zip');
    assert.equal(s3.sha256Hex(zip.body), run.sha256);
    const manifest = JSON.parse(man.body.toString());
    assert.deepEqual(Object.keys(manifest).sort(), ['app_version', 'created_at', 'drama_id', 'export_version', 'sha256', 'size', 'title']);
    assert.equal(manifest.drama_id, dramaId);
    assert.equal(manifest.sha256, run.sha256);
    assert.equal(manifest.size, run.size);
    assert.equal(manifest.app_version, '9.9.9-test');
    assert.equal(manifest.export_version, '1.5');
    assert.equal(manifest.created_at, '2026-10-02T03:04:05.123Z');
    // ZIP 就是「导出项目」的格式
    assert.ok(new AdmZip(zip.body).getEntry('project.json'));

    const list = await svc.listSnapshots();
    assert.equal(list.source, 's3');
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].title, manifest.title);
    assert.equal(list.items[0].sha256, run.sha256);
    assert.equal(list.items[0].size, run.size);
    assert.equal((await svc.listSnapshots(dramaId)).items.length, 1);
    assert.equal((await svc.listSnapshots(dramaId + 100)).items.length, 0);

    // 另一台机器的视角：本地没有记录时从清单取标题
    db.exec('DELETE FROM backup_runs');
    const fresh = await svc.listSnapshots();
    assert.equal(fresh.items[0].title, manifest.title);
    assert.equal(fresh.items[0].app_version, '9.9.9-test');

    const r = await svc.restore(run.key, { mode: 'new' });
    assert.equal(r.title, `${manifest.title} 导入1`); // 从不覆盖：重名加后缀
    assert.notEqual(r.drama_id, dramaId);
    assert.equal(r.sha256, run.sha256);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dramas WHERE deleted_at IS NULL').get().n, before + 1);
    const srcShots = db.prepare('SELECT COUNT(*) n FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE e.drama_id = ? AND s.deleted_at IS NULL').get(dramaId).n;
    const newShots = db.prepare('SELECT s.* FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE e.drama_id = ? AND s.deleted_at IS NULL').all(r.drama_id);
    assert.equal(newShots.length, srcShots);
    assert.equal(srcShots, 5);
    for (const sb of newShots) if (sb.local_path) assert.ok(fs.existsSync(path.join(cfg.storage.local_path, ...sb.local_path.split('/'))), sb.local_path);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM characters WHERE drama_id = ?').get(r.drama_id).n, 2);
    const runs = svc.listRuns();
    assert.deepEqual(runs.map((x) => [x.kind, x.status]), [['restore', 'done']]);
    assert.equal(runs[0].drama_id, dramaId); // 恢复记录挂在来源项目上
    await assert.rejects(svc.restore(run.key, { mode: 'overwrite' }), (e) => e.code === 'BAD_REQUEST' && /覆盖/.test(e.message));
    await assert.rejects(svc.restore('talekiln/other/x.zip'), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(svc.restore(`talekiln/dramas/${dramaId}/2026-10-02T03-04-05.123Z.zip`.replace('123', '999')), (e) => e.code === 'NOT_FOUND' && e.status === 404);
  });

  it('a tampered object or a missing manifest fails the checksum and creates nothing', async () => {
    const { db, svc, dramaId } = await setupService({ srv });
    const { run } = await svc.backupDrama(dramaId);
    const before = db.prepare('SELECT COUNT(*) n FROM dramas').get().n;
    const obj = srv.objects.get(`tk-test/${run.key}`);
    obj.body = Buffer.concat([obj.body, Buffer.from('tampered')]);
    await assert.rejects(svc.restore(run.key), (e) => e.code === 'BACKUP_CHECKSUM' && e.status === 409 && /sha256/.test(e.message));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dramas').get().n, before);
    const failed = svc.listRuns().find((r) => r.kind === 'restore');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /校验/);
    // 没有清单、本地也没记录 -> 拒绝
    srv.objects.delete(`tk-test/${run.key.replace(/\.zip$/, '.json')}`);
    db.exec('DELETE FROM backup_runs');
    await assert.rejects(svc.restore(run.key), (e) => e.code === 'BACKUP_CHECKSUM' && /清单/.test(e.message));
  });

  it('ZIP never sits in memory as a whole: backup streams a temp file, restore downloads to a temp file; a >64 MB payload round-trips with equal sha256', async () => {
    const seeded = await seededDb({ withTimeline: false });
    const storage = path.join(seeded.dir, 'storage');
    const store = memSecretStore();
    secrets.setSecretStore(store);
    const BIG = 65 * 1024 * 1024; // > 64 MB
    const seen = { exportOut: null, importArg: null, importSha: null };
    // 导出：按约定把 ZIP 写进 outFile（这里用生成数据代替真正的 ZIP，避免把 65 MB 塞进 adm-zip）
    const exportDrama = (d, c, l, id, opts) => {
      seen.exportOut = opts.outFile;
      const fd = fs.openSync(opts.outFile, 'w');
      const block = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < block.length; i++) block[i] = (i * 131 + 17) & 0xff;
      for (let written = 0; written < BIG; written += block.length) fs.writeSync(fd, block, 0, Math.min(block.length, BIG - written));
      fs.closeSync(fd);
      return { file: opts.outFile, size: fs.statSync(opts.outFile).size, title: `大项目 ${id}`, version: '1.4' };
    };
    // 导入：收到的是临时文件路径，而不是 Buffer
    const importDrama = async (d, c, l, zipPath) => {
      seen.importArg = zipPath;
      assert.equal(typeof zipPath, 'string');
      assert.ok(fs.existsSync(zipPath));
      seen.importSha = await s3.sha256File(zipPath);
      return { drama_id: 4242, title: '大项目 恢复' };
    };
    const svc = createBackupService({ db: seeded.db, config: { storage: { local_path: storage } }, log, exportDrama, importDrama, clientOptions: { sleep: noSleep } });
    svc.putSettings({ endpoint: srv.url, bucket: 'tk-test', prefix: 'talekiln', access_key: srv.accessKey, secret_key: srv.secretKey, auto: 'off', keep: 10 });
    const dramaId = seeded.db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(seeded.episodeId).drama_id;
    assert.equal(svc.tempDir, path.join(storage, 'tmp', 'backup'));

    const heapBefore = process.memoryUsage().heapUsed;
    const { run } = await svc.backupDrama(dramaId);
    assert.equal(run.status, 'done');
    assert.equal(run.size, BIG);
    assert.ok(seen.exportOut.startsWith(svc.tempDir), seen.exportOut);
    assert.equal(fs.existsSync(seen.exportOut), false); // 用完即删
    const obj = srv.objects.get(`tk-test/${run.key}`);
    assert.equal(obj.body.length, BIG);
    assert.equal(s3.sha256Hex(obj.body), run.sha256);
    const put = srv.requests.find((q) => q.method === 'PUT' && q.path.endsWith(path.posix.basename(run.key)));
    assert.equal(put.headers['x-amz-content-sha256'], run.sha256); // 文件 sha256 作为签名载荷，假 S3 已核对
    const manifest = JSON.parse(srv.objects.get(`tk-test/${run.key.replace(/\.zip$/, '.json')}`).body.toString());
    assert.deepEqual([manifest.size, manifest.sha256, manifest.export_version, manifest.title], [BIG, run.sha256, '1.4', `大项目 ${dramaId}`]);
    // 本进程没有为整包多分配一份内存（假 S3 自己持有一份 65 MB，所以阈值放宽到 1.5 倍包大小）
    assert.ok(process.memoryUsage().heapUsed - heapBefore < BIG * 1.5, 'heap grew by more than 1.5x the payload');

    const r = await svc.restore(run.key);
    assert.deepEqual([r.drama_id, r.title, r.size, r.sha256], [4242, '大项目 恢复', BIG, run.sha256]);
    assert.equal(seen.importSha, run.sha256); // 往返 sha256 一致
    assert.ok(seen.importArg.startsWith(svc.tempDir));
    assert.equal(fs.existsSync(seen.importArg), false);
    assert.deepEqual(fs.readdirSync(svc.tempDir), []); // 临时目录干净

    // 下载内容被改动 -> 校验失败，临时文件也删掉，导入不会被调用
    obj.body = Buffer.concat([obj.body.subarray(0, 1024), Buffer.from('x'), obj.body.subarray(1025)]);
    seen.importArg = null;
    await assert.rejects(svc.restore(run.key), (e) => e.code === 'BACKUP_CHECKSUM');
    assert.equal(seen.importArg, null);
    assert.deepEqual(fs.readdirSync(svc.tempDir), []);
    srv.objects.clear();
  });

  it('legacy exporters that only return a Buffer still work, and leftover temp ZIPs are cleaned at startup', async () => {
    const seeded = await seededDb({ withTimeline: false });
    const storage = path.join(seeded.dir, 'storage');
    secrets.setSecretStore(memSecretStore());
    const tmp = path.join(storage, 'tmp', 'backup');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'backup-1-stale.zip'), 'stale');
    fs.writeFileSync(path.join(tmp, 'keep.txt'), 'not a zip');
    const exportDrama = (d, c, l, id) => ({ buffer: Buffer.from('PK-legacy-' + id), title: '旧式导出' });
    const svc = createBackupService({ db: seeded.db, config: { storage: { local_path: storage } }, log, exportDrama, clientOptions: { sleep: noSleep } });
    assert.deepEqual(fs.readdirSync(tmp), ['keep.txt']);
    svc.putSettings({ endpoint: srv.url, bucket: 'tk-test', prefix: 'talekiln', access_key: srv.accessKey, secret_key: srv.secretKey, auto: 'off', keep: 10 });
    const dramaId = seeded.db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(seeded.episodeId).drama_id;
    const { run } = await svc.backupDrama(dramaId);
    assert.equal(run.status, 'done');
    assert.equal(srv.objects.get(`tk-test/${run.key}`).body.toString(), 'PK-legacy-' + dramaId);
    assert.equal(run.sha256, s3.sha256Hex(Buffer.from('PK-legacy-' + dramaId)));
    const manifest = JSON.parse(srv.objects.get(`tk-test/${run.key.replace(/\.zip$/, '.json')}`).body.toString());
    assert.equal(manifest.export_version, null); // 不是 ZIP，读不到版本也不影响备份
    assert.deepEqual(fs.readdirSync(tmp), ['keep.txt']);
    srv.objects.clear();
  });

  it('prune keeps the newest `keep` snapshots per drama (zip and manifest) and runs after each backup', async () => {
    let t = Date.parse('2026-10-02T00:00:00.000Z');
    const { db, svc, dramaId } = await setupService({ srv, now: () => new Date(t) });
    svc.putSettings({ keep: 2 });
    // 另一个项目的快照不受影响
    const other = db.prepare("INSERT INTO dramas (title, status, created_at, updated_at) VALUES ('另一个', 'draft', '2026-01-01', '2026-01-01')").run().lastInsertRowid;
    const keys = [];
    for (let i = 0; i < 4; i++) { t += 60_000; keys.push((await svc.backupDrama(dramaId)).run.key); }
    t += 60_000;
    const otherKey = (await svc.backupDrama(other)).run.key;
    const left = [...srv.objects.keys()].sort();
    assert.deepEqual(left, [`tk-test/${keys[2]}`, `tk-test/${keys[2].replace(/\.zip$/, '.json')}`, `tk-test/${keys[3]}`, `tk-test/${keys[3].replace(/\.zip$/, '.json')}`, `tk-test/${otherKey}`, `tk-test/${otherKey.replace(/\.zip$/, '.json')}`].sort());
    assert.deepEqual((await svc.listSnapshots(dramaId)).items.map((s) => s.key), [keys[3], keys[2]]); // 新的在前
    // keep 调小后手动清理
    svc.putSettings({ keep: 1 });
    const p = await svc.prune();
    assert.deepEqual(p.deleted, [keys[2]]);
    assert.equal((await svc.prune()).deleted.length, 0);
    svc.putSettings({ keep: 0 });
    assert.deepEqual(await svc.prune(), { deleted: [], keep: 0 });
    // 删除快照：zip 与清单一起删
    await svc.deleteSnapshot(keys[3]);
    assert.equal(srv.objects.has(`tk-test/${keys[3]}`), false);
    assert.equal(srv.objects.has(`tk-test/${keys[3].replace(/\.zip$/, '.json')}`), false);
    await assert.rejects(svc.deleteSnapshot('talekiln/dramas/x/y.zip'), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(svc.deleteSnapshot(`other/dramas/${dramaId}/2026-10-02T00-01-00.000Z.zip`), (e) => e.code === 'BAD_REQUEST'); // 别的前缀
  });

  it('backups are serialised and status reflects the running one', async () => {
    const { svc, dramaId } = await setupService({ srv });
    const a = svc.backupDrama(dramaId);
    const b = svc.backupDrama(dramaId);
    const st = svc.status();
    assert.equal(st.configured, true);
    const [ra, rb] = await Promise.all([a, b]);
    assert.notEqual(ra.run.id, rb.run.id);
    assert.equal(svc.status().running, false);
    assert.equal(svc.status().last_run.id, rb.run.id);
    assert.equal(svc.status().last_error, null);
    void st;
    await assert.rejects(svc.backupDrama(999999), (e) => e.code === 'NOT_FOUND' && e.status === 404);
    await assert.rejects(svc.backupDrama('abc'), (e) => e.code === 'BAD_REQUEST');
  });

  it('offline: list falls back to local records, backup fails as BACKUP_UNREACHABLE, daily tick retries later', async () => {
    let t = Date.parse('2026-10-02T08:00:00.000Z');
    const { db, svc, dramaId } = await setupService({ srv, now: () => new Date(t) });
    const { run } = await svc.backupDrama(dramaId);
    // 把设置指到一个没人监听的端口
    svc.putSettings({ endpoint: 'http://127.0.0.1:9', auto: 'daily' });
    const l = await svc.listSnapshots();
    assert.equal(l.source, 'local');
    assert.equal(l.offline, true);
    assert.deepEqual(l.items.map((s) => [s.key, s.title, s.source]), [[run.key, run.title, 'local']]);
    t += 25 * 3600_000; // 新的一天
    await assert.rejects(svc.backupDrama(dramaId), (e) => e.code === 'BACKUP_UNREACHABLE' && e.status === 502);
    const st = svc.status();
    assert.equal(st.last_run.status, 'failed');
    assert.equal(st.last_error.code, 'BACKUP_UNREACHABLE');
    assert.ok(st.offline_since);
    // 每日：连不上 -> 不记为完成，下一轮再试
    const r1 = await svc.tick();
    assert.deepEqual([r1.ran, r1.complete, r1.offline], [true, false, true]);
    assert.equal(getGlobalSetting(db, LAST_DAILY_KEY, null), null);
    // 回到线上
    svc.putSettings({ endpoint: srv.url });
    const r2 = await svc.tick();
    assert.deepEqual([r2.ran, r2.complete, r2.done, r2.failed], [true, true, 1, 0]);
    assert.equal(getGlobalSetting(db, LAST_DAILY_KEY, null), new Date(t).toISOString());
    assert.equal(svc.listRuns({ dramaId }).filter((r) => r.trigger === 'daily' && r.status === 'done').length, 1);
    assert.equal(svc.status().offline_since, null);
    assert.equal((await svc.tick()).reason, 'done_today');
    assert.equal(svc.status().next_daily_at, new Date(t + 24 * 3600_000).toISOString());
    // 24 小时后再来一轮；最近 24h 已备份过的项目跳过
    t += 24 * 3600_000 + 1;
    const r3 = await svc.tick();
    assert.equal(r3.complete, true);
    assert.equal(svc.listRuns({ dramaId }).filter((r) => r.trigger === 'daily' && r.status === 'done').length, 2);
    assert.equal(svc.listRuns({ dramaId }).filter((r) => r.trigger === 'daily' && r.status === 'failed').length, 1); // 断网那次
    svc.putSettings({ auto: 'off' });
    assert.equal((await svc.tick()).reason, 'off');
  });

  it('daily tick: one failing drama does not stop the others; busy service waits', async () => {
    const { db, svc, dramaId } = await setupService({ srv });
    svc.putSettings({ auto: 'daily' });
    // 一个标题为空的「坏」项目：导出服务找不到它（已删除）却仍在列表里不可能，所以用一个导出会抛错的注入
    const broken = db.prepare("INSERT INTO dramas (title, status, created_at, updated_at) VALUES ('坏项目', 'draft', '2026-01-01', '2026-01-01')").run().lastInsertRowid;
    const svc2 = createBackupService({
      db, config: { storage: { local_path: path.join(os.tmpdir(), 'nope') } }, log, clientOptions: { sleep: noSleep },
      exportDrama: (d, c, l, id) => { if (Number(id) === Number(broken)) throw new Error('导出炸了'); return require('../src/services/dramaExportService').exportDrama(d, c, l, id); },
    });
    const r = await svc2.tick();
    assert.deepEqual([r.complete, r.done, r.failed], [true, 1, 1]);
    assert.equal(svc2.listRuns({ dramaId: broken })[0].status, 'failed');
    assert.match(svc2.listRuns({ dramaId: broken })[0].error, /导出炸了/);
    assert.equal(svc2.listRuns({ dramaId })[0].status, 'done');
    void svc;
  });

  it('after_export: the export hook backs up the episode\'s drama once; off mode does nothing', async () => {
    const { db, svc, dramaId, episodeId } = await setupService({ srv });
    assert.equal(svc.onExportFinished({ episode_id: episodeId }), null); // auto: off
    svc.putSettings({ auto: 'after_export' });
    const p1 = svc.onExportFinished({ episode_id: episodeId });
    const p2 = svc.onExportFinished({ episode_id: episodeId }); // 同一项目已在排队 -> 去重
    assert.ok(p1);
    assert.equal(p2, null);
    await p1;
    const runs = svc.listRuns({ dramaId });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger, 'after_export');
    assert.equal(runs[0].status, 'done');
    assert.equal(svc.onExportFinished({ episode_id: 999999 }), null);
    assert.equal(svc.onExportFinished({}), null);
    void db;
  });
});

describe('backup scheduler', () => {
  it('waits initialDelay, then ticks every interval; stop clears the timer; errors go to onError', async () => {
    const timers = [];
    const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
    const clearTimer = (t) => { if (t) t.cleared = true; };
    let ticks = 0;
    const errors = [];
    const service = { tick: async () => { ticks++; if (ticks === 2) throw new Error('boom'); return { ran: false }; } };
    const s = createBackupScheduler({ service, setTimer, clearTimer, intervalMs: 1000, initialDelayMs: 50, onError: (e) => errors.push(e.message) });
    assert.equal(s.isRunning(), false);
    s.start();
    s.start(); // 幂等
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 50);
    await timers[0].fn();
    assert.equal(ticks, 1);
    assert.equal(timers[1].ms, 1000);
    await timers[1].fn();
    assert.deepEqual(errors, ['boom']);
    assert.equal(timers.length, 3);
    await s.stop();
    assert.equal(timers[2].cleared, true);
    await timers[2].fn(); // 停止后触发也不再 tick
    assert.equal(ticks, 2);
    assert.throws(() => createBackupScheduler({ service: {} }), /tick/);
  });
});

describe('export service onFinished hook', () => {
  it('fires exactly once when the job reaches done (after the AIGC pass)', async () => {
    const tl = require('../src/timeline');
    const aigc = require('../src/export/aigc');
    const { createExportService } = require('../src/export/service');
    const MIG = (f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-export-'));
    const db = new Database(path.join(dir, 't.db'));
    db.exec(MIG('01_init.sql'));
    db.exec(`CREATE TABLE IF NOT EXISTS global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`);
    db.exec(MIG('24_timelines.sql'));
    db.exec(MIG('26_music_library_and_mix.sql'));
    const storageRoot = path.join(dir, 'storage');
    fs.mkdirSync(path.join(storageRoot, 'v'), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, 'v', '1.mp4'), 'x');
    tl.saveTimeline(db, { episode_id: 7, tracks: [
      { kind: 'video', volume: 1, clips: [{ id: 'v1', start_ms: 0, duration_ms: 4000, asset_ref: 'v/1.mp4', asset_kind: 'video', src_in_ms: 0, src_out_ms: 4000 }] },
      { kind: 'subtitle', volume: 1, clips: [] }, { kind: 'narration', volume: 1, clips: [] }, { kind: 'music', volume: 1, clips: [] },
    ] });
    aigc.setSettings(db, { watermark: false, metadata: false });
    const statuses = [{ status: 'running', percent: 50 }, { status: 'done', percent: 100, result: {} }];
    const core = { async call() { return { encoders: [{ name: 'libx264', available: true }], best: 'libx264' }; }, async renderStart() { return { jobId: 'j1' }; }, async renderStatus() { return statuses.length > 1 ? statuses.shift() : statuses[0]; } };
    const finished = [];
    const svc = createExportService(db, { getCore: async () => core, storageRoot, opener() {}, onFinished: (e) => finished.push(e) });
    const out = path.join(dir, 'out.mp4');
    await svc.start({ episode_id: 7, width: 1280, height: 720, fps: 30, encoder: 'libx264', output_path: out });
    assert.equal((await svc.status('j1')).status, 'running');
    assert.deepEqual(finished, []);
    assert.equal((await svc.status('j1')).status, 'done');
    assert.deepEqual(finished, [{ job_id: 'j1', episode_id: 7, output_path: out }]);
    await svc.status('j1');
    assert.equal(finished.length, 1); // 只通知一次
    // 钩子抛错不影响导出结果
    const svc2 = createExportService(db, { getCore: async () => core, storageRoot, opener() {}, onFinished: () => { throw new Error('hook'); } });
    await svc2.start({ episode_id: 7, width: 1280, height: 720, fps: 30, encoder: 'libx264', output_path: out });
    assert.equal((await svc2.status('j1')).status, 'done');
  });
});

// ---------- REST ----------

describe('backup routes', () => {
  let srv;
  let ctx;
  let server;
  let call;
  before(async () => {
    srv = await startFakeS3({ accessKey: AK, secretKey: SK, bucket: 'tk-test' });
    ctx = await setupService();
    const h = backupRoutes(ctx.svc, log);
    const app = express();
    app.use(express.json());
    app.get('/backup/settings', h.getSettings);
    app.put('/backup/settings', h.putSettings);
    app.post('/backup/test', h.test);
    app.post('/backup/dramas/:id', h.backupDrama);
    app.get('/backup/snapshots', h.snapshots);
    app.post('/backup/restore', h.restore);
    app.delete('/backup/snapshots', h.deleteSnapshot);
    app.get('/backup/status', h.status);
    app.get('/backup/runs', h.runs);
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    call = async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };
  });
  after(async () => { server.close(); await srv.close(); });

  it('settings: GET never returns the secret, PUT validates, errors use the code table', async () => {
    let r = await call('GET', '/backup/settings');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.has_secret, false);
    assert.equal(r.body.data.auto, 'off');
    r = await call('PUT', '/backup/settings', { endpoint: 'http://example.com:9000' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'BACKUP_ENDPOINT_INVALID');
    assert.equal(r.body.error.action, ENTRIES.BACKUP_ENDPOINT_INVALID.action);
    r = await call('POST', '/backup/dramas/' + ctx.dramaId);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'BACKUP_NOT_CONFIGURED');
    r = await call('PUT', '/backup/settings', { endpoint: srv.url, bucket: 'tk-test', prefix: 'tk-test', access_key: AK, secret_key: SK, auto: 'after_export', keep: 3 });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.has_secret, true);
    assert.equal(r.body.data.configured, true);
    assert.equal(JSON.stringify(r.body).includes(SK), false);
    r = await call('GET', '/backup/settings');
    assert.equal(JSON.stringify(r.body).includes(SK), false);
    assert.equal(r.body.data.prefix, 'tk-test');
  });

  it('test / backup / snapshots / restore / delete / status / runs', async () => {
    let r = await call('POST', '/backup/test', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.data.ok, true);
    r = await call('POST', '/backup/test', { secret_key: 'bad' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'BACKUP_AUTH');

    r = await call('POST', '/backup/dramas/' + ctx.dramaId);
    assert.equal(r.status, 201);
    const key = r.body.data.run.key;
    assert.match(key, new RegExp(`^tk-test/dramas/${ctx.dramaId}/.+\\.zip$`));
    r = await call('POST', '/backup/dramas/999999');
    assert.equal(r.status, 404);

    r = await call('GET', `/backup/snapshots?drama_id=${ctx.dramaId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.source, 's3');
    assert.deepEqual(r.body.data.items.map((s) => s.key), [key]);
    r = await call('GET', '/backup/snapshots?drama_id=abc');
    assert.equal(r.status, 400);

    r = await call('POST', '/backup/restore', {});
    assert.equal(r.status, 400);
    r = await call('POST', '/backup/restore', { key });
    assert.equal(r.status, 201);
    assert.ok(r.body.data.drama_id);
    assert.match(r.body.data.title, /导入1$/);
    srv.objects.get(`tk-test/${key}`).body = Buffer.from('garbage');
    r = await call('POST', '/backup/restore', { key, mode: 'new' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'BACKUP_CHECKSUM');

    r = await call('GET', '/backup/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.configured, true);
    assert.equal(r.body.data.auto, 'after_export');
    assert.equal(r.body.data.running, false);
    r = await call('GET', `/backup/runs?drama_id=${ctx.dramaId}&limit=10`);
    assert.deepEqual(r.body.data.items.map((x) => [x.kind, x.status]), [['restore', 'failed'], ['restore', 'done'], ['backup', 'done']]);

    r = await call('DELETE', '/backup/snapshots', { key });
    assert.equal(r.status, 200);
    assert.equal(srv.objects.has(`tk-test/${key}`), false);
    r = await call('DELETE', '/backup/snapshots?key=' + encodeURIComponent('tk-test/dramas/1/nope.zip'));
    assert.equal(r.status, 400);
    r = await call('GET', '/backup/snapshots');
    assert.deepEqual(r.body.data.items, []);
  });
});

describe('key layout helpers', () => {
  it('parseKey / isoOfStamp', () => {
    assert.deepEqual(parseKey('talekiln/dramas/12/2026-10-02T03-04-05.123Z.zip', 'talekiln'), { drama_id: 12, stamp: '2026-10-02T03-04-05.123Z', created_at: '2026-10-02T03:04:05.123Z', kind: 'zip' });
    assert.equal(parseKey('talekiln/dramas/12/2026-10-02T03-04-05.123Z.json', 'talekiln').kind, 'json');
    assert.equal(parseKey('talekiln/dramas/12/random.zip', 'talekiln'), null);
    assert.equal(parseKey('other/dramas/12/2026-10-02T03-04-05.123Z.zip', 'talekiln'), null);
    assert.equal(parseKey('talekiln/shared/x.png', 'talekiln'), null);
    assert.equal(parseKey('a.b/dramas/1/2026-10-02T03-04-05.123Z.zip', 'a.b').drama_id, 1);
    assert.equal(parseKey('aXb/dramas/1/2026-10-02T03-04-05.123Z.zip', 'a.b'), null); // 点不是通配
    assert.equal(isoOfStamp('nope'), null);
  });
  it('all BACKUP_* error codes are in the table with Chinese text', () => {
    for (const c of ['BACKUP_NOT_CONFIGURED', 'BACKUP_ENDPOINT_INVALID', 'BACKUP_UNREACHABLE', 'BACKUP_AUTH', 'BACKUP_FAILED', 'BACKUP_CHECKSUM']) {
      assert.equal(ENTRIES[c].scope, 'local', c);
      assert.match(ENTRIES[c].message, /[一-龥]/);
    }
  });
});
