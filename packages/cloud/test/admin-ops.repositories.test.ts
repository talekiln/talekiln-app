import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRepos } from './helpers/repos';
import type { ReleaseInput } from '../src/domain/repositories';

// P2-H 仓储契约：内存与 Prisma(PostgreSQL) 必须表现一致。设置 TEST_DATABASE_URL/DATABASE_URL 时跑真实库。
const T0 = new Date('2026-10-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const H = 3600_000;

test('公告仓储：生效窗口与渠道过滤、更新、删除、排序', async () => {
  const r = await makeRepos();
  const base = { title: 't', body: 'b', level: 'info' as const, channel: 'all' as const, enabled: true };
  const a = await r.announcements.create({ ...base, title: 'all-now', startsAt: at(0), endsAt: null }, at(0));
  const b = await r.announcements.create({ ...base, title: 'beta-only', channel: 'beta', startsAt: at(1 * H), endsAt: at(5 * H) }, at(0));
  const c = await r.announcements.create({ ...base, title: 'future', startsAt: at(10 * H), endsAt: null }, at(0));
  const d = await r.announcements.create({ ...base, title: 'off', enabled: false, startsAt: at(0), endsAt: null }, at(0));
  const e = await r.announcements.create({ ...base, title: 'stable-only', channel: 'stable', startsAt: at(2 * H), endsAt: at(3 * H) }, at(0));

  const ids = async (now: Date, ch: 'beta' | 'stable') => (await r.announcements.listEffective(now, ch)).map((x) => x.title);
  assert.deepEqual(await ids(at(0), 'stable'), ['all-now']);
  assert.deepEqual(await ids(at(1 * H), 'beta'), ['beta-only', 'all-now'], '开始时间新的在前，开始时刻即生效');
  assert.deepEqual(await ids(at(1 * H), 'stable'), ['all-now']);
  assert.deepEqual(await ids(at(2.5 * H), 'stable'), ['stable-only', 'all-now']);
  assert.deepEqual(await ids(at(3 * H), 'stable'), ['all-now'], '结束时刻即失效');
  assert.deepEqual(await ids(at(11 * H), 'beta'), ['future', 'all-now']);
  assert.equal((await r.announcements.list()).length, 5);
  assert.deepEqual((await r.announcements.list())[0].title, 'future');

  const upd = await r.announcements.update(d.id, { enabled: true, title: 'on' }, at(1000));
  assert.equal(upd!.title, 'on');
  assert.equal(upd!.enabled, true);
  assert.equal(upd!.updatedAt.getTime(), at(1000).getTime());
  assert.equal(upd!.createdAt.getTime(), at(0).getTime());
  assert.equal(await r.announcements.update('00000000-0000-4000-8000-000000000000', { title: 'x' }, at(0)), null);
  assert.equal(await r.announcements.update(a.id, { endsAt: at(H) }, at(0)).then((x) => x!.endsAt!.getTime()), at(H).getTime());
  assert.equal(await r.announcements.update(a.id, { endsAt: null }, at(0)).then((x) => x!.endsAt), null);

  assert.equal(await r.announcements.delete(b.id), true);
  assert.equal(await r.announcements.delete(b.id), false);
  assert.equal(await r.announcements.findById(b.id), null);
  assert.equal((await r.announcements.findById(c.id))!.title, 'future');
  void e;
});

test('发布仓储：(版本, 通道) 唯一、更新、只列启用', async () => {
  const r = await makeRepos();
  const rel = (o: Partial<ReleaseInput> = {}): ReleaseInput => ({
    version: '1.0.0', channel: 'stable', rolloutPercent: 10, minVersion: null, forced: false, notes: '', enabled: true, ...o,
  });
  const a = await r.releases.create(rel(), at(0));
  await r.releases.create(rel({ channel: 'beta' }), at(1));
  await assert.rejects(r.releases.create(rel(), at(2)), '同通道同版本重复');
  const c = await r.releases.create(rel({ version: '1.1.0', enabled: false }), at(3));
  assert.deepEqual((await r.releases.listEnabled(['stable'])).map((x) => x.version), ['1.0.0']);
  assert.equal((await r.releases.listEnabled(['stable', 'beta'])).length, 2);
  assert.equal((await r.releases.list()).length, 3);
  assert.equal((await r.releases.list())[0].id, c.id, '新建的在前');

  const u = await r.releases.update(a.id, { rolloutPercent: 55, forced: true, minVersion: '0.9.0', notes: '修复' }, at(10));
  assert.deepEqual([u!.rolloutPercent, u!.forced, u!.minVersion, u!.notes, u!.version, u!.channel], [55, true, '0.9.0', '修复', '1.0.0', 'stable']);
  assert.equal((await r.releases.update(a.id, { minVersion: null }, at(11)))!.minVersion, null);
  assert.equal(await r.releases.update('00000000-0000-4000-8000-000000000000', { forced: true }, at(0)), null);
  assert.equal((await r.releases.findById(a.id))!.rolloutPercent, 55);
});

test('管理员角色仓储：授予/更新/移除，账号删除时级联', async () => {
  const r = await makeRepos();
  const acc = await r.accounts.create({ email: 'op@x.com', passwordHash: 'h', role: 'USER', plan: 'free' });
  const rec = await r.adminRoles.set(acc.id, 'OPERATOR', null, at(0));
  assert.equal(rec.role, 'OPERATOR');
  const again = await r.adminRoles.set(acc.id, 'READONLY', acc.id, at(5));
  assert.equal(again.role, 'READONLY');
  assert.equal(again.grantedBy, acc.id);
  assert.equal(again.createdAt.getTime(), at(0).getTime(), '更新不改创建时间');
  assert.equal((await r.adminRoles.list()).length, 1);
  assert.equal((await r.adminRoles.find(acc.id))!.role, 'READONLY');
  assert.equal(await r.adminRoles.remove(acc.id), true);
  assert.equal(await r.adminRoles.remove(acc.id), false);
  assert.equal(await r.adminRoles.find(acc.id), null);
  await r.adminRoles.set(acc.id, 'ADMIN', null, at(6));
  await r.accounts.delete(acc.id);
  assert.equal(await r.adminRoles.find(acc.id), null, '账号删除后角色记录随之删除');

  const b = await r.accounts.create({ email: 'b@x.com', passwordHash: 'h', role: 'USER', plan: 'free' });
  await r.accounts.setRole(b.id, 'ADMIN');
  assert.equal((await r.accounts.findById(b.id))!.role, 'ADMIN');
});

test('审计仓储：只增、倒序、按条件筛选、before 翻页、detail JSON 往返', async () => {
  const r = await makeRepos();
  const mk = (i: number, extra: Partial<Parameters<typeof r.adminAudit.add>[0]> = {}) => r.adminAudit.add({
    at: at(i * 1000), actorId: 'actor-1', actorEmail: 'a@x.com', actorRole: 'ADMIN', action: 'POST /admin/releases',
    targetType: 'releases', targetId: `t${i}`, ok: true, status: 201, detail: { body: { n: i, nested: { a: [1, 2] } } }, ip: '127.0.0.1', ...extra,
  });
  for (let i = 1; i <= 5; i++) await mk(i);
  await mk(6, { actorId: 'actor-2', action: 'DELETE /admin/announcements/:id', targetType: 'announcements', ok: false, status: 404, detail: null });
  await mk(7, { actorId: null, actorEmail: 'x@y.com', actorRole: null, action: 'POST /admin/auth/login', targetType: null, targetId: null, ok: false, status: 401 });

  const all = await r.adminAudit.list({ limit: 100 });
  assert.deepEqual(all.map((x) => x.targetId), [null, 't6', 't5', 't4', 't3', 't2', 't1']);
  assert.deepEqual(all[2].detail, { body: { n: 5, nested: { a: [1, 2] } } });
  assert.equal(all[1].detail, null);
  assert.equal(all[0].actorId, null);
  assert.equal(all[0].actorRole, null);
  assert.deepEqual((await r.adminAudit.list({ actorId: 'actor-2', limit: 10 })).map((x) => x.targetId), ['t6']);
  assert.equal((await r.adminAudit.list({ action: 'POST /admin/releases', limit: 100 })).length, 5);
  assert.equal((await r.adminAudit.list({ targetType: 'announcements', limit: 100 })).length, 1);
  assert.equal((await r.adminAudit.list({ targetId: 't3', limit: 100 })).length, 1);
  assert.deepEqual((await r.adminAudit.list({ limit: 2 })).map((x) => x.targetId), [null, 't6']);
  assert.deepEqual((await r.adminAudit.list({ before: at(5000), limit: 2 })).map((x) => x.targetId), ['t4', 't3']);
});

test('推广点击：between 取 [from, to) 区间', async () => {
  const r = await makeRepos();
  await r.referralClicks.create({ code: 'ark', src: null, createdAt: at(0) });
  await r.referralClicks.create({ code: 'ark', src: 'a', createdAt: at(1000) });
  await r.referralClicks.create({ code: 'bailian', src: null, createdAt: at(2000) });
  const rows = await r.referralClicks.between(at(0), at(2000));
  assert.deepEqual(rows.map((x) => x.src), [null, 'a']);
  assert.equal((await r.referralClicks.between(at(5000), at(6000))).length, 0);
});
