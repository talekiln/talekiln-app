import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { canonicalJson } from './catalog.service';
import type { PluginSignature } from '../domain/repositories';

/**
 * 插件包签名（与 @talekiln/plugin-sdk 的 signing.js 同一算法；云端镜像不含 SDK，故在此复刻并由测试交叉校验）：
 *   载荷 = canonicalJson({ manifest: <不含 signature 的 manifest>, files: { "<相对路径>": "<sha256 hex>" } })
 *   签名 = ES256（P-256 + SHA-256，IEEE P1363 r||s）over UTF-8 载荷，base64url，带签名密钥的 kid
 * 客户端用官方 JWKS（与目录、许可证同一把密钥）按 kid 取公钥验签。
 */
export function pluginSigningPayload(manifest: Record<string, unknown>, fileHashes: Record<string, string>): string {
  const { signature: _signature, ...rest } = manifest;
  return canonicalJson({ manifest: rest, files: fileHashes });
}

/** 展示用指纹：sha256(载荷)。本地插件页显示同一个值，可据此对上审核记录。 */
export const pluginHash = (payload: string): string => createHash('sha256').update(payload, 'utf8').digest('hex');

export function signPluginPayload(payload: string, privateKey: KeyObject, kid: string): PluginSignature {
  const value = cryptoSign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { alg: 'ES256', kid, value };
}

export function verifyPluginPayload(payload: string, signature: PluginSignature, key: KeyObject): boolean {
  if (!signature || signature.alg !== 'ES256' || typeof signature.value !== 'string') return false;
  const pub = key.type === 'public' ? key : createPublicKey(key);
  try {
    return cryptoVerify('sha256', Buffer.from(payload, 'utf8'), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature.value, 'base64url'));
  } catch {
    return false;
  }
}
