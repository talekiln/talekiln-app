import { Module, type OnApplicationShutdown, Inject, Injectable, type Provider } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuthController, CatalogController, DeviceController, HealthController, LicenceController, ReferralController } from './http/controllers';
import { AdminAuthController, AdminController, PublicController } from './http/admin.controllers';
import { AccessGuard, AdminGuard } from './http/guard';
import { createPrismaRepositories } from './domain/prisma.repositories';
import { REPOS, type Repositories } from './domain/repositories';
import { AdminAuthService } from './services/admin-auth.service';
import { AdminService } from './services/admin.service';
import { AuthService } from './services/auth.service';
import { CONFIG, loadConfig, type AppConfig } from './services/config';
import { CatalogService, loadCatalogFromEnv } from './services/catalog.service';
import { ReferralService, loadReferralConfig } from './services/referral.service';
import { DeviceService } from './services/device.service';
import { FeedbackService } from './services/feedback.service';
import { LicenceService } from './services/licence.service';
import { RateLimiter } from './services/rate-limiter';
import { StatsService } from './services/stats.service';
import { TokenService } from './services/token.service';

export { CONFIG };
const PRISMA = Symbol('PRISMA');

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
      AdminAuthController, AdminController, PublicController, CatalogController, ReferralController,
    ],
    providers: [
      ...infra,
      { provide: RateLimiter, useFactory: () => new RateLimiter() },
      { provide: TokenService, useFactory: (r: Repositories, c: AppConfig) => new TokenService(r, c), inject: [REPOS, CONFIG] },
      { provide: AuthService, useFactory: (r: Repositories, t: TokenService) => new AuthService(r, t), inject: [REPOS, TokenService] },
      { provide: DeviceService, useFactory: (r: Repositories) => new DeviceService(r), inject: [REPOS] },
      { provide: LicenceService, useFactory: (r: Repositories, c: AppConfig) => new LicenceService(r, c), inject: [REPOS, CONFIG] },
      { provide: AdminAuthService, useFactory: (r: Repositories, c: AppConfig) => new AdminAuthService(r, c), inject: [REPOS, CONFIG] },
      { provide: AdminService, useFactory: (r: Repositories, c: AppConfig) => new AdminService(r, c), inject: [REPOS, CONFIG] },
      { provide: StatsService, useFactory: (r: Repositories) => new StatsService(r), inject: [REPOS] },
      { provide: FeedbackService, useFactory: (r: Repositories, c: AppConfig) => new FeedbackService(r, c), inject: [REPOS, CONFIG] },
      { provide: CatalogService, useFactory: (c: AppConfig) => new CatalogService(c, loadCatalogFromEnv()), inject: [CONFIG] },
      { provide: ReferralService, useFactory: (r: Repositories) => new ReferralService(loadReferralConfig(), r.referralClicks), inject: [REPOS] },
      AccessGuard,
      AdminGuard,
    ],
  })
  class AppModuleImpl {}
  return AppModuleImpl;
}

export const AppModule = createAppModule();
