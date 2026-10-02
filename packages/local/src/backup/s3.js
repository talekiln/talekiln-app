'use strict';
/**
 * P3-K 云备份：最小 S3 兼容客户端（不引入新依赖）。
 *
 * - 签名：AWS Signature V4（node:crypto），头部签名方式；载荷哈希放在 x-amz-content-sha256。
 * - 寻址：默认 path-style（MinIO 默认），可切 virtual-hosted；区域可配，默认 us-east-1（MinIO 默认）。
 * - 地址策略：https:// 一律允许；http:// 只允许回环地址或 RFC1918 私网地址（家里 NAS 上的 MinIO），其它一律拒绝。
 * - 超时 + 重试：所有操作都是幂等的（PUT 同一内容、DELETE、GET、HEAD），网络错误 / 5xx / 429 最多重试到 3 次，指数退避。
 * - fetch / sleep / now 可注入（测试用假服务器与假时钟）。
 *
 * 错误统一为 S3Error：code 对应 errors/error-codes.json 的 BACKUP_*（或 NOT_FOUND），status 为建议的 HTTP 状态，
 * s3Code 为对象存储返回的 <Code>（SignatureDoesNotMatch / NoSuchKey …）。
 */
const crypto = require('crypto');
const fs = require('fs');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const DEFAULT_REGION = 'us-east-1';

class S3Error extends Error {
  constructor(code, message, { status = 500, s3Code = null, retriable = false, cause = null } = {}) {
    super(message || code);
    this.name = 'S3Error';
    this.code = code;
    this.status = status;
    this.s3Code = s3Code;
    this.retriable = retriable;
    if (cause) this.cause = cause;
  }
}

// ---------- 编码与哈希 ----------

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
/** 流式算文件 sha256（不把文件读进内存）。 */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(); } }));
  return hash.digest('hex');
}
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/** AWS 的 UriEncode：除 A-Z a-z 0-9 - _ . ~ 外全部百分号编码；路径里的 / 不编码。 */
function uriEncode(str, { encodeSlash = true } = {}) {
  const enc = encodeURIComponent(String(str)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return encodeSlash ? enc : enc.replace(/%2F/g, '/');
}

/** 规范化路径：每一段单独编码，保留 /。 */
function canonicalPath(pathname) {
  const p = pathname || '/';
  return p.split('/').map((seg) => uriEncode(seg)).join('/') || '/';
}

/** 规范化查询串：按键、值排序；空值写成 key=。query 可以是对象或 [k, v] 数组。 */
function canonicalQuery(query) {
  const pairs = [];
  const entries = Array.isArray(query) ? query : Object.entries(query || {});
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    pairs.push([uriEncode(k), uriEncode(String(v))]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** 把 Date 变成 20260102T030405Z。 */
function amzDateOf(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 计算 SigV4 头部签名。headers 里必须已经含 host（与 x-amz-date 一起签；这里会补 x-amz-date）。
 * 返回 { authorization, amzDate, signedHeaders, canonicalRequest, stringToSign, signature, headers }。
 */
function signV4({ method, path, query, headers, payloadHash, accessKey, secretKey, region, service = 's3', date = new Date() }) {
  const amzDate = amzDateOf(date);
  const dateStamp = amzDate.slice(0, 8);
  const all = { ...headers, 'x-amz-date': amzDate };
  const lower = {};
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined || v === null) continue;
    lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  }
  if (!lower.host) throw new Error('signV4: host header is required');
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method.toUpperCase(), canonicalPath(path), canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash || EMPTY_SHA256,
  ].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, amzDate, signedHeaders, canonicalRequest, stringToSign, signature, headers: { ...all, Authorization: authorization } };
}

// ---------- 地址策略 ----------

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isLoopbackHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = IPV4.exec(h);
  return !!m && Number(m[1]) === 127;
}

