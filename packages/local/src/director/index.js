'use strict';
/**
 * 导演模式（P3-D）：自然语言指令 -> 用用户自己的文本模型 Key 生成执行计划（只允许内核已有意图）->
 * 本地校验 + 在克隆图上干跑 -> 影响范围 / 时长变化 / 估价 -> 执行时合成一个内核事务（tx_id director:<turnId>，整体可撤销）。
 *
 *   plan(ep, message)  调模型、校验、干跑、估价，记一行 director_turns（status planned | rejected）
 *   apply(turnId)      结构摘要核对后在最新图上重跑步骤，一次 store.commit；status -> applied
 *   undo(turnId)       只在该事务位于撤销栈顶时 store.undo；否则报出栈顶是什么；status -> undone
 *   list / get         轮次记录（带撤销栈里的实时状态 history_state）
 *
 * 测试不联网：deps.resolveProvider / deps.createProviders 可注入假的文本模型（录制的计划在 test/fixtures/director）。
 */
const kernel = require('@talekiln/kernel');
const store = require('../kernel/store');
const legacy = require('../kernel/legacy');
const { buildContext, buildMessages, repairMessages } = require('./prompt');
const P = require('./plan');
const { allowedIntents } = require('./intentSchemas');

const { KernelError } = kernel;

class DirectorError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'DirectorError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

const STATUS_LABEL = { planned: '待执行', rejected: '已拒绝', applied: '已执行', undone: '已撤销' };
const DEFAULT_MODEL = 'qwen-plus';
const DEFAULT_ATTEMPTS = 2;
const MESSAGE_MAX = 2000;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;

const nowIso = () => new Date().toISOString();
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };
const cut = (s, n = 40) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

