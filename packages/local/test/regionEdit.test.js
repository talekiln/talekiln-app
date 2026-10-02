'use strict';
// P3-R 选镜改片：估算 / 建任务 / 降级拼接 / 写回新版本（不自动采用）/ 采用版本 / REST。全部用假的服务商门面，不联网。
// 需要 ffmpeg 的用例（截帧、拼接）在没有 ffmpeg 的机器上跳过；估算、校验、额度、REST 的估算分支不依赖 ffmpeg。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const express = require('express');
const kernel = require('@talekiln/kernel');
const store = require('../src/kernel/store');
const { createAiTaskStore, createAiTaskQueue, createWorker, blobPath, createQueueProvider, withDownloads } = require('../src/queue');
const { createSpendService } = require('../src/spend');
const { createGenerationService } = require('../src/generation');
const regionEdit = require('../src/regionEdit');
const regionEditRoutes = require('../src/routes/regionEdit');
const { seededDb, log } = require('./helpers/kernelDb');

const { createRegionEditService, RegionEditError, EDIT_PREFIX } = regionEdit;
const FAKE_CONFIGS = [{ provider: 'dashscope', api_key: 'fake-key-not-real', is_active: true, service_type: 'text' }];
const RECT = { x: 0.25, y: 0.1, w: 0.5, h: 0.4 };
const HAS_FFMPEG = (() => { try { return spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0; } catch (_) { return false; } })();
const needFfmpeg = { skip: HAS_FFMPEG ? false : '本机没有 ffmpeg/ffprobe' };

/** lavfi 合成的小视频（带一轨正弦波音频，覆盖“原片音轨铺回整条”的分支）。 */
function makeVideo(file, { seconds = 3, fps = 25, size = '160x90', audio = true, src = 'testsrc2' } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${src}=size=${size}:rate=${fps}:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac', '-shortest');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file);
  execFileSync('ffmpeg', args);
  return file;
}
function putBlob(storageDir, buf) {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const dest = blobPath(storageDir, sha256);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { sha256, size: buf.length, path: path.relative(storageDir, dest).split(path.sep).join('/') };
}

/** 假的队列门面：记录 submit；poll 一次成功（或失败）；download 写一段真实的小视频（降级路径要拼接它）或假字节。 */
function fakeProvider(storageDir, behavior = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async submit(task) { calls.push({ kind: task.kind, key: task.idempotency_key, params: JSON.parse(task.params) }); return { vendorTaskId: `fake-${task.kind}-${++n}` }; },
    async poll(task) {
      if (behavior.fail) return { status: 'failed', errorCode: 'TASK_FAILED', errorMessage: '假的失败' };
      return { status: 'succeeded', result: { url: `https://fake.invalid/${task.id}.mp4`, usage: { duration: 2 } } };
    },
    async download(task, result) {
      let buf;
      if (behavior.realVideo) {
        const tmp = path.join(storageDir, 'tmp', `gen-${task.id}.mp4`);
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        makeVideo(tmp, { seconds: 2, fps: 24, size: '320x180', audio: false, src: 'testsrc' });
        buf = fs.readFileSync(tmp);
        fs.rmSync(tmp, { force: true });
      } else {
        buf = Buffer.from(`video:${task.id}`);
      }
      return { ...result, files: [{ url: result.url, ...putBlob(storageDir, buf) }] };
    },
  };
}

/**
 * 种好的示例项目 + 第一镜一版“已采用”的视频（真实小视频或假字节）+ 队列 / 花费 / 改片服务。
 * 生成服务也挂在 onTaskFinished 上：证明 `edit:` 任务不会被它当成自己的任务写回。
 */
