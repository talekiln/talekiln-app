import { z } from 'zod';
import type { Repositories, TelemetryRow } from '../domain/repositories';

/**
 * 匿名使用统计（客户端须经用户同意后才上报；服务端不依赖也不记录账号/IP）。
 * 白名单 + strict：任何额外字段（提示词、路径、Key、邮箱等）都会令整个请求被拒绝，而不是被悄悄存下。
 */
export const EVENT_NAMES = [
  'app_open', 'onboarding_step', 'connect_test', 'project_created', 'export_done', 'export_failed', 'task_failed',
] as const;
/** 记为“失败”的事件：connect_test 仅在带错误码时计入。 */
const FAILURE_EVENTS = new Set(['export_failed', 'task_failed', 'connect_test']);

// 错误码只允许大写蛇形（如 ENCODER_FAIL、AUTH_401），形状上就不可能夹带 Key、路径或自由文本
const codeRe = /^[A-Z][A-Z0-9_]{1,47}$/;
const stepRe = /^[a-z0-9_]{1,32}$/;

const event = z.object({
  name: z.enum(EVENT_NAMES),
  code: z.string().regex(codeRe).optional(),
  step: z.string().regex(stepRe).optional(),
}).strict();

export const telemetryBody = z.object({
  installId: z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
  appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
  events: z.array(event).min(1).max(50),
}).strict();

export const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export class StatsService {
  constructor(
    private readonly repos: Repositories,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ingest(input: unknown): Promise<{ accepted: number }> {
    const b = telemetryBody.parse(input);
    const at = this.now(); // 以服务器收到时间为准
    const rows: TelemetryRow[] = b.events.map((e) => ({
      at, day: dayOf(at), installId: b.installId, name: e.name, code: e.code ?? null, step: e.step ?? null,
    }));
    await this.repos.telemetry.addMany(rows);
    return { accepted: rows.length };
  }

  async overview(days = 14) {
    const n = Math.min(Math.max(Math.floor(days), 1), 90);
    const today = this.now();
    const dayList: string[] = [];
    for (let i = n - 1; i >= 0; i--) dayList.push(dayOf(new Date(today.getTime() - i * 86400_000)));
    const rows = await this.repos.telemetry.since(dayList[0]);

    const perDay = new Map(dayList.map((d) => [d, { day: d, installs: new Set<string>(), projects: 0, exports: 0, failures: 0 }]));
    const codes = new Map<string, number>();
    const steps = new Map<string, Set<string>>();
    const allInstalls = new Set<string>();
    for (const r of rows) {
      const d = perDay.get(r.day);
      if (!d) continue;
      d.installs.add(r.installId);
      allInstalls.add(r.installId);
      if (r.name === 'project_created') d.projects++;
      if (r.name === 'export_done') d.exports++;
      if (FAILURE_EVENTS.has(r.name) && r.code && !(r.name === 'connect_test' && r.code === 'OK')) {
        d.failures++;
        const key = `${r.name}:${r.code}`;
        codes.set(key, (codes.get(key) ?? 0) + 1);
      }
      if (r.name === 'onboarding_step' && r.step) {
        if (!steps.has(r.step)) steps.set(r.step, new Set());
        steps.get(r.step)!.add(r.installId);
      }
    }
    const series = [...perDay.values()].map((d) => ({
      day: d.day, dau: d.installs.size, projects: d.projects, exports: d.exports, failures: d.failures,
    }));
    const accounts = await this.repos.accounts.list();
    const invites = await this.repos.invites.list();
    const now = this.now();
    return {
      days: n,
      series,
      totals: {
        activeInstalls: allInstalls.size,
        projects: series.reduce((s, x) => s + x.projects, 0),
        exports: series.reduce((s, x) => s + x.exports, 0),
        failures: series.reduce((s, x) => s + x.failures, 0),
        accounts: accounts.length,
        disabledAccounts: accounts.filter((a) => a.disabledAt).length,
        invitesUnused: invites.filter((i) => !i.usedAt && !i.revokedAt && !(i.expiresAt && i.expiresAt <= now)).length,
        invitesUsed: invites.filter((i) => i.usedAt).length,
      },
      failureCodes: [...codes.entries()].map(([key, count]) => {
        const [event, ...rest] = key.split(':');
        return { event, code: rest.join(':'), count };
      }).sort((a, b) => b.count - a.count).slice(0, 20),
      onboarding: [...steps.entries()].map(([step, s]) => ({ step, installs: s.size })).sort((a, b) => b.installs - a.installs),
    };
  }
}
