import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AdminRequest } from './guard';
import { AdminAuthService } from '../services/admin-auth.service';
import { CONFIG, type AppConfig } from '../services/config';
import { AdminService, type InviteStatus } from '../services/admin.service';
import { FeedbackService } from '../services/feedback.service';
import { RateLimiter } from '../services/rate-limiter';
import { StatsService } from '../services/stats.service';

const loginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });
const inviteBody = z.object({
  plan: z.string().min(1).max(50).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  count: z.number().int().min(1).max(200).optional(),
});
const MIN = 60_000;

@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    @Inject(AdminAuthService) private readonly admins: AdminAuthService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  @Post('login') @HttpCode(200)
  login(@Req() req: AdminRequest, @Body() b: unknown) {
    const body = loginBody.parse(b);
    // 防暴力破解：按来源 IP 与目标邮箱分别限流
    this.limiter.hit(`admin-login:ip:${req.ip}`, 20, 15 * MIN);
    this.limiter.hit(`admin-login:email:${body.email.toLowerCase()}`, 8, 15 * MIN);
    return this.admins.login(body.email, body.password);
  }
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(StatsService) private readonly stats: StatsService,
    @Inject(FeedbackService) private readonly feedback: FeedbackService,
  ) {}

  @Get('me') me(@Req() req: AdminRequest) { return req.admin; }

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

  @Get('announcements') announcements() { return this.admin.getAnnouncements(); }
  @Put('announcements') setAnnouncements(@Body() b: unknown) { return this.admin.setAnnouncements(b); }
  @Get('catalog') catalog() { return this.admin.getCatalog(); }
  @Put('catalog') setCatalog(@Body() b: unknown) { return this.admin.setCatalog(b); }

  @Get('stats/overview')
  overview(@Query('days') days?: string) {
    return this.stats.overview(z.coerce.number().int().min(1).max(90).catch(14).parse(days));
  }

  @Get('feedback') listFeedback() { return this.feedback.list(100); }
  @Get('feedback/:id/diagnostic')
  @Header('Content-Type', 'application/zip')
  @Header('Content-Disposition', 'attachment; filename="diagnostic.zip"')
  async diagnostic(@Param('id') id: string) {
    return new StreamableFile((await this.feedback.diagnostic(id)).data);
  }
}

/** 客户端可调用的公开接口：匿名统计、反馈、公告/目录。 */
@Controller()
export class PublicController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(StatsService) private readonly stats: StatsService,
    @Inject(FeedbackService) private readonly feedback: FeedbackService,
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

  @Get('public/announcements') announcements() { return this.admin.publicAnnouncements(); }
  @Get('public/catalog') catalog() { return this.admin.publicCatalog(); }
}
