'use strict';
// P3-C 角色一致性：生成完成后对锁定参考图评分、报告、重评、自动挑参考图。评分器与服务商都是假的（不启动 lycore，不联网）。
const { describe, it } = require('node:test');
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
const { createConsistencyService, createCoreScorer, ConsistencyError, settingsFrom, suggestionFor, resolveLocal, relOf } = require('../src/consistency');
const consistencyRoutes = require('../src/routes/consistency');
const { seededDb, log } = require('./helpers/kernelDb');
const referenceLocks = require('../src/services/referenceLockService');
const kernelInputs = require('../src/kernel/inputs');

const FAKE_CONFIGS = [{ provider: 'dashscope', api_key: 'fake-key-not-real', is_active: true, service_type: 'text' }];

/** 假的队列服务商：image 同步完成、video 轮询一次成功；download 写入内容寻址目录（结果就在本机存储目录里）。 */
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

/** 假评分器：按参考图文件名给分（缺省 85）；排序按候选文件名给分（缺省 50）。 */
function fakeScorer({ scores = {}, pick = {}, available = true } = {}) {
  const calls = [];
  const s = {
    calls, scores, pick, available: async () => available,
    async score({ reference, target, min_score = 60, sample_frames }) {
      calls.push({ method: 'score', reference, target, sample_frames });
      const name = path.basename(reference);
      const score = name in s.scores ? s.scores[name] : 85;
      return { score, parts: { phash: score, histogram: score, palette: score }, suggestion: suggestionFor(score, min_score), kind: 'image', frames: [] };
    },
    async pickReference({ candidates, anchor = null }) {
      calls.push({ method: 'pick', candidates, anchor });
      const ranked = candidates
        .map((p) => ({ path: p, score: s.pick[path.basename(p)] ?? 50, sharpness: 1, width: 512, height: 512, similarity: anchor ? 80 : null }))
        .sort((a, b) => b.score - a.score);
      return { anchor, ranked, skipped: [] };
    },
  };
  return s;
}

async function harness({ scorer = fakeScorer(), config = null } = {}) {
  const { db, episodeId: ep, dir } = await seededDb();
  const storageDir = path.join(dir, 'storage');
  require('../src/kernel/legacy').importLegacy(db, ep);
  const taskStore = createAiTaskStore(db);
  const provider = fakeProvider(storageDir);
  const queue = createAiTaskQueue({ store: taskStore, providers: { bailian: provider } });
  const spend = createSpendService(db);
  let gen = null;
  const worker = createWorker({ queue, store: taskStore, config: {}, onTaskFinished: (t) => { spend.recordFinished(t); if (gen) gen.onTaskFinished(t); }, onError() {} });
  const consistency = createConsistencyService({ db, storageRoot: storageDir, config, scorer, generation: () => gen, log });
  gen = createGenerationService({
    db, store: taskStore, worker: { wake() {} }, spend, storageRoot: storageDir, getCore: null, listConfigs: () => FAKE_CONFIGS, catalogModels: () => [], log,
    onAdopted: (info) => consistency.onAdopted(info),
  });
  const drain = async () => {
    for (let i = 0; i < 30 && worker.unfinishedCount() > 0; i++) { await worker.runOnce(); await gen.idle(); }
    await worker.runOnce();
    await gen.idle();
  };
  const graph = () => store.openProject(db, ep).graph;
  const shots = () => kernel.shotOrder(graph());
  const file = (rel) => { const abs = path.join(storageDir, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, `png:${rel}`); return abs; };
  const edit = (shotId, patch, id) => store.commit(db, ep, (g) => kernel.intents.shot.setShotField(g, shotId, patch, { tx_id: id }), { tx_id: id });
  const rows = (nodeId) => (nodeId
    ? db.prepare('SELECT * FROM consistency_scores WHERE episode_id = ? AND node_id = ? ORDER BY id').all(ep, nodeId)
    : db.prepare('SELECT * FROM consistency_scores WHERE episode_id = ? ORDER BY id').all(ep));
  const cid = db.prepare('SELECT id FROM characters ORDER BY id LIMIT 1').get().id;
  /** 第 1 镜：锁定场景 77 与第一个角色的参考图（文件都在本机存储目录里）。 */
  const lockFirstShot = () => {
    const [s1] = shots();
    file('media/scene-77.png');
    file('media/char-ref.png');
    db.prepare('UPDATE storyboards SET scene_id = 77 WHERE id = ?').run(graph().nodes[s1].legacy_id);
    referenceLocks.setLock(db, 'scene', 77, { local_path: 'media/scene-77.png' });
    referenceLocks.setLock(db, 'character', cid, { local_path: 'media/char-ref.png' });
    edit(s1, { characters: [cid] }, 'lock-chars');
    kernelInputs.syncReferences(db);
    return s1;
  };
  return { db, ep, dir, storageDir, taskStore, worker, gen, provider, scorer, consistency, drain, graph, shots, file, edit, rows, cid, lockFirstShot };
}

