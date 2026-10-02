import { z } from 'zod';
import { defaultPlanSeeds, type PlanSeed } from './billing.config';
import { ServiceError } from './errors';
import type { PlanVersion, Repositories } from '../domain/repositories';

const cents = z.number().int().min(1).max(10_000_000).nullable();
export const entitlementsSchema = z.object({
  maxDevices: z.number().int().min(1).max(100),
  exportMaxHeight: z.number().int().min(144).max(8640),
  watermark: z.boolean(),
  features: z.array(z.string().min(1).max(40)).max(50),
});
export const planVersionSchema = z.object({
  priceMonthCents: cents,
  priceYearCents: cents,
  entitlements: entitlementsSchema,
});
export const planCreateSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_-]{1,29}$/),
  name: z.string().min(1).max(60),
}).and(planVersionSchema);

export interface PublicPlan {
  code: string;
  name: string;
  version: number;
  versionId: string;
  prices: { month: number | null; year: number | null };
  currency: 'CNY';
  entitlements: PlanVersion['entitlements'];
}

const toPublic = (name: string, v: PlanVersion): PublicPlan => ({
  code: v.planCode, name, version: v.version, versionId: v.id,
  prices: { month: v.priceMonthCents, year: v.priceYearCents }, currency: 'CNY', entitlements: v.entitlements,
});

export class PlanService {
  constructor(private readonly repos: Repositories) {}

  /** 幂等播种：只创建缺失的套餐（含第 1 版），不会改动已存在的套餐与价格。 */
  async ensureSeeded(seeds: PlanSeed[] = defaultPlanSeeds()): Promise<void> {
    for (const s of seeds) {
      let plan = await this.repos.plans.findByCode(s.code);
      if (!plan) {
        try {
          plan = await this.repos.plans.create({ code: s.code, name: s.name });
        } catch (e) {
          // 多实例同时启动：唯一键冲突说明别人已建好
          const code = (e as { code?: string }).code;
          if (code !== 'P2002' && !(e as Error).message?.startsWith('unique:')) throw e;
          plan = await this.repos.plans.findByCode(s.code);
        }
      }
      if (plan && !(await this.repos.plans.latestVersion(plan.id))) {
        await this.repos.plans.addVersion(plan.id, {
          priceMonthCents: s.priceMonthCents, priceYearCents: s.priceYearCents, entitlements: s.entitlements,
        });
      }
    }
  }

  /** 对外展示：已启用套餐的最新版本。 */
  async listPublic(): Promise<PublicPlan[]> {
    const all = await this.repos.plans.list();
    return all
      .filter((x) => x.plan.enabled && x.versions.length > 0)
      .map((x) => toPublic(x.plan.name, x.versions[x.versions.length - 1]));
  }

  /** 管理端：全部套餐与全部版本。 */
  listAdmin() { return this.repos.plans.list(); }

  async create(input: unknown) {
    const body = planCreateSchema.parse(input);
    try {
      const plan = await this.repos.plans.create({ code: body.code, name: body.name });
      const version = await this.repos.plans.addVersion(plan.id, {
        priceMonthCents: body.priceMonthCents, priceYearCents: body.priceYearCents, entitlements: body.entitlements,
      });
      return { plan, version };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P2002' || (e as Error).message?.startsWith('unique:')) throw new ServiceError('conflict', '套餐代码已存在');
      throw e;
    }
  }

  /** 改价/改权益 = 新增版本。老订单不受影响。 */
  async addVersion(code: string, input: unknown) {
    const body = planVersionSchema.parse(input);
    const plan = await this.repos.plans.findByCode(code);
    if (!plan) throw new ServiceError('not_found');
    return this.repos.plans.addVersion(plan.id, body);
  }

  async setEnabled(code: string, enabled: boolean) {
    if (!(await this.repos.plans.setEnabled(code, enabled))) throw new ServiceError('not_found');
  }
}
