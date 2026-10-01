import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AccessGuard, requireAdmin, type AuthedRequest } from './guard';
import { AuthService } from '../services/auth.service';
import { DeviceService } from '../services/device.service';
import { LicenceService } from '../services/licence.service';
import { CatalogService } from '../services/catalog.service';
import { ReferralService } from '../services/referral.service';

const device = z.object({ fingerprint: z.string().min(8).max(200), name: z.string().min(1).max(100) });
const email = z.string().email().max(200);
const password = z.string().min(8).max(200);
const activateBody = z.object({ inviteCode: z.string().min(1).max(100), email, password, device: device.optional() });
const loginBody = z.object({ email, password: z.string().min(1).max(200), device: device.optional() });
const refreshBody = z.object({ refreshToken: z.string().min(1).max(500) });
const inviteBody = z.object({ plan: z.string().max(50).optional(), expiresInDays: z.number().int().min(1).max(365).optional() });

@Controller()
export class HealthController {
  @Get('health')
  health() { return { status: 'ok', time: new Date().toISOString() }; }
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('activate') activate(@Body() b: unknown) { return this.auth.activate(activateBody.parse(b)); }
  @Post('login') @HttpCode(200) login(@Body() b: unknown) { return this.auth.login(loginBody.parse(b)); }
  @Post('refresh') @HttpCode(200) refresh(@Body() b: unknown) { return this.auth.refresh(refreshBody.parse(b).refreshToken); }
  @Post('logout') @HttpCode(204) async logout(@Body() b: unknown) { await this.auth.logout(refreshBody.parse(b).refreshToken); }
}

@Controller('devices')
@UseGuards(AccessGuard)
export class DeviceController {
  constructor(@Inject(DeviceService) private readonly devices: DeviceService) {}

  @Post() register(@Req() req: AuthedRequest, @Body() b: unknown) {
    return this.devices.register(req.auth!.accountId, device.parse(b));
  }
  @Get() list(@Req() req: AuthedRequest) { return this.devices.list(req.auth!.accountId); }
  @Post(':id/revoke') @HttpCode(204) async revoke(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.devices.revoke(req.auth!.accountId, id);
  }
}

@Controller()
export class LicenceController {
  constructor(@Inject(LicenceService) private readonly licences: LicenceService) {}

  @Post('licence/renew') @HttpCode(200) @UseGuards(AccessGuard)
  renew(@Req() req: AuthedRequest) { return this.licences.renew(req.auth!.accountId, req.auth!.deviceId); }

  @Get('.well-known/licence-jwks.json')
  jwks() { return this.licences.jwks(); }
}

@Controller('admin')
@UseGuards(AccessGuard)
export class AdminController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('invites') async createInvite(@Req() req: AuthedRequest, @Body() b: unknown) {
    const admin = requireAdmin(req);
    const i = await this.auth.createInvite(admin.accountId, inviteBody.parse(b ?? {}));
    return { code: i.code, plan: i.plan, expiresAt: i.expiresAt };
  }
  @Get('invites') async listInvites(@Req() req: AuthedRequest) {
    requireAdmin(req);
    return this.auth.listInvites();
  }
}

/** 公开：模型/价格/公告目录。?since=<version> 命中则只回 { version, unchanged }。 */
@Controller('catalog')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get() get(@Query('since') since?: string) {
    return this.catalog.get(typeof since === 'string' ? since : undefined);
  }
}

/** 推广跳转：记录点击后 302 到配置里的目标（目标不取自请求）。 */
@Controller('r')
export class ReferralController {
  constructor(@Inject(ReferralService) private readonly referrals: ReferralService) {}

  @Get(':code') async go(@Param('code') code: string, @Query('src') src: string | undefined, @Res() res: Response) {
    const target = await this.referrals.resolve(code, typeof src === 'string' ? src : undefined);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, target);
  }
}
