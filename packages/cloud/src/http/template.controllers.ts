import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Put, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuditInterceptor } from './audit.interceptor';
import { AdminGuard } from './guard';
import { TemplateService } from '../services/template.service';

/** 公开：已发布模板的目录（清单里嵌入官方签名，客户端用 JWKS 验签）。 */
@Controller('templates')
export class TemplateCatalogController {
  constructor(@Inject(TemplateService) private readonly templates: TemplateService) {}

  @Get('catalog')
  @Header('Cache-Control', 'no-store')
  catalog() { return this.templates.catalog(); }
}

/**
 * 管理：模板与版本。读需要 read，写需要 ops:write（AdminGuard 默认规则），写操作由 AuditInterceptor 记审计。
 *   GET    /admin/templates                       全部模板及版本
 *   POST   /admin/templates                       { id, name, genre, tier?, description? }
 *   GET    /admin/templates/:id
 *   PUT    /admin/templates/:id                   { name?, genre?, tier?, description? }
 *   DELETE /admin/templates/:id                   级联删除版本
 *   POST   /admin/templates/:id/versions          { manifest, packageUrl? } -> 校验 + 签名，默认未发布
 *   POST   /admin/templates/:id/versions/:vid/publish | unpublish
 */
@Controller('admin/templates')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
export class AdminTemplateController {
  constructor(@Inject(TemplateService) private readonly templates: TemplateService) {}

  @Get() list() { return this.templates.list(); }
  @Post() create(@Body() b: unknown) { return this.templates.create(b); }
  @Get(':id') get(@Param('id') id: string) { return this.templates.get(id); }
  @Put(':id') update(@Param('id') id: string, @Body() b: unknown) { return this.templates.update(id, b); }
  @Delete(':id') @HttpCode(204)
  async remove(@Param('id') id: string) { await this.templates.remove(id); }

  @Post(':id/versions') addVersion(@Param('id') id: string, @Body() b: unknown) { return this.templates.addVersion(id, b); }
  @Post(':id/versions/:vid/publish') @HttpCode(200)
  publish(@Param('id') id: string, @Param('vid') vid: string) { return this.templates.publish(id, vid); }
  @Post(':id/versions/:vid/unpublish') @HttpCode(200)
  unpublish(@Param('id') id: string, @Param('vid') vid: string) { return this.templates.unpublish(id, vid); }
}