async function harness({ realVideo = HAS_FFMPEG, hasVideoEdit = false, fail = false, db: existing, baseSeconds = 3 } = {}) {
  const seeded = existing ? null : await seededDb();
  const { db, episodeId, dir } = existing || seeded;
  const storageDir = path.join(dir, 'storage');
  require('../src/kernel/legacy').importLegacy(db, episodeId); // 幂等
  const graph = () => store.openProject(db, episodeId).graph;
  const shots = () => kernel.shotOrder(graph());
  const [s1] = shots();
  const vnode = kernel.partsOfShot(graph(), s1).video;
  if (!existing) {
    let blob;
    if (realVideo) {
      const tmp = path.join(dir, 'base.mp4');
      makeVideo(tmp, { seconds: baseSeconds });
      blob = putBlob(storageDir, fs.readFileSync(tmp));
    } else {
      blob = putBlob(storageDir, Buffer.from('not really a video'));
    }
    store.commit(db, episodeId, (g) => kernel.intents.shot.recordGeneration(g, vnode, {
      version_id: 'v_base', asset: { ref: `/static/${blob.path}`, path: blob.path, hash: blob.sha256, size: blob.size, kind: 'video' },
      metadata: { duration_ms: baseSeconds * 1000, duration_source: 'probe', inputs: { model: 'wan2.6-t2v' } },
    }, { tx_id: 'base-video' }), { tx_id: 'base-video' });
  }
  const taskStore = createAiTaskStore(db);
  const provider = fakeProvider(storageDir, { realVideo, fail });
  const queue = createAiTaskQueue({ store: taskStore, providers: { bailian: provider } });
  const spend = createSpendService(db);
  const capabilities = () => (hasVideoEdit ? ['video.submit', 'video.poll', 'video.edit'] : ['video.submit', 'video.poll']);
  const gen = createGenerationService({ db, store: taskStore, worker: { wake() {} }, spend, storageRoot: storageDir, listConfigs: () => FAKE_CONFIGS, catalogModels: () => [], log });
  const woke = { n: 0 };
  const svc = createRegionEditService({ db, store: taskStore, worker: { wake() { woke.n++; } }, spend, storageRoot: storageDir, listConfigs: () => FAKE_CONFIGS, catalogModels: () => [], log, capabilities });
  const worker = createWorker({ queue, store: taskStore, config: {}, onTaskFinished: (t) => { spend.recordFinished(t); gen.onTaskFinished(t); svc.onTaskFinished(t); }, onError() {} });
  const drain = async () => {
    for (let i = 0; i < 30 && worker.unfinishedCount() > 0; i++) { await worker.runOnce(); await svc.idle(); await gen.idle(); }
    await worker.runOnce();
    await svc.idle();
    await gen.idle();
  };
  const sbId = graph().nodes[s1].legacy_id;
  const rowOf = () => db.prepare('SELECT * FROM storyboards WHERE id = ?').get(sbId);
  const regions = () => db.prepare('SELECT * FROM edit_regions ORDER BY id').all();
  const taskCount = () => db.prepare('SELECT COUNT(*) n FROM ai_tasks').get().n;
  const seq = () => store.openProject(db, episodeId).seq;
  const probe = (abs) => regionEdit.ffmpeg.createFfmpeg().probe(abs);
  return { db, ep: episodeId, dir, storageDir, taskStore, queue, worker, spend, gen, svc, provider, drain, graph, shots, s1, vnode, sbId, rowOf, regions, taskCount, seq, probe, woke };
}

const EDIT = { t0_ms: 1000, t1_ms: 2500, rect: RECT, prompt: '把伞换成红色' };

