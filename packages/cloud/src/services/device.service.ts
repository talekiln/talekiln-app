import { ServiceError } from './errors';
import { EntitlementService } from './entitlement.service';
import type { DeviceInfo } from './auth.service';
import type { Repositories } from '../domain/repositories';

export class DeviceService {
  constructor(
    private readonly repos: Repositories,
    private readonly now: () => Date = () => new Date(),
    private readonly entitlements: EntitlementService = new EntitlementService(repos, now),
  ) {}

  /**
   * 注册设备（登录与 /devices 共用）。新设备受当前权益的 maxDevices 限制；
   * 已注册过的设备（同指纹）重复登录不占新名额；已吊销的设备不能再用。
   * 上限判断在仓储里和创建在同一把账号锁内完成，并发注册不会超限。
   */
  async register(accountId: string, info: DeviceInfo) {
    const { entitlements } = await this.entitlements.resolve(accountId);
    const r = await this.repos.devices.registerLimited(accountId, info.fingerprint, info.name, entitlements.maxDevices);
    if (!r.ok) {
      throw new ServiceError('device_limit', `device limit reached (${entitlements.maxDevices}); revoke a device first`);
    }
    if (r.device.revokedAt) throw new ServiceError('device_revoked');
    await this.repos.devices.touch(r.device.id, this.now());
    return r.device;
  }

  list(accountId: string) { return this.repos.devices.listByAccount(accountId); }

  async revoke(accountId: string, deviceId: string) {
    const d = await this.repos.devices.findById(deviceId);
    if (!d || d.accountId !== accountId) throw new ServiceError('not_found');
    await this.repos.devices.revoke(deviceId, this.now());
  }
}
