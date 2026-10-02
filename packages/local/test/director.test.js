'use strict';
// P3-D 导演模式：自然语言 -> 计划 -> 校验 / 干跑 / 影响 / 估价 -> 一个事务执行 -> 撤销。
// 不联网：文本模型用录制在 fixtures/director/*.json 里的回复回放；图 / 视频估价用假的服务商配置。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const kernel = require('@talekiln/kernel');
const store = require('../src/kernel/store');
const legacy = require('../src/kernel/legacy');
const { INTENTS } = require('../src/kernel/intentTable');
const { createDirectorService, DirectorError, STATUS_LABEL } = require('../src/director');
const P = require('../src/director/plan');
const { buildContext, buildMessages, repairMessages } = require('../src/director/prompt');
const { SCHEMAS, EXCLUDED, allowedIntents, checkArgs, describeIntent } = require('../src/director/intentSchemas');
const { createSpendService, createEstimator } = require('../src/spend');
const TEST_PRICES = require('./fixtures/prices.sample.json'); // 固定示例价表，见 batch.test.js
const { createAiTaskStore } = require('../src/queue');
const { createGenerationService } = require('../src/generation');
const { localTokenGuard } = require('../src/utils/localToken');
const { ENTRIES } = require('../src/errors');
const { seededDb, sbRows, log } = require('./helpers/kernelDb');

const FX_DIR = path.join(__dirname, 'fixtures', 'director');
const fx = (id) => JSON.parse(fs.readFileSync(path.join(FX_DIR, `${id}.json`), 'utf8'));
const FAKE_CONFIGS = [{ provider: 'dashscope', api_key: 'fake-key-not-real', is_active: true, service_type: 'text' }];
const FAKE_PROVIDER = { kind: 'bailian', cfg: { bailian: { apiKey: 'fake-key-not-real' } }, model: 'qwen-plus' };

/** 片段 id 来自旧时间线（uuid），回复里用 {{seg:shot_2}} 占位，回放前按当前图替换。 */
const resolveIds = (text, g) => text.replace(/\{\{seg:([a-z0-9_]+)\}\}/g, (_, shot) => kernel.segmentsOfShot(g, shot)[0].id);

