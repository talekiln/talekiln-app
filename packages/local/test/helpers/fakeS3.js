'use strict';
/**
 * 测试用的进程内假 S3（node:http）：path-style，一个桶。
 *  - 用配置的 Secret Key 在服务端重算 SigV4 签名，不一致返回 403 SignatureDoesNotMatch；
 *    载荷哈希（x-amz-content-sha256）也会对照实际请求体校验（UNSIGNED-PAYLOAD 除外）——文件流式上传签的是文件 sha256，同样在这里被重算核对。
 *    这里的规范化 / 编码是独立实现的，不从 src/backup/s3.js 引用，所以客户端与服务端互为对照。
 *  - 实现 HeadBucket / CreateBucket / PutObject / GetObject / HeadObject / DeleteObject / ListObjectsV2（含 prefix、max-keys、continuation-token）。
 *  - failNext(status, n)：接下来 n 个请求直接返回该状态（测重试）；requests 记录每个请求；objects 可直接改（测校验失败）。
 *  - encodeListKeys：'requested'（默认，像 MinIO / AWS：请求带 encoding-type=url 才把键按查询串规则编码并声明 <EncodingType>）
 *    或 'always'（像 gofakes3 / rclone serve s3：不管请求与否一律编码并声明）。
 */
const http = require('http');
const crypto = require('crypto');

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** encoding-type=url 的键编码：查询串规则（空格 -> +，其余保留字百分号编码），与 AWS / MinIO / gofakes3 一致。 */
const queryEsc = (s) => enc(s).replace(/%20/g, '+');

function errorXml(res, status, code, message, extra = '') {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEsc(message)}</Message>${extra}<RequestId>fake</RequestId></Error>`);
}

/** 服务端重算签名；返回 null 表示通过，否则返回 { code, message }。 */
function verify(req, rawPath, query, body, { accessKey, secretKey, region }) {
  const auth = req.headers.authorization || '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return { code: 'AccessDenied', message: 'missing or malformed Authorization header' };
  const [, ak, dateStamp, rgn, signedHeaders, signature] = m;
  if (ak !== accessKey) return { code: 'InvalidAccessKeyId', message: 'The access key does not exist' };
  if (rgn !== region) return { code: 'AuthorizationHeaderMalformed', message: `the region '${rgn}' is wrong; expecting '${region}'`, region };
  const amzDate = req.headers['x-amz-date'];
  if (!amzDate || !amzDate.startsWith(dateStamp)) return { code: 'AccessDenied', message: 'x-amz-date missing or does not match credential scope' };
  const payloadHash = req.headers['x-amz-content-sha256'];
  if (!payloadHash) return { code: 'AccessDenied', message: 'x-amz-content-sha256 missing' };
  // 真实 S3 对载荷哈希不符返回 400（不是 403）
  if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha256(body)) return { status: 400, code: 'XAmzContentSHA256Mismatch', message: 'payload hash mismatch' };
  const names = signedHeaders.split(';');
  const canonHeaders = names.map((n) => `${n}:${String(req.headers[n] === undefined && n === 'host' ? req.headers.host : req.headers[n] || '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonPath = rawPath.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/') || '/';
  const canonQuery = [...query.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [req.method, canonPath, canonQuery, canonHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), 's3'), 'aws4_request');
  const expected = crypto.createHmac('sha256', kSigning).update(sts, 'utf8').digest('hex');
  if (expected !== signature) return { code: 'SignatureDoesNotMatch', message: 'The request signature we calculated does not match the signature you provided' };
  return null;
}

/**
 * 启动假 S3。返回 { url, port, objects: Map<key,{body,contentType,lastModified,etag}>, requests: [], failNext(status, n), buckets: Set, close() }。
 */