describe('选镜改片：估算与校验', () => {
  it('只重做一段比整镜重做便宜；估算不建任务、不记行、不改图', async () => {
    const h = await harness({ realVideo: false });
    const seq0 = h.seq();
    const e = h.svc.estimate(h.sbId, EDIT);
    assert.equal(e.confirmed, false);
    assert.equal(e.strategy, 'segment_splice');
    assert.equal(e.provider, 'bailian');
    assert.equal(e.provider_ready, true);
    assert.equal(e.model, 'wan2.2-kf2v-flash', '降级路径带首尾帧，按首帧模型估价');
    assert.deepEqual(e.segment, { t0_ms: 1000, t1_ms: 2500, seconds: 2 }, '1.5 秒向上取整到 2 秒');
    assert.equal(e.total_ms, 3000);
    assert.equal(e.estimate.full.seconds, 3);
    assert.ok(e.estimate.total > 0, '有价格');
    assert.ok(e.estimate.total < e.estimate.full.total, `只改一段 ${e.estimate.total} 必须比整镜 ${e.estimate.full.total} 便宜`);
    assert.ok(Number.isInteger(e.estimate.cents) && e.estimate.cents > 0 && e.estimate.cents < e.estimate.full.cents);
    assert.equal(e.estimate.currency, 'CNY');
    assert.equal(e.allowed, true);
    assert.deepEqual(e.edit, { base: 'v_base', mode: 'region', t0_ms: 1000, t1_ms: 2500, rect: RECT, prompt: '把伞换成红色' });
    assert.equal(h.taskCount(), 0);
    assert.equal(h.regions().length, 0);
    assert.equal(h.seq(), seq0, '估算不改图');
    // 整段模式：没给 rect 默认整幅画面
    const seg = h.svc.estimate(h.sbId, { t0_ms: 0, t1_ms: 3000, prompt: '整段重做', mode: 'segment' });
    assert.deepEqual(seg.edit.rect, { x: 0, y: 0, w: 1, h: 1 });
    assert.equal(seg.segment.seconds, 3);
  });

  it('校验：出点超过片长、空提示词、坏矩形、没有已采用视频的镜头', async () => {
    const h = await harness({ realVideo: false });
    const bad = (args, code, status) => assert.throws(() => h.svc.estimate(h.sbId, args), (e) => e instanceof RegionEditError && e.code === code && e.status === status, `${code} for ${JSON.stringify(args)}`);
    bad({ ...EDIT, t1_ms: 3500 }, 'BAD_REQUEST', 400);
    bad({ ...EDIT, t0_ms: 2500, t1_ms: 2500 }, 'BAD_REQUEST', 400);
    bad({ ...EDIT, prompt: '   ' }, 'BAD_REQUEST', 400);
    bad({ ...EDIT, rect: { x: 0.8, y: 0, w: 0.5, h: 0.5 } }, 'BAD_REQUEST', 400);
    bad({ ...EDIT, mode: 'inpaint' }, 'BAD_REQUEST', 400);
    const s2 = h.shots()[1];
    const sb2 = h.graph().nodes[s2].legacy_id;
    assert.throws(() => h.svc.estimate(sb2, EDIT), (e) => e.code === 'REGION_EDIT_NO_VIDEO' && e.status === 409 && /已采用的视频/.test(e.message));
    assert.throws(() => h.svc.estimate(999999, EDIT), (e) => e.code === 'NOT_FOUND' && e.status === 404);
    assert.throws(() => h.svc.estimate(h.s1, EDIT), (e) => e.code === 'BAD_REQUEST', '节点 id 需要 episode_id');
    assert.equal(h.svc.estimate(h.s1, { ...EDIT, episode_id: h.ep }).shot_id, h.s1);
  });

  it('超过额度：整批拒绝，不记行不建任务', async () => {
    const h = await harness({ realVideo: false });
    h.spend.setLimits({ monthly_cap: 0.01 });
    assert.equal(h.svc.estimate(h.sbId, EDIT).allowed, false);
    await assert.rejects(h.svc.submit(h.sbId, EDIT), (e) => e instanceof RegionEditError && e.code === 'SPEND_LIMIT' && e.status === 402);
    assert.equal(h.taskCount(), 0);
    assert.equal(h.regions().length, 0);
  });

  it('原视频没有本地文件：降级路径无法截帧，提交被拒', async () => {
    const h = await harness({ realVideo: false });
    const blob = blobPath(h.storageDir, kernel.adoptedVersion(h.graph(), h.vnode).asset.hash);
    fs.rmSync(blob, { force: true });
    await assert.rejects(h.svc.submit(h.sbId, EDIT), (e) => e.code === 'REGION_EDIT_BASE_MISSING' && e.status === 409);
    assert.equal(h.regions().length, 0);
  });
});

