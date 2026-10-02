import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRepos } from './helpers/repos';

// 仓储契约：内存与 Prisma 实现必须表现一致（设置 TEST_DATABASE_URL 时跑真实 PostgreSQL）。
const T0 = new Date('2026-10-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

async function acct(r: Awaited<ReturnType<typeof makeRepos>>, email = 'a@x.com') {
  return r.accounts.create({ email, passwordHash: 'h', role: 'USER', plan: 'test' });
}

test('仓储契约：账号邮箱唯一，禁用/删除级联', async () => {
  const r = await makeRepos();
  const a = await acct(r);
  await assert.rejects(acct(r));
  assert.equal(a.disabledAt, null);
  await r.accounts.setDisabled(a.id, at(5));
  assert.deepEqual((await r.accounts.findById(a.id))!.disabledAt, at(5));
  await r.accounts.setDisabled(a.id, null);
  assert.equal((await r.accounts.findByEmail('a@x.com'))!.disabledAt, null);
  const d = await r.devices.upsert(a.id, 'fp', 'n');
  const t = await r.refreshTokens.create({ familyId: 'f', accountId: a.id, deviceId: d.id, tokenHash: 'h1', expiresAt: at(1000) });
  await r.accounts.delete(a.id);
  assert.equal(await r.accounts.findById(a.id), null);
  assert.equal(await r.devices.findById(d.id), null);
  assert.equal(await r.refreshTokens.findByHash(t.tokenHash), null);
});

test('仓储契约：邀请码唯一、consume 边界、并发只有一个赢家、删除使用者置空', async () => {
  const r = await makeRepos();
  const a = await acct(r);
  const i = await r.invites.create({ code: 'C1', plan: 'p', createdBy: null, expiresAt: at(1000) });
  await assert.rejects(r.invites.create({ code: 'C1', plan: 'p', createdBy: null, expiresAt: null }));
  assert.equal(await r.invites.consume('C1', a.id, at(1000)), false, '到期瞬间视为过期');
  assert.equal(await r.invites.consume('NOPE', a.id, at(0)), false);
  const results = await Promise.all(Array.from({ length: 12 }, () => r.invites.consume('C1', a.id, at(999))));
  assert.equal(results.filter(Boolean).length, 1);
  const used = (await r.invites.findById(i.id))!;
  assert.equal(used.usedById, a.id);
  assert.equal(await r.invites.revoke(i.id, at(1)), false, '已使用不可吊销');
  const j = await r.invites.create({ code: 'C2', plan: 'p', createdBy: null, expiresAt: null });
  assert.equal(await r.invites.revoke(j.id, at(1)), true);
  assert.equal(await r.invites.revoke(j.id, at(2)), false);
  assert.equal(await r.invites.consume('C2', a.id, at(3)), false, '已吊销不可使用');
  assert.equal((await r.invites.list()).length, 2);
  await r.accounts.delete(a.id);
  assert.equal((await r.invites.findByCode('C1'))!.usedById, null);
});

test('仓储契约：设备 upsert 幂等、刷新令牌原子 markUsed 与族撤销', async () => {
  const r = await makeRepos();
  const a = await acct(r);
  const b = await acct(r, 'b@x.com');
  const d1 = await r.devices.upsert(a.id, 'fp', 'one');
  const d2 = await r.devices.upsert(a.id, 'fp', 'two');
  assert.equal(d1.id, d2.id);
  assert.equal(d2.name, 'two');
  const racing = await Promise.all(Array.from({ length: 8 }, () => r.devices.upsert(b.id, 'fpx', 'x')));
  assert.equal(new Set(racing.map((x) => x.id)).size, 1, '并发 upsert 不应因唯一键冲突失败或重复');
  assert.equal((await r.devices.listByAccount(a.id)).length, 1);
  await r.devices.touch(d1.id, at(7));
  await r.devices.revoke(d1.id, at(8));
  const got = (await r.devices.findById(d1.id))!;
  assert.deepEqual([got.lastSeenAt, got.revokedAt], [at(7), at(8)]);

  const mk = (hash: string, fam: string, acc = a.id) =>
    r.refreshTokens.create({ familyId: fam, accountId: acc, deviceId: null, tokenHash: hash, expiresAt: at(9999) });
  const t1 = await mk('h1', 'f1');
  await assert.rejects(mk('h1', 'f1'));
  const wins = await Promise.all(Array.from({ length: 10 }, () => r.refreshTokens.markUsed(t1.id, at(1))));
  assert.equal(wins.filter(Boolean).length, 1);
  await mk('h2', 'f1');
  await mk('h3', 'f2');
  await r.refreshTokens.revokeFamily('f1', at(2));
  assert.ok((await r.refreshTokens.findByHash('h2'))!.revokedAt);
  assert.equal((await r.refreshTokens.findByHash('h3'))!.revokedAt, null);
  assert.equal(await r.refreshTokens.markUsed((await r.refreshTokens.findByHash('h3'))!.id, at(3)), true);
  await r.refreshTokens.revokeAllForAccount(a.id, at(4));
  assert.ok((await r.refreshTokens.findByHash('h3'))!.revokedAt);
});

test('仓储契约：设置 JSON、遥测按天过滤、推广计数', async () => {
  const r = await makeRepos();
  assert.equal(await r.settings.get('k'), null);
  await r.settings.set('k', { a: [1, 'x', null], b: { c: true } });
  await r.settings.set('k', { v: 2 });
  assert.deepEqual(await r.settings.get('k'), { v: 2 });
  await r.settings.set('s', 'str');
  await r.settings.set('n', 0);
  assert.equal(await r.settings.get('s'), 'str');
  assert.equal(await r.settings.get('n'), 0);

  const row = (day: string, name: string) => ({ at: T0, day, installId: 'i', name, code: null, step: null });
  await r.telemetry.addMany([row('2026-09-30', 'a'), row('2026-10-01', 'b'), { ...row('2026-10-02', 'c'), code: 'E1', step: 's' }]);
  await r.telemetry.addMany([]);
  const since = await r.telemetry.since('2026-10-01');
  assert.deepEqual(since.map((x) => x.name).sort(), ['b', 'c']);
  assert.equal(since.find((x) => x.name === 'c')!.code, 'E1');

  await r.referralClicks.create({ code: 'ark', src: null, createdAt: T0 });
  await r.referralClicks.create({ code: 'ark', src: 'x', createdAt: T0 });
  assert.equal(await r.referralClicks.countByCode('ark'), 2);
  assert.equal(await r.referralClicks.countByCode('none'), 0);
});

test('仓储契约：反馈诊断包二进制往返、列表不含诊断且按新到旧', async () => {
  const r = await makeRepos();
  const bin = Buffer.from([0, 1, 2, 255, 254, 0]);
  const base = { accountId: null, installId: 'i', contact: null, taskId: null, appVersion: '1' };
  const f1 = await r.feedback.create({ ...base, message: 'one', diagnostic: bin, diagnosticSize: bin.length });
  assert.ok(Buffer.isBuffer(f1.diagnostic));
  await new Promise((res) => setTimeout(res, 5));
  const f2 = await r.feedback.create({ ...base, message: 'two', diagnostic: null, diagnosticSize: 0 });
  const got = (await r.feedback.findById(f1.id))!;
  assert.ok(Buffer.isBuffer(got.diagnostic));
  assert.ok(got.diagnostic!.equals(bin));
  assert.equal((await r.feedback.findById(f2.id))!.diagnostic, null);
  assert.equal(await r.feedback.findById('00000000-0000-0000-0000-000000000000'), null);
  const list = await r.feedback.list(10);
  assert.deepEqual(list.map((x) => x.message), ['two', 'one']);
  assert.ok(!('diagnostic' in list[0]));
  assert.equal((await r.feedback.list(1)).length, 1);
});
