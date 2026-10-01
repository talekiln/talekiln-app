import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, StreamableFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import { AuditInterceptor } from './audit.interceptor';
import { AdminGuard, Require, auditContext, type AdminRequest } from './guard';
import { AdminAuthService } from '../services/admin-auth.service';
import { ROLE_PERMISSIONS } from '../services/admin-roles';
import { CONFIG, type AppConfig } from '../services/config';
import { AdminService, type InviteStatus } from '../services/admin.service';
import { AdminsService } from '../services/admins.service';
import { AnnouncementService } from '../services/announcement.service';
import { AuditService } from '../services/audit.service';
import { FeedbackService } from '../services/feedback.service';
import { FunnelService } from '../services/funnel.service';
import { RateLimiter } from '../services/rate-limiter';
import { ReleaseService } from '../services/release.service';
import { ServiceError } from '../services/errors';
import { StatsService } from '../services/stats.service';

const loginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });
const inviteBody = z.object({
  plan: z.string().min(1).max(50).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  count: z.number().int().min(1).max(200).optional(),
});
const channelQuery = z.enum(['beta', 'stable']).catch('stable');
const MIN = 60_000;

@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    @Inject(AdminAuthService) private readonly admins: AdminAuthService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post('login') @HttpCode(200)
  async login(@Req() req: AdminRequest, @Body() b: unknown) {
    const body = loginBody.parse(b);
    // 防暴力破解：按来源 IP 与目标邮箱分别限流
    this.limiter.hit(`admin-login:ip:${req.ip}`, 20, 15 * MIN);
    this.limiter.hit(`admin-login:email:${body.email.toLowerCase()}`, 8, 15 * MIN);
    const ctx = { ...auditContext(req), body: { email: body.email.toLowerCase() } };
    try {
      const r = await this.admins.login(body.email, body.password);
      await this.audit.record({ id: r.admin.id, email: r.admin.email, role: r.admin.role }, ctx, true, 200);
      return r;
    } catch (e) {
      if (e instanceof ServiceError) await this.audit.record({ id: null, email: body.email.toLowerCase().slice(0, 200), role: null }, ctx, false, e.code === 'account_disabled' ? 403 : 401);
      throw e;
    }
  }
}

@Controller('admin')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(StatsService) private readonly stats: StatsService,
    @Inject(FeedbackService) private readonly feedback: FeedbackService,
  ) {}

  /** 当前管理员：带角色与权限清单，供后台界面决定显示哪些入口。 */
  @Get('me') me(@Req() req: AdminRequest) {
    const a = req.admin!;
    return { accountId: a.accountId, email: a.email, role: a.role, permissions: ROLE_PERMISSIONS[a.role] };
  }

  @Post('invites') createInvites(@Req() req: AdminRequest, @Body() b: unknown) {
    return this.admin.createInvites(req.admin!.accountId, inviteBody.parse(b ?? {}));
  }
  @Get('invites') listInvites(@Query('status') status?: string) {
    const s = z.enum(['unused', 'used', 'expired', 'revoked']).optional().parse(status);
    return this.admin.listInvites(s as InviteStatus | undefined);
  }
  @Post('invites/:id/revoke') @HttpCode(204)
  async revokeInvite(@Param('id') id: string) { await this.admin.revokeInvite(id); }

  @Get('users') listUsers() { return this.admin.listUsers(); }
  @Get('users/:id') getUser(@Param('id') id: string) { return this.admin.getUser(id); }
  @Post('users/:id/disable') @HttpCode(204)
  async disable(@Param('id') id: string) { await this.admin.setDisabled(id, true); }
  @Post('users/:id/enable') @HttpCode(204)
  async enable(@Param('id') id: string) { await this.admin.setDisabled(id, false); }

  @Get('catalog') catalog() { return this.admin.getCatalog(); }
  @Put('catalog') setCatalog(@Body() b: unknown) { return this.admin.setCatalog(b); }

  @Get('stats/overview')
  overview(@Query('days') days?: string) {
    return this.stats.overview(z.coerce.number().int().min(1).max(90).catch(14).parse(days));
  }

  @Get('feedback') listFeedback() { return this.feedback.list(100); }
  @Get('feedback/:id/diagnostic')
  @Require('feedback:diagnostic')
  @Header('Content-Type', 'application/zip')
  @Header('Content-Disposition', 'attachment; filename="diagnostic.zip"')
  async diagnostic(@Param('id') id: string) {
    return new StreamableFile((await this.feedback.diagnostic(id)).data);
  }
}