describe('选镜改片：降级路径（截帧 -> 首尾帧生视频 -> 拼接）', needFfmpeg, () => {
  it('提交：截取入点 / 出点两帧，建 edit: 任务；图不动，原视频仍新鲜；再点一次复用', async () => {
    const h = await harness();
    const seq0 = h.seq();
    const r = await h.svc.submit(h.sbId, EDIT);
    assert.equal(r.confirmed, true);
    assert.equal(r.outcome, 'created');
    assert.equal(r.task.state, 'queued');
    assert.equal(r.region.status, 'queued');
    assert.equal(r.region.strategy, 'segment_splice');
    assert.deepEqual(r.region.rect, RECT);
    assert.equal(h.woke.n, 1, '唤醒 worker');
    assert.equal(h.seq(), seq0, '提交不改图');
    assert.equal(kernel.nodeState(h.graph(), h.vnode), 'fresh', '等待期间原视频仍新鲜');
    const task = h.taskStore.get(r.task.id);
    assert.ok(task.idempotency_key.startsWith(`${EDIT_PREFIX}${h.ep}:${h.vnode}:`));
    const p = JSON.parse(task.params);
    assert.equal(p.duration, 2);
    assert.equal(p.model, 'wan2.2-kf2v-flash');
    assert.ok(/只修改画面上方（约占画面 20%）/.test(p.prompt) && /把伞换成红色/.test(p.prompt) && /保持不变/.test(p.prompt), p.prompt);
    assert.ok(p.prompt.startsWith(h.graph().nodes[h.s1].params.video_prompt.slice(0, 10)), '镜头原提示词在前');
    for (const ref of [p.firstFrameUrl, p.lastFrameUrl]) {
      assert.ok(ref.startsWith('/static/blobs/'), ref);
      const buf = fs.readFileSync(path.join(h.storageDir, ref.slice('/static/'.length)));
      assert.equal(buf.toString('latin1', 1, 4), 'PNG', '截出来的是 PNG');
    }
    assert.notEqual(p.firstFrameUrl, p.lastFrameUrl);
    assert.equal(p._edit.id, r.region.id);
    assert.equal(p._edit.frames.first.at_ms, 1000);
    assert.equal(p._edit.frames.last.at_ms, 2500);
    assert.notEqual(p._gen.cache_key, kernel.cacheKeys(h.graph())[h.vnode], '任务记的是改片后的 key');
    assert.equal(p.videoUrl, undefined);
    assert.equal(p.edit, undefined, '降级路径不带 edit 字段（适配器会把它路由到 video.edit）');
    // 同一配方再点：复用
    const again = await h.svc.submit(h.sbId, EDIT);
    assert.equal(again.outcome, 'already_queued');
    assert.equal(again.region.id, r.region.id);
    assert.equal(h.taskCount(), 1);
    assert.equal(h.regions().length, 1);
    // 不同提示词 = 新的一次
    const other = await h.svc.submit(h.sbId, { ...EDIT, prompt: '把伞换成蓝色' });
    assert.equal(other.outcome, 'created');
    assert.equal(h.taskCount(), 2);
    assert.equal(h.svc.listRegions(h.sbId).items.length, 2);
    assert.equal(h.svc.listRegions(h.sbId).items[0].id, other.region.id, '新的在前');
  });

  it('完成：拼接成整条、作为新版本入图但不采用；时长与原片相差不超过一帧；记录状态 done', async () => {
    const h = await harness();
    const r = await h.svc.submit(h.sbId, EDIT);
    const seq0 = h.seq();
    await h.drain();
    assert.equal(h.taskStore.get(r.task.id).state, 'succeeded');
    const g = h.graph();
    assert.equal(h.seq(), seq0 + 1, '一个任务一次 commit');
    assert.equal(g.adopted[h.vnode], 'v_base', '不自动采用');
    assert.equal(kernel.nodeState(g, h.vnode), 'fresh');
    const v = g.versions[h.vnode].find((x) => x.id === `t_${r.task.id}`);
    assert.ok(v, '新版本入图');
    assert.equal(v.cache_key, JSON.parse(h.taskStore.get(r.task.id).params)._gen.cache_key);
    assert.equal(v.source, `region-edit:${r.region.id}`);
    assert.deepEqual(v.metadata.edit, r.edit);
    assert.equal(v.metadata.strategy, 'segment_splice');
    assert.equal(v.metadata.base_version_id, 'v_base');
    assert.equal(v.metadata.segment_ms, 2000, '生成片段真实 2 秒（缩放到 1.5 秒拼回去）');
    assert.equal(v.asset.kind, 'video');
    assert.ok(v.asset.ref.startsWith('/static/blobs/'));
    const abs = path.join(h.storageDir, v.asset.path);
    assert.ok(fs.existsSync(abs));
    const out = await h.probe(abs);
    assert.ok(Math.abs(out.duration_ms - 3000) <= 1000 / 25, `时长 ${out.duration_ms} 应与原片 3000 相差不超过一帧`);
    assert.ok(Math.abs(v.metadata.duration_ms - 3000) <= 40);
    assert.equal(out.width, 160);
    assert.equal(out.height, 90);
    assert.equal(out.fps, 25);
    assert.equal(out.has_audio, true, '原片音轨铺回整条');
    const row = h.regions()[0];
    assert.equal(row.status, 'done');
    assert.equal(row.result_version_id, v.id);
    assert.equal(h.rowOf().video_url, kernel.adoptedVersion(g, h.vnode).asset.ref, '旧表仍指向原视频');
    // 列表：记录 + 版本列表（原版本当前且已采用；改片结果不是当前 key）
    const l = h.svc.listRegions(h.sbId);
    assert.equal(l.items[0].status, 'done');
    assert.equal(l.adopted, 'v_base');
    assert.equal(l.versions.node, h.vnode);
    const byId = Object.fromEntries(l.versions.versions.map((x) => [x.id, x]));
    assert.equal(byId.v_base.adopted, true);
    assert.equal(byId.v_base.current, true);
    assert.equal(byId[v.id].adopted, false);
    assert.equal(byId[v.id].current, false);
    assert.ok(byId[v.id].created_at);
    // 同一任务重复写回是空操作
    const again = await h.svc.finishTask(h.taskStore.get(r.task.id));
    assert.equal(again.recorded, false);
    assert.equal(h.seq(), seq0 + 1);
  });

  it('采用改片结果：节点参数跟随配方（新鲜），合成过期，旧表切到新视频；采用回原版本也新鲜', async () => {
    const h = await harness();
    const r = await h.svc.submit(h.sbId, EDIT);
    await h.drain();
    const vid = `t_${r.task.id}`;
    const a = h.svc.adoptVersion(h.sbId, { version_id: vid });
    assert.equal(a.applied, true);
    assert.equal(a.version_id, vid);
    let g = h.graph();
    assert.equal(g.adopted[h.vnode], vid);
    assert.deepEqual(g.nodes[h.vnode].params.edit, r.edit);
    assert.equal(kernel.nodeState(g, h.vnode), 'fresh', '采用后 key 含该 edit，与版本一致');
    assert.ok(kernel.staleSet(g).includes(kernel.composeId(g)), '最终成片要重新合成');
    assert.equal(h.rowOf().video_url, g.versions[h.vnode].find((x) => x.id === vid).asset.ref);
    const l = h.svc.listRegions(h.sbId);
    const byId = Object.fromEntries(l.versions.versions.map((x) => [x.id, x]));
    assert.equal(byId[vid].current, true);
    assert.equal(byId.v_base.current, false);
    // 已采用且参数一致 = 空操作，不写日志
    const seq = h.seq();
    assert.equal(h.svc.adoptVersion(h.sbId, { version_id: vid }).applied, false);
    assert.equal(h.seq(), seq);
    // 采用回原版本：edit 清除，仍新鲜
    const b = h.svc.adoptVersion(h.sbId, { version_id: 'v_base' });
    assert.equal(b.applied, true);
    g = h.graph();
    assert.equal(g.adopted[h.vnode], 'v_base');
    assert.ok(!('edit' in g.nodes[h.vnode].params));
    assert.equal(kernel.nodeState(g, h.vnode), 'fresh');
    assert.throws(() => h.svc.adoptVersion(h.sbId, { version_id: 'nope' }), (e) => e.code === 'NOT_FOUND' && e.status === 404);
    assert.throws(() => h.svc.adoptVersion(h.sbId, {}), (e) => e.code === 'BAD_REQUEST');
  });

  it('任务失败：图不动、没有新版本，记录标成失败；再点一次 = 重试同一任务', async () => {
    const h = await harness({ fail: true });
    const r = await h.svc.submit(h.sbId, EDIT);
    const seq0 = h.seq();
    const nv = h.graph().versions[h.vnode].length;
    await h.drain();
    assert.equal(h.taskStore.get(r.task.id).state, 'failed');
    assert.equal(h.seq(), seq0, '失败不写内核');
    assert.equal(h.graph().versions[h.vnode].length, nv);
    const row = h.regions()[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.error, '假的失败');
    assert.equal(h.svc.listRegions(h.sbId).items[0].status, 'failed');
    const again = await h.svc.submit(h.sbId, EDIT);
    assert.equal(again.outcome, 'retried');
    assert.equal(again.task.id, r.task.id);
    assert.equal(again.region.id, r.region.id);
    assert.equal(again.task.state, 'submitted', '已有服务商任务号：重试 = 续轮询，绝不二次提交');
    assert.equal(again.region.status, 'running');
    assert.equal(h.regions()[0].error, null);
    assert.equal(h.taskCount(), 1);
  });

  it('任务已成功但写回前进程崩了：recoverFinished 补写，且只补一次', async () => {
    const h = await harness();
    const r = await h.svc.submit(h.sbId, EDIT);
    const bare = createWorker({ queue: h.queue, store: h.taskStore, config: {}, onError() {} });
    for (let i = 0; i < 10 && bare.unfinishedCount() > 0; i++) await bare.runOnce();
    assert.equal(h.taskStore.get(r.task.id).state, 'succeeded');
    assert.equal(h.svc.listRegions(h.sbId).items[0].status, 'running', '结果还没进图时仍显示进行中');
    const rec = await h.svc.recoverFinished();
    assert.equal(rec.length, 1);
    assert.equal(rec[0].recorded, true);
    assert.ok(h.graph().versions[h.vnode].some((v) => v.id === `t_${r.task.id}`));
    assert.equal(h.regions()[0].status, 'done');
    assert.equal((await h.svc.recoverFinished()).length, 0);
  });

  it('出点在片尾：取最后一帧；拼接只有头 + 新片段', async () => {
    const h = await harness();
    const r = await h.svc.submit(h.sbId, { t0_ms: 2000, t1_ms: 3000, prompt: '结尾改成日落', mode: 'segment' });
    const p = JSON.parse(h.taskStore.get(r.task.id).params);
    assert.equal(p._edit.frames.last.at_ms, 2960, '3000 ms 已经越过最后一帧，退到 2960');
    await h.drain();
    const v = h.graph().versions[h.vnode].find((x) => x.id === `t_${r.task.id}`);
    assert.ok(v);
    assert.ok(Math.abs(v.metadata.duration_ms - 3000) <= 40);
  });
});

