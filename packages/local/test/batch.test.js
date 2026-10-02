'use strict';
// P3-B 批量生成：假服务商 + 假时钟，覆盖并发上限、预算停止、夜间时段、重试后跳过、暂停策略、取消与 REST。不联网。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const kernel = require('@talekiln/kernel');
const kstore = require('../src/kernel/store');
const { createAiTaskStore, createAiTaskQueue, createWorker, blobPath } = require('../src/queue');
const { createSpendService } = require('../src/spend');
const { createGenerationService } = require('../src/generation');
const batchMod = require('../src/batch');
const batchRoutes = require('../src/routes/batches');
const { seededDb, log } = require('./helpers/kernelDb');

const { createBatchService, createBatchScheduler, attachToWorker, BatchError, inNightWindow, normalizePolicy, normalizeConcurrency, normalizeKinds, toCents } = batchMod;

const FAKE_CONFIGS = [{ provider: 'dashscope', api_key: 'fake-key-not-real', is_active: true, service_type: 'text' }];
const NON_TERMINAL = ['queued', 'submitting', 'submitted', 'polling', 'downloading'];
const LIMITS = { default: 2, bailian: 3 };
const T0 = Date.UTC(2026, 9, 2, 12, 0, 0); // 12:00（分钟数按 UTC 算，见 minutesOfDay）
const minutesOfDay = (ms) => Math.floor(ms / 60000) % 1440;

/**
 * 可控的假 bailian 门面：hold=true 时任务一直 running 直到 release(id)；shouldFail(task) 决定是否失败；
 * 记录每次 submit。download 写入内容寻址目录。
 */
function fakeVendor(storageDir) {
  const v = { submits: [], hold: false, released: new Set(), shouldFail: () => false, failures: 0 };
  v.provider = {
    async submit(task) {
      v.submits.push({ id: task.id, kind: task.kind, params: JSON.parse(task.params) });
      return { vendorTaskId: `v-${task.id}` };
    },
    async poll(task) {
      if (v.hold && !v.released.has(task.id)) return { status: 'running' };
      if (v.shouldFail(task)) { v.failures++; return { status: 'failed', errorCode: 'TASK_FAILED', errorMessage: 'fake failure' }; }
      return task.kind === 'video'
        ? { status: 'succeeded', result: { url: `https://fake.invalid/${task.id}.mp4`, usage: { duration: 5 } } }
        : { status: 'succeeded', result: { urls: [`https://fake.invalid/${task.id}.png`] } };
    },
    async download(task, result) {
      const buf = Buffer.from(`${task.kind}:${task.id}`);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const dest = blobPath(storageDir, sha256);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return { ...result, files: [{ url: result.url || result.urls[0], sha256, size: buf.length, path: path.relative(storageDir, dest).split(path.sep).join('/') }] };
    },
  };
  v.release = (id) => v.released.add(id);
  v.releaseAll = () => { v.hold = false; };
  return v;
}

