import { createHmac, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface AppConfig {
  accessSecret: Uint8Array;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  licenceTtlSeconds: number;
  graceDays: number;
  licenceKeyId: string;
  licenceIssuer: string;
  licencePrivateKey: KeyObject;
  /** 管理后台令牌密钥（与用户访问令牌密钥独立）。 */
  adminSecret: Uint8Array;
  adminTtlSeconds: number;
  /** 诊断包解码后的最大字节数。 */
  maxDiagnosticBytes: number;
  /** 每 IP 每 10 分钟允许的反馈条数。 */
  feedbackRateLimit: number;
}

export const CONFIG = Symbol('CONFIG');

export function generateLicenceKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const secret = env.JWT_ACCESS_SECRET ?? '';
  if (secret.length < 32) throw new Error('JWT_ACCESS_SECRET 至少需要 32 个字符');
  let key: KeyObject;
  const pem = env.LICENCE_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n');
  if (pem) {
    key = createPrivateKey(pem);
  } else if (env.NODE_ENV === 'production') {
    throw new Error('生产环境必须提供 LICENCE_PRIVATE_KEY_PEM');
  } else {
    console.warn('[cloud] 未提供 LICENCE_PRIVATE_KEY_PEM，使用临时密钥（重启后已签发许可证将失效）');
    key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  }
  // 管理后台令牌密钥：优先 ADMIN_JWT_SECRET；未设置时由访问令牌密钥派生，二者不可互换
  const adminRaw = env.ADMIN_JWT_SECRET ?? '';
  if (adminRaw && adminRaw.length < 32) throw new Error('ADMIN_JWT_SECRET 至少需要 32 个字符');
  const adminSecret = adminRaw
    ? new TextEncoder().encode(adminRaw)
    : new Uint8Array(createHmac('sha256', secret).update('talekiln-admin-v1').digest());
  return {
    adminSecret,
    adminTtlSeconds: 2 * 3600,
    feedbackRateLimit: Number(env.FEEDBACK_RATE_LIMIT ?? 5),
    maxDiagnosticBytes: Number(env.MAX_DIAGNOSTIC_BYTES ?? 1_500_000),
    accessSecret: new TextEncoder().encode(secret),
    accessTtlSeconds: 15 * 60,
    refreshTtlSeconds: 30 * 86400,
    licenceTtlSeconds: Number(env.LICENCE_TTL_DAYS ?? 7) * 86400,
    graceDays: Number(env.LICENCE_GRACE_DAYS ?? 14),
    licenceKeyId: env.LICENCE_KEY_ID ?? 'lic-1',
    licenceIssuer: 'talekiln-cloud',
    licencePrivateKey: key,
  };
}