/** RFC1918：10/8、172.16/12、192.168/16。 */
function isPrivateHost(host) {
  const m = IPV4.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * 校验对象存储地址。通过返回 { url: URL, insecure: boolean }，否则抛 S3Error(BACKUP_ENDPOINT_INVALID, 400)。
 * 允许带路径前缀（反向代理放在子路径时），不允许用户名口令、查询串与锚点。
 */
function validateEndpoint(raw) {
  const s = String(raw || '').trim();
  const bad = (why) => new S3Error('BACKUP_ENDPOINT_INVALID', `对象存储地址不合法：${why}`, { status: 400 });
  if (!s) throw bad('地址为空');
  let u;
  try { u = new URL(s); } catch (_) { throw bad('不是合法的 URL'); }
  if (u.username || u.password) throw bad('地址里不能带用户名或口令');
  if (u.search || u.hash) throw bad('地址里不能带查询串或锚点');
  if (u.protocol === 'https:') return { url: u, insecure: false };
  if (u.protocol !== 'http:') throw bad('只支持 https:// 或 http://');
  if (isLoopbackHost(u.hostname) || isPrivateHost(u.hostname)) return { url: u, insecure: true };
  throw bad('http:// 只允许本机或局域网地址（10.x、172.16–31.x、192.168.x），公网地址请用 https://');
}

// ---------- 极简 XML 解析（够读 ListBucketResult 与 <Error>） ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

/**
 * 解析 XML 文本为 { name, children: [], text } 树（属性忽略，命名空间前缀去掉）。
 * 只处理对象存储响应这种良构、无 DTD 的小文档；格式错误时抛 Error。
 */
function parseXml(src) {
  const s = String(src || '');
  let i = 0;
  const root = { name: '#document', children: [], text: '' };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { top().text += decodeEntities(s.slice(i)); break; }
    if (lt > i) top().text += decodeEntities(s.slice(i, lt));
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt); if (e < 0) throw new Error('xml: unterminated declaration'); i = e + 2; continue; }
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt); if (e < 0) throw new Error('xml: unterminated comment'); i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); if (e < 0) throw new Error('xml: unterminated CDATA'); top().text += s.slice(lt + 9, e); i = e + 3; continue; }
    if (s.startsWith('<!', lt)) { const e = s.indexOf('>', lt); if (e < 0) throw new Error('xml: unterminated <!'); i = e + 1; continue; }
    const gt = s.indexOf('>', lt);
    if (gt < 0) throw new Error('xml: unterminated tag');
    const body = s.slice(lt + 1, gt).trim();
    if (body.startsWith('/')) {
      const name = body.slice(1).trim().replace(/^[^:]+:/, '');
      const node = stack.pop();
      if (!node || node === root || node.name !== name) throw new Error(`xml: mismatched close tag </${name}>`);
    } else {
      const selfClose = body.endsWith('/');
      const name = (selfClose ? body.slice(0, -1) : body).split(/\s/)[0].replace(/^[^:]+:/, '');
      if (!name) throw new Error('xml: empty tag name');
      const node = { name, children: [], text: '' };
      top().children.push(node);
      if (!selfClose) stack.push(node);
    }
    i = gt + 1;
  }
  if (stack.length !== 1) throw new Error(`xml: unclosed <${top().name}>`);
  return root.children[0] || null;
}

const childOf = (node, name) => (node ? node.children.find((c) => c.name === name) : undefined);
const childrenOf = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const textOf = (node, name) => { const c = childOf(node, name); return c ? c.text : ''; };

/** 解析 ListObjectsV2 响应。 */
function parseListObjects(xml) {
  const root = parseXml(xml);
  if (!root || root.name !== 'ListBucketResult') throw new Error('xml: not a ListBucketResult');
  const contents = childrenOf(root, 'Contents').map((c) => ({
    key: textOf(c, 'Key'),
    size: Number(textOf(c, 'Size')) || 0,
    lastModified: textOf(c, 'LastModified') || null,
    etag: (textOf(c, 'ETag') || '').replace(/^"|"$/g, '') || null,
  }));
  const token = textOf(root, 'NextContinuationToken');
  return {
    contents,
    commonPrefixes: childrenOf(root, 'CommonPrefixes').map((p) => textOf(p, 'Prefix')),
    isTruncated: textOf(root, 'IsTruncated') === 'true',
    nextContinuationToken: token || null,
    keyCount: Number(textOf(root, 'KeyCount')) || contents.length,
  };
}

