import { createPublicKey, type KeyObject } from 'node:crypto';
import type { JWK } from 'jose';
import type { AppConfig } from './config';

/** 公钥 JWK（绝不含私钥分量 d），客户端按 kid 取用。 */
export function publicJwk(key: KeyObject, kid: string): JWK {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  const { d: _d, ...jwk } = pub.export({ format: 'jwk' }) as JWK;
  return { ...jwk, kid, alg: 'ES256', use: 'sig' };
}

/**
 * 官方 JWKS（GET /.well-known/licence-jwks.json）：许可证密钥在前（许可证、目录、模板都用它签），
 * 其后是独立的插件签名密钥（配置了才有，回退时与许可证密钥是同一把、不重复列出）和已退役的插件签名公钥。
 * 客户端（packages/local/src/cloud/jwks.js）只认这里出现的 kid，所以退役公钥留在这里就能让旧签名继续验得过。
 */
export function buildJwks(cfg: AppConfig): { keys: JWK[] } {
  const keys = [publicJwk(cfg.licencePrivateKey, cfg.licenceKeyId)];
  if (cfg.pluginSigningDedicated) keys.push(publicJwk(cfg.pluginSigningPrivateKey, cfg.pluginSigningKeyId));
  for (const r of cfg.pluginRetiredKeys) keys.push(publicJwk(r.publicKey, r.kid));
  return { keys };
}

export interface PluginSigningKeyInfo {
  /** 当前给插件签名用的 kid。 */
  kid: string;
  alg: 'ES256';
  /** 是否配置了独立的插件签名密钥；false 表示暂用许可证密钥。 */
  dedicated: boolean;
  licenceKid: string;
  /** 仍在 JWKS 里、只用于验签的退役 kid。 */
  retiredKids: string[];
  jwksPath: string;
}

/** 后台「插件审核」页展示用；只有 kid 等公开信息，没有任何密钥材料。 */
export function pluginSigningKeyInfo(cfg: AppConfig): PluginSigningKeyInfo {
  return {
    kid: cfg.pluginSigningKeyId,
    alg: 'ES256',
    dedicated: cfg.pluginSigningDedicated,
    licenceKid: cfg.licenceKeyId,
    retiredKids: cfg.pluginRetiredKeys.map((r) => r.kid),
    jwksPath: '/.well-known/licence-jwks.json',
  };
}
