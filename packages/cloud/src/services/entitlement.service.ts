import { FALLBACK_FREE_ENTITLEMENTS, FREE_PLAN_CODE, LEGACY_TEST_ENTITLEMENTS } from './billing.config';
import { ServiceError } from './errors';
import type { Entitlements, Repositories } from '../domain/repositories';

export interface ResolvedEntitlement {
  planCode: string;
  planVersionId: string | null;
  /** subscription：付费订阅有效；legacy：邀请码内测账号；free：免费版。 */
  source: 'subscription' | 'legacy' | 'free';
  entitlements: Entitlements;
  /** 订阅区间（仅 source = subscription 时有值；过期的订阅不算）。 */
  periodStart: Date | null;
  periodEnd: Date | null;
}

/** 账号当前生效的权益：有效订阅 > 内测账号（plan = test）> 免费版。 */
export class EntitlementService {
  constructor(private readonly repos: Repositories, private readonly now: () => Date = () => new Date()) {}

  async resolve(accountId: string): Promise<ResolvedEntitlement> {
    const account = await this.repos.accounts.findById(accountId);
    if (!account) throw new ServiceError('not_found');
    const now = this.now();
    const sub = await this.repos.subscriptions.findByAccount(accountId);
    if (sub && sub.currentPeriodEnd.getTime() > now.getTime()) {
      const v = await this.repos.plans.findVersion(sub.planVersionId);
      if (v) {
        return {
          planCode: v.planCode, planVersionId: v.id, source: 'subscription',
          entitlements: v.entitlements, periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd,
        };
      }
    }
    if (account.plan === 'test') {
      return {
        planCode: 'test', planVersionId: null, source: 'legacy',
        entitlements: LEGACY_TEST_ENTITLEMENTS, periodStart: null, periodEnd: null,
      };
    }
    const free = await this.repos.plans.findByCode(FREE_PLAN_CODE);
    const fv = free ? await this.repos.plans.latestVersion(free.id) : null;
    return {
      planCode: FREE_PLAN_CODE, planVersionId: fv?.id ?? null, source: 'free',
      entitlements: fv?.entitlements ?? FALLBACK_FREE_ENTITLEMENTS, periodStart: null, periodEnd: null,
    };
  }
}
