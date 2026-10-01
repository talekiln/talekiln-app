'use strict';

/**
 * 可插拔密钥存储。
 *
 * 约定：
 * - 明文只存在于进程内存（Map）；落盘的只有 cipher 产出的密文。
 * - cipher 接口：{ isAvailable(): boolean, encrypt(plain: string): string, decrypt(ciphertext: string): string }
 *   生产环境由 apps/desktop/main.js 用 Electron safeStorage 实现并注入；
 *   cipher 不可用时拒绝写入（抛 SecretStoreUnavailableError），绝不降级为明文。
 * - 存储接口：get(ref) / set(ref, plain) / delete(ref) / has(ref) / isAvailable() / knownSecrets()
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SecretStoreUnavailableError extends Error {
  constructor(msg) {
    super(msg || '系统密钥加密不可用，已拒绝保存 API Key');
    this.name = 'SecretStoreUnavailableError';
    this.code = 'SECRET_STORE_UNAVAILABLE';
  }
}

/** 内存 + 密文文件后端。filePath 为空时仅内存（测试用）。 */
class FileSecretStore {
  constructor({ cipher, filePath } = {}) {
    this.cipher = cipher || null;
    this.filePath = filePath || null;
    this.mem = new Map();
    this.cipherTexts = {};
    this._load();
  }

  isAvailable() {
    return !!(this.cipher && this.cipher.isAvailable());
  }

  _load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (raw && typeof raw === 'object') this.cipherTexts = raw;
    } catch (_) {
      this.cipherTexts = {};
    }
    if (!this.isAvailable()) return;
    for (const [ref, ct] of Object.entries(this.cipherTexts)) {
      try {
        this.mem.set(ref, this.cipher.decrypt(ct));
      } catch (_) {
        // 无法解密（换机器 / 用户重置）：忽略该条，用户需重新填写 key
      }
    }
  }

  _persist() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.cipherTexts), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  get(ref) {
    return this.mem.has(ref) ? this.mem.get(ref) : null;
  }

  has(ref) {
    return this.mem.has(ref);
  }

  set(ref, plain) {
    if (plain == null || plain === '') return this.delete(ref);
    if (!this.isAvailable()) throw new SecretStoreUnavailableError();
    const ct = this.cipher.encrypt(String(plain));
    this.cipherTexts[ref] = ct;
    this._persist();
    this.mem.set(ref, String(plain));
  }

  delete(ref) {
    const had = ref in this.cipherTexts || this.mem.has(ref);
    delete this.cipherTexts[ref];
    this.mem.delete(ref);
    if (had) this._persist();
  }

  knownSecrets() {
    return [...this.mem.values()];
  }
}

/** 永远不可用的存储：未注入时的默认值，读返回空，写拒绝。 */
class UnavailableSecretStore {
  isAvailable() { return false; }
  get() { return null; }
  has() { return false; }
  set(ref, plain) {
    if (plain == null || plain === '') return;
    throw new SecretStoreUnavailableError();
  }
  delete() {}
  knownSecrets() { return []; }
}

/** AES-256-GCM cipher：仅供测试 / 开发（密钥由调用方提供，不是系统级保护）。 */
function createAesCipher(key32) {
  const key = Buffer.isBuffer(key32) ? key32 : Buffer.from(String(key32), 'hex');
  if (key.length !== 32) throw new Error('AES cipher requires a 32-byte key');
  return {
    isAvailable: () => true,
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
    },
    decrypt(b64) {
      const buf = Buffer.from(b64, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

/** 由 Electron safeStorage（或同形对象）构造 cipher，密文以 base64 存放。 */
function createSafeStorageCipher(safeStorage) {
  return {
    isAvailable: () => {
      try { return !!safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
    },
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };
}

let current = new UnavailableSecretStore();
function setSecretStore(store) { current = store || new UnavailableSecretStore(); }
function getSecretStore() { return current; }

/** 掩码：仅保留末 4 位；过短（<8）的 key 完全掩码，避免暴露过大比例。 */
function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  return s.length >= 8 ? '****' + s.slice(-4) : '****';
}
function isMaskedKey(v) {
  return typeof v === 'string' && v.startsWith('****') && v.length <= 8;
}

const SENSITIVE_NAME = /api[_-]?key|secret|token|authorization|password|access_key/i;
/** 日志脱敏：按字段名清洗对象；按已知密钥值与 Bearer 模式清洗文本。 */
function redactValue(v, depth = 0) {
  if (depth > 6 || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  if (typeof v === 'object') {
    if (v instanceof Error) return { name: v.name, message: v.message };
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SENSITIVE_NAME.test(k) && val && typeof val !== 'boolean' ? '[REDACTED]' : redactValue(val, depth + 1);
    }
    return out;
  }
  return v;
}
function redactText(text) {
  let s = String(text);
  for (const secret of current.knownSecrets()) {
    if (secret && secret.length >= 6) s = s.split(secret).join('[REDACTED]');
  }
  return s.replace(/(Bearer|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]');
}

module.exports = {
  SecretStoreUnavailableError,
  FileSecretStore,
  UnavailableSecretStore,
  createAesCipher,
  createSafeStorageCipher,
  setSecretStore,
  getSecretStore,
  maskKey,
  isMaskedKey,
  redactValue,
  redactText,
  configRef: (id) => `ai_config:${id}`,
};
