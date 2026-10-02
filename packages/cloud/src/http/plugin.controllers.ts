import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuditInterceptor } from './audit.interceptor';
import { AdminGuard, Require, type AdminRequest } from './guard';
import { PluginRegistryService, type PluginActor } from '../services/plugin-registry.service';

const actor = (req: AdminRequest): PluginActor => ({ accountId: req.admin!.accountId, email: req.admin!.email });

/** 公开：已通过审核的插件版本（含官方签名后的 manifest），客户端据此安装与核对审核日期。 */
@Controller('plugins')
export class PluginCatalogController {
  constructor(@Inject(PluginRegistryService) private readonly plugins: PluginRegistryService) {}

  @Get('catalog')
  @Header('Cache-Control', 'public, max-age=300')
  catalog() { return this.plugins.catalog(); }
}

/**
 * P3-P 插件注册表管理：登记（ops:write）、审核（plugins:review）、官方签名（plugins:sign，仅 ADMIN）。
 * 所有写操作由 AuditInterceptor 自动审计。
 */
@Controller('admin/plugins')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
export class AdminPluginController {
  constructor(@Inject(PluginRegistryService) private readonly plugins: PluginRegistryService) {}

  @Get() list(@Query() q: Record<string, unknown>) { return this.plugins.list(q); }
  @Get(':id') get(@Param('id') id: string) { return this.plugins.get(id); }

  @Post() submit(@Req() req: AdminRequest, @Body() b: unknown) { return this.plugins.submit(actor(req), b); }

  @Post(':id/approve') @HttpCode(200) @Require('plugins:review')
  approve(@Req() req: AdminRequest, @Param('id') id: string, @Body() b: unknown) { return this.plugins.approve(actor(req), id, b); }

  @Post(':id/reject') @HttpCode(200) @Require('plugins:review')
  reject(@Req() req: AdminRequest, @Param('id') id: string, @Body() b: unknown) { return this.plugins.reject(actor(req), id, b); }

  @Post(':id/sign') @HttpCode(200) @Require('plugins:sign')
  sign(@Req() req: AdminRequest, @Param('id') id: string, @Body() b: unknown) { return this.plugins.sign(actor(req), id, b); }
}