describe('纯函数', () => {
  it('配置读取：非法值回退默认；建议阈值', () => {
    assert.deepEqual(settingsFrom(null), { enabled: true, min_score: 60, sample_frames: 5 });
    assert.deepEqual(settingsFrom({ consistency: { enabled: false, min_score: 75, sample_frames: 3 } }), { enabled: false, min_score: 75, sample_frames: 3 });
    assert.deepEqual(settingsFrom({ consistency: { min_score: 'abc', sample_frames: 99 } }), { enabled: true, min_score: 60, sample_frames: 5 });
    assert.deepEqual(settingsFrom({ consistency: { min_score: 101, sample_frames: 0 } }), { enabled: true, min_score: 60, sample_frames: 5 });
    assert.equal(suggestionFor(60, 60), 'ok');
    assert.equal(suggestionFor(59.9, 60), 'check');
    assert.equal(suggestionFor(40, 60), 'check');
    assert.equal(suggestionFor(39.9, 60), 'retry');
  });

  it('只有本机存储目录里的文件能评分：远程 / 目录外 / 不存在都是 null', () => {
    const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cons-'));
    fs.mkdirSync(path.join(root, 'media'));
    fs.writeFileSync(path.join(root, 'media', 'a.png'), 'x');
    assert.equal(resolveLocal(root, '/static/media/a.png'), path.join(root, 'media', 'a.png'));
    assert.equal(resolveLocal(root, 'media/a.png'), path.join(root, 'media', 'a.png'));
    assert.equal(resolveLocal(root, '/static/media/missing.png'), null);
    assert.equal(resolveLocal(root, '/static/../etc/passwd'), null);
    assert.equal(resolveLocal(root, 'https://example.invalid/a.png'), null);
    assert.equal(resolveLocal(root, 'data:image/png;base64,AAAA'), null);
    assert.equal(resolveLocal(root, ''), null);
    assert.equal(relOf('/static/media/a.png'), 'media/a.png');
    assert.equal(relOf('oss://bucket/a.png'), null);
  });

  it('默认评分器：没有内核 -> 不可用，调用给 CONSISTENCY_UNAVAILABLE（503）；连不上后一段时间内不再重试；内核数字错误码原样带回', async () => {
    const none = createCoreScorer(null);
    assert.equal(await none.available(), false);
    await assert.rejects(none.score({}), (e) => e instanceof ConsistencyError && e.code === 'CONSISTENCY_UNAVAILABLE' && e.status === 503);

    let attempts = 0;
    let t = 1000;
    const flaky = createCoreScorer(async () => { attempts++; throw new Error('connect refused'); }, { retryAfterMs: 30000, now: () => t });
    assert.equal(await flaky.available(), false);
    assert.equal(await flaky.available(), false);
    assert.equal(attempts, 1, '30 秒内不再重连');
    t += 30001;
    assert.equal(await flaky.available(), false);
    assert.equal(attempts, 2);

    const core = { call: async (method, params) => { if (method === 'consistency.score') { const e = new Error('ffmpeg 未找到'); e.code = -32020; e.data = { action: 'reinstall' }; throw e; } return { ranked: [], skipped: [], params }; } };
    const ok = createCoreScorer(async () => core);
    assert.equal(await ok.available(), true);
    await assert.rejects(ok.score({ reference: 'a', target: 'b' }), (e) => e instanceof ConsistencyError && e.code === '-32020' && e.status === 502 && e.details.action === 'reinstall');
    assert.deepEqual((await ok.pickReference({ candidates: ['x'] })).params, { candidates: ['x'] });
  });
});

