import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './http/setup';
import { AuthService } from './services/auth.service';
import { PlanService } from './services/plan.service';
import { REPOS, type Repositories } from './domain/repositories';

async function seedAdmin(app: Awaited<ReturnType<typeof NestFactory.create>>) {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
  if (!email || !password) return;
  const repos = app.get<Repositories>(REPOS);
  if (await repos.accounts.findByEmail(email.toLowerCase())) return;
  const hash = await app.get(AuthService).hash(password);
  await repos.accounts.create({ email: email.toLowerCase(), passwordHash: hash, role: 'ADMIN', plan: 'test' });
  console.log('[cloud] 已创建初始管理员', email);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureApp(app);
  app.enableShutdownHooks();
  await seedAdmin(app);
  await app.get(PlanService).ensureSeeded(); // 幂等：只补缺失的套餐，不改已有价格
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
void bootstrap();
