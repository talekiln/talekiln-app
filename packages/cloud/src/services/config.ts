import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface RetiredSigningKey { kid: string; publicKey: KeyObject }

export interface AppConfig {
  accessSecret: Uint8Array;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  licenceTtlSeconds: number;
  graceDays: number;
  licenceKeyId: string;
  licenceIssuer: string;
  licencePrivateKey: KeyObject;
  /**
   * 插件签名密钥（P3-P）。官方插件签名只在云端服务器上做，私钥只存在于服务器的 .env。
   * 未配置 PLUGIN_SIGNING_PRIVATE_KEY_PEM 时回退到许可证密钥（pluginSigningDedicated=false），kid 也随之等于 licenceKeyId。
   */
  pluginSigningKeyId: string;
  pluginSigningPrivateKey: KeyObject;
  pluginSigningDedicated: boolean;
  /** 已轮换下线、但为了让已分发的签名包继续验得过而仍发布在 JWKS 里的插件签名公钥。 */
  pluginRetiredKeys: RetiredSigningKey[];
  /** 管理后台令牌密钥（与用户访问令牌密钥独立）。 */
  adminSecret: Uint8Array;
  adminTtlSeconds: number;
  /** 诊断包解码后的最大字节数。 */
  maxDiagnosticBytes: number;
  /** 每 IP 每 10 分钟允许的反馈条数。 */
  feedbackRateLimit: number;
  /**
   * P2-C 登录适配器开关：mock = 模拟实现（验证码写日志、二维码靠“模拟确认”接口），none = 未接入（相关接口 503）。
   * 开发 / 测试环境默认 mock，生产环境默认 none；真实厂商（阿里云短信 / 微信开放平台）只留接口与文档。
   */
  smsProvider: LoginProviderKind;
  wechatProvider: LoginProviderKind;
  /** 非生产环境：/auth/sms/send 返回 debug_code，便于测试与联调。 */
  loginDebug: boolean;
}

export type LoginProviderKind = 'mock' | 'none';

function parseLoginProvider(raw: string | undefined, name: string, production: boolean): LoginProviderKind {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return production ? 'none' : 'mock';
  if (v === 'mock' || v === 'none') return v;
  throw new Error(`${name} 只能是 mock 或 none（真实厂商尚未接入，见 docs/phase2-login.md）`);
}

export const CONFIG = Symbol('CONFIG');

export function generateLicenceKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const unescapePem = (s: string) => s.replace(/\\n/g, '\n').trim();

/** JWKS 里的 kid 规则与 SDK signManifest 一致（字母、数字、. _ -，最长 64）。 */
function checkKid(kid: string, name: string): string {
  if (!KID_RE.test(kid)) throw new Error(`${name} 只能含字母、数字、. _ -（1–64 位）`);
  return kid;
}

/** 签名密钥必须是 ES256 用的 EC P-256（prime256v1）。 */
function assertP256(key: KeyObject, name: string): KeyObject {
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`${name} 必须是 EC P-256（prime256v1）密钥`);
  }
  return key;
}

/**
 * 退役公钥：PLUGIN_SIGNING_RETIRED_PUBLIC_KEYS_PEM 为一把或多把 SPKI 公钥 PEM（换行写成 \n），多把用 ; 分隔；
 * PLUGIN_SIGNING_RETIRED_KEY_IDS 为逗号分隔的 kid，按同样顺序一一对应。只接受公钥材料。
 */
