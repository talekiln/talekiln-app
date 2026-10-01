import { after } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { createMemoryRepositories } from '../../src/domain/memory.repositories';
import { createPrismaRepositories } from '../../src/domain/prisma.repositories';
import type { Repositories } from '../../src/domain/repositories';

// 同一套断言的双后端：默认内存仓储；设置 TEST_DATABASE_URL（或 DATABASE_URL）时改用真实 PostgreSQL。
// 连接串只从环境变量读取，不写入任何文件。
const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
export const usingPostgres = Boolean(url);

let client: PrismaClient | null = null;

const TABLES = ['RefreshToken', 'Device', 'InviteCode', 'Feedback', 'TelemetryEvent', 'ReferralClick', 'Setting', 'Account'];

/** 每个测试调用一次，得到一份干净的仓储（PG 模式下先清空所有表）。 */
export async function makeRepos(): Promise<Repositories> {
  if (!url) return createMemoryRepositories();
  if (!client) client = new PrismaClient({ datasources: { db: { url } } });
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  return createPrismaRepositories(client);
}

after(async () => {
  if (client) await client.$disconnect();
  client = null;
});
