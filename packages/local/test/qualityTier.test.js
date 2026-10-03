'use strict';
// 草稿 / 成片质量档（四视图改造 Task 4，spec §10.2）。全部用假的服务商门面，不联网。
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const kernel = require('@talekiln/kernel');
const store = require('../src/kernel/store');
const { createAiTaskStore, createAiTaskQueue, createWorker, blobPath } = require('../src/queue');
const { createSpendService } = require('../src/spend');
const { createGenerationService } = require('../src/generation');
const dramaRoutes = require('../src/routes/drama');
const qualityRerunRoutes = require('../src/routes/qualityRerun');
const dramaService = require('../src/services/dramaService');
const enablement = require('../src/providers/enablement');
const backupHooks = require('../src/backup/hooks');
const Q = require('../src/generation/qualityProfiles');
const { seededDb, log } = require('./helpers/kernelDb');

const BAILIAN_CONFIGS = [{ provider: 'dashscope', api_key: 'sk-dummy-safestorage-TEST1234', is_active: true, service_type: 'text' }];
const ARK_CONFIGS = [{ provider: 'ark', api_key: 'sk-dummy-safestorage-TEST1234', is_active: true, service_type: 'text' }];

function fakeProvider(storageDir) {
  let n = 0;
  return {
    async submit(task) { return { vendorTaskId: `fake-${task.kind}-${++n}` }; },
    async poll(task) {
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
}

async function harness({ configs = BAILIAN_CONFIGS } = {}) {
  const { db, episodeId, dir } = await seededDb();
  const storageDir = path.join(dir, 'storage');
  require('../src/kernel/legacy').importLegacy(db, episodeId);
  const taskStore = createAiTaskStore(db);
  const provider = fakeProvider(storageDir);
  const queue = createAiTaskQueue({ store: taskStore, providers: { bailian: provider, ark: provider } });
  const spend = createSpendService(db);
  let gen = null;
  const worker = createWorker({ queue, store: taskStore, config: {}, onTaskFinished: (t) => { spend.recordFinished(t); if (gen) gen.onTaskFinished(t); }, onError() {} });
  gen = createGenerationService({ db, store: taskStore, worker: { wake() {} }, spend, storageRoot: storageDir, getCore: null, listConfigs: () => configs, catalogModels: () => [], log });
  const drain = async () => {
    for (let i = 0; i < 40 && worker.unfinishedCount() > 0; i++) { await worker.runOnce(); await gen.idle(); }
    await worker.runOnce();
    await gen.idle();
  };
  const graph = () => store.openProject(db, episodeId).graph;
  const shots = () => kernel.shotOrder(graph());
  const dramaId = db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(episodeId).drama_id;
  const setQuality = (q) => db.prepare('UPDATE dramas SET quality = ? WHERE id = ?').run(q, dramaId);
  const tasks = () => db.prepare('SELECT * FROM ai_tasks ORDER BY rowid').all().map((t) => ({ ...t, p: JSON.parse(t.params) }));
  const stale = () => [...kernel.staleSet(graph())].sort();
  const adopted = (node) => kernel.adoptedVersion(graph(), node);
  const node = (shotId, kind) => kernel.partsOfShot(graph(), shotId)[kind];
  return { db, ep: episodeId, dramaId, taskStore, spend, gen, drain, graph, shots, setQuality, tasks, stale, adopted, node, worker };
}

afterEach(() => { enablement.resetEnabled(); backupHooks.setBeforeDestructive(null); });

describe('qualityProfiles（纯函数）', () => {
  it('final 不改任何东西；draft 只放已核实的取值', () => {
    assert.equal(Q.profileFor('final', 'bailian', 'image'), null);
    assert.equal(Q.profileFor(undefined, 'bailian', 'image'), null, '缺省 = final');
    assert.equal(Q.profileFor('bogus', 'bailian', 'video', { hasFrame: true }), null, '非法值按 final');
    assert.deepEqual(Q.profileFor('draft', 'bailian', 'image'), { model: 'z-image-turbo' });
    assert.equal(Q.profileFor('draft', 'bailian', 'image', { hasRefs: true }), null, '带参考图没有更便宜的已验证模型');
    assert.deepEqual(Q.profileFor('draft', 'bailian', 'video', { hasFrame: true }), { model: 'wan2.2-kf2v-flash', resolution: '480P' });
    assert.equal(Q.profileFor('draft', 'bailian', 'video', { hasFrame: false }), null, '文生视频 480P 没验证过');
    assert.deepEqual(Q.profileFor('draft', 'ark', 'video', { hasFrame: true }), { resolution: '480p' });
    assert.equal(Q.profileFor('draft', 'ark', 'image'), null);
    assert.equal(Q.profileFor('draft', 'nobody', 'image'), null);
    assert.equal(Q.normalizeQuality('draft'), 'draft');
    assert.equal(Q.normalizeQuality(null), 'final');
    assert.ok(Q.isQuality('draft') && Q.isQuality('final') && !Q.isQuality('x'));
  });

  it('applyQuality：用户显式选的模型优先，只套分辨率；目录不允许的档位模型不用', () => {
    const base = { quality: 'draft', provider: 'bailian', kind: 'image', shape: {}, autoModel: 'wan2.6-t2i' };
    const a = Q.applyQuality({ ...base, model: 'wan2.6-t2i' });
    assert.deepEqual([a.model, a.applied], ['z-image-turbo', true]);
    const explicit = Q.applyQuality({ ...base, model: 'wan2.5-t2i-preview' });
    assert.deepEqual([explicit.model, explicit.applied], ['wan2.5-t2i-preview', false], '显式模型优先');
    const blocked = Q.applyQuality({ ...base, model: 'wan2.6-t2i', allowed: () => false });
    assert.deepEqual([blocked.model, blocked.applied], ['wan2.6-t2i', false]);
    const fin = Q.applyQuality({ ...base, quality: 'final', model: 'wan2.6-t2i' });
    assert.deepEqual([fin.model, fin.applied], ['wan2.6-t2i', false]);
    // kf2v 的默认就是 480P：请求与成片档完全一致，不算“降档”
    const kf = Q.applyQuality({ quality: 'draft', provider: 'bailian', kind: 'video', shape: { hasFrame: true }, model: 'wan2.2-kf2v-flash', autoModel: 'wan2.2-kf2v-flash' });
    assert.deepEqual([kf.model, kf.resolution, kf.applied], ['wan2.2-kf2v-flash', undefined, false]);
    // 显式选了别的视频模型：套最低分辨率
    const other = Q.applyQuality({ quality: 'draft', provider: 'bailian', kind: 'video', shape: { hasFrame: true }, model: 'wan2.6-i2v-flash', autoModel: 'wan2.2-kf2v-flash' });
    assert.deepEqual([other.model, other.resolution, other.applied], ['wan2.6-i2v-flash', '480P', true]);
    const ark = Q.applyQuality({ quality: 'draft', provider: 'ark', kind: 'video', shape: { hasFrame: false }, model: undefined, autoModel: undefined });
    assert.deepEqual([ark.model, ark.resolution, ark.applied], [undefined, '480p', true]);
  });
});

describe('质量档：生成服务', () => {
  it('默认 final：行为与现状一致（模型照旧，元数据记 final，迁移列默认 final）', async () => {
    const h = await harness();
    assert.equal(h.db.prepare('SELECT quality FROM dramas WHERE id = ?').get(h.dramaId).quality, 'final');
    assert.equal(h.gen.projectQuality(h.ep), 'final');
    const r = h.gen.create(h.ep, { shots: 'all', kind: 'both', regenerate: true }); // 示例项目的图本来就是新鲜的：重新生成才会建图片任务
    assert.equal(r.tasks.length, 5);
    const img = h.tasks().find((t) => t.kind === 'image');
    assert.equal(img.p.model, 'wan2.6-t2i');
    assert.equal(img.p.size, undefined);
    assert.equal(img.p._gen.quality, 'final');
    await h.drain();
    const v = h.adopted(h.node(h.shots()[0], 'image'));
    assert.equal(v.metadata.quality, 'final');
    assert.equal(v.metadata.model, 'wan2.6-t2i');
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
  });

  it('draft：图片任务用档位表里的模型；版本元数据记 draft；节点参数里的模型不变', async () => {
    const h = await harness();
    h.setQuality('draft');
    const [s1] = h.shots();
    h.gen.create(h.ep, { shots: 'all', kind: 'image', regenerate: true });
    const imgs = h.tasks().filter((t) => t.kind === 'image');
    assert.equal(imgs.length, 5);
    assert.ok(imgs.every((t) => t.p.model === 'z-image-turbo' && t.p._gen.quality === 'draft'));
    await h.drain();
    for (const s of h.shots()) {
      const v = h.adopted(h.node(s, 'image'));
      assert.equal(v.metadata.quality, 'draft');
      assert.equal(v.metadata.model, 'z-image-turbo');
    }
    assert.equal(h.graph().nodes[h.node(s1, 'image')].params.model, 'wan2.6-t2i', '节点参数里仍是成片档的自动选择：质量档不写进节点参数');
    assert.ok(h.gen.status(h.ep).shots.every((x) => x.image.state === 'fresh'));
  });

  it('draft：有首帧的视频沿用 kf2v（它本来就是 480P，无可再省），文生视频没有已验证的更便宜选项；元数据如实记 final', async () => {
    const h = await harness();
    h.setQuality('draft');
    const [s1, s2] = h.shots();
    h.gen.create(h.ep, { shots: [s1], kind: 'both' });
    await h.drain();
    const vid = h.tasks().find((t) => t.kind === 'video');
    assert.equal(vid.p.model, 'wan2.2-kf2v-flash');
    assert.ok(vid.p.firstFrameUrl);
    assert.equal(vid.p.resolution, undefined, '默认已是 480P，不额外带参数');
    assert.equal(h.adopted(h.node(s1, 'video')).metadata.quality, 'final');
    // 第 2 镜没有首帧：文生视频
    store.commit(h.db, h.ep, { tx_id: 'drop-frame', label: 'drop', ops: [{ op: 'adoptVersion', node: h.node(s2, 'image'), version_id: null }] });
    h.gen.create(h.ep, { shots: [s2], kind: 'video' });
    const t2 = h.tasks().filter((t) => t.kind === 'video').find((t) => t.p._gen.shot_id === s2);
    assert.equal(t2.p.model, 'wan2.6-t2v');
    assert.equal(t2.p.resolution, undefined);
    assert.equal(t2.p._gen.quality, 'final');
  });

  it('draft：带锁定参考图的出图没有已验证的更便宜模型，照成片档走，产物记 final（不会出现在 draft-nodes）', async () => {
    const h = await harness();
    h.setQuality('draft');
    const [s1] = h.shots();
    const cid = h.db.prepare('SELECT id FROM characters LIMIT 1').get().id;
    h.db.prepare('INSERT INTO reference_locks (entity_type, entity_id, local_path, locked_at) VALUES (?, ?, ?, ?)').run('character', cid, 'media/char-ref.png', 'now');
    store.commit(h.db, h.ep, (g) => kernel.intents.shot.setShotField(g, s1, { image_prompt: '带参考图的画面', characters: [cid] }, { tx_id: 'e-ref' }), { tx_id: 'e-ref' });
    h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    const t = h.tasks().find((x) => x.kind === 'image');
    assert.deepEqual(t.p.referenceImages, ['/static/media/char-ref.png']);
    assert.equal(t.p.model, 'wan2.6-image');
    assert.equal(t.p._gen.quality, 'final');
    await h.drain();
    assert.equal(h.adopted(h.node(s1, 'image')).metadata.quality, 'final');
    assert.equal(h.gen.draftNodes(h.ep).count, 0);
  });

  it('方舟：draft 视频带 --rs 480p 分辨率（适配器已支持、价目表里最低档），模型不换；final 不带', async () => {
    enablement.configureEnabled(['ark']);
    const h = await harness({ configs: ARK_CONFIGS });
    const spec = (kind) => h.gen.estimate(h.ep, { shots: 'all', kind }).billable[0].spec;
    assert.equal(spec('video').provider, 'ark');
    assert.equal(spec('video').params.resolution, undefined);
    h.setQuality('draft');
    assert.equal(spec('video').params.resolution, '480p');
    assert.equal(h.gen.estimate(h.ep, { shots: 'all', kind: 'video' }).billable[0].quality, 'draft');
    const imgEst = h.gen.estimate(h.ep, { shots: 'all', kind: 'image', regenerate: true }).billable[0];
    assert.equal(imgEst.spec.params.size, undefined, '方舟图片没有已验证的更便宜档位');
    assert.equal(imgEst.quality, 'final');
  });

  it('切换档位不让任何产物过期：cacheKey、过期集合、状态都不变，再点生成不建任务', async () => {
    const h = await harness();
    h.setQuality('draft');
    h.gen.create(h.ep, { shots: 'all', kind: 'image', regenerate: true });
    await h.drain();
    const keys = JSON.stringify(kernel.cacheKeys(h.graph()));
    const seq = store.openProject(h.db, h.ep).seq;
    const stale = h.stale();
    const counts = JSON.stringify(h.gen.status(h.ep).counts);
    h.setQuality('final');
    assert.equal(JSON.stringify(kernel.cacheKeys(h.graph())), keys);
    assert.deepEqual(h.stale(), stale);
    assert.equal(JSON.stringify(h.gen.status(h.ep).counts), counts);
    const again = h.gen.create(h.ep, { shots: 'all', kind: 'image' });
    assert.equal(again.tasks.length, 0, '草稿图在 final 下仍是新鲜的，不会被自动重做（要靠“按成片质量重跑”）');
    assert.equal(store.openProject(h.db, h.ep).seq, seq, '切档位 + 再点生成不写内核');
    h.setQuality('draft');
    assert.equal(JSON.stringify(kernel.cacheKeys(h.graph())), keys);
    assert.deepEqual(h.stale(), stale);
  });

  it('draft-nodes 只含采用版本是草稿且仍新鲜的节点；带参考图的图（没降档）与过期的图不算', async () => {
    const h = await harness();
    h.setQuality('draft');
    h.gen.create(h.ep, { shots: 'all', kind: 'both', regenerate: true });
    await h.drain();
    let d = h.gen.draftNodes(h.ep);
    assert.equal(d.count, 5);
    assert.ok(d.nodes.every((n) => n.kind === 'image' && h.graph().nodes[n.node].type === 'image' && h.graph().nodes[n.shot].type === 'shot'));
    assert.deepEqual(d.nodes.map((n) => n.shot), h.shots());
    // 改一个镜头的提示词：它的草稿图过期，不再算“草稿产物”（过期的要走普通生成）
    const s3 = h.shots()[2];
    store.commit(h.db, h.ep, (g) => kernel.intents.shot.setShotField(g, s3, { image_prompt: '改过的提示词' }, { tx_id: 'e1' }), { tx_id: 'e1' });
    d = h.gen.draftNodes(h.ep);
    assert.equal(d.count, 4);
    assert.ok(!d.nodes.some((n) => n.shot === s3));
  });

  it('估价 = 重跑实际入队任务的价格合计；重跑只命中草稿节点，结果是成片版本，过期集合不变', async () => {
    const h = await harness();
    h.setQuality('draft');
    h.gen.create(h.ep, { shots: 'all', kind: 'both', regenerate: true });
    await h.drain();
    h.setQuality('final');
    const staleBefore = h.stale();
    const keysBefore = JSON.stringify(kernel.cacheKeys(h.graph()));
    const taskCountBefore = h.tasks().length;
    const imageVersionCounts = h.shots().map((s) => h.graph().versions[h.node(s, 'image')].length);
    const videoVersions = h.shots().map((s) => h.graph().versions[h.node(s, 'video')].map((v) => v.id));
    const d = h.gen.draftNodes(h.ep);
    assert.equal(d.count, 5);
    assert.equal(d.estimate.currency, 'CNY');
    assert.ok(d.estimate.amount > 0);

    const r = h.gen.rerunDrafts(h.ep);
    assert.equal(r.tasks.length, d.count, '入队数 = 预告数');
    assert.ok(r.tasks.every((t) => t.outcome === 'created' && t.kind === 'image'));
    const queued = h.tasks().slice(taskCountBefore);
    assert.equal(queued.length, 5);
    assert.ok(queued.every((t) => t.p.model === 'wan2.6-t2i' && t.p._gen.quality === 'final' && t.p._gen.rerun_of));
    const total = h.spend.checkBatch(queued.map((t) => ({ provider: t.provider, kind: t.kind, params: t.p }))).total;
    assert.equal(total, d.estimate.amount, '估价与入队任务的预估合计相等');

    await h.drain();
    for (const [i, s] of h.shots().entries()) {
      const versions = h.graph().versions[h.node(s, 'image')];
      assert.equal(versions.length, imageVersionCounts[i] + 1, '草稿版本保留，成片版本新增');
      assert.ok(versions.some((v) => v.metadata && v.metadata.quality === 'draft'));
      const cur = h.adopted(h.node(s, 'image'));
      assert.equal(cur.metadata.quality, 'final');
      assert.equal(cur.metadata.model, 'wan2.6-t2i');
      assert.equal(cur.cache_key, kernel.cacheKeys(h.graph())[h.node(s, 'image')]);
    }
    assert.deepEqual(h.stale(), staleBefore, '重跑不改变过期集合');
    assert.equal(JSON.stringify(kernel.cacheKeys(h.graph())), keysBefore, '重跑不改 cacheKey');
    assert.deepEqual(h.shots().map((s) => h.graph().versions[h.node(s, 'video')].map((v) => v.id)), videoVersions, '视频节点不重跑');
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
    assert.equal(h.gen.draftNodes(h.ep).count, 0);
    assert.equal(h.gen.rerunDrafts(h.ep).tasks.length, 0, '没有草稿产物时重跑什么都不建');
    assert.equal(h.tasks().length, taskCountBefore + 5);
  });

  it('首帧和视频都要重跑时：首帧成片落地后视频接着按同一 cacheKey 重出（force 沿用到链上）', async () => {
    const h = await harness();
    h.gen.create(h.ep, { shots: 'all', kind: 'both' });
    await h.drain();
    const [s1] = h.shots();
    const img = h.node(s1, 'image');
    const vid = h.node(s1, 'video');
    const staleBefore = h.stale();
    const before = h.tasks().length;
    const nVer = (n) => h.graph().versions[n].length;
    const [imgVer, vidVer] = [nVer(img), nVer(vid)];
    const est = h.gen.estimate(h.ep, { shots: [s1], kind: 'both', force: [img, vid], only: true, quality: 'final' });
    assert.deepEqual(est.items.map((i) => i.action), ['create', 'chain']);
    const r = h.gen.create(h.ep, { shots: [s1], kind: 'both', force: [img, vid], only: true, quality: 'final' });
    assert.equal(r.tasks.length, 1);
    await h.drain();
    const now = h.tasks().slice(before);
    assert.deepEqual(now.map((t) => t.kind), ['image', 'video'], '首帧后接着出视频');
    assert.equal(nVer(img), imgVer + 1);
    assert.equal(nVer(vid), vidVer + 1);
    assert.deepEqual(h.stale(), staleBefore);
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
  });
});

describe('质量档：REST', () => {
  async function serve(h) {
    const app = express();
    app.use(express.json());
    const dr = dramaRoutes(h.db, {}, log);
    const qr = qualityRerunRoutes(h.gen, log);
    app.put('/dramas/:id/quality', dr.setQuality);
    app.get('/dramas/:id', dr.getDrama);
    app.get('/episodes/:id/quality/draft-nodes', qr.draftNodes);
    app.post('/episodes/:id/quality/rerun', qr.rerun);
    const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const call = async (method, url, body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    return { server, call };
  }

  it('PUT /dramas/:id/quality：设置并回读（GET 带回 quality）；非法值 400；不存在 404', async () => {
    const h = await harness();
    const { server, call } = await serve(h);
    try {
      let r = await call('GET', `/dramas/${h.dramaId}`);
      assert.equal(r.body.data.quality, 'final');
      r = await call('PUT', `/dramas/${h.dramaId}/quality`, { quality: 'draft' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data, { quality: 'draft' });
      assert.equal(dramaService.getDrama(h.db, h.dramaId).quality, 'draft');
      assert.equal((await call('GET', `/dramas/${h.dramaId}`)).body.data.quality, 'draft');
      r = await call('PUT', `/dramas/${h.dramaId}/quality`, { quality: 'ultra' });
      assert.equal(r.status, 400);
      assert.equal((await call('PUT', `/dramas/${h.dramaId}/quality`, {})).status, 400);
      assert.equal((await call('PUT', `/dramas/${h.dramaId}/quality`, { quality: 'final' })).body.data.quality, 'final');
      assert.equal((await call('PUT', '/dramas/999999/quality', { quality: 'draft' })).status, 404);
    } finally {
      server.close();
    }
  });

  it('draft-nodes / rerun：先备份钩子再入队；估价一致；没有草稿时不调钩子；额度不够整批 402 且不建任务', async () => {
    const h = await harness();
    const { server, call } = await serve(h);
    const hookCalls = [];
    backupHooks.setBeforeDestructive(async (ep, reason) => { hookCalls.push([ep, reason, h.tasks().length]); });
    try {
      let r = await call('GET', `/episodes/${h.ep}/quality/draft-nodes`);
      assert.deepEqual([r.status, r.body.data.count, r.body.data.nodes], [200, 0, []]);
      r = await call('POST', `/episodes/${h.ep}/quality/rerun`, {});
      assert.deepEqual([r.body.data.count, r.body.data.tasks], [0, []]);
      assert.equal(hookCalls.length, 0, '没有要重跑的就不做快照');

      h.setQuality('draft');
      h.gen.create(h.ep, { shots: 'all', kind: 'image', regenerate: true });
      await h.drain();
      h.setQuality('final');
      r = await call('GET', `/episodes/${h.ep}/quality/draft-nodes`);
      assert.equal(r.body.data.count, 5);
      assert.ok(r.body.data.nodes.every((n) => n.node && n.kind === 'image' && n.shot));
      const { amount, currency } = r.body.data.estimate;
      assert.ok(amount > 0 && currency === 'CNY');

      const taskCount = h.tasks().length;
      h.spend.setLimits({ monthly_cap: 0.01 });
      r = await call('POST', `/episodes/${h.ep}/quality/rerun`, {});
      assert.equal(r.status, 402);
      assert.equal(r.body.error.code, 'SPEND_LIMIT');
      assert.equal(h.tasks().length, taskCount, '额度不够：一个任务都不建');
      assert.equal(h.gen.draftNodes(h.ep).count, 5);
      assert.equal(hookCalls.length, 0, '额度不够不做快照');

      h.spend.setLimits({ monthly_cap: 100 });
      r = await call('POST', `/episodes/${h.ep}/quality/rerun`, {});
      assert.equal(r.status, 200);
      assert.equal(r.body.data.tasks.length, 5);
      assert.equal(r.body.data.estimate.amount, amount);
      assert.equal(hookCalls.length, 1);
      assert.deepEqual(hookCalls[0].slice(0, 2), [h.ep, 'quality-rerun']);
      assert.equal(hookCalls[0][2], taskCount, '钩子在入队之前调用');
      await h.drain();
      assert.equal((await call('GET', `/episodes/${h.ep}/quality/draft-nodes`)).body.data.count, 0);
      assert.equal((await call('GET', '/episodes/abc/quality/draft-nodes')).status, 400);
      assert.equal((await call('GET', '/episodes/999999/quality/draft-nodes')).status, 404);
    } finally {
      server.close();
    }
  });
});
