import { ServiceError } from './errors';
import type { DeviceInfo } from './auth.service';
import type { Repositories } from '../domain/repositories';

export class DeviceService {
  constructor(private readonly repos: Repositories, private readonly now: () => Date = () => new Date()) {}

  async register(accountId: string, info: DeviceInfo) {
    const d = await this.repos.devices.upsert(accountId, info.fingerprint, info.name);
    if (d.revokedAt) throw new ServiceError('device_revoked');
    await this.repos.devices.touch(d.id, this.now());
    return d;
  }

  list(accountId: string) { return this.repos.devices.listByAccount(accountId); }

  async revoke(accountId: string, deviceId: string) {
    const d = await this.repos.devices.findById(deviceId);
    if (!d || d.accountId !== accountId) throw new ServiceError('not_found');
    await this.repos.devices.revoke(deviceId, this.now());
  }
}
