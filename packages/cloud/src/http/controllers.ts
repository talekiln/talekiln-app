import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AccessGuard, type AuthedRequest } from './guard';
import { AuthService } from '../services/auth.service';
import { LoginService } from '../services/login.service';
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

// P2-C 登录：短信验证码 / 微信扫码（适配器未接入时 503；模拟确认接口只在模拟适配器下存在）
const phone = z.string().min(11).max(20);
const smsSendBody = z.object({ phone, scene: z.literal('login').optional() });
const smsLoginBody = z.object({ phone, code: z.string().min(4).max(10), inviteCode: z.string().min(1).max(100).optional(), device: device.optional() });
const ticketParam = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
const qrConfirmBody = z.object({ openId: z.string().min(1).max(100).optional(), scanOnly: z.boolean().optional() }).default({});
const wechatLoginBody = z.object({ ticket: ticketParam, inviteCode: z.string().min(1).max(100).optional(), device: device.optional() });
const callbackQuery = z.object({ code: z.string().min(1).max(200), state: ticketParam });
const ip = (req: Request) => req.ip ?? null;

@Controller('auth')
export class LoginController {
  constructor(@Inject(LoginService) private readonly login: LoginService) {}

  @Post('sms/send') @HttpCode(200)
  smsSend(@Req() req: Request, @Body() b: unknown) { return this.login.sendSmsCode({ ...smsSendBody.parse(b), ip: ip(req) }); }

  @Post('sms/login') @HttpCode(200)
  smsLogin(@Req() req: Request, @Body() b: unknown) { return this.login.smsLogin({ ...smsLoginBody.parse(b), ip: ip(req) }); }

  @Post('wechat/qr') @HttpCode(201)
  wechatQr(@Req() req: Request) { return this.login.createWechatQr({ ip: ip(req) }); }

  @Get('wechat/qr/:ticket')
  wechatQrStatus(@Param('ticket') t: string) { return this.login.wechatQrStatus(ticketParam.parse(t)); }

  @Post('wechat/qr/:ticket/confirm') @HttpCode(200)
  wechatConfirm(@Param('ticket') t: string, @Body() b: unknown) { return this.login.simulateConfirm(ticketParam.parse(t), qrConfirmBody.parse(b ?? {})); }

  /** 真实微信开放平台回调（code + state）。模拟适配器下也可用，便于联调。 */
  @Get('wechat/callback')
  wechatCallback(@Query() q: unknown) { return this.login.wechatCallback(callbackQuery.parse(q)); }

  @Post('wechat/login') @HttpCode(200)
  wechatLogin(@Req() req: Request, @Body() b: unknown) { return this.login.wechatLogin({ ...wechatLoginBody.parse(b), ip: ip(req) }); }
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
