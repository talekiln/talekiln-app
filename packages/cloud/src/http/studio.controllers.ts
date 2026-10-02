import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Put, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuditInterceptor } from './audit.interceptor';
import { AccessGuard, AdminGuard, type AuthedRequest } from './guard';
import { StudioService, type StudioActor } from '../services/studio.service';

const actorOf = (req: AuthedRequest): StudioActor => ({ accountId: req.auth!.accountId, ip: req.ip ?? null });

/**
 * P3-S 工作室（用户侧，AccessGuard：桌面端登录态令牌）。本机服务用这些接口取「我在哪个工作室、什么角色」。
 *   GET    /studios/mine                              我所在的工作室（含席位占用、我的角色）
 *   POST   /studios                                   { name } -> 201，创建者为 owner；席位数用服务端默认值（定价待定）
 *   POST   /studios/accept                            { code } -> 接受邀请
 *   GET    /studios/:id                               详情（成员带邮箱；owner/admin 还能看到未处理邀请）
 *   POST   /studios/:id/invites                       { email?, role?, expiresInDays? } -> 201 邀请；席位满 403 seat_limit
 *   DELETE /studios/:id/invites/:inviteId             撤销邀请 -> 204
 *   DELETE /studios/:id/members/:accountId            移除成员 / 退出 -> 204
 *   PUT    /studios/:id/members/:accountId/role       { role: 'admin' | 'member' }（仅 owner）
 * 写操作由 StudioService 记入审计日志（actorId 为用户账号）。
 */
@Controller('studios')
@UseGuards(AccessGuard)
export class StudioController {
  constructor(@Inject(StudioService) private readonly studios: StudioService) {}

  @Get('mine') @Header('Cache-Control', 'no-store')
  mine(@Req() req: AuthedRequest) { return this.studios.mine(req.auth!.accountId); }

  @Post() create(@Req() req: AuthedRequest, @Body() b: unknown) { return this.studios.create(actorOf(req), b); }

  @Post('accept') @HttpCode(200)
  accept(@Req() req: AuthedRequest, @Body() b: unknown) { return this.studios.accept(actorOf(req), b); }

  @Get(':id') @Header('Cache-Control', 'no-store')
  get(@Req() req: AuthedRequest, @Param('id') id: string) { return this.studios.get(id, req.auth!.accountId); }

  @Post(':id/invites') invite(@Req() req: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.studios.invite(actorOf(req), id, b); }

  @Delete(':id/invites/:inviteId') @HttpCode(204)
  async revokeInvite(@Req() req: AuthedRequest, @Param('id') id: string, @Param('inviteId') inviteId: string) { await this.studios.revokeInvite(actorOf(req), id, inviteId); }

  @Delete(':id/members/:accountId') @HttpCode(204)
  async removeMember(@Req() req: AuthedRequest, @Param('id') id: string, @Param('accountId') accountId: string) { await this.studios.removeMember(actorOf(req), id, accountId); }

  @Put(':id/members/:accountId/role')
  setRole(@Req() req: AuthedRequest, @Param('id') id: string, @Param('accountId') accountId: string, @Body() b: unknown) { return this.studios.setRole(actorOf(req), id, accountId, b); }
}

/**
 * 后台：工作室只读列表 + 调整席位数 / 状态（AdminGuard 默认规则：读 read、写 ops:write；写由 AuditInterceptor 记审计）。
 *   GET /admin/studios                 全部工作室（席位占用、所有者邮箱）
 *   GET /admin/studios/:id             详情（含已移除成员与全部邀请）
 *   PUT /admin/studios/:id/seats       { seatLimit }   计费占位：将来由订阅驱动，定价待定
 *   PUT /admin/studios/:id/status      { status: 'active' | 'suspended' }
 */
@Controller('admin/studios')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
export class AdminStudioController {
  constructor(@Inject(StudioService) private readonly studios: StudioService) {}

  @Get() list() { return this.studios.adminList(); }
  @Get(':id') get(@Param('id') id: string) { return this.studios.adminGet(id); }
  @Put(':id/seats') setSeats(@Param('id') id: string, @Body() b: unknown) { return this.studios.adminSetSeatLimit(id, b); }
  @Put(':id/status') setStatus(@Param('id') id: string, @Body() b: unknown) { return this.studios.adminSetStatus(id, b); }
}
