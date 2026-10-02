'use strict';
const path = require('path');

/** Environment variable that relocates the app data directory (database, storage, logs, secrets). */
const ENV_VAR = 'TALEKILN_USER_DATA_DIR';
/** Command-line form of the same override: `Talekiln.exe --user-data-dir=<absolute path>`. */
const ARG_PREFIX = '--user-data-dir=';

function clean(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^"(.*)"$/, '$1').trim();
}

/**
 * Where the app keeps its data. Default is `<appData>/talekiln` (`%APPDATA%\talekiln` on Windows).
 * Overrides, highest priority first: the `--user-data-dir=` argument, then TALEKILN_USER_DATA_DIR.
 * Only absolute paths are accepted; anything else falls back to the default so a broken value can never
 * put the data somewhere unexpected. Returns `{ dir, source }` with source in 'arg' | 'env' | 'default'.
 */
function resolveUserDataDir({ appDataDir, env = process.env, argv = process.argv } = {}) {
  if (!appDataDir) throw new Error('appDataDir is required');
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith(ARG_PREFIX));
  const candidates = [
    ['arg', arg ? arg.slice(ARG_PREFIX.length) : ''],
    ['env', env ? env[ENV_VAR] : ''],
  ];
  for (const [source, raw] of candidates) {
    const v = clean(raw);
    if (v && path.isAbsolute(v)) return { dir: path.normalize(v), source };
  }
  return { dir: path.join(appDataDir, 'talekiln'), source: 'default' };
}

module.exports = { resolveUserDataDir, ENV_VAR, ARG_PREFIX };
