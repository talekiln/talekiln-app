'use strict';
// Minimal JSON-RPC 2.0 client for lycore (named pipe on Windows, UDS elsewhere). No deps.
const net = require('net');

class RpcError extends Error {
  constructor(err) {
    super(err.message);
    this.code = err.code;
    this.data = err.data;
  }
}

function connect(endpoint, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint);
    const pending = new Map();
    let nextId = 1;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new RpcError(msg.error));
        else p.resolve(msg.result);
      }
    });
    sock.on('close', () => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection closed')); }
      pending.clear();
    });
    sock.once('error', reject);
    sock.once('connect', () => {
      sock.removeListener('error', reject);
      sock.on('error', () => {});
      resolve({
        call(method, params) {
          const id = nextId++;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => { pending.delete(id); rej(new Error('timeout: ' + method)); }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
          });
        },
        hello(apiVersions = [1]) { return this.call('core.hello', { apiVersions }); },
        close() { sock.end(); },
      });
    });
  });
}

/** Retry connect until the server is listening. */
async function connectRetry(endpoint, tries = 50, delayMs = 100) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await connect(endpoint); } catch (e) { last = e; await new Promise((r) => setTimeout(r, delayMs)); }
  }
  throw last;
}

module.exports = { connect, connectRetry, RpcError };