/** 假的文本模型门面：每次 text.stream 回放下一条录制回复（分块 delta + done）。 */
function fakeProviders(replies) {
  const calls = [];
  return {
    calls,
    text: {
      stream(provider, req) {
        calls.push({ provider, req: { ...req, messages: req.messages.map((m) => ({ ...m })) } });
        const text = replies[calls.length - 1];
        if (text === undefined) throw new Error('no recorded reply left');
        return (async function* () {
          for (let i = 0; i < text.length; i += 64) yield { type: 'delta', text: text.slice(i, i + 64) };
          yield { type: 'done', text, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
        })();
      },
    },
  };
}

const canon = (g) => kernel.canonicalJSON(g);
const rowsJson = (db, ep) => JSON.stringify(sbRows(db, ep).map(({ updated_at, ...r }) => r)); // 旧表的 updated_at 随每次物化变化

async function harness({ withGeneration = false } = {}) {
  const { db, episodeId: ep, dir } = await seededDb();
  legacy.importLegacy(db, ep);
  let spend = null;
  let generation = null;
  if (withGeneration) {
    spend = createSpendService(db, { estimator: createEstimator(TEST_PRICES) });
    generation = createGenerationService({
      db, store: createAiTaskStore(db), worker: { wake() {} }, spend, storageRoot: path.join(dir, 'storage'), getCore: null,
      listConfigs: () => FAKE_CONFIGS, catalogModels: () => [], log,
    });
  }
  const graph = () => store.openProject(db, ep).graph;
  /** 用一组录制回复建一个导演服务（每个测试一份，回放互不干扰）。 */
  const make = (replies, over = {}) => {
    const p = fakeProviders(replies.map((t) => resolveIds(t, graph())));
    const svc = createDirectorService({
      db, log, spend, generation, listConfigs: () => FAKE_CONFIGS, catalogModels: () => [],
      resolveProvider: () => FAKE_PROVIDER, createProviders: () => p, config: { director: { model: 'qwen-plus', max_attempts: 2 } }, ...over,
    });
    return { svc, p };
  };
  const planFx = async (id, over) => { const f = fx(id); const { svc, p } = make(f.replies, over); const turn = await svc.plan(ep, f.message); return { turn, svc, p, f }; };
  return { db, ep, dir, spend, generation, graph, make, planFx, project: () => store.openProject(db, ep) };
}

// ---------- 提示词 / 参数表 ----------

describe('导演模式：上下文、提示词与参数表', () => {
  it('buildContext 给出紧凑上下文：镜头（序号 / 节点 / 片段 / 状态）、行、总时长', async () => {
    const h = await harness();
    const ctx = buildContext(h.graph());
    assert.equal(ctx.shot_count, 5);
    assert.equal(ctx.total_ms, 16000);
    assert.deepEqual(ctx.shots.map((s) => s.no), [1, 2, 3, 4, 5]);
    assert.deepEqual(ctx.shots.map((s) => s.id), kernel.shotOrder(h.graph()));
    const s2 = ctx.shots[1];
    assert.equal(s2.group, 'grp_1');
    assert.deepEqual(s2.nodes, { image: 'img_2', video: 'vid_2', narration: 'nar_2' });
    assert.deepEqual(s2.line_ids, ['line_3']);
    assert.equal(s2.state.image, 'fresh');
    assert.equal(s2.segments.length, 1);
    assert.equal(s2.segments[0].id, kernel.segmentsOfShot(h.graph(), 'shot_2')[0].id);
    assert.equal(ctx.lines.length, 6);
    assert.deepEqual(ctx.lines.find((l) => l.id === 'line_3').shot_ids, ['shot_2']);
    assert.deepEqual(ctx.groups.map((g) => g.id), ['grp_script', 'grp_1']);
  });

  it('开放给模型的动作 = REST 白名单 − EXCLUDED，每个都有参数表；提示词里逐条列出，不含被排除的', () => {
    const all = Object.keys(INTENTS).flatMap((v) => Object.keys(INTENTS[v]).map((n) => `${v}.${n}`));
    for (const k of Object.keys(EXCLUDED)) assert.ok(all.includes(k), `EXCLUDED 里的 ${k} 不在白名单里`);
    const allowed = allowedIntents();
    assert.deepEqual(allowed.map((a) => a.key).sort(), all.filter((k) => !EXCLUDED[k]).sort());
    assert.equal(allowed.length, 20);
    for (const a of allowed) assert.ok(SCHEMAS[a.view][a.name].desc, a.key);
    const msgs = buildMessages(buildContext({ nodes: {}, edges: [], groups: {}, group_order: [], versions: {}, adopted: {}, layout: {} }), '把第一镜改成夜景');
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].role, 'user');
    for (const a of allowed) assert.ok(msgs[0].content.includes(`- ${a.key}(`), a.key);
    for (const k of Object.keys(EXCLUDED)) assert.ok(!msgs[0].content.includes(`- ${k}(`), k);
    assert.match(msgs[0].content, /只输出一个 JSON 对象/);
    assert.match(msgs[1].content, /用户要求：把第一镜改成夜景/);
    assert.match(describeIntent(allowed.find((a) => a.key === 'shot.setShotField')), /^- shot\.setShotField\(shot_id\*: string, patch\*: object\{title:string,/);
    const rep = repairMessages('{"x":1}', ['问题一', '问题二']);
    assert.equal(rep[0].role, 'assistant');
    assert.match(rep[1].content, /- 问题一\n- 问题二/);
  });

  it('checkArgs：必填、类型、枚举、对象形状、未知参数都给中文错误', () => {
    const s = SCHEMAS.shot.setShotField;
    assert.deepEqual(checkArgs(s, { shot_id: 'shot_1', patch: { title: '夜' } }), []);
    const errs = checkArgs(s, { shot_id: 1, patch: { duration_ms: '3s', nope: 1 }, extra: true });
    assert.ok(errs.some((e) => /shot_id 应为字符串/.test(e)), errs.join('|'));
    assert.ok(errs.some((e) => /patch\.duration_ms 应为整数/.test(e)));
    assert.ok(errs.some((e) => /patch\.nope 不在允许的字段里/.test(e)));
    assert.ok(errs.some((e) => /参数 extra 不在该意图的参数表里/.test(e)));
    assert.ok(checkArgs(s, { shot_id: 'shot_1', patch: {} }).some((e) => /不能是空对象/.test(e)));
    assert.ok(checkArgs(s, { patch: { title: 'x' } }).some((e) => /缺少必填参数 shot_id/.test(e)));
    assert.ok(checkArgs(SCHEMAS.script.insertLine, { group: 'g', kind: 'song' }).some((e) => /kind 只能取/.test(e)));
    assert.deepEqual(checkArgs(SCHEMAS.timeline.setTransition, { segment_id: 's', transition: null }), []);
    assert.deepEqual(checkArgs(SCHEMAS.shot.regenerateShot, { shot_id: 'shot_1', targets: ['image'] }), []);
    assert.ok(checkArgs(SCHEMAS.shot.regenerateShot, { shot_id: 'shot_1', targets: ['audio'] }).some((e) => /targets 只能取 image \/ video/.test(e)));
    assert.deepEqual(checkArgs(s, 'nope'), ['args 应为对象，收到 "nope"']);
  });

  it('parsePlan / normalizePlan / checkPlan：容忍代码块与闲聊；空步骤、清单外动作、被排除动作、步骤太多都拒绝', () => {
    const ok = P.parsePlan('好的：\n```json\n{"summary": "s", "steps": [{"view": "shot", "name": "deleteShot", "args": {"shot_id": "shot_1"},}], "untouched": ["x", 3, " y "]}\n```');
    assert.ok(ok.value);
    const norm = P.normalizePlan(ok.value);
    assert.deepEqual(norm.untouched, ['x', 'y']);
    assert.equal(norm.steps[0].reason, '');
    assert.deepEqual(P.checkPlan(norm), []);
    assert.match(P.parsePlan('不是 JSON').error, /模型输出不是 JSON/);
    assert.match(P.parsePlan('[1,2]').error, /不是 JSON/);
    assert.deepEqual(P.checkPlan(P.normalizePlan({ summary: '信息不足', steps: [] })), ['steps 为空：模型没有给出可执行的步骤（信息不足）']);
    assert.deepEqual(P.checkPlan(P.normalizePlan({ steps: 'x' })), ['steps 必须是数组']);
    const errs = P.checkPlan(P.normalizePlan({ steps: [
      { view: 'shot', name: 'explode', args: {} }, { view: 'canvas', name: 'moveNode', args: { node_id: 'a', x: 1, y: 2 } }, 'x',
      { view: 'shots', name: 'deleteShot', args: { shot_id: 'shot_1' } }, { view: 'script', name: 'constructor', args: {} },
    ] }));
    assert.equal(errs.length, 4, errs.join('|'));
    assert.match(errs[0], /第 1 步：动作 shot\.explode 不在可用动作清单里/);
    assert.match(errs[1], /第 2 步：动作 canvas\.moveNode 不对导演模式开放/);
    assert.match(errs[2], /第 3 步不是对象/);
    assert.match(errs[3], /第 5 步：动作 script\.constructor 不在可用动作清单里/);
    const many = { steps: Array.from({ length: P.MAX_STEPS + 1 }, () => ({ view: 'shot', name: 'deleteShot', args: { shot_id: 'shot_1' } })) };
    assert.match(P.checkPlan(P.normalizePlan(many))[0], /步骤太多/);
  });
});

// ---------- 生成计划 ----------

describe('导演模式：生成计划', () => {
  it('合法的多步计划：三步干跑通过，记为 planned，带影响范围 / 过期节点 / 不改动清单 / 估价', async () => {
    const h = await harness();
    const before = h.graph();
    const { turn, p } = await h.planFx('valid-multistep');
    assert.equal(turn.status, 'planned');
    assert.equal(turn.status_label, '待执行');
    assert.equal(turn.error, null);
    assert.equal(turn.validation.ok, true);
    assert.equal(turn.validation.attempts, 1);
    assert.equal(turn.validation.base.seq, 0);
    assert.equal(turn.validation.base.structure_hash, P.structureHash(before));
    assert.equal(turn.provider, 'bailian');
    assert.equal(turn.model, 'qwen-plus');
    assert.equal(turn.usage.total_tokens, 150);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].provider, 'bailian');
    assert.equal(p.calls[0].req.model, 'qwen-plus');
    assert.ok(p.calls[0].req.messages[1].content.includes('"shot_2"'), 'user message carries the context ids');
    assert.match(turn.summary, /夜景特写/);
    assert.deepEqual(turn.untouched, ['其余镜头的画面与台词不变', '镜头顺序与总时长不变']);
    assert.deepEqual(turn.steps.map((s) => [s.view, s.name, s.ok, s.label]), [['shot', 'setShotField', true, 'setShotField'], ['script', 'rewriteLine', true, 'rewriteLine'], ['timeline', 'setTransition', true, 'setTransition']]);
    assert.ok(turn.steps.every((s) => s.op_count > 0 && s.reason));
    assert.deepEqual(turn.steps[0].stale_nodes, ['img_2'], 'changing the description makes the (fresh) first frame stale; the video was never generated');
    assert.deepEqual(turn.steps[1].stale_nodes, ['img_3', 'nar_3'], 'a line is an input of its shot: the narration and the (fresh) first frame go stale');
    assert.deepEqual(turn.steps[2].stale_nodes, []);
    // 影响范围
    const im = turn.impact;
    assert.deepEqual(im.changed_shots.map((c) => [c.id, c.change, c.changes]), [['shot_2', 'modified', ['content', 'segments']], ['shot_3', 'modified', ['lines']]]);
    assert.deepEqual(im.unchanged_shots, ['shot_1', 'shot_4', 'shot_5']);
    assert.deepEqual(im.added_shots, []);
    assert.deepEqual(im.removed_shots, []);
    assert.deepEqual(im.duration, { before_ms: 16000, after_ms: 16000 });
    assert.deepEqual(im.shots_after.map((s) => s.change), ['unchanged', 'modified', 'modified', 'unchanged', 'unchanged']);
    assert.deepEqual(im.stale_nodes.map((n) => [n.node, n.type, n.step, n.shot_id, n.shot_no]), [['img_2', 'image', 0, 'shot_2', 2], ['img_3', 'image', 1, 'shot_3', 3], ['nar_3', 'narration', 1, 'shot_3', 3]]);
    // 估价（没有生成服务：按已启用服务商与默认模型粗估）
    const c = turn.cost_estimate;
    assert.equal(c.currency, 'CNY');
    assert.equal(c.allowed, true);
    assert.deepEqual(c.items.map((i) => [i.node, i.kind, i.shot_no, i.step]), [['img_2', 'image', 2, 0], ['img_3', 'image', 3, 1], ['nar_3', 'tts', 3, 1]]);
    assert.ok(c.items.every((i) => i.estimate > 0 && i.known), JSON.stringify(c.items));
    assert.equal(c.total, Math.round(c.items.reduce((a, i) => a + i.estimate, 0) * 1e6) / 1e6);
    assert.equal(turn.steps[0].cost, c.items[0].estimate);
    assert.equal(turn.steps[1].cost, Math.round((c.items[1].estimate + c.items[2].estimate) * 1e6) / 1e6);
    assert.equal(turn.steps[2].cost, 0);
    // 生成计划不动项目
    assert.equal(canon(h.graph()), canon(before));
    assert.equal(h.project().history.past.length, 0);
    // 列表 / 单条
    const svc = h.make([]).svc;
    const list = svc.list(h.ep);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, turn.id);
    assert.equal(list[0].history_state, null);
    assert.equal(list[0].raw, undefined);
    assert.equal(svc.get(turn.id).raw.length, 1);
    assert.ok(svc.get(turn.id).raw[0].includes('```json'), 'raw model text is kept verbatim');
  });

  it('只改顺序：花费 0、没有要重新生成的节点、镜头标记为 moved、时长不变', async () => {
    const h = await harness();
    const { turn } = await h.planFx('reorder-only');
    assert.equal(turn.status, 'planned');
    assert.equal(turn.cost_estimate.total, 0);
    assert.deepEqual(turn.cost_estimate.items, []);
    assert.deepEqual(turn.impact.stale_nodes, []);
    assert.deepEqual(turn.impact.changed_shots.map((c) => [c.id, c.change, c.changes, c.before.no, c.after.no]), [['shot_2', 'moved', ['order'], 2, 1], ['shot_1', 'moved', ['order'], 1, 2]]);
    assert.deepEqual(turn.impact.unchanged_shots, ['shot_3', 'shot_4', 'shot_5']);
    assert.deepEqual(turn.impact.shots_after.map((s) => s.id), ['shot_2', 'shot_1', 'shot_3', 'shot_4', 'shot_5']);
    assert.deepEqual(turn.impact.duration, { before_ms: 16000, after_ms: 16000 });
    assert.equal(turn.steps[0].cost, 0);
  });

  it('修正回合：第一次不是 JSON，把问题喂回去后第二次通过；时长改动让时间线跟随', async () => {
    const h = await harness();
    const { turn, p } = await h.planFx('repair');
    assert.equal(turn.status, 'planned');
    assert.equal(turn.validation.attempts, 2);
    assert.equal(p.calls.length, 2);
    const second = p.calls[1].req.messages;
    assert.equal(second.length, 4);
    assert.equal(second[2].role, 'assistant');
    assert.match(second[2].content, /抱歉/);
    assert.equal(second[3].role, 'user');
    assert.match(second[3].content, /模型输出不是 JSON/);
    assert.equal(turn.usage.total_tokens, 300, 'usage adds up over attempts');
    assert.equal(h.make([]).svc.get(turn.id).raw.length, 2);
    assert.deepEqual(turn.impact.duration, { before_ms: 16000, after_ms: 17500 });
    assert.deepEqual(turn.impact.changed_shots.map((c) => [c.id, c.after.used_ms]), [['shot_1', 4500]]);
    // 时长也是镜头输入：已生成的首帧图过期；从未生成的视频不算新增花费
    assert.deepEqual(turn.cost_estimate.items.map((i) => [i.node, i.kind]), [['img_1', 'image']]);
    assert.equal(turn.cost_estimate.total, turn.cost_estimate.items[0].estimate);
  });

  for (const [id, re] of [
    ['unknown-intent', /第 1 步：动作 shot\.explodeShot 不在可用动作清单里/],
    ['bad-args', /patch\.duration_ms 应为整数/],
    ['excluded-intent', /canvas\.moveNode 不对导演模式开放/],
    ['missing-shot', /第 1 步 shot\.setShotField 执行失败/],
    ['empty-steps', /steps 为空：模型没有给出可执行的步骤（信息不足/],
  ]) {
    it(`拒绝：${id}（可读原因，记录保留原始输出，两次尝试，项目不变）`, async () => {
      const h = await harness();
      const before = h.graph();
      const { turn, p, svc } = await h.planFx(id);
      assert.equal(turn.status, 'rejected');
      assert.equal(turn.status_label, '已拒绝');
      assert.equal(turn.validation.ok, false);
      assert.equal(turn.validation.attempts, 2);
      assert.equal(p.calls.length, 2);
      assert.ok(turn.validation.errors.some((e) => re.test(e)), turn.validation.errors.join(' | '));
      assert.equal(turn.error.code, 'DIRECTOR_PLAN_REJECTED');
      assert.ok(re.test(turn.error.message));
      assert.equal(turn.impact, null);
      assert.equal(turn.cost_estimate, null);
      assert.equal(turn.raw.length, 2);
      // 修正回合把错误清单喂了回去
      assert.ok(turn.validation.errors.every((e) => p.calls[1].req.messages.at(-1).content.includes(e.slice(0, 20))));
      assert.equal(canon(h.graph()), canon(before));
      assert.throws(() => svc.apply(turn.id), (e) => e instanceof DirectorError && e.code === 'DIRECTOR_TURN_STATE' && e.status === 409 && /已拒绝/.test(e.message));
      assert.throws(() => svc.undo(turn.id), (e) => e.code === 'DIRECTOR_TURN_STATE');
    });
  }

  it('bad-args 同时报出每一个问题；missing-shot 的干跑记录带内核错误', async () => {
    const h = await harness();
    const a = await h.planFx('bad-args');
    const all = a.turn.validation.errors.join('\n');
    assert.match(all, /第 1 步 shot\.setShotField：参数 patch\.duration_ms 应为整数/);
    assert.match(all, /第 1 步 shot\.setShotField：参数 force 不在该意图的参数表里/);
    assert.match(all, /第 2 步 script\.rewriteLine：缺少必填参数 line_id/);
    assert.equal(a.turn.steps.length, 2, 'the plan steps are kept for display');
    assert.equal(a.turn.steps[0].ok, false);
    const m = await h.planFx('missing-shot');
    assert.equal(m.turn.steps[0].ok, false);
    assert.match(m.turn.steps[0].error, /shot_99/);
  });

  it('输入与环境错误：空要求、太长、分集不存在、没有文本模型配置、模型调用失败', async () => {
    const h = await harness();
    const { svc } = h.make(['{}']);
    await assert.rejects(() => svc.plan(h.ep, '   '), (e) => e.code === 'BAD_REQUEST' && /请输入修改要求/.test(e.message));
    await assert.rejects(() => svc.plan(h.ep, 'x'.repeat(2001)), (e) => e.code === 'BAD_REQUEST' && /太长/.test(e.message));
    await assert.rejects(() => svc.plan(99999, '改一下'), (e) => e.code === 'NOT_FOUND' && e.status === 404);
    const none = h.make([], { resolveProvider: () => null }).svc;
    await assert.rejects(() => none.plan(h.ep, '改一下'), (e) => e.code === 'NO_TEXT_PROVIDER' && e.status === 400 && /AI 配置/.test(e.message));
    const boom = { text: { stream() { throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' }); } } };
    const broken = h.make([], { createProviders: () => boom }).svc;
    await assert.rejects(() => broken.plan(h.ep, '改一下'), (e) => e.code === 'DIRECTOR_MODEL_FAILED' && e.status === 502 && /socket hang up/.test(e.message) && e.details.code === 'NETWORK');
    assert.equal(h.make([]).svc.list(h.ep).length, 0, 'failed calls leave no record');
    assert.throws(() => svc.get(12345), (e) => e.code === 'NOT_FOUND');
    assert.throws(() => svc.list(99999), (e) => e.code === 'NOT_FOUND');
  });

  it('模型来自 config.director.model；没有配置时百炼默认 qwen-plus，其它服务商用配置里的模型', async () => {
    const h = await harness();
    const f = fx('reorder-only');
    const a = h.make(f.replies, { config: {} });
    await a.svc.plan(h.ep, f.message);
    assert.equal(a.p.calls[0].req.model, 'qwen-plus');
    const b = h.make(f.replies, { config: { director: { model: 'qwen-max' } } });
    await b.svc.plan(h.ep, f.message);
    assert.equal(b.p.calls[0].req.model, 'qwen-max');
    const c = h.make(f.replies, { config: {}, resolveProvider: () => ({ kind: 'ark', cfg: { ark: { apiKey: 'fake-key-not-real' } }, model: 'doubao-x' }) });
    await c.svc.plan(h.ep, f.message);
    assert.equal(c.p.calls[0].provider, 'ark');
    assert.equal(c.p.calls[0].req.model, 'doubao-x');
  });
});

// ---------- 执行与撤销 ----------

describe('导演模式：执行与撤销', () => {
  it('执行 = 一个事务（tx_id director:<id>）；执行后的图等于干跑结果；旧表同步；撤销后图与旧表都回到原样', async () => {
    const h = await harness();
    const before = h.graph();
    const rowsBefore = rowsJson(h.db, h.ep);
    const { turn, svc } = await h.planFx('valid-multistep');
    const dry = P.dryRun(before, { steps: turn.steps.map((s) => ({ view: s.view, name: s.name, args: s.args })) });
    assert.equal(dry.ok, true);

    const r = svc.apply(turn.id);
    assert.equal(r.result.applied, true);
    assert.equal(r.result.tx_id, `director:${turn.id}`);
    assert.equal(r.result.seq, 1);
    assert.deepEqual(r.result.invalidated, ['img_2', 'img_3', 'nar_3']);
    assert.equal(r.result.can_undo, true);
    assert.equal(r.turn.status, 'applied');
    assert.equal(r.turn.status_label, '已执行');
    assert.equal(r.turn.history_state, 'applied');
    assert.equal(r.turn.tx_id, `director:${turn.id}`);
    assert.ok(r.turn.applied_at);
    const p = h.project();
    assert.equal(p.history.past.length, 1, 'exactly one history entry');
    assert.equal(p.history.past[0].tx.tx_id, `director:${turn.id}`);
    assert.equal(p.history.past[0].tx.label, '导演模式');
    assert.equal(p.history.past[0].tx.meta.director_turn, turn.id);
    assert.deepEqual(p.history.past[0].tx.meta.labels, ['setShotField', 'rewriteLine', 'setTransition']);
    assert.equal(p.history.past[0].tx.ops.length, turn.steps.reduce((a, s) => a + s.op_count, 0));
    assert.equal(canon(p.graph), canon(dry.graph), 'apply reproduces the dry run exactly');
    assert.equal(p.graph.nodes.shot_2.params.shot_type, '特写');
    assert.equal(p.graph.nodes.line_4.params.text, '她终于放松下来。');
    assert.equal(kernel.segmentsOfShot(p.graph, 'shot_2')[0].transition, 'fade');
    const rows = sbRows(h.db, h.ep);
    assert.equal(rows[1].shot_type, '特写');
    assert.equal(rows[2].narration, '她终于放松下来。', 'narration lines materialize into the narration column');
    assert.ok(kernel.staleSet(p.graph).includes('img_2'));
    assert.equal(svc.list(h.ep)[0].history_state, 'applied');
    assert.throws(() => svc.apply(turn.id), (e) => e.code === 'DIRECTOR_TURN_STATE' && /已执行/.test(e.message));

    const u = svc.undo(turn.id);
    assert.equal(u.turn.status, 'undone');
    assert.equal(u.turn.status_label, '已撤销');
    assert.equal(u.turn.history_state, 'undone');
    assert.equal(u.result.tx_id, `director-undo:${turn.id}:1`);
    assert.equal(u.result.can_undo, false);
    assert.equal(u.result.can_redo, true);
    assert.deepEqual(u.result.revalidated, ['img_2', 'img_3', 'nar_3']);
    const after = h.project();
    assert.equal(canon(after.graph), canon(before), 'apply then undo leaves the graph deep-equal');
    assert.equal(rowsJson(h.db, h.ep), rowsBefore, 'legacy rows restored too');
    assert.equal(after.history.past.length, 0);
    assert.equal(after.history.future[0].tx.tx_id, `director:${turn.id}`);
    assert.equal(svc.list(h.ep)[0].history_state, 'undone');
    assert.throws(() => svc.undo(turn.id), (e) => e.code === 'DIRECTOR_TURN_STATE' && /已撤销/.test(e.message));
    assert.throws(() => svc.apply(turn.id), (e) => e.code === 'DIRECTOR_TURN_STATE');
  });

  it('新增镜头：执行后撤销也回到原样（新建节点与片段全部回收）；id 分配与干跑一致', async () => {
    const h = await harness();
    const before = h.graph();
    const { turn, svc } = await h.planFx('add-shot');
    assert.equal(turn.status, 'planned');
    assert.deepEqual(turn.impact.added_shots, ['shot_6']);
    assert.deepEqual(turn.impact.duration, { before_ms: 16000, after_ms: 19000 });
    assert.deepEqual(turn.impact.shots_after.map((s) => s.id), ['shot_1', 'shot_2', 'shot_6', 'shot_3', 'shot_4', 'shot_5']);
    assert.deepEqual(turn.impact.unchanged_shots, ['shot_1', 'shot_2', 'shot_3', 'shot_4', 'shot_5']);
    assert.deepEqual(turn.impact.stale_nodes.map((n) => [n.node, n.type, n.shot_no]), [['img_6', 'image', 3], ['vid_6', 'video', 3], ['nar_6', 'narration', 3]]);
    svc.apply(turn.id);
    const g = h.graph();
    assert.equal(g.nodes.shot_6.params.title, '车窗笑脸');
    assert.deepEqual(kernel.shotOrder(g), ['shot_1', 'shot_2', 'shot_6', 'shot_3', 'shot_4', 'shot_5']);
    assert.equal(kernel.timelineView(g).duration_ms, 19000);
    const live = () => sbRows(h.db, h.ep).filter((r) => !r.deleted_at);
    assert.equal(live().length, 6);
    svc.undo(turn.id);
    assert.equal(canon(h.graph()), canon(before));
    assert.equal(live().length, 5, 'the legacy row of the new shot is soft-deleted again');
  });

  it('只能在撤销栈顶撤销：后面有别的修改时报 DIRECTOR_NOT_ON_TOP 并说明栈顶；顶栏撤销掉那步后可以撤销', async () => {
    const h = await harness();
    const { turn, svc } = await h.planFx('reorder-only');
    svc.apply(turn.id);
    store.commit(h.db, h.ep, (g) => kernel.intents.shot.setShotField(g, 'shot_3', { title: '手动改的' }, { tx_id: 'manual-1' }), { tx_id: 'manual-1' });
    assert.throws(() => svc.undo(turn.id), (e) => e instanceof DirectorError && e.code === 'DIRECTOR_NOT_ON_TOP' && e.status === 409
      && /还有 1 步修改/.test(e.message) && /setShotField/.test(e.message) && e.details.steps_above === 1 && e.details.in_stack === true && e.details.top.tx_id === 'manual-1');
    assert.equal(svc.get(turn.id).status, 'applied');
    assert.equal(svc.get(turn.id).history_state, 'applied');
    store.undo(h.db, h.ep, { tx_id: 'manual-undo' });
    const u = svc.undo(turn.id);
    assert.equal(u.turn.status, 'undone');
    assert.deepEqual(kernel.shotOrder(h.graph()), ['shot_1', 'shot_2', 'shot_3', 'shot_4', 'shot_5']);
  });

  it('事务被顶栏撤销后又被新修改覆盖：history_state 为 discarded，撤销报“已不在撤销栈里”', async () => {
    const h = await harness();
    const { turn, svc } = await h.planFx('reorder-only');
    svc.apply(turn.id);
    store.undo(h.db, h.ep, { tx_id: 'toolbar-undo' });
    assert.equal(svc.get(turn.id).history_state, 'undone');
    assert.equal(svc.get(turn.id).status, 'applied', 'the record only changes through the director undo');
    store.commit(h.db, h.ep, (g) => kernel.intents.shot.setShotField(g, 'shot_3', { title: '覆盖' }, { tx_id: 'manual-2' }), { tx_id: 'manual-2' });
    assert.equal(svc.get(turn.id).history_state, 'discarded');
    assert.throws(() => svc.undo(turn.id), (e) => e.code === 'DIRECTOR_NOT_ON_TOP' && /已不在撤销栈里/.test(e.message) && e.details.in_stack === false);
  });

  it('计划生成后项目结构变了：执行报 DIRECTOR_STALE_PLAN；只是采用版本变了不影响', async () => {
    const h = await harness();
    const { turn, svc } = await h.planFx('valid-multistep');
    // 非结构性：改采用版本（生成结果写回也属于这一类）
    store.commit(h.db, h.ep, { tx_id: 'adopt-1', label: 'adoptVersion', ops: [{ op: 'adoptVersion', node: 'img_1', version_id: null }] });
    const second = await h.planFx('reorder-only');
    // 结构性：改了一个镜头的字段
    store.commit(h.db, h.ep, (g) => kernel.intents.shot.setShotField(g, 'shot_5', { title: '改了' }, { tx_id: 'manual-3' }), { tx_id: 'manual-3' });
    assert.throws(() => svc.apply(turn.id), (e) => e instanceof DirectorError && e.code === 'DIRECTOR_STALE_PLAN' && e.status === 409 && /请重新生成计划/.test(e.message) && e.details.base_seq === 0 && e.details.seq === 2);
    assert.equal(svc.get(turn.id).status, 'planned');
    assert.throws(() => second.svc.apply(second.turn.id), (e) => e.code === 'DIRECTOR_STALE_PLAN');
    store.undo(h.db, h.ep, { tx_id: 'undo-3' });
    // 回到计划时的结构（采用版本的差异不算）：可以执行
    const r = second.svc.apply(second.turn.id);
    assert.equal(r.result.applied, true);
    assert.deepEqual(kernel.shotOrder(h.graph()), ['shot_2', 'shot_1', 'shot_3', 'shot_4', 'shot_5']);
  });
});

// ---------- 估价 ----------

describe('导演模式：估价（与生成服务一致）', () => {
  it('新增镜头的花费 = 生成服务对过期节点的计划经花费服务估价之和；配音没有文字不计费', async () => {
    const h = await harness({ withGeneration: true });
    const before = h.graph();
    const { turn } = await h.planFx('add-shot');
    const c = turn.cost_estimate;
    assert.equal(c.allowed, true);
    assert.equal(c.sample_prices, true);
    assert.deepEqual(c.items.map((i) => [i.node, i.kind, i.shot_id, i.step]), [['img_6', 'image', 'shot_6', 0], ['vid_6', 'video', 'shot_6', 0], ['nar_6', 'tts', 'shot_6', 0]]);
    assert.ok(c.items[0].estimate > 0 && c.items[1].estimate > 0);
    assert.equal(c.items[2].estimate, 0);
    assert.equal(c.items[2].basis, '没有可配音的文字');
    assert.ok(c.items[1].model, 'video model chosen by the generation service');
    const dry = P.dryRun(before, { steps: turn.steps.map((s) => ({ view: s.view, name: s.name, args: s.args })) });
    const plan = h.generation.planGraph(dry.graph, h.ep, ['shot_6'], ['image', 'video']);
    assert.deepEqual(plan.map((i) => i.action), ['create', 'chain']);
    const expect = h.spend.checkBatch(plan.map((i) => i.spec));
    assert.equal(c.total, expect.total);
    assert.equal(c.max, expect.max);
    assert.equal(turn.steps[0].cost, c.total);
    assert.equal(c.items[0].estimate, expect.estimates[0].estimate);
    assert.equal(c.items[1].estimate, expect.estimates[1].estimate);
  });

  it('改描述 + 改台词：首帧按生成服务的模型与提示词估价，配音按字数；超过单次上限时 allowed=false 但计划照样可执行', async () => {
    const h = await harness({ withGeneration: true });
    const { turn } = await h.planFx('valid-multistep');
    const c = turn.cost_estimate;
    assert.deepEqual(c.items.map((i) => [i.node, i.kind]), [['img_2', 'image'], ['img_3', 'image'], ['nar_3', 'tts']]);
    const dry = P.dryRun(h.graph(), { steps: turn.steps.map((s) => ({ view: s.view, name: s.name, args: s.args })) });
    const plan = h.generation.planGraph(dry.graph, h.ep, ['shot_2', 'shot_3'], ['image']);
    const img2 = plan.find((i) => i.node === 'img_2');
    const img3 = plan.find((i) => i.node === 'img_3');
    assert.equal(img2.action, 'create');
    assert.equal(img3.action, 'create');
    assert.equal(c.items[0].model, img2.model);
    assert.equal(c.items[0].estimate, h.spend.estimate(img2.spec).estimate);
    assert.equal(c.items[1].estimate, h.spend.estimate(img3.spec).estimate);
    const tts = h.spend.estimate({ provider: 'bailian', kind: 'tts', params: { text: '她终于放松下来。' } });
    assert.equal(c.items[2].estimate, tts.estimate);
    assert.match(c.items[2].basis, /chars/);
    assert.equal(c.total, h.spend.checkBatch([img2.spec, img3.spec, { provider: 'bailian', kind: 'tts', params: { text: '她终于放松下来。' } }]).total);
    // 上限
    h.spend.setLimits({ per_run_cap: 0.0001 });
    const again = await h.planFx('valid-multistep');
    assert.equal(again.turn.cost_estimate.allowed, false);
    assert.equal(again.turn.cost_estimate.refusal.reason, 'per_run');
    assert.match(again.turn.cost_estimate.refusal.message, /单次上限/);
    assert.equal(again.turn.status, 'planned');
    assert.equal(again.svc.apply(again.turn.id).result.applied, true, 'the cap is enforced when generating, not when editing');
  });
});

// ---------- REST ----------

describe('导演模式 REST', () => {
  let server;
  let base;
  let h;
  let replies = [];
  const call = async (method, p, body, token = 'tok') => {
    const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-talekiln-token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    h = await harness();
    // 每次 plan 现取当前的录制回复（片段 id 按当前图替换）
    const facade = { text: { stream: (provider, req) => fakeProviders(replies.map((t) => resolveIds(t, h.graph()))).text.stream(provider, req) } };
    const svc = createDirectorService({ db: h.db, log, listConfigs: () => FAKE_CONFIGS, catalogModels: () => [], resolveProvider: () => FAKE_PROVIDER, createProviders: () => facade, config: { director: {} } });
    const d = require('../src/routes/director')(svc, log);
    const app = express();
    app.use(localTokenGuard('tok'));
    app.use(express.json());
    const r = express.Router();
    r.post('/episodes/:id/director/plan', d.plan);
    r.get('/episodes/:id/director/turns', d.turns);
    r.post('/episodes/:id/director/turns/:turnId/apply', d.apply);
    r.post('/episodes/:id/director/turns/:turnId/undo', d.undo);
    app.use('/api/v1', r);
    await new Promise((ok) => { server = app.listen(0, '127.0.0.1', ok); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  it('错误码都在错误表里（中文文案 + 建议操作）', () => {
    for (const code of ['NO_TEXT_PROVIDER', 'DIRECTOR_MODEL_FAILED', 'DIRECTOR_PLAN_REJECTED', 'DIRECTOR_TURN_STATE', 'DIRECTOR_STALE_PLAN', 'DIRECTOR_NOT_ON_TOP']) {
      assert.ok(ENTRIES[code], code);
      assert.equal(ENTRIES[code].scope, 'local');
      assert.match(ENTRIES[code].action, /[一-龥]/);
    }
    assert.deepEqual(Object.keys(STATUS_LABEL), ['planned', 'rejected', 'applied', 'undone']);
  });

  it('plan -> turns -> apply -> undo；拒绝的计划也是 200 并带原因；状态错误 409；越权记录 404；无令牌 401', async () => {
    assert.equal((await call('POST', `/episodes/${h.ep}/director/plan`, { message: 'x' }, null)).status, 401);
    assert.equal((await call('POST', `/episodes/${h.ep}/director/plan`, {})).body.error.code, 'BAD_REQUEST');
    assert.equal((await call('POST', `/episodes/abc/director/plan`, { message: 'x' })).status, 400);
    assert.equal((await call('POST', `/episodes/99999/director/plan`, { message: 'x' })).status, 404);

    replies = fx('unknown-intent').replies;
    const rej = await call('POST', `/episodes/${h.ep}/director/plan`, { message: fx('unknown-intent').message });
    assert.equal(rej.status, 200);
    assert.equal(rej.body.data.status, 'rejected');
    assert.equal(rej.body.data.error.code, 'DIRECTOR_PLAN_REJECTED');
    assert.ok(rej.body.data.validation.errors.length);
    assert.equal(rej.body.data.raw.length, 2, 'the model text is returned for the "show raw" toggle');

    replies = fx('valid-multistep').replies;
    const pl = await call('POST', `/episodes/${h.ep}/director/plan`, { message: fx('valid-multistep').message, provider: 'bailian' });
    assert.equal(pl.status, 200);
    assert.equal(pl.body.data.status, 'planned');
    const id = pl.body.data.id;
    assert.equal(pl.body.data.steps.length, 3);
    assert.ok(pl.body.data.impact.changed_shots.length);
    assert.ok(pl.body.data.cost_estimate);

    const list = await call('GET', `/episodes/${h.ep}/director/turns?limit=1`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.turns.map((t) => t.id), [id]);
    assert.equal((await call('GET', `/episodes/${h.ep}/director/turns`)).body.data.turns.length, 2);
    assert.equal((await call('GET', `/episodes/99999/director/turns`)).status, 404);

    const otherEp = h.db.prepare('INSERT INTO episodes (drama_id, title, created_at, updated_at) SELECT drama_id, ?, created_at, updated_at FROM episodes WHERE id = ?').run('别的分集', h.ep).lastInsertRowid;
    const wrong = await call('POST', `/episodes/${otherEp}/director/turns/${id}/apply`, {});
    assert.equal(wrong.status, 404);
    assert.equal(wrong.body.error.code, 'NOT_FOUND');
    assert.equal((await call('POST', `/episodes/${h.ep}/director/turns/abc/apply`, {})).status, 400);
    assert.equal((await call('POST', `/episodes/${h.ep}/director/turns/424242/apply`, {})).status, 404);

    const notYet = await call('POST', `/episodes/${h.ep}/director/turns/${id}/undo`, {});
    assert.equal(notYet.status, 409);
    assert.equal(notYet.body.error.code, 'DIRECTOR_TURN_STATE');
    assert.ok(notYet.body.error.action);

    const ap = await call('POST', `/episodes/${h.ep}/director/turns/${id}/apply`, {});
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    assert.equal(ap.body.data.turn.status, 'applied');
    assert.equal(ap.body.data.applied, true);
    assert.equal(ap.body.data.tx_id, `director:${id}`);
    assert.equal(ap.body.data.can_undo, true);
    assert.deepEqual(ap.body.data.invalidated, ['img_2', 'img_3', 'nar_3']);
    assert.equal(h.project().history.past.length, 1);
    const twice = await call('POST', `/episodes/${h.ep}/director/turns/${id}/apply`, {});
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'DIRECTOR_TURN_STATE');
    assert.equal(twice.body.error.details.status, 'applied');

    const un = await call('POST', `/episodes/${h.ep}/director/turns/${id}/undo`, {});
    assert.equal(un.status, 200, JSON.stringify(un.body));
    assert.equal(un.body.data.turn.status, 'undone');
    assert.equal(un.body.data.can_redo, true);
    assert.equal(h.project().history.past.length, 0);
    assert.equal((await call('GET', `/episodes/${h.ep}/director/turns`)).body.data.turns[0].history_state, 'undone');
  });
});
