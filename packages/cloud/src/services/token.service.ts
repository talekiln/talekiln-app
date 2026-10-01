import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { AppConfig } from './config';
import { ServiceError } from './errors';
import type { Account, Repositories } from '../domain/repositories';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AccessClaims {
  accountId: string;
  role: 'USER' | 'ADMIN';
  deviceId: string | null;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class TokenService {
  constructor(
    private readonly repos: Repositories,
    private readonly cfg: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 新登录：开启新的令牌家族。 */
  issue(account: Account, deviceId: string | null): Promise<TokenPair> {
    return this.issueInFamily(account, deviceId, randomUUID());
  }

  private async issueInFamily(account: Account, deviceId: string | null, familyId: string): Promise<TokenPair> {
    const now = this.now();
    const refreshToken = randomBytes(32).toString('base64url');
    await this.repos.refreshTokens.create({
      familyId,
      accountId: account.id,
      deviceId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(now.getTime() + this.cfg.refreshTtlSeconds * 1000),
    });
    const accessToken = await new SignJWT({ role: account.role, did: deviceId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(account.id)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + this.cfg.accessTtlSeconds)
      .sign(this.cfg.accessSecret);
    return { accessToken, refreshToken, expiresIn: this.cfg.accessTtlSeconds };
  }

  /**
   * 刷新令牌轮换。旧令牌一旦使用即作废；
   * 若已使用/已吊销的令牌被重放，视为泄露，整个家族全部吊销。
   */
  async rotate(refreshToken: string): Promise<TokenPair> {
    const now = this.now();
    const rec = await this.repos.refreshTokens.findByHash(sha256(refreshToken));
    if (!rec) throw new ServiceError('invalid_token');
    if (rec.usedAt || rec.revokedAt) {
      await this.repos.refreshTokens.revokeFamily(rec.familyId, now);
      throw new ServiceError('token_reuse', 'refresh token reuse detected; session revoked');
    }
    if (rec.expiresAt <= now) throw new ServiceError('invalid_token');
    // 并发重放：只有一个请求能 markUsed 成功，输家按重放处理
    if (!(await this.repos.refreshTokens.markUsed(rec.id, now))) {
      await this.repos.refreshTokens.revokeFamily(rec.familyId, now);
      throw new ServiceError('token_reuse', 'refresh token reuse detected; session revoked');
    }
    const account = await this.repos.accounts.findById(rec.accountId);
    if (!account) throw new ServiceError('invalid_token');
    if (account.disabledAt) {
      await this.repos.refreshTokens.revokeFamily(rec.familyId, now);
      throw new ServiceError('account_disabled');
    }
    if (rec.deviceId) {
      const d = await this.repos.devices.findById(rec.deviceId);
      if (!d || d.revokedAt) {
        await this.repos.refreshTokens.revokeFamily(rec.familyId, now);
        throw new ServiceError('device_revoked');
      }
    }
    return this.issueInFamily(account, rec.deviceId, rec.familyId);
  }

  async logout(refreshToken: string): Promise<void> {
    const rec = await this.repos.refreshTokens.findByHash(sha256(refreshToken));
    if (rec) await this.repos.refreshTokens.revokeFamily(rec.familyId, this.now());
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.cfg.accessSecret, {
        algorithms: ['HS256'],
        currentDate: this.now(),
      });
      return {
        accountId: String(payload.sub),
        role: payload.role === 'ADMIN' ? 'ADMIN' : 'USER',
        deviceId: typeof payload.did === 'string' ? payload.did : null,
      };
    } catch {
      throw new ServiceError('invalid_token');
    }
  }
}