async function startFakeS3({ accessKey = 'ci', secretKey = 'ci-throwaway-minio', bucket = 'talekiln-test', region = 'us-east-1', extraBuckets = [], encodeListKeys = 'requested' } = {}) {
  const objects = new Map();
  const buckets = new Set([bucket, ...extraBuckets]);
  const requests = [];
  const failures = [];
  const cfg = { accessKey, secretKey, region };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://fake');
      const rawPath = u.pathname;
      requests.push({ method: req.method, path: rawPath, query: Object.fromEntries(u.searchParams), headers: req.headers, size: body.length });
      if (failures.length) {
        const status = failures.shift();
        return errorXml(res, status, status === 503 ? 'SlowDown' : 'InternalError', 'injected failure');
      }
      const bad = verify(req, rawPath, u.searchParams, body, cfg);
      if (bad) return errorXml(res, bad.status || 403, bad.code, bad.message, bad.region ? `<Region>${bad.region}</Region>` : '');
      const segs = rawPath.replace(/^\/+/, '').split('/');
      const b = decodeURIComponent(segs[0] || '');
      const key = segs.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (req.method === 'PUT' && !key) {
        if (buckets.has(b)) return errorXml(res, 409, 'BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.');
        buckets.add(b);
        res.writeHead(200, { location: `/${b}` });
        return res.end();
      }
      if (!buckets.has(b)) return errorXml(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
      if (!key) {
        if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
        if (req.method === 'GET' && u.searchParams.get('list-type') === '2') return list(res, u.searchParams, b);
        return errorXml(res, 400, 'InvalidRequest', 'unsupported bucket operation');
      }
      const full = `${b}/${key}`;
      if (req.method === 'PUT') {
        // 流式 / 文件上传必须声明 content-length，且与实际收到的字节数一致（真实 S3 对不上会 IncompleteBody）
        const declared = req.headers['content-length'];
        if (declared !== undefined && Number(declared) !== body.length) return errorXml(res, 400, 'IncompleteBody', `content-length ${declared} but got ${body.length}`);
        const etag = crypto.createHash('md5').update(body).digest('hex');
        objects.set(full, { body, contentType: req.headers['content-type'] || 'binary/octet-stream', lastModified: new Date().toUTCString(), etag });
        res.writeHead(200, { etag: `"${etag}"` });
        return res.end();
      }
      const obj = objects.get(full);
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!obj) return req.method === 'HEAD' ? (res.writeHead(404), res.end()) : errorXml(res, 404, 'NoSuchKey', 'The specified key does not exist.');
        res.writeHead(200, { 'content-type': obj.contentType, 'content-length': String(obj.body.length), etag: `"${obj.etag}"`, 'last-modified': obj.lastModified });
        return res.end(req.method === 'HEAD' ? undefined : obj.body);
      }
      if (req.method === 'DELETE') { objects.delete(full); res.writeHead(204); return res.end(); }
      return errorXml(res, 405, 'MethodNotAllowed', 'nope');
    });
  });

  function list(res, q, b) {
    const prefix = q.get('prefix') || '';
    const maxKeys = Math.max(1, Math.min(1000, Number(q.get('max-keys')) || 1000));
    const token = q.get('continuation-token');
    const after = token ? Buffer.from(token, 'base64').toString('utf8') : null;
    const encoded = encodeListKeys === 'always' || (encodeListKeys === 'requested' && q.get('encoding-type') === 'url');
    const keyXml = (k) => xmlEsc(encoded ? queryEsc(k) : k);
    const keys = [...objects.keys()].filter((k) => k.startsWith(`${b}/`)).map((k) => k.slice(b.length + 1)).filter((k) => k.startsWith(prefix)).sort();
    const start = after ? keys.findIndex((k) => k > after) : 0;
    const slice = start < 0 ? [] : keys.slice(start, start + maxKeys);
    const truncated = start >= 0 && start + maxKeys < keys.length;
    const next = truncated ? Buffer.from(slice[slice.length - 1], 'utf8').toString('base64') : null;
    const items = slice.map((k) => {
      const o = objects.get(`${b}/${k}`);
      return `<Contents><Key>${keyXml(k)}</Key><LastModified>${new Date(o.lastModified).toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
    }).join('');
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEsc(b)}</Name><Prefix>${keyXml(prefix)}</Prefix><KeyCount>${slice.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${items}${next ? `<NextContinuationToken>${xmlEsc(next)}</NextContinuationToken>` : ''}${encoded ? '<EncodingType>url</EncodingType>' : ''}</ListBucketResult>`);
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`, port, objects, requests, buckets, bucket, accessKey, secretKey, region,
    failNext: (status, n = 1) => { for (let i = 0; i < n; i++) failures.push(status); },
    close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
  };
}

module.exports = { startFakeS3 };
