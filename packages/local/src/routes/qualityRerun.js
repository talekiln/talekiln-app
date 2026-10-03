'use strict';
// 草稿 -> 成片重跑（spec §10.2；令牌校验由 app 级 localTokenGuard 统一处理）：
//   GET  /episodes/:id/quality/draft-nodes   当前采用版本是草稿档产出的节点，及按成片档重跑的估价
//        -> { count, nodes: [{ node, kind, shot }], estimate: { amount, max, currency }, allowed, refusal }
//   POST /episodes/:id/quality/rerun          只对这些节点以 final 档入队（同一个 cacheKey，不让任何产物过期）
//        -> { count, nodes, estimate, tasks }；超出额度 402 SPEND_LIMIT（整批拒绝，不建任务）
// 入队前调用 backup/hooks.beforeDestructive(episodeId, 'quality-rerun')（失败不阻断，由 hook 自己保证）。
const kernel = require('@talekiln/kernel');
const response = require('../response');
const { GenerationError } = require('../generation');
const backupHooks = require('../backup/hooks');

const KERNEL_STATUS = { NOT_FOUND: 404, GRAPH_NOT_FOUND: 404 };

function routes(service, log) {
  const fail = (res, name, err) => {
    if (err instanceof GenerationError) return response.error(res, err.status, err.code, err.message, err.details);
    if (err instanceof kernel.KernelError) return response.error(res, KERNEL_STATUS[err.code] || 400, err.code, err.message);
    log.error('quality ' + name, { error: err.message });
    return response.internalError(res, err.message);
  };
  const ep = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new GenerationError('BAD_REQUEST', 'episode id must be a positive integer');
    return id;
  };
  const publicView = (d) => ({
    episode_id: d.episode_id, count: d.count, nodes: d.nodes, estimate: d.estimate, allowed: d.allowed, refusal: d.refusal,
  });

  return {
    draftNodes(req, res) {
      try {
        response.success(res, publicView(service.draftNodes(ep(req))));
      } catch (err) {
        fail(res, 'draft-nodes', err);
      }
    },
    async rerun(req, res) {
      try {
        const id = ep(req);
        const d = service.draftNodes(id);
        if (!d.count) return response.success(res, { ...publicView(d), tasks: [] });
        if (!d.allowed) { // 额度不够：整批拒绝，不做快照也不建任务
          return response.error(res, 402, 'SPEND_LIMIT', d.refusal.message, { reason: d.refusal.reason, estimate: d.estimate.amount, max: d.estimate.max, currency: d.estimate.currency, episode_id: id });
        }
        await backupHooks.beforeDestructive(id, 'quality-rerun');
        const r = service.rerunDrafts(id);
        response.success(res, { ...publicView(r), tasks: r.tasks });
      } catch (err) {
        fail(res, 'rerun', err);
      }
    },
  };
}

module.exports = routes;