describe('选镜改片：服务商自带遮罩编辑（provider_mask）', () => {
  it('适配器声明 video.edit：任务带 videoUrl + edit，不截帧；结果直接成为新版本', async () => {
    const h = await harness({ realVideo: false, hasVideoEdit: true });
    const e = h.svc.estimate(h.sbId, EDIT);
    assert.equal(e.strategy, 'provider_mask');
    assert.equal(e.model, null, '编辑模型交给适配器挑');
    const r = await h.svc.submit(h.sbId, EDIT);
    assert.equal(r.strategy, 'provider_mask');
    const p = JSON.parse(h.taskStore.get(r.task.id).params);
    assert.equal(p.videoUrl, kernel.adoptedVersion(h.graph(), h.vnode).asset.ref);
    assert.deepEqual(p.edit, { t0_ms: 1000, t1_ms: 2500, rect: RECT, mode: 'region' });
    assert.equal(p.prompt, '把伞换成红色');
    assert.equal(p.firstFrameUrl, undefined);
    assert.equal(p._edit.strategy, 'provider_mask');
    await h.drain();
    const v = h.graph().versions[h.vnode].find((x) => x.id === `t_${r.task.id}`);
    assert.ok(v);
    assert.equal(v.metadata.strategy, 'provider_mask');
    assert.equal(v.metadata.duration_ms, 2000, '假文件探测不出时长，退到服务商用量');
    assert.equal(v.metadata.duration_source, 'provider');
    assert.equal(h.graph().adopted[h.vnode], 'v_base');
    assert.equal(h.regions()[0].status, 'done');
  });

  it('队列适配层：带 edit 的视频任务走 video.edit，否则走 video.submit；没有该能力时任务失败为 CAPABILITY_NOT_SUPPORTED', async () => {
    const calls = { submit: [], edit: [] };
    let withEdit = true;
    const createProviders = () => ({
      image: { generate: async () => ({ urls: [] }) },
      video: {
        submit: async (p, req) => { calls.submit.push(req); return { taskId: 'vt-s' }; },
        edit: async (p, req) => {
          if (!withEdit) { const { ProviderError, ERROR_CODES } = require('../src/providers/errors'); throw new ProviderError(ERROR_CODES.CAPABILITY_NOT_SUPPORTED, 'bailian:video.edit'); }
          calls.edit.push(req); return { taskId: 'vt-e' };
        },
        poll: async () => ({ status: 'succeeded', videoUrl: 'https://fake.invalid/v.mp4' }),
      },
      tts: { synthesize: async () => ({ audio: Buffer.from('a') }) },
    });
    const listConfigs = (t) => (t === 'video' ? [{ provider: 'dashscope', api_key: 'fake-key-not-real', is_active: true, service_type: 'video', model: ['wan2.6-t2v'] }] : []);
    const qp = createQueueProvider('bailian', { storageDir: path.join(require('os').tmpdir(), 'x'), listConfigs, createProviders });
    const task = (params) => ({ id: 't', kind: 'video', provider: 'bailian', params: JSON.stringify(params) });
    assert.deepEqual(await qp.submit(task({ prompt: 'p', videoUrl: 'https://x/v.mp4', edit: { t0_ms: 0, t1_ms: 1000, rect: RECT, mode: 'region' }, _edit: { id: 1 } })), { vendorTaskId: 'vt-e' });
    assert.equal(calls.edit.length, 1);
    assert.equal(calls.edit[0]._edit, undefined, '内部字段不发给服务商');
    assert.equal(calls.edit[0].videoUrl, 'https://x/v.mp4');
    assert.deepEqual(await qp.submit(task({ prompt: 'p', firstFrameUrl: 'https://x/f.png' })), { vendorTaskId: 'vt-s' });
    assert.equal(calls.submit.length, 1);
    withEdit = false;
    await assert.rejects(qp.submit(task({ prompt: 'p', videoUrl: 'https://x/v.mp4', edit: { t0_ms: 0, t1_ms: 1000 } })), (e) => e.code === 'CAPABILITY_NOT_SUPPORTED');
    // 真实适配器：百炼 / 方舟都没有 video.edit（文档标为未验证）
    const svcCaps = createRegionEditService({ db: (await harness({ realVideo: false })).db, store: { get() {} }, spend: { estimate() {}, checkBatch() {} }, storageRoot: '/tmp' });
    assert.equal(svcCaps.hasVideoEdit('bailian'), false);
  });
});

