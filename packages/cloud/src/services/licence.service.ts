import { createPublicKey, type KeyObject } from 'node:crypto';
import { jwtVerify, SignJWT, type JWK } from 'jose';
import type { AppConfig } from './config';
import { EntitlementService } from './entitlement.service';
import { ServiceError } from './errors';
import type { Repositories } from '../domain/repositories';

/** 套餐 -> 功能权益。test 套餐拥有全部功能。 */
export const ALL_FEATURES = ['generate', 'export', 'cloud-sync', 'batch', 'pro-models'] as const;
export const PLAN_ENTITLEMENTS: Record<string, readonly string[]> = {
  test: ALL_FEATURES,
};

export interface LicenceClaims {
  sub: string;       // accountId
  did: string;       // deviceId
  plan: string;
  entitlements: string[];
  graceDays: number;
  /** 当前权益的限额：设备数、导出最大高度（像素）、是否带水印。 */
  limits: { maxDevices: number; exportMaxHeight: number; watermark: boolean };
  /** 付费订阅到期时间（Unix 秒）；免费版/内测账号为 null。客户端应在此时间后按免费版处理。 */
  subEnd: number | null;
  exp: number;
  iat: number;
  iss: string;
}

export class LicenceService {
  private readonly publicKey: KeyObject;

  constructor(
    private readonly repos: Repositories,
    private readonly cfg: AppConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly entitlements: EntitlementService = new EntitlementService(repos, now),
  ) {
    this.publicKey = createPublicKey(cfg.licencePrivateKey);
  }

  async renew(accountId: string, deviceId: string | null) {
    if (!deviceId) throw new ServiceError('device_required');
    const device = await this.repos.devices.findById(deviceId);
    if (!device || device.accountId !== accountId) throw new ServiceError('device_required');
    if (device.revokedAt) throw new ServiceError('device_revoked');
    const account = await this.repos.accounts.findById(accountId);
    if (!account) throw new ServiceError('not_found');
    if (account.disabledAt) throw new ServiceError('account_disabled');

    const eff = await this.entitlements.resolve(accountId);
    // 降级后设备数超限：只有按注册先后排在前 maxDevices 个的未吊销设备能续期，其余需要用户先吊销别的设备
    const active = (await this.repos.devices.listByAccount(accountId))
      .filter((d) => !d.revokedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    if (active.findIndex((d) => d.id === device.id) >= eff.entitlements.maxDevices) {
      throw new ServiceError('device_limit', `device limit reached (${eff.entitlements.maxDevices})`);
    }

    const iat = Math.floor(this.now().getTime() / 1000);
    const exp = iat + this.cfg.licenceTtlSeconds;
    const subEnd = eff.source === 'subscription' && eff.periodEnd ? Math.floor(eff.periodEnd.getTime() / 1000) : null;
    const { maxDevices, exportMaxHeight, watermark } = eff.entitlements;
    const licence = await new SignJWT({
      did: device.id, plan: eff.planCode, entitlements: [...eff.entitlements.features], graceDays: this.cfg.graceDays,
      limits: { maxDevices, exportMaxHeight, watermark }, subEnd,
    })
      .setProtectedHeader({ alg: 'ES256', kid: this.cfg.licenceKeyId, typ: 'JWT' })
      .setIssuer(this.cfg.licenceIssuer)
      .setSubject(account.id)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.cfg.licencePrivateKey);
    await this.repos.devices.touch(device.id, this.now());
    await this.repos.licenceUsage.record({
      accountId, deviceId: device.id, planCode: eff.planCode,
      issuedAt: new Date(iat * 1000), expiresAt: new Date(exp * 1000),
    });
    return { licence, expiresAt: new Date(exp * 1000).toISOString(), graceDays: this.cfg.graceDays };
  }

  jwks(): { keys: JWK[] } {
    const jwk = this.publicKey.export({ format: 'jwk' }) as JWK;
    return { keys: [{ ...jwk, kid: this.cfg.licenceKeyId, alg: 'ES256', use: 'sig' }] };
  }

  /** 服务端自检用；客户端用 JWKS 公钥做同样的校验（exp 过期后的 14 天宽限由客户端自行判断）。 */
  async verify(token: string, opts: { ignoreExpiry?: boolean } = {}): Promise<LicenceClaims> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      algorithms: ['ES256'],
      issuer: this.cfg.licenceIssuer,
      currentDate: opts.ignoreExpiry ? new Date(0) : this.now(),
    });
    return payload as unknown as LicenceClaims;
  }
}
