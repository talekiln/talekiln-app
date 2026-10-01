import { z } from 'zod';
import { ServiceError } from './errors';
import type { AnnouncementInput, AnnouncementRecord, ReleaseChannel, Repositories } from '../domain/repositories';

const isoDate = z.string().datetime({ offset: true }).transform((s) => new Date(s));

export const announcementCreateSchema = z.object({
  title: z.string().trim().min(1).max(100),
  body: z.string().max(2000).default(''),
  level: z.enum(['info', 'warn', 'critical']).default('info'),
  channel: z.enum(['all', 'beta', 'stable']).default('all'),
  /** 缺省 = 现在。 */
  startsAt: isoDate.optional(),
  endsAt: isoDate.nullable().optional(),
  enabled: z.boolean().default(true),
});
export const announcementPatchSchema = z.object({
  title: z.string().trim().min(1).max(100),
  body: z.string().max(2000),
  level: z.enum(['info', 'warn', 'critical']),
  channel: z.enum(['all', 'beta', 'stable']),
  startsAt: isoDate,
  endsAt: isoDate.nullable(),
  enabled: z.boolean(),
}).partial();

/** 客户端看到的公告形状：不含内部字段。 */
export function publicAnnouncement(a: AnnouncementRecord) {
  return { id: a.id, title: a.title, body: a.body, level: a.level, channel: a.channel, startsAt: a.startsAt, endsAt: a.endsAt };
}

function assertWindow(startsAt: Date, endsAt: Date | null) {
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) throw new ServiceError('bad_request', '结束时间必须晚于生效时间');
}

/** 公告：标题、正文、生效时间窗、渠道。客户端只拿到“已启用且在时间窗内”的公告。 */
export class AnnouncementService {
  constructor(private readonly repos: Repositories, private readonly now: () => Date = () => new Date()) {}

  list() { return this.repos.announcements.list(); }

  async create(input: unknown) {
    const b = announcementCreateSchema.parse(input);
    const now = this.now();
    const data: AnnouncementInput = {
      title: b.title, body: b.body, level: b.level, channel: b.channel,
      startsAt: b.startsAt ?? now, endsAt: b.endsAt ?? null, enabled: b.enabled,
    };
    assertWindow(data.startsAt, data.endsAt);
    return this.repos.announcements.create(data, now);
  }

  async update(id: string, input: unknown) {
    const patch = announcementPatchSchema.parse(input);
    const cur = await this.repos.announcements.findById(id);
    if (!cur) throw new ServiceError('not_found');
    assertWindow(patch.startsAt ?? cur.startsAt, patch.endsAt === undefined ? cur.endsAt : patch.endsAt);
    return (await this.repos.announcements.update(id, patch, this.now()))!;
  }

  async remove(id: string) {
    if (!(await this.repos.announcements.delete(id))) throw new ServiceError('not_found');
  }

  async listPublic(channel: ReleaseChannel) {
    return (await this.repos.announcements.listEffective(this.now(), channel)).map(publicAnnouncement);
  }
}