describe('生成完成后评分', () => {
  it('对镜头的每张锁定参考图各评一次并存行；报告给出最好 / 最差 / 实体 / 建议 / 重做估价', async () => {
    const h = await harness({ scorer: fakeScorer({ scores: { 'scene-77.png': 90, 'char-ref.png': 35 } }) });
    const s1 = h.lockFirstShot();
    assert.equal(h.gen.status(h.ep).shots[0].image.state, 'stale', '锁定参考图后首帧图过期');
    const r = h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    assert.equal(r.tasks.length, 1);
    await h.drain();
    const g = h.graph();
    const imgNode = kernel.partsOfShot(g, s1).image;
    const v = kernel.adoptedVersion(g, imgNode);
    const rows = h.rows(imgNode);
    assert.deepEqual(rows.map((x) => [x.entity_type, x.entity_id, x.score, x.suggestion, x.version_id]), [['scene', 77, 90, 'ok', v.id], ['character', h.cid, 35, 'retry', v.id]]);
    assert.deepEqual(JSON.parse(rows[0].parts), { phash: 90, histogram: 90, palette: 90 });
    assert.equal(h.scorer.calls.length, 2);
    assert.ok(h.scorer.calls.every((c) => c.target.startsWith(h.storageDir) && c.reference.startsWith(h.storageDir) && c.sample_frames === 5), '只传本机绝对路径');
    assert.equal(h.rows().length, 2, '其它镜头没有锁定参考图，不评分');

    const rep = await h.consistency.episodeReport(h.ep);
    assert.equal(rep.available, true);
    assert.equal(rep.min_score, 60);
    assert.equal(rep.shots.length, 5);
    const shot = rep.shots[0];
    assert.equal(shot.shot_id, s1);
    assert.equal(shot.storyboard_id, g.nodes[s1].legacy_id);
    assert.equal(shot.number, 1);
    assert.equal(shot.scored, true);
    assert.equal(shot.best, 90);
    assert.equal(shot.worst, 35);
    assert.equal(shot.suggestion, 'retry');
    assert.deepEqual(shot.entity, { type: 'character', id: h.cid, name: h.db.prepare('SELECT name FROM characters WHERE id = ?').get(h.cid).name });
    assert.equal(shot.image.scored, true);
    assert.equal(shot.image.scores.length, 2);
    assert.equal(shot.image.scores[0].entity_name, '场景 77', '场景不在库里时用编号');
    assert.equal(shot.video, null, '视频还没有采用的版本');
    assert.equal(shot.regenerate.kind, 'both', '首帧图差 -> 图和视频一起重做');
    assert.ok(shot.regenerate.estimate > 0 && shot.regenerate.max >= shot.regenerate.estimate);
    assert.equal(shot.regenerate.currency, 'CNY');
    assert.equal(shot.regenerate.allowed, true);
    assert.ok(rep.shots.slice(1).every((s) => s.scored === false && s.suggestion === null && s.regenerate === null));
    assert.deepEqual(rep.counts, { ok: 0, check: 0, retry: 1, unscored: 4 });
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM ai_tasks').get().n, 1, '估价只算不建任务');

    // 接着出视频：视频版本也评分；分数高的话建议只看最差的那个节点
    h.scorer.scores['char-ref.png'] = 70;
    h.gen.create(h.ep, { shots: [s1], kind: 'video' });
    await h.drain();
    const rep2 = await h.consistency.episodeReport(h.ep);
    const vnode = kernel.partsOfShot(h.graph(), s1).video;
    assert.equal(h.rows(vnode).length, 2);
    assert.equal(rep2.shots[0].video.scored, true);
    assert.equal(rep2.shots[0].video.worst, 70);
    assert.equal(rep2.shots[0].video.suggestion, 'ok');
    assert.equal(rep2.shots[0].worst, 35, '首帧图那次的低分还在');
    assert.equal(rep2.shots[0].suggestion, 'retry');
  });

  it('只有视频差 -> 估价只重做视频；全部合格 -> 不估价', async () => {
    const h = await harness({ scorer: fakeScorer({ scores: { 'scene-77.png': 95, 'char-ref.png': 50 } }) });
    const s1 = h.lockFirstShot();
    // 首帧图用导入的旧版本（没经过生成钩子，所以没有行），只有视频这次评了分
    h.gen.create(h.ep, { shots: [s1], kind: 'video' });
    await h.drain();
    const g = h.graph();
    const parts = kernel.partsOfShot(g, s1);
    assert.equal(h.rows(parts.image).length, 0, '首帧图这次没生成，不评');
    const rep = await h.consistency.episodeReport(h.ep);
    assert.equal(rep.shots[0].image.scored, false);
    assert.equal(rep.shots[0].video.suggestion, 'check');
    assert.equal(rep.shots[0].regenerate.kind, 'video');
    assert.deepEqual(rep.counts, { ok: 0, check: 1, retry: 0, unscored: 4 });
    h.scorer.scores['char-ref.png'] = 88;
    const again = await h.consistency.rescoreShot({ id: String(g.nodes[s1].legacy_id) });
    assert.equal(again.suggestion, 'ok');
    assert.equal(again.regenerate, null);
    assert.deepEqual(again.rescored, { image: 2, video: 2 }, '重评连导入的首帧图（本机文件）一起评');
    assert.deepEqual(again.reasons, { image: null, video: null });
    assert.equal(again.image.scored, true);
  });

  it('重评覆盖旧行（不重复）；镜头 id 可用旧表 id 或节点 id；未知镜头 404', async () => {
    const h = await harness({ scorer: fakeScorer({ scores: { 'char-ref.png': 30 } }) });
    const s1 = h.lockFirstShot();
    h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    await h.drain();
    const imgNode = kernel.partsOfShot(h.graph(), s1).image;
    assert.equal(h.rows(imgNode).length, 2);
    const before = h.rows(imgNode).find((r) => r.entity_type === 'character');
    h.scorer.scores['char-ref.png'] = 72;
    const r = await h.consistency.rescoreShot({ id: h.graph().nodes[s1].legacy_id });
    assert.equal(h.rows(imgNode).length, 2, '版本 × 实体唯一，重评覆盖');
    const after = h.rows(imgNode).find((r2) => r2.entity_type === 'character');
    assert.equal(after.id, before.id);
    assert.equal(after.score, 72);
    assert.equal(after.suggestion, 'ok');
    assert.equal(r.shot_id, s1);
    assert.equal(r.worst, 72);
    assert.equal(r.rescored.image, 2);
    const byNode = await h.consistency.rescoreShot({ id: s1, episode_id: h.ep });
    assert.equal(byNode.shot_id, s1);
    await assert.rejects(h.consistency.rescoreShot({ id: s1 }), (e) => e.code === 'BAD_REQUEST', '节点 id 需要 episode_id');
    await assert.rejects(h.consistency.rescoreShot({ id: 999999 }), (e) => e instanceof ConsistencyError && e.status === 404);
    await assert.rejects(h.consistency.rescoreShot({ id: 'shot_nope', episode_id: h.ep }), (e) => e.status === 404);
    await assert.rejects(h.consistency.episodeReport(999999), (e) => e.status === 404);
  });

  it('没有评分器 / 内核不可用：生成照常写回、不存行；报告 available=false；重评 503', async () => {
    const h = await harness({ scorer: fakeScorer({ available: false }) });
    const s1 = h.lockFirstShot();
    h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    await h.drain();
    assert.equal(h.gen.status(h.ep).shots[0].image.state, 'fresh', '写回不受影响');
    assert.equal(h.rows().length, 0);
    assert.equal(h.scorer.calls.length, 0);
    const rep = await h.consistency.episodeReport(h.ep);
    assert.equal(rep.available, false);
    assert.equal(rep.shots[0].scored, false);
    await assert.rejects(h.consistency.rescoreShot({ id: h.graph().nodes[s1].legacy_id }), (e) => e.code === 'CONSISTENCY_UNAVAILABLE' && e.status === 503);
  });

  it('配置 enabled=false：钩子不评分，但手动重评仍可用', async () => {
    const h = await harness({ config: { consistency: { enabled: false, min_score: 80, sample_frames: 2 } } });
    const s1 = h.lockFirstShot();
    h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    await h.drain();
    assert.equal(h.rows().length, 0);
    const rep = await h.consistency.episodeReport(h.ep);
    assert.equal(rep.enabled, false);
    assert.equal(rep.min_score, 80);
    const r = await h.consistency.rescoreShot({ id: h.graph().nodes[s1].legacy_id });
    assert.equal(r.rescored.image, 2);
    assert.equal(r.suggestion, 'ok', '85 ≥ 80');
    assert.ok(h.scorer.calls.every((c) => c.sample_frames === 2));
  });

  it('评分器抛错只记日志，不影响写回；远程参考图跳过、远程目标不评', async () => {
    const h = await harness({ scorer: { available: async () => true, score: async () => { throw new Error('boom'); }, pickReference: async () => ({ ranked: [], skipped: [] }) } });
    const s1 = h.lockFirstShot();
    h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    await h.drain();
    assert.equal(h.gen.status(h.ep).shots[0].image.state, 'fresh');
    assert.equal(h.rows().length, 0);

    // 远程参考图：跳过并说明原因；本机的照评
    const h2 = await harness();
    const s = h2.lockFirstShot();
    referenceLocks.setLock(h2.db, 'scene', 77, { image_url: 'https://example.invalid/scene.png' });
    const imgNode = kernel.partsOfShot(h2.graph(), s).image;
    const v = kernel.adoptedVersion(h2.graph(), imgNode);
    const r = await h2.consistency.scoreVersion({ episode_id: h2.ep, node: imgNode, version_id: v.id });
    assert.equal(r.scored, 1);
    assert.deepEqual(r.rows.map((x) => [x.entity_type, x.skipped || null]), [['scene', 'reference_not_local'], ['character', null]]);
    // 远程目标（版本资产不在本机）：不评
    store.commit(h2.db, h2.ep, (g) => ({ tx_id: 'remote-v', label: 'remote', ops: [{ op: 'addVersion', node: imgNode, version: { id: 'v_remote', cache_key: kernel.cacheKeys(g)[imgNode], asset: { ref: 'https://example.invalid/out.png', kind: 'image', hash: 'h' }, metadata: {}, source: 'test' } }] }), { tx_id: 'remote-v' });
    const r2 = await h2.consistency.scoreVersion({ episode_id: h2.ep, node: imgNode, version_id: 'v_remote' });
    assert.deepEqual(r2, { scored: 0, rows: [], reason: 'target_not_local' });
    assert.equal((await h2.consistency.scoreVersion({ episode_id: h2.ep, node: imgNode, version_id: 'nope' })).reason, 'no_version');
    assert.equal((await h2.consistency.scoreVersion({ episode_id: h2.ep, node: 'nope', version_id: v.id })).reason, 'no_node');
    assert.equal((await h2.consistency.scoreVersion({ episode_id: 999999, node: imgNode, version_id: v.id })).reason, 'no_graph');
    const other = h2.shots()[1];
    const otherImg = kernel.partsOfShot(h2.graph(), other).image;
    assert.equal((await h2.consistency.scoreVersion({ episode_id: h2.ep, node: otherImg, version_id: kernel.adoptedVersion(h2.graph(), otherImg).id })).reason, 'no_locked_references');
  });
});

