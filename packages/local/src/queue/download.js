'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { ProviderError, ERROR_CODES } = require('../providers/errors');

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Content-addressed location below the project storage dir. */
function blobPath(storageDir, sha) {
  return path.join(storageDir, 'blobs', sha.slice(0, 2), sha);
}

/** Parse "bytes 100-199/1000" or "bytes * /1000" (no space). */
function parseContentRange(h) {
  const m = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(String(h || '').trim());
  if (!m) return null;
  return { start: m[1] != null ? Number(m[1]) : null, end: m[2] != null ? Number(m[2]) : null, total: m[3] === '*' ? null : Number(m[3]) };
}

function parseRetryAfter(h, now = Date.now()) {
  if (h == null) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return n * 1000;
  const d = Date.parse(h);
  return Number.isNaN(d) ? null : Math.max(0, d - now);
}

/**
 * Resumable download into `<storageDir>/blobs/<aa>/<sha256>`.
 * Partial data is kept in `<storageDir>/tmp/<sha1(url)>.part` and continued with HTTP Range, also
 * across process restarts (a retry of a failed task resumes). The final file is hashed (sha256) and
 * compared with expectedSha256 when given; a mismatch discards the partial file.
 */
function createDownloader({ storageDir, fetchImpl = (...a) => fetch(...a), sleep = sleepDefault, maxAttempts = 6, retryDelayMs = 200, maxRetryDelayMs = 30000 }) {
  if (!storageDir) throw new Error('storageDir required');

  async function download(url, { expectedSha256, headers = {}, signal } = {}) {
    const key = crypto.createHash('sha1').update(url).digest('hex');
    const tmpDir = path.join(storageDir, 'tmp');
    await fsp.mkdir(tmpDir, { recursive: true });
    const part = path.join(tmpDir, `${key}.part`);
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal && signal.aborted) throw new ProviderError(ERROR_CODES.NETWORK, 'download aborted');
      let offset = 0;
      try { offset = (await fsp.stat(part)).size; } catch (_) { /* no partial */ }
      let wait = Math.min(maxRetryDelayMs, retryDelayMs * 2 ** (attempt - 1));
      try {
        const h = { ...headers };
        if (offset > 0) h.Range = `bytes=${offset}-`;
        const res = await fetchImpl(url, { headers: h, signal });
        let total = null;
        let append = false;
        if (res.status === 416) {
          const cr = parseContentRange(res.headers.get('content-range'));
          if (offset > 0 && cr && cr.total === offset) { total = offset; append = true; }
          else { await fsp.rm(part, { force: true }); lastErr = new Error('range not satisfiable, restarting'); wait = 0; continue; }
        } else if (res.status === 206) {
          const cr = parseContentRange(res.headers.get('content-range'));
          if (!cr || cr.start !== offset) { await fsp.rm(part, { force: true }); lastErr = new Error('unexpected Content-Range, restarting'); wait = 0; continue; }
          total = cr.total;
          append = true;
        } else if (res.status === 200) {
          const cl = Number(res.headers.get('content-length'));
          total = Number.isFinite(cl) && cl > 0 ? cl : null; // server ignored Range: restart from 0
        } else if (res.status === 429 || res.status >= 500) {
          const ra = parseRetryAfter(res.headers.get('retry-after'));
          if (ra != null) wait = Math.min(maxRetryDelayMs, ra);
          lastErr = new ProviderError(res.status === 429 ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.NETWORK, `HTTP ${res.status}`, { status: res.status });
          if (res.body) await res.body.cancel().catch(() => {});
          if (attempt < maxAttempts) await sleep(wait);
          continue;
        } else {
          if (res.body) await res.body.cancel().catch(() => {});
          throw new ProviderError(ERROR_CODES.BAD_RESPONSE, `download HTTP ${res.status}`, { status: res.status });
        }
        if (res.status !== 416) {
          await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
        }
        const size = (await fsp.stat(part)).size;
        if (total != null && size !== total) { lastErr = new Error(`incomplete: ${size}/${total}`); wait = 0; continue; }
        return await finalize(part, expectedSha256);
      } catch (err) {
        if (err instanceof ProviderError && err.code !== ERROR_CODES.NETWORK && err.code !== ERROR_CODES.RATE_LIMITED) throw err;
        lastErr = err; // interrupted transfer: keep the partial file and resume
      }
      if (attempt < maxAttempts && wait > 0) await sleep(wait);
    }
    const code = lastErr instanceof ProviderError ? lastErr.code : ERROR_CODES.NETWORK;
    throw new ProviderError(code, `download failed after ${maxAttempts} attempts: ${lastErr && lastErr.message}`);
  }

  async function finalize(part, expectedSha256) {
    const sha256 = await sha256File(part);
    if (expectedSha256 && String(expectedSha256).toLowerCase() !== sha256) {
      await fsp.rm(part, { force: true });
      throw new ProviderError(ERROR_CODES.BAD_RESPONSE, `sha256 mismatch: expected ${expectedSha256}, got ${sha256}`);
    }
    const dest = blobPath(storageDir, sha256);
    const size = (await fsp.stat(part)).size;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) await fsp.rm(part, { force: true });
    else await fsp.rename(part, dest);
    return { sha256, size, path: path.relative(storageDir, dest).split(path.sep).join('/') };
  }

  return { download };
}

/**
 * Wrap provider facades that have no download() of their own: result.url / result.urls[] are fetched
 * into the content-addressed store and reported as result.files. Anything else passes through.
 */
function withDownloads(providers, downloader) {
  const out = {};
  for (const [name, p] of Object.entries(providers)) {
    out[name] = p.download ? p : {
      ...p,
      async download(task, result) {
        const urls = [];
        if (result && typeof result.url === 'string') urls.push(result.url);
        if (result && Array.isArray(result.urls)) urls.push(...result.urls.filter((u) => typeof u === 'string'));
        const http = urls.filter((u) => /^https?:\/\//i.test(u));
        if (!http.length) return result;
        const files = [];
        for (const u of http) files.push({ url: u, ...(await downloader.download(u, { expectedSha256: result.sha256 })) });
        return { ...result, files };
      },
    };
  }
  return out;
}

module.exports = { createDownloader, withDownloads, sha256File, blobPath, parseContentRange, parseRetryAfter };
