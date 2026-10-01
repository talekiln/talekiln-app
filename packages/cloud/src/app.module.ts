import { Module, type OnApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuthController, AdminController, DeviceController, HealthController, LicenceController } from './http/controllers';
import { AccessGuard } from './http/guard';
import { createPrismaRepositories } from './domain/prisma.repositories';
import { REPOS, type Repositories } from './domain/repositories';
import { AuthService } from './services/auth.service';
import { loadConfig, type AppConfig } from './services/config';
import { DeviceService } from './services/device.service';
import { LicenceService } from './services/licence.service';
import { TokenService } from './services/token.service';

export const CONFIG = Symbol('CONFIG');
const PRISMA = Symbol('PRISMA');

@Injectable()
class PrismaShutdown implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient) {}
  async onApplicationShutdown() { await this.db.$disconnect(); }
}

/** 业务服务是无装饰器的普通类，这里用工厂提供者装配。 */
@Module({
  controllers: [HealthController, AuthController, DeviceController, LicenceController, AdminController],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: PRISMA, useFactory: () => new PrismaClient() },
    { provide: REPOS, useFactory: (db: PrismaClient) => createPrismaRepositories(db), inject: [PRISMA] },
    { provide: TokenService, useFactory: (r: Repositories, c: AppConfig) => new TokenService(r, c), inject: [REPOS, CONFIG] },
    { provide: AuthService, useFactory: (r: Repositories, t: TokenService) => new AuthService(r, t), inject: [REPOS, TokenService] },
    { provide: DeviceService, useFactory: (r: Repositories) => new DeviceService(r), inject: [REPOS] },
    { provide: LicenceService, useFactory: (r: Repositories, c: AppConfig) => new LicenceService(r, c), inject: [REPOS, CONFIG] },
    AccessGuard,
    PrismaShutdown,
  ],
})
export class AppModule {}