describe('自动挑选参考图', () => {
  /** 给角色准备候选：主图、额外图、一张已完成的生成图、一张远程图；四视图作锚图。 */
  function prepare(h, { withAnchor = true } = {}) {
    h.file('characters/main.png');
    h.file('characters/extra.png');
    h.file('characters/gen.png');
    if (withAnchor) h.file('characters/four.png');
    h.db.prepare('UPDATE characters SET local_path = ?, image_url = ?, extra_images = ?, four_view_image_url = ? WHERE id = ?')
      .run('characters/main.png', '/static/characters/main.png', JSON.stringify(['characters/extra.png', 'https://remote.invalid/x.png']), withAnchor ? '/static/characters/four.png' : null, h.cid);
    h.db.prepare("INSERT INTO image_generations (character_id, status, local_path, image_url, created_at) VALUES (?, 'completed', ?, ?, ?)").run(h.cid, 'characters/gen.png', '/static/characters/gen.png', '2026-01-01T00:00:00Z');
    h.db.prepare("INSERT INTO image_generations (character_id, status, local_path, created_at) VALUES (?, 'failed', ?, ?)").run(h.cid, 'characters/failed.png', '2026-01-01T00:00:00Z');
    h.db.prepare("INSERT INTO image_generations (character_id, status, local_path, created_at) VALUES (?, 'completed', ?, ?)").run(h.cid, 'characters/four.png', '2026-01-02T00:00:00Z'); // 与锚图同一文件 -> 排除
  }

  it('候选 = 主图 / 额外图 / 已完成的生成图（去重、排除锚图、远程跳过），按内核排序返回；不锁定时不改锁', async () => {
    const h = await harness({ scorer: fakeScorer({ pick: { 'main.png': 70, 'extra.png': 60, 'gen.png': 92 } }) });
    prepare(h);
    const r = await h.consistency.autoPickCharacter(h.cid);
    const call = h.scorer.calls.find((c) => c.method === 'pick');
    assert.equal(call.anchor, path.join(h.storageDir, 'characters', 'four.png'));
    assert.deepEqual(call.candidates.map((p) => path.basename(p)).sort(), ['extra.png', 'gen.png', 'main.png']);
    assert.deepEqual(r.anchor, { local_path: 'characters/four.png' });
    assert.deepEqual(r.ranked.map((x) => [x.local_path, x.source, x.score, x.source_image_id, x.similarity]), [
      ['characters/gen.png', 'generated', 92, h.db.prepare("SELECT id FROM image_generations WHERE local_path = 'characters/gen.png'").get().id, 80],
      ['characters/main.png', 'main', 70, null, 80],
      ['characters/extra.png', 'extra', 60, null, 80],
    ]);
    assert.equal(r.ranked[0].image_url, '/static/characters/gen.png');
    assert.deepEqual(r.skipped, [{ local_path: null, image_url: 'https://remote.invalid/x.png', source: 'extra', reason: 'remote' }], '远程图不下载，列在 skipped 里');
    assert.equal(r.picked.local_path, 'characters/gen.png');
    assert.equal(r.locked, false);
    assert.equal(referenceLocks.getLock(h.db, 'character', h.cid), null);
  });

  it('lock=true：锁定第一名并同步进内核，用到该角色的镜头过期；没有四视图时不传锚图', async () => {
    const h = await harness({ scorer: fakeScorer({ pick: { 'gen.png': 92 } }) });
    prepare(h, { withAnchor: false });
    const [s1] = h.shots();
    h.edit(s1, { characters: [h.cid] }, 'chars');
    h.gen.create(h.ep, { shots: 'all', kind: 'both' });
    await h.drain();
    assert.equal(h.gen.status(h.ep).counts.fresh, 5);
    const r = await h.consistency.autoPickCharacter(h.cid, { lock: true });
    assert.equal(r.anchor, null);
    assert.equal(h.scorer.calls.find((c) => c.method === 'pick').anchor, null);
    assert.equal(r.locked, true);
    assert.equal(r.lock.local_path, 'characters/gen.png');
    assert.ok(Array.isArray(r.synced) && r.synced[0].applied === true);
    const lock = referenceLocks.getLock(h.db, 'character', h.cid);
    assert.equal(lock.local_path, 'characters/gen.png');
    assert.equal(lock.image_url, '/static/characters/gen.png');
    const st = h.gen.status(h.ep).shots;
    assert.deepEqual([st[0].image.state, st[0].video.state], ['stale', 'stale'], '用到该角色的镜头：图和视频都过期');
    assert.ok(st.slice(1).every((s) => s.image.state === 'fresh' && s.video.state === 'fresh'));
    const node = kernel.partsOfShot(h.graph(), s1).image;
    assert.deepEqual(h.graph().nodes[node].params.reference_hashes, [kernelInputs.hashRef('/static/characters/gen.png')]);
  });

  it('没有本机候选 -> NO_REFERENCE_CANDIDATES（400）；角色不存在 -> 404；内核不可用 -> 503', async () => {
    const h = await harness();
    await assert.rejects(h.consistency.autoPickCharacter(h.cid), (e) => e instanceof ConsistencyError && e.code === 'NO_REFERENCE_CANDIDATES' && e.status === 400);
    h.db.prepare('UPDATE characters SET image_url = ? WHERE id = ?').run('https://remote.invalid/only.png', h.cid);
    await assert.rejects(h.consistency.autoPickCharacter(h.cid), (e) => e.code === 'NO_REFERENCE_CANDIDATES' && e.details.skipped.length === 1 && e.details.skipped[0].reason === 'remote');
    h.db.prepare('UPDATE characters SET image_url = NULL, local_path = ? WHERE id = ?').run('characters/gone.png', h.cid);
    await assert.rejects(h.consistency.autoPickCharacter(h.cid), (e) => e.code === 'NO_REFERENCE_CANDIDATES' && e.details.skipped[0].reason === 'not_local' && e.details.skipped[0].local_path === 'characters/gone.png');
    await assert.rejects(h.consistency.autoPickCharacter(999999), (e) => e.status === 404);
    const h2 = await harness({ scorer: fakeScorer({ available: false }) });
    prepare(h2);
    h2.scorer.pickReference = async () => { throw new ConsistencyError('CONSISTENCY_UNAVAILABLE', 'down', 503); };
    await assert.rejects(h2.consistency.autoPickCharacter(h2.cid, { lock: true }), (e) => e.status === 503);
    assert.equal(referenceLocks.getLock(h2.db, 'character', h2.cid), null, '失败不锁');
  });
});

