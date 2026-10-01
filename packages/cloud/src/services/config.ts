import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface AppConfig {
  accessSecret: Uint8Array;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  licenceTtlSeconds: number;
  graceDays: number;
  licenceKeyId: string;
  licenceIssuer: string;
  licencePrivateKey: KeyObject;
}

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
  return {
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