function createDirectorService({
  db, log = console, spend = null, generation = null, config = null, listConfigs = null, catalogModels = null,
  resolveProvider = null, createProviders = null, maxAttempts = null, now = nowIso,
} = {}) {
  if (!db) throw new Error('db is required');
  const cfg = (config && config.director) || {};
  const attemptsMax = Number(maxAttempts ?? cfg.max_attempts) >= 1 ? Number(maxAttempts ?? cfg.max_attempts) : DEFAULT_ATTEMPTS;
  const resolve = resolveProvider || ((d, preferred) => require('../services/scriptgenService').resolveProvider(d, preferred));
  const mkProviders = createProviders || ((c) => require('../providers').createProviders(c));
  const configsOf = listConfigs || ((type) => require('../services/aiConfigService').listConfigsInternal(db, type));
  const warn = (m, extra) => { try { (log.warn || log.error || (() => {})).call(log, m, extra); } catch (_) { /* ignore */ } };

  // ---------- 图 ----------

  function episodeRow(ep) {
    const id = Number(ep);
    const row = Number.isInteger(id) && id > 0 ? db.prepare('SELECT id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(id) : null;
    if (!row) throw new DirectorError('NOT_FOUND', `分集 ${ep} 不存在`, 404);
    return row;
  }
  function openGraph(ep) {
    episodeRow(ep);
    if (!store.hasProject(db, ep)) legacy.importLegacy(db, ep);
    return store.openProject(db, ep);
  }
  const summary = (r) => ({
    applied: r.applied, tx_id: r.tx_id, seq: r.seq, invalidated: r.invalidated, revalidated: r.revalidated,
    stale: kernel.staleSet(r.graph), can_undo: r.canUndo, can_redo: r.canRedo,
  });

  // ---------- 模型 ----------

  function pickModel(prov) {
    if (cfg.model) return String(cfg.model);
    return prov.kind === 'bailian' ? DEFAULT_MODEL : (prov.model || DEFAULT_MODEL);
  }

  async function callModel(facade, provider, model, messages, signal) {
    let text = '';
    let usage = null;
    try {
      for await (const ev of facade.text.stream(provider, { model, messages, temperature: 0.2, signal })) {
        if (ev.type === 'delta') text += ev.text;
        if (ev.type === 'done') { if (!text && ev.text) text = ev.text; usage = ev.usage || usage; }
      }
    } catch (e) {
      throw new DirectorError('DIRECTOR_MODEL_FAILED', `调用文本模型失败：${e && e.message ? e.message : e}`, 502, { provider, model, code: e && e.code ? e.code : null });
    }
    return { text, usage };
  }

  // ---------- 记录 ----------

  const SELECT = 'SELECT * FROM director_turns';
  function rowById(id) {
    const n = Number(id);
    const row = Number.isInteger(n) && n > 0 ? db.prepare(`${SELECT} WHERE id = ?`).get(n) : null;
    if (!row) throw new DirectorError('NOT_FOUND', `导演模式记录 ${id} 不存在`, 404);
    return row;
  }

  /** 撤销栈里的实时状态：applied（仍生效）/ undone（在重做栈）/ discarded（被别的操作顶掉）/ null（没执行过）。 */
  function historyStates(ep, rows) {
    const out = new Map();
    const need = rows.filter((r) => r.tx_id);
    if (!need.length || !store.hasProject(db, ep)) return out;
    try {
      const p = store.openProject(db, ep);
      const past = new Set(p.history.past.map((x) => x.tx.tx_id));
      const future = new Set(p.history.future.map((x) => x.tx.tx_id));
      for (const r of need) out.set(r.id, past.has(r.tx_id) ? 'applied' : future.has(r.tx_id) ? 'undone' : 'discarded');
    } catch (e) {
      warn('director history state', { error: e && e.message });
    }
    return out;
  }

  function toTurn(row, { raw = false, history_state = null } = {}) {
    const plan = parseJson(row.plan) || {};
    const validation = parseJson(row.validation) || {};
    const vsteps = Array.isArray(validation.steps) ? validation.steps : [];
    const cost = parseJson(row.cost_estimate);
    const perStep = {};
    for (const it of (cost && cost.items) || []) if (it.step != null) perStep[it.step] = (perStep[it.step] || 0) + (it.estimate || 0);
    const steps = (Array.isArray(plan.steps) ? plan.steps : []).map((s, i) => {
      const v = vsteps[i] || {};
      return {
        index: i, view: s.view, name: s.name, args: s.args, reason: s.reason || '',
        label: v.label || s.name, ok: v.ok === true, error: v.error || null, op_count: v.op_count || 0,
        stale_nodes: v.stale_nodes || [], cost: Math.round((perStep[i] || 0) * 1e6) / 1e6,
      };
    });
    const errors = Array.isArray(validation.errors) ? validation.errors : [];
    return {
      id: row.id, episode_id: row.episode_id, message: row.message, status: row.status, status_label: STATUS_LABEL[row.status] || row.status,
      history_state, created_at: row.created_at, applied_at: row.applied_at, tx_id: row.tx_id,
      summary: plan.summary || '', untouched: plan.untouched || [], steps,
      validation: { ok: validation.ok === true, errors, attempts: validation.attempts || 0, base: validation.base || null },
      impact: parseJson(row.impact), cost_estimate: cost,
      provider: plan.provider || null, model: plan.model || null, usage: plan.usage || null,
      error: row.status === 'rejected' ? { code: 'DIRECTOR_PLAN_REJECTED', message: errors.join('；') || '计划未通过校验' } : null,
      ...(raw ? { raw: plan.raw || [] } : {}),
    };
  }

  function insertTurn(ep, message, { plan, validation, impact, cost, status }) {
    const info = db.prepare(`INSERT INTO director_turns (episode_id, message, plan, validation, impact, cost_estimate, status, tx_id, created_at, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`)
      .run(Number(ep), message, JSON.stringify(plan), JSON.stringify(validation), impact ? JSON.stringify(impact) : null, cost ? JSON.stringify(cost) : null, status, now());
    return Number(info.lastInsertRowid);
  }

  // ---------- plan ----------

  /**
   * 生成计划。opts.provider 可指定服务商；opts.signal 取消。
   * 返回轮次记录（status planned / rejected）。模型不可用、没有文本配置时抛 DirectorError。
   */
  async function plan(ep, message, opts = {}) {
    const msg = typeof message === 'string' ? message.trim() : '';
    if (!msg) throw new DirectorError('BAD_REQUEST', '请输入修改要求');
    if (msg.length > MESSAGE_MAX) throw new DirectorError('BAD_REQUEST', `修改要求太长（最多 ${MESSAGE_MAX} 字）`);
    const { graph, seq } = openGraph(ep);
    const prov = resolve(db, opts.provider);
    if (!prov) throw new DirectorError('NO_TEXT_PROVIDER', `未找到可用的文本模型配置（${require('../providers/enablement').enabledLabels()}），请先在 AI 配置中添加`);
    const facade = mkProviders(prov.cfg);
    const model = pickModel(prov);

    const ctx = buildContext(graph);
    const messages = buildMessages(ctx, msg);
    const raw = [];
    const usage = {};
    let parsed = null;
    let dry = null;
    let errors = [];
    let attempts = 0;
    for (attempts = 1; attempts <= attemptsMax; attempts++) {
      const r = await callModel(facade, prov.kind, model, messages, opts.signal);
      raw.push(r.text);
      for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (r.usage && r.usage[k]) usage[k] = (usage[k] || 0) + r.usage[k];
      const pr = P.parsePlan(r.text);
      if (!pr.value) { parsed = null; errors = [pr.error]; }
      else {
        parsed = P.normalizePlan(pr.value);
        errors = P.checkPlan(parsed);
        if (!errors.length) { dry = P.dryRun(graph, parsed); errors = dry.errors; }
      }
      if (!errors.length) break;
      if (attempts < attemptsMax) messages.push(...repairMessages(r.text, errors));
    }
    attempts = Math.min(attempts, attemptsMax);

    const base = { seq, structure_hash: P.structureHash(graph) };
    const planJson = { summary: parsed ? parsed.summary : '', steps: parsed ? parsed.steps : [], untouched: parsed ? parsed.untouched : [], raw, provider: prov.kind, model, usage };
    if (errors.length) {
      const validation = { ok: false, errors, attempts, base, steps: dry ? dry.steps.map(publicStep) : [] };
      const id = insertTurn(ep, msg, { plan: planJson, validation, impact: null, cost: null, status: 'rejected' });
      return toTurn(rowById(id), { raw: true });
    }
    const impact = P.computeImpact(graph, dry.graph, dry.staleNodes);
    let cost = null;
    try {
      cost = P.estimateCost({ graph: dry.graph, staleNodes: dry.staleNodes, episodeId: Number(ep), spend, generation, listConfigs: configsOf, catalogModels });
    } catch (e) {
      warn('director cost estimate', { error: e && e.message });
      cost = { total: 0, max: 0, currency: 'CNY', sample_prices: true, known: false, allowed: true, refusal: null, items: [], error: e && e.message };
    }
    const validation = { ok: true, errors: [], attempts, base, steps: dry.steps.map(publicStep) };
    const id = insertTurn(ep, msg, { plan: planJson, validation, impact, cost, status: 'planned' });
    return toTurn(rowById(id), { raw: true });
  }
  const publicStep = (s) => ({ index: s.index, label: s.label, ok: s.ok, error: s.error || null, op_count: s.op_count, stale_nodes: s.stale_nodes });

  // ---------- apply ----------

  function apply(turnId) {
    const row = rowById(turnId);
    if (row.status !== 'planned') throw new DirectorError('DIRECTOR_TURN_STATE', `这轮计划状态为「${STATUS_LABEL[row.status] || row.status}」，不能执行`, 409, { status: row.status });
    const ep = row.episode_id;
    const planJson = parseJson(row.plan) || {};
    const validation = parseJson(row.validation) || {};
    const p = store.openProject(db, ep);
    const base = validation.base || {};
    if (base.structure_hash && P.structureHash(p.graph) !== base.structure_hash) {
      throw new DirectorError('DIRECTOR_STALE_PLAN', `生成计划之后项目已被修改（计划基于第 ${base.seq} 步，现在是第 ${p.seq} 步），请重新生成计划`, 409, { base_seq: base.seq, seq: p.seq });
    }
    const txId = `director:${row.id}`;
    const label = '导演模式';
    const r = store.commit(db, ep, (g) => {
      const c = P.compileOps(g, planJson.steps || []);
      return { tx_id: txId, label, ops: c.ops, meta: { director_turn: row.id, summary: cut(planJson.summary, 80), labels: c.labels } };
    }, { tx_id: txId });
    db.prepare('UPDATE director_turns SET status = ?, tx_id = ?, applied_at = ? WHERE id = ?').run('applied', txId, now(), row.id);
    const turn = toTurn(rowById(row.id), { history_state: 'applied' });
    return { turn, result: summary(r) };
  }

  // ---------- undo ----------

  function undo(turnId) {
    const row = rowById(turnId);
    if (row.status !== 'applied') throw new DirectorError('DIRECTOR_TURN_STATE', `这轮计划状态为「${STATUS_LABEL[row.status] || row.status}」，没有可撤销的执行`, 409, { status: row.status });
    const ep = row.episode_id;
    const p = store.openProject(db, ep);
    const past = p.history.past;
    const top = past[past.length - 1];
    if (!top) throw new KernelError('NOTHING_TO_UNDO', '没有可撤销的操作');
    if (top.tx.tx_id !== row.tx_id) {
      const idx = past.findIndex((x) => x.tx.tx_id === row.tx_id);
      const above = idx >= 0 ? past.length - 1 - idx : null;
      const topLabel = top.tx.label || top.tx.tx_id;
      const msg = idx >= 0
        ? `这轮计划之后还有 ${above} 步修改（栈顶是「${topLabel}」），不能单独撤销；请先在顶栏撤销后面的修改，或在版本历史里回到这一步`
        : `这轮计划的事务已不在撤销栈里（可能已在顶栏撤销或被新的修改覆盖），栈顶是「${topLabel}」`;
      throw new DirectorError('DIRECTOR_NOT_ON_TOP', msg, 409, { top: { tx_id: top.tx.tx_id, label: top.tx.label || '' }, steps_above: above, in_stack: idx >= 0 });
    }
    const r = store.undo(db, ep, { tx_id: `director-undo:${row.id}:${p.seq}` });
    db.prepare('UPDATE director_turns SET status = ? WHERE id = ?').run('undone', row.id);
    const turn = toTurn(rowById(row.id), { history_state: 'undone' });
    return { turn, result: summary(r) };
  }

  // ---------- 查询 ----------

  function list(ep, { limit } = {}) {
    episodeRow(ep);
    const n = Number(limit);
    const lim = Number.isInteger(n) && n > 0 ? Math.min(n, LIST_MAX) : LIST_DEFAULT;
    const rows = db.prepare(`${SELECT} WHERE episode_id = ? ORDER BY id DESC LIMIT ?`).all(Number(ep), lim);
    const states = historyStates(Number(ep), rows);
    return rows.map((r) => toTurn(r, { history_state: states.get(r.id) || null }));
  }

  function get(turnId, { raw = true } = {}) {
    const row = rowById(turnId);
    const states = historyStates(row.episode_id, [row]);
    return toTurn(row, { raw, history_state: states.get(row.id) || null });
  }

  return { plan, apply, undo, list, get, buildContext, allowedIntents, DirectorError };
}

module.exports = { createDirectorService, DirectorError, STATUS_LABEL, DEFAULT_MODEL };