export function parseRetiredKeys(env: NodeJS.ProcessEnv): RetiredSigningKey[] {
  const pems = (env.PLUGIN_SIGNING_RETIRED_PUBLIC_KEYS_PEM ?? '').split(';').map(unescapePem).filter(Boolean);
  const kids = (env.PLUGIN_SIGNING_RETIRED_KEY_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (pems.length !== kids.length) {
    throw new Error(`PLUGIN_SIGNING_RETIRED_PUBLIC_KEYS_PEM（${pems.length} 把）与 PLUGIN_SIGNING_RETIRED_KEY_IDS（${kids.length} 个）数量不一致`);
  }
  const seen = new Set<string>();
  return pems.map((pem, i) => {
    const kid = checkKid(kids[i], 'PLUGIN_SIGNING_RETIRED_KEY_IDS');
    if (seen.has(kid)) throw new Error(`PLUGIN_SIGNING_RETIRED_KEY_IDS 重复：${kid}`);
    seen.add(kid);
    // 只接受公钥材料：私钥 PEM 也能被 createPublicKey 读出公钥，但退役私钥应当销毁，不该还留在 .env 里
    if (/PRIVATE KEY/.test(pem)) throw new Error(`PLUGIN_SIGNING_RETIRED_PUBLIC_KEYS_PEM 第 ${i + 1} 把是私钥；退役列表只能放公钥（SPKI PEM）`);
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(pem);
    } catch (e) {
      throw new Error(`PLUGIN_SIGNING_RETIRED_PUBLIC_KEYS_PEM 第 ${i + 1} 把不是合法的公钥 PEM：${(e as Error).message}`);
    }
    return { kid, publicKey: assertP256(publicKey, `退役公钥 ${kid}`) };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const secret = env.JWT_ACCESS_SECRET ?? '';
  if (secret.length < 32) throw new Error('JWT_ACCESS_SECRET 至少需要 32 个字符');
  const production = env.NODE_ENV === 'production';
  let key: KeyObject;
  const pem = env.LICENCE_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n');
  if (pem) {
    key = createPrivateKey(pem);
  } else if (production) {
    throw new Error('生产环境必须提供 LICENCE_PRIVATE_KEY_PEM');
  } else {
    console.warn('[cloud] 未提供 LICENCE_PRIVATE_KEY_PEM，使用临时密钥（重启后已签发许可证将失效）');
    key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  }
  const licenceKeyId = checkKid(env.LICENCE_KEY_ID ?? 'lic-1', 'LICENCE_KEY_ID');

  // 插件签名密钥：独立于许可证密钥；没有就回退（生产环境告警），kid 不能与许可证密钥撞车
  let pluginKey = key;
  let pluginSigningKeyId = licenceKeyId;
  let pluginSigningDedicated = false;
  const pluginPem = unescapePem(env.PLUGIN_SIGNING_PRIVATE_KEY_PEM ?? '');
  if (pluginPem) {
    try {
      pluginKey = assertP256(createPrivateKey(pluginPem), 'PLUGIN_SIGNING_PRIVATE_KEY_PEM');
    } catch (e) {
      throw new Error(`PLUGIN_SIGNING_PRIVATE_KEY_PEM 无法读取：${(e as Error).message}`);
    }
    pluginSigningKeyId = checkKid(env.PLUGIN_SIGNING_KEY_ID?.trim() || 'plg-1', 'PLUGIN_SIGNING_KEY_ID');
    if (pluginSigningKeyId === licenceKeyId) throw new Error('PLUGIN_SIGNING_KEY_ID 不能与 LICENCE_KEY_ID 相同（JWKS 里 kid 必须唯一）');
    pluginSigningDedicated = true;
  } else if (production) {
    console.warn('[cloud] 未提供 PLUGIN_SIGNING_PRIVATE_KEY_PEM，插件签名暂用许可证密钥；请按 docs/tencent-deploy.md 在服务器上生成独立的插件签名密钥');
  }
  const pluginRetiredKeys = parseRetiredKeys(env);
  for (const r of pluginRetiredKeys) {
    if (r.kid === licenceKeyId || r.kid === pluginSigningKeyId) throw new Error(`退役密钥 kid ${r.kid} 与在用密钥重复`);
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
    licenceKeyId,
    licenceIssuer: 'talekiln-cloud',
    licencePrivateKey: key,
    pluginSigningKeyId,
    pluginSigningPrivateKey: pluginKey,
    pluginSigningDedicated,
    pluginRetiredKeys,
    smsProvider: parseLoginProvider(env.SMS_PROVIDER, 'SMS_PROVIDER', production),
    wechatProvider: parseLoginProvider(env.WECHAT_PROVIDER, 'WECHAT_PROVIDER', production),
    loginDebug: !production,
  };
}
