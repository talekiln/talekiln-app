'use strict';
// I1：出图 / 出视频走持久队列并写回内核。全部用假的服务商门面，不联网。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const kernel = require('@talekiln/kernel');
const store = require('../src/kernel/store');
const { createAiTaskStore, createAiTaskQueue, createWorker, blobPath, CrashSignal } = require('../src/queue');
const { createSpendService } = require('../src/spend');
const { createGenerationService, GenerationError } = require('../src/generation');
const generationRoutes = require('../src/routes/generation');
const { seededDb, sbRows, log } = require('./helpers/kernelDb');
const referenceLocks = require('../src/services/referenceLockService');
const kernelInputs = require('../src/kernel/inputs');

const FAKE_CONFIGS = [{ provider: 'dashscope', api_key: 'fake-key-not-real', is_active: true, service_type: 'text' }];

/**
 * 假的 bailian 队列门面：记录每次 submit 的参数；image 同步完成，video 轮询一次后成功；download 写入内容寻址目录。
 * behavior.failKinds: 这些 kind 的 poll 返回 failed。
 */
function fakeProvider(storageDir, behavior = {}) {
  const calls = [];
  let n = 0;
  const p = {
    calls,
    async submit(task) {
      const params = JSON.parse(task.params);
      calls.push({ kind: task.kind, key: task.idempotency_key, params });
      return { vendorTaskId: `fake-${task.kind}-${++n}` };
    },
    async poll(task) {
      if ((behavior.failKinds || []).includes(task.kind)) return { status: 'failed', errorCode: 'TASK_FAILED', errorMessage: 'fake failure' };
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
  return p;
}

async function harness({ behavior, crash, withCore = true, db: existing } = {}) {
  const seeded = existing ? null : await seededDb();
  const { db, episodeId, dir } = existing || seeded;
  const storageDir = path.join(dir, 'storage');
  require('../src/kernel/legacy').importLegacy(db, episodeId); // 幂等
  const taskStore = createAiTaskStore(db);
  const provider = fakeProvider(storageDir, behavior);
  const queue = createAiTaskQueue({ store: taskStore, providers: { bailian: provider }, crash });
  const spend = createSpendService(db);
  let gen = null;
  const worker = createWorker({ queue, store: taskStore, config: {}, onTaskFinished: (t) => { spend.recordFinished(t); if (gen) gen.onTaskFinished(t); }, onError() {} });
  const probed = [];
  const getCore = withCore ? async () => ({ call: async (m, args) => { probed.push([m, args.path]); return { durationSec: 4.8 }; } }) : null;
  const catalog = { models: [] };
  gen = createGenerationService({ db, store: taskStore, worker: { wake() {} }, spend, storageRoot: storageDir, getCore, listConfigs: () => FAKE_CONFIGS, catalogModels: () => catalog.models, log });
  const drain = async () => {
    for (let i = 0; i < 30 && worker.unfinishedCount() > 0; i++) { await worker.runOnce(); await gen.idle(); }
    await worker.runOnce();
    await gen.idle();
  };
  const shots = () => kernel.shotOrder(store.openProject(db, episodeId).graph);
  const graph = () => store.openProject(db, episodeId).graph;
  const rowOf = (shotId) => db.prepare('SELECT * FROM storyboards WHERE id = ?').get(graph().nodes[shotId].legacy_id);
  const edit = (shotId, patch, id) => store.commit(db, episodeId, (g) => kernel.intents.shot.setShotField(g, shotId, patch, { tx_id: id }), { tx_id: id });
  const taskCount = () => db.prepare('SELECT COUNT(*) n FROM ai_tasks').get().n;
  return { catalog, db, ep: episodeId, dir, storageDir, taskStore, queue, worker, spend, gen, provider, probed, drain, shots, graph, rowOf, edit, taskCount, getCore };
}

describe('生成编排：估算与建任务', () => {
  it('confirm=false 只估算：不建任务，给出费用与额度状态；confirm=true 才建', async () => {
    const h = await harness();
    h.spend.setLimits({ monthly_cap: 100 });
    const pre = h.gen.preview(h.ep, { shots: 'all', kind: 'video' });
    assert.equal(h.taskCount(), 0, '估算阶段不能建任务');
    assert.equal(pre.billable, 5);
    assert.equal(pre.items.length, 5);
    assert.ok(pre.estimate.total > 0 && pre.estimate.max >= pre.estimate.total);
    assert.equal(pre.estimate.currency, 'CNY');
    assert.equal(pre.estimate.by_item.length, 5);
    assert.equal(pre.cap.monthly_cap, 100);
    assert.equal(pre.cap.monthly_remaining, 100);
    assert.equal(pre.allowed, true);
    const done = h.gen.create(h.ep, { shots: 'all', kind: 'video' });
    assert.equal(done.confirmed, true);
    assert.equal(done.tasks.length, 5);
    assert.ok(done.tasks.every((t) => t.outcome === 'created' && t.state === 'queued'));
    assert.equal(h.taskCount(), 5);
    // 估算 = 实际入队任务的价格之和
    assert.equal(h.spend.checkBatch(done.tasks.map((t) => {
      const row = h.taskStore.get(t.task_id);
      return { provider: row.provider, kind: row.kind, params: JSON.parse(row.params) };
    })).total, pre.estimate.total);
  });

  it('视频：有已采用首帧走首帧模型，没有则文生视频；尾帧一并传入', async () => {
    const h = await harness();
    const [s1, s2] = h.shots();
    // 去掉第 2 镜的首帧：直接清空采用版本
    store.commit(h.db, h.ep, { tx_id: 'drop-frame', label: 'drop', ops: [{ op: 'adoptVersion', node: kernel.partsOfShot(h.graph(), s2).image, version_id: null }] });
    h.db.prepare('UPDATE storyboards SET last_frame_local_path = ? WHERE id = ?').run('media/tail-1.png', h.graph().nodes[s1].legacy_id);
    h.gen.create(h.ep, { shots: [s1, s2], kind: 'video' });
    const byShot = (id) => h.db.prepare('SELECT params FROM ai_tasks').all().map((r) => JSON.parse(r.params)).find((p) => p._gen.shot_id === id);
    const a = byShot(s1);
    const b = byShot(s2);
    assert.equal(a.model, 'wan2.2-kf2v-flash');
    assert.equal(a.firstFrameUrl, kernel.adoptedVersion(h.graph(), kernel.partsOfShot(h.graph(), s1).image).asset.ref);
    assert.equal(a.lastFrameUrl, '/static/media/tail-1.png');
    assert.equal(b.model, 'wan2.6-t2v');
    assert.equal(b.firstFrameUrl, undefined);
    assert.equal(a.duration, Math.round(h.graph().nodes[s1].params.duration_ms / 1000));
  });

  it('图片：已锁定的角色参考图带上并改用带参考图的模型', async () => {
    const h = await harness();
    const [s1] = h.shots();
    const legacyId = h.graph().nodes[s1].legacy_id;
    const cid = h.db.prepare('SELECT id FROM characters LIMIT 1').get().id;
    h.db.prepare('INSERT INTO reference_locks (entity_type, entity_id, local_path, locked_at) VALUES (?, ?, ?, ?)').run('character', cid, 'media/char-ref.png', 'now');
    h.edit(s1, { image_prompt: '改过的提示词', characters: [cid] }, 'e1'); // 经内核写（物化会按图覆盖旧表的 characters 列）
    h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    const p = JSON.parse(h.db.prepare("SELECT params FROM ai_tasks WHERE kind = 'image'").get().params);
    assert.deepEqual(p.referenceImages, ['/static/media/char-ref.png']);
    assert.equal(p.model, 'wan2.6-image');
    assert.equal(p.prompt, '改过的提示词');
  });

  it('再点一次不花钱：排队中复用同一任务；跑完后全部新鲜，不再建任务', async () => {
    const h = await harness();
    h.gen.create(h.ep, { shots: 'all', kind: 'video' });
    const again = h.gen.create(h.ep, { shots: 'all', kind: 'video' });
    assert.ok(again.tasks.every((t) => t.outcome === 'already_queued'));
    assert.equal(h.taskCount(), 5);
    await h.drain();
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
    const third = h.gen.preview(h.ep, { shots: 'all', kind: 'both' });
    assert.equal(third.billable, 0);
    assert.equal(third.estimate.total, 0);
    assert.deepEqual(third.counts, { fresh: 10 });
    const c = h.gen.create(h.ep, { shots: 'all', kind: 'both' });
    assert.equal(c.tasks.length, 0);
    assert.equal(h.taskCount(), 5);
  });

  it('改了又改回原样：命中旧版本，直接采用，不建任务也不花钱', async () => {
    const h = await harness();
    const [s1] = h.shots();
    const imgNode = kernel.partsOfShot(h.graph(), s1).image;
    const originalPrompt = h.graph().nodes[s1].params.image_prompt;
    const v0 = kernel.adoptedVersion(h.graph(), imgNode).id;
    h.edit(s1, { image_prompt: '临时改动' }, 'e1');
    assert.equal(h.gen.status(h.ep).shots[0].image.state, 'stale');
    h.edit(s1, { image_prompt: originalPrompt }, 'e2');
    // 改回去后版本仍采用着旧版本且 key 一致 = 新鲜
    assert.equal(h.gen.status(h.ep).shots[0].image.state, 'fresh');

    // 改动后真的生成一版（采用新版本），再改回原样 -> 旧版本是缓存命中
    h.edit(s1, { image_prompt: '第二次改动' }, 'e3');
    h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    await h.drain();
    assert.notEqual(kernel.adoptedVersion(h.graph(), imgNode).id, v0);
    const tasksBefore = h.taskCount();
    h.edit(s1, { image_prompt: originalPrompt }, 'e4');
    const pre = h.gen.preview(h.ep, { shots: [s1], kind: 'image' });
    assert.equal(pre.items[0].action, 'cache_hit');
    assert.equal(pre.billable, 0);
    assert.equal(pre.estimate.total, 0);
    const r = h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    assert.equal(r.tasks.length, 0);
    assert.equal(h.taskCount(), tasksBefore, '命中缓存不建任务');
    const back = kernel.adoptedVersion(h.graph(), imgNode);
    assert.ok(back.id === v0 || back.rebased_from === v0, '采用回旧版本（导入的旧版本不知道当时的输入，改记成当前 key 的别名版本，资产相同）');
    assert.equal(back.asset.ref, kernel.adoptedVersion(store.openProject(h.db, h.ep).graph, imgNode).asset.ref);
    assert.equal(h.gen.status(h.ep).shots[0].image.state, 'fresh');
  });

  it('改一个镜头的提示词：只有这个镜头的链重新生成（图 -> 接着出视频）', async () => {
    const h = await harness();
    h.gen.create(h.ep, { shots: 'all', kind: 'video' });
    await h.drain();
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
    const base = h.taskCount();
    const s3 = h.shots()[2];
    h.edit(s3, { image_prompt: '换一个画面' }, 'e1');
    const st = h.gen.status(h.ep);
    assert.deepEqual(st.shots.map((s) => s.state), ['fresh', 'fresh', 'stale', 'fresh', 'fresh']);

    const pre = h.gen.preview(h.ep, { shots: 'all', kind: 'both' });
    assert.equal(pre.billable, 2, '一张图 + 接在后面的一段视频');
    assert.deepEqual(pre.items.filter((i) => i.action !== 'fresh').map((i) => [i.shot_id, i.kind, i.action]), [[s3, 'image', 'create'], [s3, 'video', 'chain']]);
    const r = h.gen.create(h.ep, { shots: 'all', kind: 'both' });
    assert.equal(r.tasks.length, 1, '点击时只建首帧任务');
    await h.drain();
    assert.equal(h.taskCount(), base + 2, '首帧成功后自动接上该镜头的视频任务');
    const video = h.provider.calls.filter((c) => c.kind === 'video').pop();
    assert.equal(video.params._gen.shot_id, s3);
    const newImage = kernel.adoptedVersion(h.graph(), kernel.partsOfShot(h.graph(), s3).image);
    assert.equal(video.params.firstFrameUrl, newImage.asset.ref, '视频用刚落地的新首帧');
    assert.equal(video.params.model, 'wan2.2-kf2v-flash');
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
  });

  it('regenerate：换种子后只重做该镜头（旧版本保留）', async () => {
    const h = await harness();
    const [s1] = h.shots();
    const imgNode = kernel.partsOfShot(h.graph(), s1).image;
    const v0 = kernel.adoptedVersion(h.graph(), imgNode).id;
    const r = h.gen.create(h.ep, { shots: [s1], kind: 'image', regenerate: true });
    assert.equal(r.tasks.length, 1);
    assert.equal(h.graph().nodes[imgNode].params.seed, 1);
    await h.drain();
    const vs = h.graph().versions[imgNode];
    assert.ok(vs.length >= 2 && vs.some((v) => v.id === v0), '旧版本保留（首次同步生成输入时可能多一条改记版本）');
    assert.notEqual(kernel.adoptedVersion(h.graph(), imgNode).id, v0);
  });
});

describe('花费上限', () => {
  it('超过月度上限：整批拒绝，不建任何任务，也不改种子', async () => {
    const h = await harness();
    h.spend.setLimits({ monthly_cap: 0.5 });
    const pre = h.gen.preview(h.ep, { shots: 'all', kind: 'video' });
    assert.equal(pre.allowed, false);
    assert.equal(pre.refusal.reason, 'monthly');
    assert.equal(h.taskCount(), 0);
    assert.throws(() => h.gen.create(h.ep, { shots: 'all', kind: 'video' }), (e) => e instanceof GenerationError && e.code === 'SPEND_LIMIT' && e.status === 402);
    assert.equal(h.taskCount(), 0);
    const seq = store.openProject(h.db, h.ep).seq;
    assert.throws(() => h.gen.create(h.ep, { shots: 'all', kind: 'video', regenerate: true }), (e) => e.code === 'SPEND_LIMIT');
    assert.equal(store.openProject(h.db, h.ep).seq, seq, '被拒绝的重新生成不能改图');
    // 单个镜头的最高价在上限内就放行
    h.spend.setLimits({ monthly_cap: 100, per_run_cap: 1 });
    assert.equal(h.gen.preview(h.ep, { shots: 'all', kind: 'video' }).refusal.reason, 'per_run');
    assert.equal(h.gen.create(h.ep, { shots: [h.shots()[0]], kind: 'video' }).tasks.length, 1);
  });

  it('提交时队列的花费守卫仍然会再查（上限在点击之后被调低）', async () => {
    const h = await harness();
    h.gen.create(h.ep, { shots: [h.shots()[0]], kind: 'video' });
    h.spend.setLimits({ monthly_cap: 0.01 });
    const queue = createAiTaskQueue({ store: h.taskStore, providers: { bailian: h.provider }, spendGuard: (t) => h.spend.guardTask(t) });
    await queue.tick();
    const row = h.db.prepare('SELECT * FROM ai_tasks').get();
    assert.equal(row.state, 'failed');
    assert.equal(row.error_code, 'SPEND_LIMIT');
    assert.equal(h.provider.calls.length, 0, '没有提交给服务商');
  });
});

describe('写回内核', () => {
  it('视频成功：一次 commit 采用新版本，物化旧列，带真实时长；估算外的花费记入花费表', async () => {
    const h = await harness();
    const [s1] = h.shots();
    const r = h.gen.create(h.ep, { shots: [s1], kind: 'video' });
    const seq0 = store.openProject(h.db, h.ep).seq;
    await h.drain();
    const g = h.graph();
    assert.equal(store.openProject(h.db, h.ep).seq, seq0 + 1, '一个任务一次 commit');
    const vnode = kernel.partsOfShot(g, s1).video;
    const v = kernel.adoptedVersion(g, vnode);
    assert.equal(v.id, `t_${r.tasks[0].task_id}`);
    assert.equal(v.cache_key, kernel.cacheKeys(g)[vnode]);
    assert.equal(v.asset.kind, 'video');
    assert.ok(v.asset.ref.startsWith('/static/blobs/'));
    assert.equal(v.asset.hash.length, 64);
    assert.equal(v.metadata.duration_ms, 4800, '用 lycore media.probe 的真实时长');
    assert.equal(v.metadata.duration_source, 'probe');
    assert.equal(h.probed[0][0], 'media.probe');
    assert.ok(h.probed[0][1].startsWith(h.storageDir));
    assert.equal(h.gen.status(h.ep).shots[0].video.duration_ms, 4800);
    // 旧页面读的列
    const row = h.rowOf(s1);
    assert.equal(row.video_url, v.asset.ref);
    assert.equal(row.status, 'completed');
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM spend_log').get().n, 1);
  });

  it('没有 lycore 时时长取服务商用量，再退到请求的时长', async () => {
    const h = await harness({ withCore: false });
    const [s1] = h.shots();
    h.gen.create(h.ep, { shots: [s1], kind: 'video' });
    await h.drain();
    const v = kernel.adoptedVersion(h.graph(), kernel.partsOfShot(h.graph(), s1).video);
    assert.equal(v.metadata.duration_ms, 5000);
    assert.equal(v.metadata.duration_source, 'provider');
  });

  it('图片成功：采用新图并写到旧表的 local_path', async () => {
    const h = await harness();
    const [s1] = h.shots();
    const before = h.rowOf(s1).local_path;
    h.edit(s1, { image_prompt: '新的首帧画面' }, 'e1');
    h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    await h.drain();
    const v = kernel.adoptedVersion(h.graph(), kernel.partsOfShot(h.graph(), s1).image);
    assert.equal(v.asset.kind, 'image');
    const row = h.rowOf(s1);
    assert.notEqual(row.local_path, before);
    assert.equal(`/static/${row.local_path}`, v.asset.ref);
    assert.equal(h.gen.status(h.ep).shots[0].image.state, 'fresh');
  });

  it('任务失败：旧采用版本、旧表列都不动，只有任务状态变化；重试成功后才换版本', async () => {
    const h = await harness({ behavior: { failKinds: ['image'] } });
    const [s1] = h.shots();
    const imgNode = kernel.partsOfShot(h.graph(), s1).image;
    const before = kernel.adoptedVersion(h.graph(), imgNode).id;
    const rowBefore = h.rowOf(s1);
    h.edit(s1, { image_prompt: '会失败的改动' }, 'e1');
    const r = h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    const seq = store.openProject(h.db, h.ep).seq; // 建任务前的输入同步已提交；之后的任务失败不能再写内核
    await h.drain();
    assert.equal(h.taskStore.get(r.tasks[0].task_id).state, 'failed');
    assert.equal(store.openProject(h.db, h.ep).seq, seq, '失败不写内核');
    assert.equal(kernel.adoptedVersion(h.graph(), imgNode).id, before);
    assert.equal(h.rowOf(s1).local_path, rowBefore.local_path);
    const st = h.gen.status(h.ep).shots[0];
    assert.equal(st.image.state, 'failed');
    assert.equal(st.state, 'failed');
    assert.equal(st.image.task_id, r.tasks[0].task_id);
    // 再点一次 = 重试这个失败的任务（同键，不是新任务）
    h.provider.calls.length = 0;
    const again = h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    assert.equal(again.tasks[0].outcome, 'retried');
    assert.equal(again.tasks[0].task_id, r.tasks[0].task_id);
  });

  it('迟到的旧结果不会顶掉已经新鲜的版本', async () => {
    const h = await harness();
    const [s1] = h.shots();
    const imgNode = kernel.partsOfShot(h.graph(), s1).image;
    h.edit(s1, { image_prompt: 'A 版本' }, 'e1');
    const a = h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    h.edit(s1, { image_prompt: 'B 版本' }, 'e2'); // 点击之后又改了
    const b = h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    assert.notEqual(a.tasks[0].task_id, b.tasks[0].task_id);
    // 先让 B 完成并采用，再让 A 完成
    const order = [b.tasks[0].task_id, a.tasks[0].task_id];
    for (const id of order) {
      const t = h.taskStore.get(id);
      h.taskStore.claim(id);
      h.taskStore.recordVendorId(id, `v-${id}`);
      const out = await h.provider.download(t, { urls: ['https://fake.invalid/x.png'] });
      h.taskStore.succeed(id, out);
      await h.gen.adoptTask(h.taskStore.get(id));
    }
    const cur = kernel.adoptedVersion(h.graph(), imgNode);
    assert.equal(cur.id, `t_${b.tasks[0].task_id}`);
    assert.equal(h.graph().versions[imgNode].some((v) => v.id === `t_${a.tasks[0].task_id}`), true, '旧结果入库但不采用');
    assert.equal(h.gen.status(h.ep).shots[0].image.state, 'fresh');
  });

  it('同一任务重复写回是空操作', async () => {
    const h = await harness();
    const [s1] = h.shots();
    h.gen.create(h.ep, { shots: [s1], kind: 'video' });
    await h.drain();
    const t = h.db.prepare("SELECT * FROM ai_tasks WHERE state = 'succeeded'").get();
    const seq = store.openProject(h.db, h.ep).seq;
    const r = await h.gen.adoptTask(t);
    assert.equal(r.adopted, false);
    assert.equal(store.openProject(h.db, h.ep).seq, seq);
  });
});

describe('崩溃恢复', () => {
  it('提交后、写入服务商任务号之后崩溃：重启走 reconcile 续轮询，成功后照样写回', async () => {
    const crashAt = { point: 'after_id_write' };
    const h1 = await harness({ crash: (p) => { if (p === crashAt.point) throw new CrashSignal(p); } });
    const [s1] = h1.shots();
    h1.gen.create(h1.ep, { shots: [s1], kind: 'video' });
    await assert.rejects(h1.worker.runOnce(), (e) => e instanceof CrashSignal);
    assert.equal(h1.provider.calls.length, 1, '已提交一次');
    const t = h1.db.prepare('SELECT * FROM ai_tasks').get();
    assert.equal(t.state, 'submitted');
    assert.ok(t.vendor_task_id);
    const vnode = kernel.partsOfShot(h1.graph(), s1).video;
    assert.equal(kernel.adoptedVersion(h1.graph(), vnode), null);

    // “重启”：新的队列 / worker / 生成服务，同一个库；不会再次提交
    const h2 = await harness({ db: { db: h1.db, episodeId: h1.ep, dir: h1.dir } });
    const out = await h2.worker.reconcileNow('startup');
    assert.equal(out.resumed.length, 1);
    await h2.drain();
    assert.equal(h2.provider.calls.length, 0, '重启后不再向服务商提交');
    assert.equal(h2.taskCount(), 1);
    assert.ok(kernel.adoptedVersion(h2.graph(), vnode));
    assert.equal(h2.gen.status(h2.ep).shots[0].video.state, 'fresh');
  });

  it('任务已成功但写回前进程崩了：recoverFinished 补写，且只补一次', async () => {
    const h = await harness();
    const [s1] = h.shots();
    const r = h.gen.create(h.ep, { shots: [s1], kind: 'video' });
    // 没有 onTaskFinished 的 worker 把任务跑完 = 写回丢了
    const bare = createWorker({ queue: h.queue, store: h.taskStore, config: {}, onError() {} });
    for (let i = 0; i < 10 && bare.unfinishedCount() > 0; i++) await bare.runOnce();
    assert.equal(h.taskStore.get(r.tasks[0].task_id).state, 'succeeded');
    const vnode = kernel.partsOfShot(h.graph(), s1).video;
    assert.equal(kernel.adoptedVersion(h.graph(), vnode), null);
    assert.equal(h.gen.status(h.ep).shots[0].video.state, 'running', '结果还没写进图时仍显示进行中');
    const rec = await h.gen.recoverFinished();
    assert.equal(rec.length, 1);
    assert.equal(rec[0].adopted, true);
    assert.ok(kernel.adoptedVersion(h.graph(), vnode));
    const rec2 = await h.gen.recoverFinished();
    assert.equal(rec2[0].adopted, false);
    assert.equal(rec2[0].reason, 'already_recorded');
  });
});

describe('生成输入进 cacheKey：锁定参考图、尾帧、所选模型', () => {
  const states = (h) => h.gen.status(h.ep).shots.map((s) => [s.image.state, s.video.state]);
  /** 先把全部镜头生成一遍（顺便完成“首次记录所选模型”的基线），得到全新鲜的起点。 */
  async function baseline(h) {
    h.gen.create(h.ep, { shots: 'all', kind: 'both' });
    await h.drain();
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
  }

  it('首次记录所选模型不会让导入的新鲜素材变过期（改记，不建任务、不花钱）', async () => {
    const h = await harness();
    const imgs = () => h.gen.status(h.ep).shots.map((s) => s.image.state);
    assert.deepEqual(imgs(), Array(5).fill('fresh'), '示例项目导入的首帧图都是新鲜的');
    const r = h.gen.create(h.ep, { shots: 'all', kind: 'image' });
    assert.equal(r.tasks.length, 0, '图片不重做');
    assert.deepEqual(imgs(), Array(5).fill('fresh'));
    const node = kernel.partsOfShot(h.graph(), h.shots()[0]).image;
    assert.equal(h.graph().nodes[node].params.model, 'wan2.6-t2i', '所选模型已记进节点参数');
    assert.equal(kernel.adoptedVersion(h.graph(), node).source, 'rebase', '采用的是改记版本，原版本保留');
    assert.equal(h.graph().versions[node].length, 2);
    // 之后换模型就是真实变化：版本已记录模型
    h.catalog.models = [{ provider: 'bailian', service_type: 'image', id: 'img-b' }];
    assert.equal(h.gen.preview(h.ep, { shots: 'all', kind: 'image' }).counts.create, 5);
  });

  it('锁定参考图：只有用到它的镜头的 image + video 过期；解除后 key 回到原值，仍是新鲜', async () => {
    const h = await harness();
    await baseline(h);
    const [s1] = h.shots();
    h.db.prepare('UPDATE storyboards SET scene_id = 77 WHERE id = ?').run(h.graph().nodes[s1].legacy_id); // scene_id 不在图里，直接写旧表
    referenceLocks.setLock(h.db, 'scene', 77, { local_path: 'media/scene-77.png' });
    const r = kernelInputs.syncReferences(h.db);
    assert.equal(r.length, 1);
    assert.equal(r[0].applied, true);
    const st = states(h);
    assert.deepEqual(st[0], ['stale', 'stale'], '用到参考图的镜头：图和视频都过期');
    assert.ok(st.slice(1).every((x) => x[0] === 'fresh' && x[1] === 'fresh'), '其它镜头不受影响');
    const node = kernel.partsOfShot(h.graph(), s1).image;
    assert.deepEqual(h.graph().nodes[node].params.reference_hashes, [kernelInputs.hashRef('/static/media/scene-77.png')]);
    // 解除 -> 参数删除 -> key 回到锁定前的值 -> 仍采用着旧版本 = 新鲜
    referenceLocks.clearLock(h.db, 'scene', 77);
    kernelInputs.syncReferences(h.db);
    assert.ok(!('reference_hashes' in h.graph().nodes[node].params));
    assert.deepEqual(states(h)[0], ['fresh', 'fresh']);
    // 再次同步没有变化 = 不写内核
    assert.equal(kernelInputs.syncReferences(h.db)[0].applied, false);
  });

  it('锁定后真的生成一版，再解除：旧版本是缓存命中，零成本重新采用', async () => {
    const h = await harness();
    await baseline(h);
    const [s1] = h.shots();
    h.db.prepare('UPDATE storyboards SET scene_id = 77 WHERE id = ?').run(h.graph().nodes[s1].legacy_id);
    referenceLocks.setLock(h.db, 'scene', 77, { local_path: 'media/scene-77.png' });
    const made = h.gen.create(h.ep, { shots: [s1], kind: 'both' });
    assert.equal(made.tasks.length, 1, '先出图（接着自动出视频）');
    await h.drain();
    const p = h.db.prepare("SELECT params FROM ai_tasks WHERE kind = 'image' ORDER BY rowid DESC").get();
    assert.deepEqual(JSON.parse(p.params).referenceImages, ['/static/media/scene-77.png']);
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
    referenceLocks.clearLock(h.db, 'scene', 77);
    kernelInputs.syncReferences(h.db);
    assert.deepEqual(states(h)[0], ['stale', 'stale']);
    const tasksBefore = h.taskCount();
    const pre = h.gen.preview(h.ep, { shots: [s1], kind: 'both' });
    assert.deepEqual(pre.items.map((i) => i.action), ['cache_hit', 'cache_hit']);
    assert.equal(pre.billable, 0);
    const r = h.gen.create(h.ep, { shots: [s1], kind: 'both' });
    assert.equal(r.tasks.length, 0);
    assert.equal(h.taskCount(), tasksBefore);
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
  });

  it('参考图锁定 / 解除的 REST 路由：改完旧表立刻同步进图，受影响镜头马上过期', async () => {
    const h = await harness();
    await baseline(h);
    const [s1] = h.shots();
    h.db.prepare('UPDATE storyboards SET scene_id = 78 WHERE id = ?').run(h.graph().nodes[s1].legacy_id);
    const wb = require('../src/routes/workbench')(h.db, log);
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    wb.setLock({ params: { type: 'scene', id: '78' }, body: { local_path: 'media/scene-78.png' } }, res);
    assert.equal(res.code, 200);
    assert.deepEqual(states(h)[0], ['stale', 'stale']);
    assert.ok(states(h).slice(1).every((x) => x[0] === 'fresh' && x[1] === 'fresh'));
    wb.clearLock({ params: { type: 'scene', id: '78' } }, res);
    assert.deepEqual(states(h)[0], ['fresh', 'fresh']);
  });

  it('尾帧：只有该镜头的 video 过期，首帧图保持新鲜；改回去恢复', async () => {
    const h = await harness();
    await baseline(h);
    const [s1] = h.shots();
    const id = h.graph().nodes[s1].legacy_id;
    h.db.prepare('UPDATE storyboards SET last_frame_local_path = ? WHERE id = ?').run('media/tail-9.png', id);
    kernelInputs.syncReferences(h.db);
    assert.deepEqual(states(h)[0], ['fresh', 'stale']);
    assert.ok(states(h).slice(1).every((x) => x[0] === 'fresh' && x[1] === 'fresh'));
    h.db.prepare('UPDATE storyboards SET last_frame_local_path = NULL WHERE id = ?').run(id);
    kernelInputs.syncReferences(h.db);
    assert.deepEqual(states(h)[0], ['fresh', 'fresh']);
    // 经队列生成：尾帧在任务参数里，版本记录了当时的输入
    h.db.prepare('UPDATE storyboards SET last_frame_local_path = ? WHERE id = ?').run('media/tail-9.png', id);
    const r = h.gen.create(h.ep, { shots: [s1], kind: 'video' });
    assert.equal(r.tasks.length, 1);
    assert.equal(JSON.parse(h.db.prepare("SELECT params FROM ai_tasks WHERE kind = 'video' ORDER BY rowid DESC").get().params).lastFrameUrl, '/static/media/tail-9.png');
    await h.drain();
    const v = kernel.adoptedVersion(h.graph(), kernel.partsOfShot(h.graph(), s1).video);
    assert.equal(v.metadata.inputs.tail_frame_hash, kernelInputs.hashRef('/static/media/tail-9.png'));
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
  });

  it('所选模型：换模型 = 该镜头 image + video 过期（估算只在副本上演算，不写库）；换回来命中旧版本', async () => {
    const h = await harness();
    h.catalog.models = [{ provider: 'bailian', service_type: 'image', id: 'wan2.6-t2i' }, { provider: 'bailian', service_type: 'video', id: 'wan2.6-t2v' }, { provider: 'bailian', service_type: 'video', id: 'wan2.2-kf2v-flash' }];
    await baseline(h);
    const imgNode = kernel.partsOfShot(h.graph(), h.shots()[0]).image;
    assert.equal(h.graph().nodes[imgNode].params.model, 'wan2.6-t2i', '所选模型已记进节点参数');
    // 目录里这个服务商的出图模型换了：新的选择必须让所有镜头的图和视频过期
    h.catalog.models = [{ provider: 'bailian', service_type: 'image', id: 'img-b' }, ...h.catalog.models.filter((m) => m.service_type === 'video')];
    const seq = store.openProject(h.db, h.ep).seq;
    const pre = h.gen.preview(h.ep, { shots: 'all', kind: 'both' });
    assert.equal(store.openProject(h.db, h.ep).seq, seq, '估算不写内核');
    assert.deepEqual(pre.items.filter((i) => i.kind === 'image').map((i) => [i.action, i.model]), Array(5).fill(['create', 'img-b']));
    const made = h.gen.create(h.ep, { shots: 'all', kind: 'both' });
    assert.equal(made.tasks.length, 5);
    await h.drain();
    assert.equal(h.graph().nodes[imgNode].params.model, 'img-b');
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
    // 换回来：旧版本的 key 与现在相同 -> 缓存命中，不建任务
    h.catalog.models = [{ provider: 'bailian', service_type: 'image', id: 'wan2.6-t2i' }, ...h.catalog.models.filter((m) => m.service_type === 'video')];
    const tasksBefore = h.taskCount();
    const back = h.gen.create(h.ep, { shots: 'all', kind: 'both' });
    assert.equal(back.tasks.length, 0);
    assert.equal(h.taskCount(), tasksBefore);
    assert.equal(h.graph().nodes[imgNode].params.model, 'wan2.6-t2i');
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
  });
});

describe('REST', () => {
  it('POST /episodes/:id/generate 与 GET .../generation/status', async () => {
    const h = await harness();
    const app = express();
    app.use(express.json());
    const gr = generationRoutes(h.gen, log, { legacyEnabled: false });
    app.post('/episodes/:id/generate', gr.generate);
    app.get('/episodes/:id/generation/status', gr.status);
    const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const call = async (method, url, body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    try {
      let r = await call('POST', `/episodes/${h.ep}/generate`, { shots: 'all', kind: 'video' }); // confirm 缺省 = false
      assert.equal(r.status, 200);
      assert.equal(r.body.data.confirmed, false);
      assert.equal(r.body.data.billable, 5);
      assert.equal(h.taskCount(), 0);

      r = await call('GET', `/episodes/${h.ep}/generation/status`);
      assert.equal(r.body.data.shots.length, 5);
      assert.equal(r.body.data.shots[0].state, 'none');
      assert.equal(r.body.data.legacy_enabled, false);

      const sb = h.graph().nodes[h.shots()[0]].legacy_id;
      r = await call('POST', `/episodes/${h.ep}/generate`, { shots: [sb], kind: 'video', confirm: true });
      assert.equal(r.body.data.tasks.length, 1);
      r = await call('GET', `/episodes/${h.ep}/generation/status`);
      assert.equal(r.body.data.shots[0].state, 'queued');
      await h.drain();
      r = await call('GET', `/episodes/${h.ep}/generation/status`);
      assert.equal(r.body.data.shots[0].video.state, 'fresh');

      h.spend.setLimits({ monthly_cap: 0.1 });
      r = await call('POST', `/episodes/${h.ep}/generate`, { shots: 'all', kind: 'video', confirm: true });
      assert.equal(r.status, 402);
      assert.equal(r.body.error.code, 'SPEND_LIMIT');
      assert.equal((await call('POST', `/episodes/${h.ep}/generate`, { shots: [999999], kind: 'video' })).status, 404);
      assert.equal((await call('POST', `/episodes/${h.ep}/generate`, { shots: 'all', kind: 'audio' })).status, 400);
      assert.equal((await call('POST', `/episodes/99999/generate`, { shots: 'all' })).status, 404);
    } finally {
      server.close();
    }
  });
});

