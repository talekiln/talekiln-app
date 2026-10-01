'use strict';
const path = require('path');

/**
 * Lazily connects to lycore and reconnects after the socket closes.
 * `endpoint` is the pipe / UDS path the desktop shell started lycore with (env LYCORE_ENDPOINT).
 * Returns null when no endpoint is configured, so routes can answer "core not started".
 */
/** 打包后 @talekiln/core 是 node_modules 里的包；源码树里回退到相对路径。 */
function loadCoreClient() {
  try { return require('@talekiln/core'); } catch (_) { return require(path.join(__dirname, '..', '..', '..', 'core', 'client')); }
}

function createCoreProvider({ endpoint, connect } = {}) {
  if (!endpoint) return null;
  const doConnect = connect || ((e) => loadCoreClient().connectRetry(e));
  let client = null;
  let pending = null;

  async function fresh() {
    if (!pending) {
      pending = doConnect(endpoint).then((c) => { client = c; return c; }).finally(() => { pending = null; });
    }
    return pending;
  }

  /** A client facade that retries a call once on a dropped connection. */
  const facade = {};
  for (const m of ['call', 'renderStart', 'renderStatus', 'renderCancel']) {
    facade[m] = async (...args) => {
      const c = client || (await fresh());
      try {
        return await c[m](...args);
      } catch (e) {
        if (e && e.message === 'connection closed') {
          client = null;
          return (await fresh())[m](...args);
        }
        throw e;
      }
    };
  }
  return { getCore: async () => { if (!client) await fresh(); return facade; } };
}

module.exports = { createCoreProvider };