describe('选镜改片：REST', () => {
  async function serve(h) {
    const app = express();
    app.use(express.json());
    const rr = regionEditRoutes(h.svc, log);
    app.post('/shots/:id/edit-region', rr.editRegion);
    app.get('/shots/:id/edit-regions', rr.listRegions);
    app.post('/shots/:id/adopt-version', rr.adoptVersion);
    const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const call = async (method, url, body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    return { server, call };
  }

  it('估算分支与错误码（不依赖 ffmpeg）', async () => {
    const h = await harness({ realVideo: false });
    const { server, call } = await serve(h);
    try {
      let r = await call('POST', `/shots/${h.sbId}/edit-region`, EDIT); // confirm 缺省 = false
      assert.equal(r.status, 200);
      assert.equal(r.body.data.confirmed, false);
      assert.ok(r.body.data.estimate.cents < r.body.data.estimate.full.cents);
      assert.equal(h.taskCount(), 0);
      r = await call('POST', `/shots/${h.sbId}/edit-region`, { ...EDIT, t0_ms: '1000', t1_ms: 2500.4 });
      assert.equal(r.status, 200, '毫秒允许数字字符串 / 小数');
      assert.deepEqual(r.body.data.segment, { t0_ms: 1000, t1_ms: 2500, seconds: 2 });
      r = await call('POST', `/shots/${h.sbId}/edit-region`, { ...EDIT, t1_ms: 9000 });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'BAD_REQUEST');
      r = await call('POST', `/shots/999999/edit-region`, EDIT);
      assert.equal(r.status, 404);
      const s2 = h.graph().nodes[h.shots()[1]].legacy_id;
      r = await call('POST', `/shots/${s2}/edit-region`, EDIT);
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'REGION_EDIT_NO_VIDEO');
      assert.ok(r.body.error.action, '错误码表带建议操作');
      r = await call('POST', `/shots/${h.s1}/edit-region`, EDIT);
      assert.equal(r.status, 400, '节点 id 需要 episode_id');
      r = await call('POST', `/shots/${h.s1}/edit-region?episode_id=${h.ep}`, EDIT);
      assert.equal(r.status, 200);
      h.spend.setLimits({ monthly_cap: 0.01 });
      r = await call('POST', `/shots/${h.sbId}/edit-region`, { ...EDIT, confirm: true });
      assert.equal(r.status, 402);
      assert.equal(r.body.error.code, 'SPEND_LIMIT');
      r = await call('GET', `/shots/${h.sbId}/edit-regions`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data.items, []);
      assert.equal(r.body.data.versions.versions.length, 1);
      r = await call('POST', `/shots/${h.sbId}/adopt-version`, {});
      assert.equal(r.status, 400);
      r = await call('POST', `/shots/${h.sbId}/adopt-version`, { version_id: 'nope' });
      assert.equal(r.status, 404);
    } finally {
      server.close();
    }
  });

  it('confirm=true -> 列表 -> 完成 -> 采用', needFfmpeg, async () => {
    const h = await harness();
    const { server, call } = await serve(h);
    try {
      let r = await call('POST', `/shots/${h.sbId}/edit-region`, { ...EDIT, confirm: true });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.confirmed, true);
      assert.equal(r.body.data.outcome, 'created');
      const taskId = r.body.data.task.id;
      r = await call('GET', `/shots/${h.sbId}/edit-regions`);
      assert.equal(r.body.data.items.length, 1);
      assert.equal(r.body.data.items[0].status, 'queued');
      await h.drain();
      r = await call('GET', `/shots/${h.sbId}/edit-regions`);
      assert.equal(r.body.data.items[0].status, 'done');
      assert.equal(r.body.data.items[0].result_version_id, `t_${taskId}`);
      assert.equal(r.body.data.versions.versions.length, 2);
      r = await call('POST', `/shots/${h.sbId}/adopt-version`, { version_id: `t_${taskId}` });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.applied, true);
      assert.equal(h.graph().adopted[h.vnode], `t_${taskId}`);
    } finally {
      server.close();
    }
  });
});
