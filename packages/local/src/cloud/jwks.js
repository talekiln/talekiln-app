'use strict';
/** 云端 JWKS 缓存：落 global_settings（公钥，非机密）；缺 kid 时联网拉取，离线则用缓存。 */
const { getGlobalSetting, setGlobalSetting } = require('../services/settingsService');
const { findKey } = require('./jws');

const KEY = 'cloud.jwks';

function createJwksProvider({ db, http }) {
  /** 返回 kid 对应的 JWK；缓存没有且联网失败时抛出（调用方按"无法验证"处理）。 */
  async function getKey(kid) {
    const cached = getGlobalSetting(db, KEY, null);
    const hit = findKey(cached, kid);
    if (hit) return hit;
    const fresh = await http.request('GET', '/.well-known/licence-jwks.json');
    if (!fresh || !Array.isArray(fresh.keys)) throw new Error('bad jwks');
    setGlobalSetting(db, KEY, fresh);
    const k = findKey(fresh, kid);
    if (!k) throw new Error('unknown kid');
    return k;
  }
  /** 只读缓存（离线验证用）。 */
  function cachedKey(kid) {
    return findKey(getGlobalSetting(db, KEY, null), kid);
  }
  return { getKey, cachedKey };
}

module.exports = { createJwksProvider };