/** 复制一集（分集行 + 分镜行，带已有首帧图），返回新分集 id。 */
function cloneEpisode(db, srcEp, number) {
  const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(srcEp);
  const cols = Object.keys(ep).filter((c) => c !== 'id');
  const info = db.prepare(`INSERT INTO episodes (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run({ ...ep, episode_number: number, title: `第 ${number} 集` });
  const newEp = Number(info.lastInsertRowid);
  for (const r of db.prepare('SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY id').all(srcEp)) {
    const c = Object.keys(r).filter((k) => k !== 'id');
    db.prepare(`INSERT INTO storyboards (${c.join(',')}) VALUES (${c.map((k) => '@' + k).join(',')})`).run({ ...r, episode_id: newEp });
  }
  return newEp;
}

async function harness({ episodes = 3, limits = LIMITS } = {}) {
  const { db, episodeId, dir } = await seededDb();
  const storageDir = path.join(dir, 'storage');
  const drama = db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(episodeId).drama_id;
  const eps = [episodeId];
  for (let i = 2; i <= episodes; i++) eps.push(cloneEpisode(db, episodeId, i));
  for (const ep of eps) require('../src/kernel/legacy').importLegacy(db, ep); // 幂等
  let clock = T0;
  const now = () => clock;
  const taskStore = createAiTaskStore(db, { now });
  const vendor = fakeVendor(storageDir);
  const queue = createAiTaskQueue({ store: taskStore, providers: { bailian: vendor.provider }, limits, now });
  const spend = createSpendService(db, { now });
  let gen = null;
  let batch = null;
  const worker = createWorker({ queue, store: taskStore, config: {}, onTaskFinished: (t) => { spend.recordFinished(t); gen.onTaskFinished(t); batch.onTaskFinished(t); }, onError() {} });
  gen = createGenerationService({ db, store: taskStore, worker: { wake() {} }, spend, storageRoot: storageDir, getCore: null, listConfigs: () => FAKE_CONFIGS, catalogModels: () => [], log });
  batch = createBatchService({ db, store: taskStore, generation: gen, spend, worker: { wake() {} }, limits, now, minutesOfDay, log });
  /** 调度 + 队列各跑一轮。 */
  const step = async () => { const r = batch.tick(); await worker.runOnce(); await gen.idle(); return r; };
  /** 跑到没有活动批次且队列空（最多 max 轮；服务商 hold 时会跑满）。 */
  const drain = async (max = 120) => { for (let i = 0; i < max; i++) { const r = await step(); if (!r.active && worker.unfinishedCount() === 0) break; } await worker.runOnce(); await gen.idle(); };
  const batchTasks = (id) => db.prepare('SELECT * FROM ai_tasks').all().filter((t) => { const p = JSON.parse(t.params || '{}'); return p._batch && p._batch.id === id; });
  const inflightByProvider = (id) => { const out = {}; for (const t of batchTasks(id)) if (NON_TERMINAL.includes(t.state)) out[t.provider] = (out[t.provider] || 0) + 1; return out; };
  const spendTotalCents = () => toCents(db.prepare('SELECT COALESCE(SUM(COALESCE(actual, estimated)), 0) s FROM spend_log').get().s);
  const taskCount = () => db.prepare('SELECT COUNT(*) n FROM ai_tasks').get().n;
  const previewCents = (ep, kind = 'video') => { const p = gen.preview(ep, { shots: 'all', kind }); return { min: toCents(p.estimate.total), max: toCents(p.estimate.max) }; };
  const shots = (ep) => kernel.shotOrder(kstore.openProject(db, ep).graph);
  const edit = (ep, shotId, patch, id) => kstore.commit(db, ep, (g) => kernel.intents.shot.setShotField(g, shotId, patch, { tx_id: id }), { tx_id: id });
  return {
    db, dir, storageDir, drama, eps, taskStore, queue, spend, gen, batch, worker, vendor, step, drain, batchTasks, inflightByProvider, spendTotalCents, taskCount, previewCents, shots, edit,
    now, advance: (ms) => { clock += ms; }, setClock: (ms) => { clock = ms; },
  };
}

describe('批量生成：创建与校验', () => {
  it('逐集估算求和得到预计区间；并发钳制到服务商上限；只建批次不建任务', async () => {
    const h = await harness();
    const per = h.eps.map((ep) => h.previewCents(ep));
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', concurrency: { bailian: 10 }, failure_policy: { retry: 2, on_fail: 'skip', night: null } });
    assert.equal(b.status, 'queued');
    assert.equal(b.totals.estimate_min_cents, per.reduce((a, p) => a + p.min, 0));
    assert.equal(b.totals.estimate_max_cents, per.reduce((a, p) => a + p.max, 0));
    assert.ok(b.totals.estimate_min_cents > 0 && b.totals.estimate_max_cents >= b.totals.estimate_min_cents);
    assert.equal(b.totals.remaining_min_cents, b.totals.estimate_min_cents, '还没开始：剩余 = 全部');
    assert.equal(b.totals.spent_cents, 0);
    assert.equal(b.concurrency.bailian, 3, '并发不超过队列上限');
    assert.equal(b.provider_limits.bailian, 3);
    assert.deepEqual(b.kinds, ['video']);
    assert.deepEqual(b.failure_policy, { retry: 2, on_fail: 'skip', night: null });
    assert.equal(b.items.length, 3);
    assert.ok(b.items.every((i) => i.status === 'pending' && i.shots_total === 5));
    assert.equal(b.items[1].episode_number, 2);
    assert.equal(h.taskCount(), 0, '创建批次不建任务');
    assert.equal(b.currency, 'CNY');
    assert.ok(b.warnings.some((w) => /示例价/.test(w)));
    // 列表带服务商上限
    const list = h.batch.list({ drama_id: h.drama });
    assert.equal(list.length, 1);
    assert.deepEqual(h.batch.providers(), [{ id: 'bailian', label: '阿里云百炼', limit: 3 }]);
  });

  it('参数校验：集数、所属项目、kinds、并发、策略、预算', async () => {
    const h = await harness({ episodes: 2 });
    const base = { drama_id: h.drama, episode_ids: h.eps, kinds: 'video' };
    const code = (c) => (e) => e instanceof BatchError && e.code === c;
    assert.throws(() => h.batch.create({ ...base, episode_ids: [] }), code('BAD_REQUEST'));
    assert.throws(() => h.batch.create({ ...base, episode_ids: [999999] }), code('NOT_FOUND'));
    assert.throws(() => h.batch.create({ ...base, drama_id: 999999 }), code('NOT_FOUND'));
    assert.throws(() => h.batch.create({ ...base, kinds: 'audio' }), code('BAD_REQUEST'));
    assert.throws(() => h.batch.create({ ...base, concurrency: { bailian: 0 } }), code('BAD_REQUEST'));
    assert.throws(() => h.batch.create({ ...base, failure_policy: { retry: 99 } }), code('BAD_REQUEST'));
    assert.throws(() => h.batch.create({ ...base, failure_policy: { on_fail: 'retry' } }), code('BAD_REQUEST'));
    assert.throws(() => h.batch.create({ ...base, failure_policy: { night: { start: '25:00', end: '06:00' } } }), code('BAD_REQUEST'));
    assert.throws(() => h.batch.create({ ...base, budget_cap_cents: -1 }), code('BAD_REQUEST'));
    // 另一个项目的分集
    const other = h.db.prepare("INSERT INTO dramas (title, created_at, updated_at) VALUES ('x', 'now', 'now')").run().lastInsertRowid;
    const foreign = h.db.prepare("INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, 1, 'y', 'now', 'now')").run(other).lastInsertRowid;
    assert.throws(() => h.batch.create({ ...base, episode_ids: [h.eps[0], Number(foreign)] }), code('BAD_REQUEST'));
    assert.equal(h.taskCount(), 0);
  });

  it('预算低于预计最低费用拒绝；月度上限不够走 SPEND_LIMIT；没有要做的事拒绝', async () => {
    const h = await harness({ episodes: 2 });
    const per = h.eps.map((ep) => h.previewCents(ep));
    const min = per.reduce((a, p) => a + p.min, 0);
    assert.throws(() => h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', budget_cap_cents: min - 1 }), (e) => e.code === 'BATCH_BUDGET_EXCEEDED' && e.status === 402 && e.details.estimate_min_cents === min);
    h.spend.setLimits({ monthly_cap: 0.01 });
    assert.throws(() => h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video' }), (e) => e.code === 'SPEND_LIMIT' && e.status === 402);
    h.spend.setLimits({ monthly_cap: null });
    // 预算在最低与最高之间：允许但有警告
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', budget_cap_cents: min });
    assert.ok(b.warnings.some((w) => /预算上限/.test(w)));
    // 首帧图都已是最新：只生成首帧图没有事可做
    assert.throws(() => h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'image' }), (e) => e.code === 'BATCH_NOTHING_TO_DO');
    assert.equal(h.taskCount(), 0);
  });

  it('dry_run：只估算不建，额度 / 预算不够时给 refusal 而不是抛错', async () => {
    const h = await harness({ episodes: 2 });
    const per = h.eps.map((ep) => h.previewCents(ep));
    const min = per.reduce((a, p) => a + p.min, 0);
    const before = h.batch.list().length;
    const ok = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', dry_run: true, concurrency: { bailian: 9 } });
    assert.equal(ok.dry_run, true);
    assert.equal(ok.allowed, true);
    assert.equal(ok.refusal, null);
    assert.equal(ok.totals.estimate_min_cents, min);
    assert.equal(ok.per_episode.length, 2);
    assert.equal(ok.per_episode[0].shots, 5);
    assert.equal(ok.concurrency.bailian, 3);
    assert.equal(ok.provider_limits.bailian, 3);
    assert.equal(h.batch.list().length, before, 'dry_run 不建批次');
    const over = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', dry_run: true, budget_cap_cents: min - 1 });
    assert.equal(over.allowed, false);
    assert.equal(over.refusal.code, 'BATCH_BUDGET_EXCEEDED');
    assert.match(over.refusal.message, /预算上限/);
    const nothing = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'image', dry_run: true });
    assert.equal(nothing.allowed, false);
    assert.equal(nothing.refusal.code, 'BATCH_NOTHING_TO_DO');
    h.spend.setLimits({ monthly_cap: 0.01 });
    const capped = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', dry_run: true });
    assert.equal(capped.allowed, false);
    assert.equal(capped.refusal.code, 'SPEND_LIMIT');
    assert.equal(capped.refusal.reason, 'monthly');
    // 参数本身不合法仍然抛
    assert.throws(() => h.batch.create({ drama_id: h.drama, episode_ids: [], dry_run: true }), (e) => e.code === 'BAD_REQUEST');
    assert.equal(h.taskCount(), 0);
  });
});

describe('批量生成：调度', () => {
  it('并发上限：每个服务商在途任务数始终不超过批次上限；按集顺序；跑完全部成功并记花费', async () => {
    const h = await harness();
    h.vendor.hold = true;
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', concurrency: { bailian: 2 } });
    let r = await h.step();
    assert.equal(r.active, true);
    assert.equal(h.batch.get(b.id).status, 'running');
    assert.equal(h.batchTasks(b.id).length, 2, '只建到并发上限');
    assert.ok(h.batchTasks(b.id).every((t) => JSON.parse(t.params)._batch.episode_id === h.eps[0]), '先排第一集');
    assert.equal(h.batch.get(b.id).waiting, 'concurrency');
    await h.step();
    assert.deepEqual(h.inflightByProvider(b.id), { bailian: 2 }, '服务商 hold 住：仍是 2 个在途');
    assert.equal(h.vendor.submits.length, 2);
    // 放掉一个 -> 落地 -> 下一轮补一个
    h.vendor.release(h.vendor.submits[0].id);
    await h.step();
    await h.step();
    assert.equal(h.batchTasks(b.id).length, 3);
    assert.deepEqual(h.inflightByProvider(b.id), { bailian: 2 });
    const view = h.batch.get(b.id);
    assert.equal(view.items[0].status, 'running');
    assert.equal(view.items[0].shots_done, 1);
    assert.equal(view.items[0].shots_enqueued, 3);
    assert.ok(view.totals.spent_cents > 0);
    assert.ok(view.totals.in_flight_max_cents > 0);
    assert.ok(view.items[0].remaining_min_cents > 0 && view.items[0].remaining_min_cents < view.items[0].estimate_min_cents, '第一集：剩余 = 还没排进去的 2 个镜头');
    assert.equal(view.totals.remaining_min_cents, view.items[0].remaining_min_cents + view.items[1].estimate_min_cents + view.items[2].estimate_min_cents, '剩余 = 还没排进去的镜头 + 没开始的集');
    // 全程放开，边跑边检查上限
    h.vendor.releaseAll();
    for (let i = 0; i < 60; i++) {
      const s = await h.step();
      const inflight = h.inflightByProvider(b.id);
      assert.ok((inflight.bailian || 0) <= 2, `在途 ${JSON.stringify(inflight)} 超过上限`);
      if (!s.active && h.worker.unfinishedCount() === 0) break;
    }
    const done = h.batch.get(b.id);
    assert.equal(done.status, 'completed');
    assert.ok(done.items.every((i) => i.status === 'succeeded' && i.shots_done === 5 && i.tasks.succeeded === 5));
    assert.equal(done.progress.shots_done, 15);
    assert.equal(done.progress.items_done, 3);
    assert.equal(done.totals.spent_cents, h.spendTotalCents(), '已花费 = 花费表里这些任务之和');
    assert.equal(done.totals.spent_cents, done.totals.estimate_min_cents, '假服务商不回传实际费用，按估算入账');
    assert.equal(done.totals.remaining_min_cents, 0);
    assert.equal(done.totals.in_flight_max_cents, 0);
    assert.ok(done.finished_at >= done.started_at);
    for (const ep of h.eps) assert.equal(h.gen.status(ep).counts.fresh, 5);
    assert.equal(h.batch.tick().active, false, '完成后没有活动批次');
    // 任务参数里带批次标记，也带项目标记（花费按项目归集）
    assert.ok(h.batchTasks(b.id).every((t) => JSON.parse(t.params)._project === String(h.drama)));
  });

  it('预算上限：已花费 + 在途最高 + 下一镜头超过预算就停；没有在途时暂停，提高预算后继续完成', async () => {
    const h = await harness({ episodes: 2 });
    // 预算 = 预计最低费用（创建允许）。在途按最高价（1.2 倍）记账，所以并发 1 时最后一个镜头排不进去：
    // 前 9 镜已花费（按估算入账）+ 第 10 镜最高价 > 预算
    const per = h.eps.map((ep) => h.previewCents(ep));
    const budget = per.reduce((a, p) => a + p.min, 0);
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', concurrency: { bailian: 1 }, budget_cap_cents: budget });
    await h.drain();
    const v = h.batch.get(b.id);
    assert.equal(v.status, 'paused');
    assert.match(v.error, /预算上限/);
    assert.equal(v.waiting, null);
    assert.equal(h.batchTasks(b.id).length, 9, '只建了预算内的镜头');
    assert.equal(v.progress.tasks.running + v.progress.tasks.queued, 0, '没有在途才暂停');
    assert.ok(v.totals.spent_cents + v.totals.remaining_max_cents > budget);
    assert.ok(v.totals.spent_cents <= budget);
    assert.equal(v.items[0].status, 'succeeded');
    assert.equal(v.items[1].status, 'running');
    assert.equal(v.items[1].shots_enqueued, 4);
    assert.equal(v.items[1].shots_done, 4);
    // 继续但不加预算：立刻又停
    h.batch.resume(b.id);
    await h.drain();
    assert.equal(h.batch.get(b.id).status, 'paused');
    assert.equal(h.batchTasks(b.id).length, 9);
    // 提高到最高预计费用 -> 跑完
    const max = per.reduce((a, p) => a + p.max, 0);
    h.batch.resume(b.id, { budget_cap_cents: max });
    assert.equal(h.batch.get(b.id).budget_cap_cents, max);
    await h.drain();
    const done = h.batch.get(b.id);
    assert.equal(done.status, 'completed');
    assert.equal(h.batchTasks(b.id).length, 10);
    assert.ok(done.totals.spent_cents <= max);
    assert.equal(done.totals.remaining_max_cents, 0);
  });

  it('夜间时段：时段外不建任务（已在跑的照常），进入时段后开始', async () => {
    const h = await harness({ episodes: 1 });
    h.vendor.hold = true;
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', concurrency: { bailian: 2 }, failure_policy: { night: { start: '22:00', end: '06:00' } } });
    await h.step(); // 12:00
    assert.equal(h.batchTasks(b.id).length, 0);
    assert.equal(h.batch.get(b.id).status, 'running');
    assert.equal(h.batch.get(b.id).waiting, 'night');
    h.setClock(Date.UTC(2026, 9, 2, 23, 0));
    await h.step();
    assert.equal(h.batchTasks(b.id).length, 2);
    // 次日 06:30 窗口已关：放掉在途的，不再新建
    h.setClock(Date.UTC(2026, 9, 3, 6, 30));
    h.vendor.releaseAll();
    await h.step();
    await h.step();
    assert.equal(h.batchTasks(b.id).length, 2);
    assert.equal(h.batch.get(b.id).items[0].shots_done, 2);
    assert.equal(h.batch.get(b.id).waiting, 'night');
    // 跨午夜：00:30 在窗口内
    h.setClock(Date.UTC(2026, 9, 4, 0, 30));
    await h.drain();
    assert.equal(h.batch.get(b.id).status, 'completed');
  });

  it('失败策略 skip：失败任务重试 n 次后该集失败、其余集继续；retry-failed 重新排进去', async () => {
    const h = await harness();
    const bad = h.eps[1];
    h.vendor.shouldFail = (t) => JSON.parse(t.params)._gen.episode_id === bad;
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', concurrency: { bailian: 1 }, failure_policy: { retry: 1, on_fail: 'skip' } });
    await h.drain();
    const v = h.batch.get(b.id);
    assert.equal(v.status, 'completed');
    assert.deepEqual(v.items.map((i) => i.status), ['succeeded', 'failed', 'succeeded']);
    assert.match(v.items[1].error, /已重试 1 次/);
    assert.equal(v.items[1].attempts, 1, '一个任务失败 -> 重试一次 -> 再失败 -> 该集失败（其它镜头不再建）');
    assert.equal(v.items[1].shots_enqueued, 1);
    assert.equal(v.progress.items_failed, 1);
    const failedTasks = h.batchTasks(b.id).filter((t) => t.state === 'failed');
    assert.equal(failedTasks.length, 1);
    assert.equal(failedTasks[0].attempts, 1, '重试过的任务 attempts 由队列重置后再提交一次');
    assert.equal(h.vendor.failures, 2);
    // 修好服务商后重试失败的集：只重做没完成的镜头，已成功的集不再花钱
    const spentBefore = v.totals.spent_cents;
    const tasksBefore = h.taskCount();
    h.vendor.shouldFail = () => false;
    const again = h.batch.retryFailed(b.id);
    assert.equal(again.status, 'queued');
    assert.equal(again.items[1].status, 'pending');
    await h.drain();
    const done = h.batch.get(b.id);
    assert.equal(done.status, 'completed');
    assert.ok(done.items.every((i) => i.status === 'succeeded'));
    assert.equal(h.taskCount(), tasksBefore + 4, '失败的那个任务同键重试，其余 4 个镜头新建');
    assert.ok(done.totals.spent_cents > spentBefore);
    assert.equal(done.totals.spent_cents, h.spendTotalCents());
    assert.equal(h.gen.status(bad).counts.fresh, 5);
    assert.throws(() => h.batch.retryFailed(b.id), (e) => e.code === 'BATCH_STATE');
  });

  it('retry-failed 可只重试其中几集；其余失败的集保持失败', async () => {
    const h = await harness();
    const bad = new Set([h.eps[0], h.eps[2]]);
    h.vendor.shouldFail = (t) => bad.has(JSON.parse(t.params)._gen.episode_id);
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', concurrency: { bailian: 1 }, failure_policy: { retry: 0, on_fail: 'skip' } });
    await h.drain();
    assert.deepEqual(h.batch.get(b.id).items.map((i) => i.status), ['failed', 'succeeded', 'failed']);
    h.vendor.shouldFail = () => false;
    assert.throws(() => h.batch.retryFailed(b.id, { episode_ids: [h.eps[1]] }), (e) => e.code === 'BATCH_STATE');
    const r = h.batch.retryFailed(b.id, { episode_ids: [h.eps[2]] });
    assert.deepEqual(r.items.map((i) => i.status), ['failed', 'succeeded', 'pending']);
    await h.drain();
    const v = h.batch.get(b.id);
    assert.equal(v.status, 'completed');
    assert.deepEqual(v.items.map((i) => i.status), ['failed', 'succeeded', 'succeeded']);
    assert.equal(v.progress.items_failed, 1);
    assert.equal(v.items[2].spent_cents > 0, true);
    assert.equal(v.totals.spent_cents, h.spendTotalCents());
  });

  it('失败策略 retry 2：第一次失败、重试成功，该集成功且 attempts=1', async () => {
    const h = await harness({ episodes: 1 });
    let failOnce = true;
    h.vendor.shouldFail = () => { if (failOnce) { failOnce = false; return true; } return false; };
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', failure_policy: { retry: 2 } });
    await h.drain();
    const v = h.batch.get(b.id);
    assert.equal(v.status, 'completed');
    assert.equal(v.items[0].status, 'succeeded');
    assert.equal(v.items[0].attempts, 1);
    assert.equal(h.batchTasks(b.id).length, 5);
  });

  it('失败策略 pause：某集失败后批次暂停，其余集保持待处理；继续后跳过失败集完成', async () => {
    const h = await harness();
    const bad = h.eps[0];
    h.vendor.shouldFail = (t) => JSON.parse(t.params)._gen.episode_id === bad;
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', concurrency: { bailian: 1 }, failure_policy: { retry: 0, on_fail: 'pause' } });
    await h.drain();
    const v = h.batch.get(b.id);
    assert.equal(v.status, 'paused');
    assert.match(v.error, /第 1 集生成失败，已按策略暂停/);
    assert.deepEqual(v.items.map((i) => i.status), ['failed', 'pending', 'pending']);
    assert.equal(v.items[0].attempts, 0);
    assert.equal(h.batchTasks(b.id).length, 1, 'retry=0 且并发 1：第一个任务失败就停');
    assert.throws(() => h.batch.pause(b.id), (e) => e.code === 'BATCH_STATE');
    h.batch.resume(b.id);
    await h.drain();
    const done = h.batch.get(b.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.items.map((i) => i.status), ['failed', 'succeeded', 'succeeded']);
  });

  it('全部集失败 -> 批次 failed；队列的费用守卫拒绝（SPEND_LIMIT）-> 批次暂停而不是烧掉重试次数', async () => {
    const h = await harness({ episodes: 1 });
    h.vendor.shouldFail = () => true;
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', failure_policy: { retry: 0 } });
    await h.drain();
    assert.equal(h.batch.get(b.id).status, 'failed');
    assert.equal(h.batch.get(b.id).progress.items_failed, 1);
    // 新批次：建任务后把月度上限调到 0，队列守卫在提交时拒绝
    h.vendor.shouldFail = () => false;
    const h2 = await harness({ episodes: 1 });
    const guarded = createAiTaskQueue({ store: h2.taskStore, providers: { bailian: h2.vendor.provider }, limits: LIMITS, now: h2.now, spendGuard: (t) => h2.spend.guardTask(t) });
    const b2 = h2.batch.create({ drama_id: h2.drama, episode_ids: h2.eps, kinds: 'video', failure_policy: { retry: 3 } });
    h2.batch.tick();
    h2.spend.setLimits({ monthly_cap: 0.001 });
    await guarded.tick();
    h2.batch.tick();
    const v2 = h2.batch.get(b2.id);
    assert.equal(v2.status, 'paused');
    assert.match(v2.error, /费用上限/);
    assert.equal(v2.items[0].attempts, 0, '不按失败策略重试');
  });

  it('取消：排队中的任务取消且不再提交，已提交的跑完照常写回；取消后不能再操作', async () => {
    const h = await harness({ episodes: 2 });
    h.vendor.hold = true;
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', concurrency: { bailian: 3 } });
    h.batch.tick(); // 建 3 个任务（排队中）
    await h.worker.runOnce(); // 提交 3 个（hold 住）
    h.batch.tick();
    assert.equal(h.batchTasks(b.id).length, 3);
    // 用 limits 以外的方式再排 1 个排队任务：把并发调不了，直接造一个排队中的批次任务没必要——取消时 3 个都已提交
    const v = h.batch.cancel(b.id);
    assert.equal(v.status, 'cancelled');
    assert.ok(v.items.every((i) => i.status === 'cancelled'));
    assert.equal(h.batch.tick().active, false);
    h.vendor.releaseAll();
    await h.drain();
    assert.equal(h.batchTasks(b.id).filter((t) => t.state === 'succeeded').length, 3, '已提交的任务照常完成写回');
    assert.equal(h.batchTasks(b.id).length, 3, '取消后不再建任务');
    assert.throws(() => h.batch.resume(b.id), (e) => e.code === 'BATCH_STATE');
    assert.throws(() => h.batch.retryFailed(b.id), (e) => e.code === 'BATCH_STATE');
    // 排队中（未提交）的任务：取消后不会提交给服务商
    const h2 = await harness({ episodes: 1 });
    const b2 = h2.batch.create({ drama_id: h2.drama, episode_ids: h2.eps, kinds: 'video', concurrency: { bailian: 3 } });
    h2.batch.tick();
    assert.equal(h2.batchTasks(b2.id).filter((t) => t.state === 'queued').length, 3);
    h2.batch.cancel(b2.id);
    assert.equal(h2.batchTasks(b2.id).filter((t) => t.state === 'cancelled').length, 3);
    await h2.drain();
    assert.equal(h2.vendor.submits.length, 0);
  });

  it('暂停 / 继续：暂停后不建新任务，在跑的继续；继续后接着排', async () => {
    const h = await harness({ episodes: 2 });
    h.vendor.hold = true;
    const b = h.batch.create({ drama_id: h.drama, episode_ids: h.eps, kinds: 'video', concurrency: { bailian: 2 } });
    await h.step();
    assert.equal(h.batchTasks(b.id).length, 2);
    h.batch.pause(b.id);
    assert.equal(h.batch.get(b.id).status, 'paused');
    h.vendor.releaseAll();
    await h.step();
    await h.step();
    assert.equal(h.batchTasks(b.id).length, 2, '暂停期间不建新任务');
    assert.equal(h.batch.get(b.id).items[0].shots_done, 2, '在跑的任务照常完成');
    h.batch.resume(b.id);
    await h.drain();
    assert.equal(h.batch.get(b.id).status, 'completed');
    assert.equal(h.batchTasks(b.id).length, 10);
  });

  it('同时只跑最早的一个批次，后面的排队', async () => {
    const h = await harness({ episodes: 2 });
    const b1 = h.batch.create({ drama_id: h.drama, episode_ids: [h.eps[0]], kinds: 'video' });
    h.advance(1000);
    const b2 = h.batch.create({ drama_id: h.drama, episode_ids: [h.eps[1]], kinds: 'video' });
    await h.step();
    assert.equal(h.batch.get(b1.id).status, 'running');
    assert.equal(h.batch.get(b2.id).status, 'queued');
    assert.equal(h.batchTasks(b2.id).length, 0);
    await h.drain();
    assert.equal(h.batch.get(b1.id).status, 'completed');
    assert.equal(h.batch.get(b2.id).status, 'completed');
  });

  it('首帧图 + 视频：首帧完成后自动接上的视频任务带批次标记、计入在途与花费，全部落地才算完成', async () => {
    const h = await harness({ episodes: 1 });
    const ep = h.eps[0];
    const [s1, s2] = h.shots(ep);
    h.edit(ep, s1, { image_prompt: '新的画面 1' }, 'e1');
    h.edit(ep, s2, { image_prompt: '新的画面 2' }, 'e2');
    const pre = h.gen.preview(ep, { shots: 'all', kind: 'both' });
    assert.equal(pre.billable, 7, '2 张图 + 2 段接着出的视频 + 3 段视频');
    const b = h.batch.create({ drama_id: h.drama, episode_ids: [ep], kinds: 'both', concurrency: { bailian: 1 } });
    assert.equal(b.totals.estimate_min_cents, toCents(pre.estimate.total));
    await h.step();
    assert.equal(h.batchTasks(b.id).length, 1);
    assert.equal(h.batchTasks(b.id)[0].kind, 'image');
    await h.drain();
    const done = h.batch.get(b.id);
    assert.equal(done.status, 'completed');
    const tasks = h.batchTasks(b.id);
    assert.equal(tasks.filter((t) => t.kind === 'image').length, 2);
    assert.equal(tasks.filter((t) => t.kind === 'video').length, 5);
    assert.ok(tasks.every((t) => t.state === 'succeeded'));
    assert.equal(done.items[0].tasks.succeeded, 7, '接着出的视频任务被发现并计入');
    assert.equal(done.totals.spent_cents, h.spendTotalCents());
    assert.equal(done.totals.spent_cents, done.totals.estimate_min_cents);
    assert.equal(h.gen.status(ep).counts.fresh, 5);
  });

  it('运行期间镜头被修改：该集按未更新失败（不重试），其余照常', async () => {
    const h = await harness({ episodes: 1 });
    const ep = h.eps[0];
    h.vendor.hold = true;
    const b = h.batch.create({ drama_id: h.drama, episode_ids: [ep], kinds: 'video', concurrency: { bailian: 3 } });
    await h.step();
    await h.step();
    const [s1] = h.shots(ep);
    h.edit(ep, s1, { video_prompt: '运行中改了提示词' }, 'e1');
    h.vendor.releaseAll();
    await h.drain();
    const v = h.batch.get(b.id);
    assert.equal(v.status, 'failed');
    assert.equal(v.items[0].status, 'failed');
    assert.match(v.items[0].error, /没有生成最新版本/);
  });
});

describe('批量生成：纯函数', () => {
  it('夜间时段：同日与跨午夜', () => {
    assert.equal(inNightWindow(23 * 60, { start: '22:00', end: '06:00' }), true);
    assert.equal(inNightWindow(3 * 60, { start: '22:00', end: '06:00' }), true);
    assert.equal(inNightWindow(6 * 60, { start: '22:00', end: '06:00' }), false, '结束时刻不含');
    assert.equal(inNightWindow(12 * 60, { start: '22:00', end: '06:00' }), false);
    assert.equal(inNightWindow(9 * 60, { start: '08:00', end: '18:00' }), true);
    assert.equal(inNightWindow(20 * 60, { start: '08:00', end: '18:00' }), false);
    assert.equal(inNightWindow(20 * 60, null), true);
  });
  it('策略 / 并发 / kinds 归一化', () => {
    assert.deepEqual(normalizePolicy(undefined), { retry: 1, on_fail: 'skip', night: null });
    assert.deepEqual(normalizePolicy({ retry: 0, on_fail: 'pause', night: { start: '22:00', end: '06:00' } }), { retry: 0, on_fail: 'pause', night: { start: '22:00', end: '06:00' } });
    assert.throws(() => normalizePolicy({ night: { start: '22:00', end: '22:00' } }), /不能相同/);
    assert.deepEqual(normalizeConcurrency({ bailian: 9, ark: '1' }, LIMITS, ['bailian', 'ark']), { bailian: 3, ark: 1 });
    assert.deepEqual(normalizeConcurrency({ default: 1 }, LIMITS, ['bailian']), { bailian: 1 });
    assert.deepEqual(normalizeConcurrency(undefined, LIMITS, ['bailian', 'ark']), { bailian: 3, ark: 2 });
    assert.throws(() => normalizeConcurrency({ bailian: 1.5 }, LIMITS, ['bailian']), /整数/);
    assert.deepEqual(normalizeKinds('both'), ['image', 'video']);
    assert.deepEqual(normalizeKinds(['video', 'image']), ['image', 'video']);
    assert.deepEqual(normalizeKinds('video'), ['video']);
    assert.throws(() => normalizeKinds(['tts']), /kinds/);
    assert.equal(toCents(0.105), 11);
  });
});

describe('批量生成：调度器', () => {
  it('假定时器：启动即跑一轮，有活动批次按 activeMs、否则按 idleMs；wake 立刻跑；stop 后不再跑；挂到 worker 生命周期', async () => {
    const timers = [];
    const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false, fired: false }; timers.push(t); return t; };
    const clearTimer = (t) => { if (t) t.cleared = true; };
    const pending = () => timers.filter((t) => !t.cleared && !t.fired);
    let active = true;
    const ticks = [];
    const service = { tick() { ticks.push(active); return { active }; }, onWake: null };
    let wake = null;
    service.onWake = (fn) => { wake = fn; };
    const s = createBatchScheduler({ service, setTimer, clearTimer, activeMs: 2000, idleMs: 15000 });
    assert.equal(typeof wake, 'function');
    const fire = async () => { const t = pending().pop(); t.fired = true; await t.fn(); };
    s.start();
    assert.equal(pending().length, 1);
    assert.equal(pending()[0].ms, 0);
    await fire();
    assert.equal(ticks.length, 1);
    assert.equal(pending()[0].ms, 2000);
    active = false;
    await fire();
    assert.equal(pending()[0].ms, 15000);
    wake();
    assert.equal(pending().length, 1, 'wake 换掉原定时器');
    assert.equal(pending()[0].ms, 0);
    await fire();
    assert.equal(ticks.length, 3);
    assert.equal(s.isRunning(), true);
    await s.stop();
    assert.equal(pending().length, 0);
    assert.equal(s.isRunning(), false);
    s.wake();
    assert.equal(pending().length, 0, '停止后 wake 不再排定时器');
    assert.equal((await s.runOnce()).active, false, 'runOnce 仍可手动跑一轮');
    // attachToWorker：worker.start 之后调度器启动，worker.stop 之前调度器停止
    const order = [];
    const worker = { async start() { order.push('worker.start'); }, async stop() { order.push('worker.stop'); } };
    const sched = { start() { order.push('sched.start'); }, async stop() { order.push('sched.stop'); } };
    const w = attachToWorker(worker, sched);
    await w.start();
    await w.stop();
    assert.deepEqual(order, ['worker.start', 'sched.start', 'sched.stop', 'worker.stop']);
  });
});

describe('批量生成：REST', () => {
  it('创建 / 列表 / 详情 / 暂停 / 继续 / 取消 / 重试失败 与错误码', async () => {
    const h = await harness({ episodes: 2 });
    const app = express();
    app.use(express.json());
    const br = batchRoutes(h.batch, log);
    app.post('/batches', br.create);
    app.get('/batches', br.list);
    app.get('/batches/:id', br.get);
    app.post('/batches/:id/retry-failed', br.retryFailed);
    app.post('/batches/:id/cancel', br.cancel);
    app.post('/batches/:id/pause', br.pause);
    app.post('/batches/:id/resume', br.resume);
    const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const call = async (method, url, body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    try {
      let r = await call('GET', `/batches?drama_id=${h.drama}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data.items, []);
      assert.equal(r.body.data.provider_limits.bailian, 3);
      assert.equal(r.body.data.providers[0].id, 'bailian');
      assert.equal((await call('GET', '/batches?drama_id=x')).status, 400);

      r = await call('POST', '/batches', { drama_id: h.drama, episode_ids: h.eps, kinds: 'video', concurrency: { bailian: 2 }, failure_policy: { retry: 1, on_fail: 'skip', night: null } });
      assert.equal(r.status, 201);
      const id = r.body.data.id;
      assert.equal(r.body.data.status, 'queued');
      assert.equal(r.body.data.items.length, 2);
      assert.equal(h.taskCount(), 0);

      r = await call('POST', '/batches', { drama_id: h.drama, episode_ids: h.eps, kinds: 'video', budget_cap_cents: 1 });
      assert.equal(r.status, 402);
      assert.equal(r.body.error.code, 'BATCH_BUDGET_EXCEEDED');
      assert.ok(r.body.error.action);
      r = await call('POST', '/batches', { drama_id: h.drama, episode_ids: h.eps, kinds: 'video', budget_cap_cents: 1, dry_run: true });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.dry_run, true);
      assert.equal(r.body.data.allowed, false);
      assert.equal(r.body.data.refusal.code, 'BATCH_BUDGET_EXCEEDED');
      assert.equal(h.batch.list().length, 1, 'dry_run 不建');
      r = await call('POST', '/batches', { drama_id: h.drama, episode_ids: [], kinds: 'video' });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'BAD_REQUEST');
      r = await call('POST', '/batches', { drama_id: h.drama, episode_ids: h.eps, kinds: 'image' });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'BATCH_NOTHING_TO_DO');
      assert.equal((await call('GET', '/batches/nope')).status, 404);
      assert.equal((await call('POST', '/batches/nope/pause')).status, 404);

      await h.step();
      r = await call('GET', `/batches/${id}`);
      assert.equal(r.body.data.status, 'running');
      assert.equal(r.body.data.progress.tasks.total, 2);
      r = await call('POST', `/batches/${id}/pause`);
      assert.equal(r.body.data.status, 'paused');
      r = await call('POST', `/batches/${id}/pause`);
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'BATCH_STATE');
      r = await call('POST', `/batches/${id}/resume`, { budget_cap_cents: 100000 });
      assert.equal(r.body.data.status, 'queued');
      assert.equal(r.body.data.budget_cap_cents, 100000);
      r = await call('POST', `/batches/${id}/retry-failed`);
      assert.equal(r.status, 409);
      await h.drain();
      r = await call('GET', `/batches/${id}`);
      assert.equal(r.body.data.status, 'completed');
      r = await call('POST', `/batches/${id}/cancel`);
      assert.equal(r.status, 409);
      r = await call('GET', `/batches?drama_id=${h.drama}`);
      assert.equal(r.body.data.items.length, 1);
      assert.equal(r.body.data.items[0].progress.items_done, 2);
    } finally {
      server.close();
    }
  });
});
