'use strict';
// Unit test for the JSON-RPC client's per-call timeout (no lycore binary needed). Run: node client/timeout.test.js
// A long-running method such as encoder.detect (sequential ffmpeg test-encodes) must be able to outlive the
// connection-wide default without raising it for every other call.
const assert = require('assert');
const net = require('net');
const os = require('os');
const path = require('path');
const { connect } = require('./index');

const id = `lycore-timeout-test-${process.pid}`;
const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);

(async () => {
  // A server that answers 'fast' at once and never answers anything else.
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.method === 'fast') sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\n');
      }
    });
  });
  await new Promise((ok) => server.listen(endpoint, ok));
  const c = await connect(endpoint, { timeoutMs: 150 });

  const timed = async (p) => { const t0 = Date.now(); try { return { v: await p, ms: Date.now() - t0 }; } catch (e) { return { e, ms: Date.now() - t0 }; } };

  // connection default applies when no per-call option is given
  let r = await timed(c.call('slow', {}));
  assert.ok(r.e && r.e.message === 'timeout: slow', `expected default timeout, got ${r.e && r.e.message}`);
  assert.ok(r.ms < 1000, `default timeout took ${r.ms}ms`);

  // per-call timeout overrides the connection default (longer...)
  r = await timed(c.call('slow', {}, { timeoutMs: 600 }));
  assert.ok(r.e && r.e.message === 'timeout: slow');
  assert.ok(r.ms >= 500, `per-call timeout fired too early: ${r.ms}ms`);

  // ...and shorter
  r = await timed(c.call('slow', {}, { timeoutMs: 30 }));
  assert.ok(r.e && r.e.message === 'timeout: slow');
  assert.ok(r.ms < 150, `per-call short timeout took ${r.ms}ms`);

  // a per-call timeout does not break normal replies, and the facade helpers still work
  r = await timed(c.call('fast', {}, { timeoutMs: 600 }));
  assert.deepStrictEqual(r.v, { ok: true });

  c.close();
  server.close();
  console.log('client timeout tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