/** P2-H 新增的管理接口：推广漏斗、公告、版本灰度、管理员与审计。 */
@Controller('admin')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
export class AdminOpsController {
  constructor(
    @Inject(FunnelService) private readonly funnel: FunnelService,
    @Inject(AnnouncementService) private readonly announcements: AnnouncementService,
    @Inject(ReleaseService) private readonly releases: ReleaseService,
    @Inject(AdminsService) private readonly admins: AdminsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('stats/funnel')
  funnelStats(@Query('days') days?: string) {
    return this.funnel.funnel(z.coerce.number().int().min(1).max(90).catch(14).parse(days));
  }

  @Get('announcements') listAnnouncements() { return this.announcements.list(); }
  @Post('announcements') createAnnouncement(@Body() b: unknown) { return this.announcements.create(b); }
  @Put('announcements/:id') updateAnnouncement(@Param('id') id: string, @Body() b: unknown) { return this.announcements.update(id, b); }
  @Delete('announcements/:id') @HttpCode(204)
  async deleteAnnouncement(@Param('id') id: string) { await this.announcements.remove(id); }

  @Get('releases') listReleases() { return this.releases.list(); }
  @Post('releases') createRelease(@Body() b: unknown) { return this.releases.create(b); }
  @Put('releases/:id') updateRelease(@Param('id') id: string, @Body() b: unknown) { return this.releases.update(id, b); }

  @Get('admins') @Require('admins:manage') listAdmins() { return this.admins.list(); }
  @Post('admins') @Require('admins:manage')
  grant(@Req() req: AdminRequest, @Body() b: unknown) { return this.admins.grant(req.admin!.accountId, b); }
  @Put('admins/:accountId/role') @Require('admins:manage')
  setRole(@Req() req: AdminRequest, @Param('accountId') id: string, @Body() b: unknown) {
    return this.admins.setRole(req.admin!.accountId, id, b);
  }
  @Delete('admins/:accountId') @Require('admins:manage') @HttpCode(204)
  async removeAdmin(@Param('accountId') id: string) { await this.admins.remove(id); }

  @Get('audit') @Require('audit:read')
  listAudit(@Query() q: Record<string, unknown>) { return this.audit.list(q); }
}

/** 客户端可调用的公开接口：匿名统计、反馈、公告/目录、检查更新。 */
@Controller()
export class PublicController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(StatsService) private readonly stats: StatsService,
    @Inject(FeedbackService) private readonly feedback: FeedbackService,
    @Inject(AnnouncementService) private readonly announcements: AnnouncementService,
    @Inject(ReleaseService) private readonly releases: ReleaseService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Post('telemetry') @HttpCode(202)
  telemetry(@Req() req: AdminRequest, @Body() b: unknown) {
    this.limiter.hit(`telemetry:ip:${req.ip}`, 120, MIN);
    return this.stats.ingest(b);
  }

  @Post('feedback') @HttpCode(201)
  submitFeedback(@Req() req: AdminRequest, @Body() b: unknown) {
    this.limiter.hit(`feedback:ip:${req.ip}`, this.cfg.feedbackRateLimit, 10 * MIN);
    return this.feedback.submit(b);
  }

  /** 生效中的公告（已启用、在时间窗内、渠道匹配）。?channel=beta|stable，默认 stable。 */
  @Get('public/announcements') publicAnnouncements(@Query('channel') channel?: string) {
    return this.announcements.listPublic(channelQuery.parse(channel));
  }
  @Get('public/catalog') catalog() { return this.admin.publicCatalog(); }

  /**
   * 客户端检查更新：GET /updates/check?version=1.2.3&channel=stable&deviceId=...
   * 同一设备对同一发布的灰度命中结果稳定可复现。
   */
  @Get('updates/check')
  @Header('Cache-Control', 'no-store')
  checkUpdate(@Req() req: AdminRequest, @Query() q: Record<string, unknown>) {
    this.limiter.hit(`updates:ip:${req.ip}`, 120, MIN);
    return this.releases.check(q);
  }
}