/** 解析 <Error><Code/><Message/></Error>；不是 XML 时返回 null。 */
function parseErrorXml(text) {
  try {
    const root = parseXml(text);
    if (!root || root.name !== 'Error') return null;
    return { code: textOf(root, 'Code') || null, message: textOf(root, 'Message') || null, region: textOf(root, 'Region') || null };
  } catch (_) { return null; }
}

// ---------- 客户端 ----------

const AUTH_CODES = new Set(['SignatureDoesNotMatch', 'InvalidAccessKeyId', 'AccessDenied', 'AuthorizationHeaderMalformed', 'InvalidSecurity', 'ExpiredToken', 'AllAccessDisabled']);
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function errorFromResponse(status, text, { op, key } = {}) {
  const parsed = parseErrorXml(text) || {};
  const s3Code = parsed.code;
  const where = key ? `${op} ${key}` : op;
  const detail = parsed.message ? `${s3Code || status}: ${parsed.message}` : `HTTP ${status}${s3Code ? ' ' + s3Code : ''}`;
  if (status === 401 || status === 403 || (s3Code && AUTH_CODES.has(s3Code))) {
    const hint = s3Code === 'AuthorizationHeaderMalformed' && parsed.region ? `（该存储桶的区域是 ${parsed.region}）` : '';
    return new S3Error('BACKUP_AUTH', `对象存储拒绝了访问凭据${hint}：${detail}`, { status: 401, s3Code });
  }
  if (status === 404) return new S3Error('NOT_FOUND', `对象不存在（${where}）：${detail}`, { status: 404, s3Code: s3Code || 'NotFound' });
  if (status === 301 || status === 307) return new S3Error('BACKUP_FAILED', `对象存储要求跳转（通常是区域填错）：${detail}`, { status: 400, s3Code });
  if (status === 429 || status === 503 || status >= 500) return new S3Error('BACKUP_FAILED', `对象存储暂时不可用（${where}）：${detail}`, { status: 502, s3Code, retriable: true });
  return new S3Error('BACKUP_FAILED', `对象存储返回错误（${where}）：${detail}`, { status: 400, s3Code });
}

/**
 * 创建客户端。
 * @param {object} o
 * @param {string} o.endpoint   https://s3.example.com 或 http://192.168.1.10:9000
 * @param {string} o.bucket
 * @param {string} o.accessKey
 * @param {string} o.secretKey
 * @param {string} [o.region='us-east-1']
 * @param {boolean} [o.pathStyle=true]
 * @param {Function} [o.fetchImpl]      默认 globalThis.fetch
 * @param {number} [o.timeoutMs=30000]  单次请求超时
 * @param {number} [o.maxAttempts=3]    含首次在内最多尝试次数（只对网络错误 / 5xx / 429 重试）
 * @param {number} [o.backoffMs=300]    退避基数：300、600、1200 …
 * @param {Function} [o.sleep]          (ms) => Promise
 * @param {Function} [o.now]            () => Date
 */