describe('REST', () => {
  it('GET /episodes/:id/consistency、POST /shots/:id/consistency/rescore、POST /characters/:id/references/auto-pick', async () => {
    const h = await harness({ scorer: fakeScorer({ scores: { 'char-ref.png': 45 }, pick: { 'main.png': 80 } }) });
    const s1 = h.lockFirstShot();
    h.gen.create(h.ep, { shots: [s1], kind: 'image' });
    await h.drain();
    const app = express();
    app.use(express.json());
    const cr = consistencyRoutes(h.consistency, log);
    app.get('/episodes/:id/consistency', cr.episodeReport);
    app.post('/shots/:id/consistency/rescore', cr.rescore);
    app.post('/characters/:id/references/auto-pick', cr.autoPick);
    const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const call = async (method, url, body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    try {
      let r = await call('GET', `/episodes/${h.ep}/consistency`);
      assert.equal(r.status, 200);
      assert.equal(r.body.data.shots.length, 5);
      assert.equal(r.body.data.shots[0].suggestion, 'check');
      assert.equal(r.body.data.shots[0].worst, 45);
      assert.equal(r.body.data.counts.check, 1);
      assert.equal((await call('GET', '/episodes/999999/consistency')).status, 404);

      h.scorer.scores['char-ref.png'] = 90;
      const sb = h.graph().nodes[s1].legacy_id;
      r = await call('POST', `/shots/${sb}/consistency/rescore`, {});
      assert.equal(r.status, 200);
      assert.equal(r.body.data.suggestion, 'ok');
      assert.equal(r.body.data.rescored.image, 2);
      r = await call('POST', `/shots/${s1}/consistency/rescore`, { episode_id: h.ep });
      assert.equal(r.status, 200);
      r = await call('POST', `/shots/${s1}/consistency/rescore`);
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'BAD_REQUEST');
      assert.equal((await call('POST', '/shots/999999/consistency/rescore', {})).status, 404);

      r = await call('POST', `/characters/${h.cid}/references/auto-pick`, {});
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'NO_REFERENCE_CANDIDATES');
      assert.ok(r.body.error.action, '错误码表里有处理建议');
      h.file('characters/main.png');
      h.db.prepare('UPDATE characters SET local_path = ? WHERE id = ?').run('characters/main.png', h.cid);
      r = await call('POST', `/characters/${h.cid}/references/auto-pick`, { lock: 'yes' });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.locked, false, 'lock 必须是布尔 true');
      r = await call('POST', `/characters/${h.cid}/references/auto-pick`, { lock: true });
      assert.equal(r.body.data.locked, true);
      assert.equal(r.body.data.picked.local_path, 'characters/main.png');
      assert.equal(referenceLocks.getLock(h.db, 'character', h.cid).local_path, 'characters/main.png');
      assert.equal((await call('POST', '/characters/999999/references/auto-pick', {})).status, 404);
    } finally {
      server.close();
    }
  });
});
