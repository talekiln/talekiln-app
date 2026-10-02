import { Module, type OnApplicationShutdown, Inject, Injectable, type Provider } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuthController, CatalogController, DeviceController, HealthController, LicenceController, ReferralController } from './http/controllers';
import { AdminAuthController, AdminController, AdminOpsController, PublicController } from './http/admin.controllers';
import { AdminBillingController, OrderController, PaymentNotifyController, PlanController, SubscriptionController } from './http/billing.controllers';
import { AdminTemplateController, TemplateCatalogController } from './http/template.controllers';
import { AdminPluginController, PluginCatalogController } from './http/plugin.controllers';
import { PluginRegistryService } from './services/plugin-registry.service';
import { AuditInterceptor } from './http/audit.interceptor';
import { AccessGuard, AdminGuard } from './http/guard';
import { createProviders } from './payments/registry';
import type { PaymentProviders } from './payments/provider';
import { BillingService } from './services/billing.service';
import { loadBillingOptions } from './services/billing.config';
import { EntitlementService } from './services/entitlement.service';
import { PlanService } from './services/plan.service';
import { createPrismaRepositories } from './domain/prisma.repositories';
import { REPOS, type Repositories } from './domain/repositories';
import { AdminAuthService } from './services/admin-auth.service';
import { AdminService } from './services/admin.service';
import { AdminsService } from './services/admins.service';
import { AnnouncementService } from './services/announcement.service';
import { AuditService } from './services/audit.service';
import { FunnelService } from './services/funnel.service';
import { ReleaseService } from './services/release.service';
import { AuthService } from './services/auth.service';
import { CONFIG, loadConfig, type AppConfig } from './services/config';
import { CatalogService, loadCatalogFromEnv } from './services/catalog.service';
import { ReferralService, loadReferralConfig } from './services/referral.service';
import { DeviceService } from './services/device.service';
import { FeedbackService } from './services/feedback.service';
import { LicenceService } from './services/licence.service';
import { RateLimiter } from './services/rate-limiter';
import { StatsService } from './services/stats.service';
import { TemplateService } from './services/template.service';
import { TokenService } from './services/token.service';

export { CONFIG };
const PRISMA = Symbol('PRISMA');
const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');

@Injectable()
class PrismaShutdown implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient) {}
  async onApplicationShutdown() { await this.db.$disconnect(); }
}

export interface ModuleOptions {
  /** 测试注入：传入内存仓储则不创建 PrismaClient。 */
  repos?: Repositories;
  config?: AppConfig;
}

/** 业务服务是无装饰器的普通类，这里用工厂提供者装配。 */
export function createAppModule(opts: ModuleOptions = {}) {
  const infra: Provider[] = [
    { provide: CONFIG, useFactory: () => opts.config ?? loadConfig() },
  ];
  if (opts.repos) {
    infra.push({ provide: REPOS, useValue: opts.repos });
  } else {
    infra.push(
      { provide: PRISMA, useFactory: () => new PrismaClient() },
      { provide: REPOS, useFactory: (db: PrismaClient) => createPrismaRepositories(db), inject: [PRISMA] },
      PrismaShutdown,
    );
  }
  @Module({
    controllers: [
      HealthController, AuthController, DeviceController, LicenceController,
      AdminAuthController, AdminController, AdminOpsController, PublicController, CatalogController, ReferralController,
      PlanController, OrderController, SubscriptionController, PaymentNotifyController, AdminBillingController,
      TemplateCatalogController, AdminTemplateController,
      PluginCatalogController, AdminPluginController,
    ],
    providers: [
      ...infra,
      { provide: RateLimiter, useFactory: () => new RateLimiter() },
      { provide: TokenService, useFactory: (r: Repositories, c: AppConfig) => new TokenService(r, c), inject: [REPOS, CONFIG] },
      { provide: EntitlementService, useFactory: (r: Repositories) => new EntitlementService(r), inject: [REPOS] },
      { provide: DeviceService, useFactory: (r: Repositories, e: EntitlementService) => new DeviceService(r, undefined, e), inject: [REPOS, EntitlementService] },
      { provide: AuthService, useFactory: (r: Repositories, t: TokenService, d: DeviceService) => new AuthService(r, t, undefined, undefined, d), inject: [REPOS, TokenService, DeviceService] },
      { provide: LicenceService, useFactory: (r: Repositories, c: AppConfig, e: EntitlementService) => new LicenceService(r, c, undefined, e), inject: [REPOS, CONFIG, EntitlementService] },
      { provide: PAYMENT_PROVIDERS, useFactory: (c: AppConfig) => createProviders(process.env, c.accessSecret), inject: [CONFIG] },
      { provide: PlanService, useFactory: (r: Repositories) => new PlanService(r), inject: [REPOS] },
      {
        provide: BillingService,
        useFactory: (r: Repositories, p: PaymentProviders, e: EntitlementService) => new BillingService(r, p, loadBillingOptions(), undefined, e),
        inject: [REPOS, PAYMENT_PROVIDERS, EntitlementService],
      },
      { provide: AdminAuthService, useFactory: (r: Repositories, c: AppConfig) => new AdminAuthService(r, c), inject: [REPOS, CONFIG] },
      { provide: AdminService, useFactory: (r: Repositories, c: AppConfig) => new AdminService(r, c), inject: [REPOS, CONFIG] },
      { provide: StatsService, useFactory: (r: Repositories) => new StatsService(r), inject: [REPOS] },
      { provide: FeedbackService, useFactory: (r: Repositories, c: AppConfig) => new FeedbackService(r, c), inject: [REPOS, CONFIG] },
      { provide: CatalogService, useFactory: (c: AppConfig) => new CatalogService(c, loadCatalogFromEnv()), inject: [CONFIG] },
      { provide: ReferralService, useFactory: (r: Repositories) => new ReferralService(loadReferralConfig(), r.referralClicks), inject: [REPOS] },
      { provide: AuditService, useFactory: (r: Repositories) => new AuditService(r), inject: [REPOS] },
      { provide: AdminsService, useFactory: (r: Repositories) => new AdminsService(r), inject: [REPOS] },
      { provide: AnnouncementService, useFactory: (r: Repositories) => new AnnouncementService(r), inject: [REPOS] },
      { provide: ReleaseService, useFactory: (r: Repositories) => new ReleaseService(r), inject: [REPOS] },
      { provide: FunnelService, useFactory: (r: Repositories) => new FunnelService(r), inject: [REPOS] },
      { provide: TemplateService, useFactory: (r: Repositories, c: AppConfig) => new TemplateService(r, c), inject: [REPOS, CONFIG] },
      { provide: PluginRegistryService, useFactory: (r: Repositories, c: AppConfig) => new PluginRegistryService(r, c), inject: [REPOS, CONFIG] },
      AuditInterceptor,
      AccessGuard,
      AdminGuard,
    ],
  })
  class AppModuleImpl {}
  return AppModuleImpl;
}

export const AppModule = createAppModule();