function createS3Client({
  endpoint, bucket, accessKey, secretKey, region = DEFAULT_REGION, pathStyle = true, fetchImpl, timeoutMs = 30000,
  maxAttempts = 3, backoffMs = 300, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(),
} = {}) {
  const { url: base, insecure } = validateEndpoint(endpoint);
  if (!bucket || !BUCKET_RE.test(String(bucket))) throw new S3Error('BACKUP_FAILED', '存储桶名称不合法（3–63 位小写字母、数字、点或连字符）', { status: 400 });
  if (!accessKey || !secretKey) throw new S3Error('BACKUP_NOT_CONFIGURED', '缺少 Access Key 或 Secret Key', { status: 503 });
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const basePath = base.pathname.replace(/\/+$/, '');
  const rgn = String(region || DEFAULT_REGION).trim() || DEFAULT_REGION;

  /** 组装请求 URL 与签名用的 host / path。 */
  function target(key, query) {
    const host = pathStyle ? base.host : `${bucket}.${base.host}`;
    const objPath = key == null ? '' : '/' + String(key).split('/').map((s) => uriEncode(s)).join('/');
    const path = (pathStyle ? `${basePath}/${bucket}` : basePath) + objPath || '/';
    const rawPath = (pathStyle ? `${basePath}/${bucket}` : basePath) + (key == null ? '' : '/' + String(key)) || '/';
    const qs = canonicalQuery(query);
    const href = `${base.protocol}//${host}${path}${qs ? '?' + qs : ''}`;
    return { host, path: rawPath, href };
  }

  /**
   * body：null / Buffer / 字符串（按内容签名、可重试）、Web 可读流（UNSIGNED-PAYLOAD、不重试），
   * 或一个返回新 Web 可读流的函数（每次尝试重新打开，所以可重试；配合 payloadHash 传文件的 sha256 就是签名载荷）。
   * expectBody = 'stream' 时不把响应体读进内存，返回 { stream }（调用方负责消费）。
   */
  async function request(method, key, { query = {}, headers = {}, body = null, payloadHash, op = method, expectBody = true, allow404 = false } = {}) {
    const t = target(key, query);
    const isFactory = typeof body === 'function';
    const inline = body == null || Buffer.isBuffer(body) || typeof body === 'string';
    const hash = payloadHash || (body == null ? EMPTY_SHA256 : inline ? sha256Hex(body) : UNSIGNED_PAYLOAD);
    const replayable = inline || isFactory; // 一次性的流不能重放，只重试可重放的请求
    let attempt = 0;
    for (;;) {
      attempt++;
      const signed = signV4({
        method, path: t.path, query, headers: { ...headers, host: t.host, 'x-amz-content-sha256': hash },
        payloadHash: hash, accessKey, secretKey, region: rgn, service: 's3', date: now(),
      });
      const { host, ...sendHeaders } = signed.headers; // fetch 自己设置 Host
      let res;
      try {
        const payload = isFactory ? body() : body;
        res = await doFetch(t.href, {
          method, headers: sendHeaders, body: payload == null ? undefined : payload, redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs), ...(payload && !Buffer.isBuffer(payload) && typeof payload !== 'string' ? { duplex: 'half' } : {}),
        });
      } catch (e) {
        const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        const err = new S3Error('BACKUP_UNREACHABLE', `连不上对象存储（${op}）：${timeout ? '请求超时' : `网络错误（${(e && e.message) || 'unknown'}）`}`, { status: 502, retriable: true, cause: e });
        if (replayable && attempt < maxAttempts) { await sleep(backoffMs * 2 ** (attempt - 1)); continue; }
        throw err;
      }
      if (res.ok) {
        if (expectBody === 'stream' && method !== 'HEAD') return { status: res.status, headers: res.headers, stream: res.body };
        const buf = expectBody && method !== 'HEAD' ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
        return { status: res.status, headers: res.headers, body: buf };
      }
      if (allow404 && res.status === 404) return { status: 404, headers: res.headers, body: Buffer.alloc(0), notFound: true };
      const text = method === 'HEAD' ? '' : await res.text().catch(() => '');
      const err = errorFromResponse(res.status, text, { op, key });
      if (err.retriable && replayable && attempt < maxAttempts) { await sleep(backoffMs * 2 ** (attempt - 1)); continue; }
      throw err;
    }
  }

  /** 存储桶可达且有权限（HEAD bucket）。 */
  async function headBucket() {
    const r = await request('HEAD', null, { op: 'HeadBucket', expectBody: false });
    return { ok: true, status: r.status };
  }

  /** 建桶（PUT bucket）。已存在且归自己所有时 S3 / MinIO 返回 409 BucketAlreadyOwnedByYou，这里视为成功。 */
  async function createBucket() {
    try {
      const r = await request('PUT', null, { op: 'CreateBucket', expectBody: false });
      return { ok: true, created: true, status: r.status };
    } catch (e) {
      if (e instanceof S3Error && (e.s3Code === 'BucketAlreadyOwnedByYou' || e.s3Code === 'BucketAlreadyExists')) return { ok: true, created: false, status: 409 };
      throw e;
    }
  }

  /**
   * 上传对象。body 为 Buffer / 字符串时按内容签名；为可读流时用 UNSIGNED-PAYLOAD（必须给 contentLength）。
   * 返回 { etag, sha256 }。
   */
  async function putObject(key, body, { contentType = 'application/octet-stream', sha256, contentLength, metadata } = {}) {
    if (!key) throw new S3Error('BACKUP_FAILED', 'putObject 需要 key', { status: 400 });
    let payload = body;
    let hash = sha256;
    const headers = { 'content-type': contentType };
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      hash = hash || sha256Hex(payload);
      headers['content-length'] = String(payload.length);
    } else if (body && typeof body.pipe === 'function') {
      if (!Number.isInteger(contentLength) || contentLength < 0) throw new S3Error('BACKUP_FAILED', '流式上传需要 contentLength', { status: 400 });
      headers['content-length'] = String(contentLength);
      payload = Readable.toWeb(body);
      hash = UNSIGNED_PAYLOAD;
    } else {
      throw new S3Error('BACKUP_FAILED', 'putObject 的 body 必须是 Buffer、字符串或可读流', { status: 400 });
    }
    if (metadata) for (const [k, v] of Object.entries(metadata)) headers[`x-amz-meta-${k.toLowerCase()}`] = String(v);
    const r = await request('PUT', key, { headers, body: payload, payloadHash: hash, op: 'PutObject', expectBody: false });
    return { etag: (r.headers.get('etag') || '').replace(/^"|"$/g, '') || null, sha256: hash === UNSIGNED_PAYLOAD ? null : hash };
  }

  /** 下载对象：{ body: Buffer, contentType, contentLength, etag, lastModified }。不存在抛 S3Error(NOT_FOUND, 404)。 */
  async function getObject(key) {
    const r = await request('GET', key, { op: 'GetObject' });
    return {
      body: r.body, contentType: r.headers.get('content-type') || null, contentLength: r.body.length,
      etag: (r.headers.get('etag') || '').replace(/^"|"$/g, '') || null, lastModified: r.headers.get('last-modified') || null,
    };
  }

  /**
   * 从本机文件上传：不把文件读进内存。先流式算文件 sha256 作为签名载荷（x-amz-content-sha256），再以 fs 流发送；
   * 每次重试重新打开文件，所以与 Buffer 上传一样可重试。返回 { etag, sha256, size }。
   */
  async function putFile(key, filePath, { contentType = 'application/octet-stream', sha256, metadata } = {}) {
    if (!key) throw new S3Error('BACKUP_FAILED', 'putFile 需要 key', { status: 400 });
    let size;
    try { size = fs.statSync(filePath).size; } catch (e) { throw new S3Error('BACKUP_FAILED', `读不到待上传文件：${(e && e.message) || e}`, { status: 500, cause: e }); }
    const hash = sha256 || await sha256File(filePath);
    const headers = { 'content-type': contentType, 'content-length': String(size) };
    if (metadata) for (const [k, v] of Object.entries(metadata)) headers[`x-amz-meta-${k.toLowerCase()}`] = String(v);
    const open = () => Readable.toWeb(fs.createReadStream(filePath));
    const r = await request('PUT', key, { headers, body: open, payloadHash: hash, op: 'PutObject', expectBody: false });
    return { etag: (r.headers.get('etag') || '').replace(/^"|"$/g, '') || null, sha256: hash, size };
  }

  /**
   * 下载对象到本机文件（流式，不进内存），边写边算 sha256。整次下载失败（含半途断开）按同样的退避重试，每次重写文件。
   * 返回 { size, sha256, contentType, etag, lastModified }。不存在抛 S3Error(NOT_FOUND, 404)。
   */
  async function getObjectToFile(key, filePath) {
    let attempt = 0;
    for (;;) {
      attempt++;
      const r = await request('GET', key, { op: 'GetObject', expectBody: 'stream' }); // 连不上 / 4xx / 5xx 在这里面已按规则重试
      const hash = crypto.createHash('sha256');
      let size = 0;
      const counter = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } });
      try {
        await pipeline(Readable.fromWeb(r.stream), counter, fs.createWriteStream(filePath));
      } catch (e) {
        try { fs.rmSync(filePath, { force: true }); } catch (_) {}
        const err = new S3Error('BACKUP_UNREACHABLE', `下载中断（GetObject）：${(e && e.message) || 'unknown'}`, { status: 502, retriable: true, cause: e });
        if (attempt < maxAttempts) { await sleep(backoffMs * 2 ** (attempt - 1)); continue; }
        throw err;
      }
      return {
        size, sha256: hash.digest('hex'), contentType: r.headers.get('content-type') || null,
        etag: (r.headers.get('etag') || '').replace(/^"|"$/g, '') || null, lastModified: r.headers.get('last-modified') || null,
      };
    }
  }

  /** 对象元信息；不存在返回 null。 */
  async function headObject(key) {
    const r = await request('HEAD', key, { op: 'HeadObject', expectBody: false, allow404: true });
    if (r.notFound) return null;
    return {
      contentType: r.headers.get('content-type') || null, contentLength: Number(r.headers.get('content-length')) || 0,
      etag: (r.headers.get('etag') || '').replace(/^"|"$/g, '') || null, lastModified: r.headers.get('last-modified') || null,
    };
  }

  /** 删除对象（不存在也算成功，S3 语义）。 */
  async function deleteObject(key) {
    const r = await request('DELETE', key, { op: 'DeleteObject', expectBody: false, allow404: true });
    return { ok: true, status: r.status };
  }

  /** ListObjectsV2 一页：{ contents, commonPrefixes, isTruncated, nextContinuationToken }。 */
  async function listObjectsV2(prefix = '', { continuationToken, maxKeys = 1000, delimiter } = {}) {
    const query = { 'list-type': '2', prefix: prefix || '', 'max-keys': String(maxKeys) };
    if (continuationToken) query['continuation-token'] = continuationToken;
    if (delimiter) query.delimiter = delimiter;
    const r = await request('GET', null, { query, op: 'ListObjectsV2' });
    return parseListObjects(r.body.toString('utf8'));
  }

  /** 翻完所有页（最多 maxPages 页，防止无限循环）。 */
  async function listAll(prefix = '', { maxPages = 100, maxKeys = 1000 } = {}) {
    const out = [];
    let token = null;
    for (let page = 0; page < maxPages; page++) {
      const r = await listObjectsV2(prefix, { continuationToken: token || undefined, maxKeys });
      out.push(...r.contents);
      if (!r.isTruncated || !r.nextContinuationToken) return out;
      token = r.nextContinuationToken;
    }
    return out;
  }

  return {
    headBucket, createBucket, putObject, putFile, getObject, getObjectToFile, headObject, deleteObject, listObjectsV2, listAll,
    endpoint: base.origin + basePath, bucket, region: rgn, pathStyle, insecure,
  };
}

module.exports = {
  createS3Client, S3Error, signV4, validateEndpoint, isLoopbackHost, isPrivateHost, uriEncode, canonicalQuery, canonicalPath,
  parseXml, parseListObjects, parseErrorXml, sha256Hex, sha256File, EMPTY_SHA256, UNSIGNED_PAYLOAD, DEFAULT_REGION, BUCKET_RE,
};
