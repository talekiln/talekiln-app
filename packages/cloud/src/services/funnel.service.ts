import type { Repositories } from '../domain/repositories';
import { effectiveRole } from './admin-roles';
import { dayOf } from './stats.service';

export const rate = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 10000) / 10000 : null);

export interface FunnelStage { key: 'clicks' | 'registered' | 'activated' | 'firstExport'; count: number; rateFromPrev: number | null; rateFromFirst: number | null }

/** 阶段计数 -> 带转化率的阶段（纯函数，便于测试）。 */
export function buildStages(counts: { clicks: number; registered: number; activated: number; firstExport: number }): FunnelStage[] {
  const keys = ['clicks', 'registered', 'activated', 'firstExport'] as const;
  return keys.map((key, i) => ({
    key,
    count: counts[key],
    rateFromPrev: i === 0 ? null : rate(counts[key], counts[keys[i - 1]]),
    rateFromFirst: i === 0 ? null : rate(counts[key], counts.clicks),
  }));
}

/**
 * 推广漏斗（按时间窗汇总，不是队列追踪）：
 * - 点击：窗口内的 ReferralClick。
 * - 注册：窗口内创建的非管理员账号。
 * - 激活：其中至少登记过一台设备的账号（客户端装好并登录）。
 * - 首次导出：窗口内到达 first_export 引导步骤（或 export_done 事件）的去重安装数。
 * 点击、遥测与账号之间没有可关联的标识（遥测匿名、点击不带账号），所以各阶段是独立口径的计数，
 * 后一阶段可以大于前一阶段（自然流量），比率只用来看趋势，不能当作逐人转化率。
 */
export class FunnelService {
  constructor(private readonly repos: Repositories, private readonly now: () => Date = () => new Date()) {}

  async funnel(daysIn = 14) {
    const days = Math.min(Math.max(Math.floor(daysIn), 1), 90);
    const now = this.now();
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const from = new Date(todayStart - (days - 1) * 86400_000);
    const to = new Date(todayStart + 86400_000);
    const dayList = Array.from({ length: days }, (_, i) => dayOf(new Date(from.getTime() + i * 86400_000)));
    const perDay = new Map(dayList.map((d) => [d, { day: d, clicks: 0, registered: 0, activated: 0, firstExport: new Set<string>() }]));

    const clicks = await this.repos.referralClicks.between(from, to);
    const byCode = new Map<string, number>();
    for (const c of clicks) {
      byCode.set(c.code, (byCode.get(c.code) ?? 0) + 1);
      const d = perDay.get(dayOf(c.createdAt));
      if (d) d.clicks++;
    }

    const [accounts, roles] = await Promise.all([this.repos.accounts.list(), this.repos.adminRoles.list()]);
    const roleByAccount = new Map(roles.map((r) => [r.accountId, r]));
    const fresh = accounts.filter((a) => a.createdAt >= from && a.createdAt < to && !effectiveRole(a, roleByAccount.get(a.id) ?? null));
    let activated = 0;
    for (const a of fresh) {
      const d = perDay.get(dayOf(a.createdAt));
      if (d) d.registered++;
      if ((await this.repos.devices.listByAccount(a.id)).length > 0) {
        activated++;
        if (d) d.activated++;
      }
    }

    const exporters = new Set<string>();
    for (const r of await this.repos.telemetry.since(dayList[0])) {
      const isFirstExport = (r.name === 'onboarding_step' && r.step === 'first_export') || r.name === 'export_done';
      if (!isFirstExport) continue;
      exporters.add(r.installId);
      perDay.get(r.day)?.firstExport.add(r.installId);
    }

    const counts = { clicks: clicks.length, registered: fresh.length, activated, firstExport: exporters.size };
    return {
      days,
      from: dayList[0],
      to: dayList[dayList.length - 1],
      cohort: false as const,
      stages: buildStages(counts),
      byCode: [...byCode.entries()].map(([code, n]) => ({ code, clicks: n })).sort((a, b) => b.clicks - a.clicks || a.code.localeCompare(b.code)),
      series: [...perDay.values()].map((d) => ({
        day: d.day, clicks: d.clicks, registered: d.registered, activated: d.activated, firstExport: d.firstExport.size,
      })),
    };
  }
}
