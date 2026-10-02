'use strict';
// P3-B 批量生成 REST：
//   POST /batches                    { drama_id, episode_ids, kinds?, concurrency?, budget_cap_cents?, failure_policy?, dry_run? } -> 201 批次视图
//                                    dry_run=true 只估算不建 -> 200 { dry_run, allowed, refusal, totals, per_episode, warnings }
//   GET  /batches?drama_id=          { items, provider_limits, providers, currency }
//   GET  /batches/:id                批次视图（含每集进度）
//   POST /batches/:id/retry-failed   失败的集重新排进去；body { episode_ids? } 只重试其中几集
//   POST /batches/:id/cancel         取消（未提交的任务取消，已提交的跑完照常写回）
//   POST /batches/:id/pause          暂停（不再建新任务；已在跑的继续）
//   POST /batches/:id/resume         继续；body 可带 { budget_cap_cents } 提高预算
const response = require('../response');
const { BatchError } = require('../batch');
const { GenerationError } = require('../generation');

function routes(service, log) {
  const guard = (name, fn) => (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      if (err instanceof BatchError || err instanceof GenerationError) return response.error(res, err.status || 400, err.code, err.message, err.details);
      log.error('batches ' + name, { error: err.message });
      response.internalError(res, err.message);
    }
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const found = (res, v) => (v ? response.success(res, v) : response.notFound(res, '批次不存在'));

  return {
    create: guard('create', (req, res) => {
      const b = body(req);
      if (b.dry_run === true) return response.success(res, service.create(b));
      response.created(res, service.create(b));
    }),
    list: guard('list', (req, res) => {
      const dramaId = req.query.drama_id != null && req.query.drama_id !== '' ? Number(req.query.drama_id) : null;
      if (dramaId != null && !(Number.isInteger(dramaId) && dramaId > 0)) return response.badRequest(res, 'drama_id 必须是正整数');
      const items = service.list(dramaId != null ? { drama_id: dramaId } : {});
      response.success(res, { items, provider_limits: service.providerLimits(), providers: service.providers(), currency: items[0] ? items[0].currency : 'CNY' });
    }),
    get: guard('get', (req, res) => found(res, service.get(req.params.id))),
    retryFailed: guard('retry-failed', (req, res) => response.success(res, service.retryFailed(req.params.id, body(req)))),
    cancel: guard('cancel', (req, res) => response.success(res, service.cancel(req.params.id))),
    pause: guard('pause', (req, res) => response.success(res, service.pause(req.params.id))),
    resume: guard('resume', (req, res) => response.success(res, service.resume(req.params.id, body(req)))),
  };
}

module.exports = routes;
