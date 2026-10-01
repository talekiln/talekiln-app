'use strict';
const response = require('../response');
const { toView, isUncertain } = require('../queue/taskView');

const PROVIDERS = ['bailian', 'ark'];
const KINDS = ['image', 'video', 'tts'];

/** Shared by enqueue and spend estimate. Returns an error string or null. */
function validateSpec(b) {
  if (!PROVIDERS.includes(b.provider)) return `provider 必须是 ${PROVIDERS.join(' / ')}`;
  if (!KINDS.includes(b.kind)) return `kind 必须是 ${KINDS.join(' / ')}`;
  if (!b.params || typeof b.params !== 'object' || Array.isArray(b.params)) return 'params 必须是对象';
  const p = b.params;
  if (b.kind === 'image' && !p.prompt) return 'image 任务需要 params.prompt';
  if (b.kind === 'video' && !(p.prompt || p.imageUrl || p.firstFrameUrl || (p.referenceUrls && p.referenceUrls.length))) return 'video 任务需要 prompt 或图片';
  if (b.kind === 'tts' && !p.text) return 'tts 任务需要 params.text';
  return null;
}

/** REST handlers for /api/v1/ai-tasks. `worker` is optional (woken after retry). */
function aiTaskRoutes(store, log, worker, { spend } = {}) {
  return {
    /** POST /ai-tasks { idempotency_key, provider, kind: image|video|tts, params, project_id? } */
    create(req, res) {
      try {
        const b = req.body || {};
        const key = typeof b.idempotency_key === 'string' ? b.idempotency_key.trim() : '';
        if (!key || key.length > 200) return response.badRequest(res, 'idempotency_key 必填（最长 200 字符）');
        const existing = store.getByKey(key);
        if (existing) return response.success(res, { ...toView(existing), created: false });
        const err = validateSpec(b);
        if (err) return response.badRequest(res, err);
        const params = { ...b.params };
        if (b.project_id != null && b.project_id !== '') params._project = String(b.project_id);
        if (spend) {
          const v = spend.check({ provider: b.provider, kind: b.kind, params });
          if (!v.ok) return response.error(res, 402, 'SPEND_LIMIT', v.message, { reason: v.reason, estimate: v.est.estimate, max: v.est.max, currency: v.est.currency });
        }
        const { task, created } = store.enqueue({ idempotencyKey: key, provider: b.provider, kind: b.kind, params });
        if (created && worker) worker.wake();
        const view = { ...toView(task), created };
        if (created) response.created(res, view); else response.success(res, view);
      } catch (e) {
        log.error('ai-tasks create', { error: e.message });
        response.internalError(res, e.message);
      }
    },
    list(req, res) {
      try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 50));
        const { items, total } = store.list({ state: req.query.state, provider: req.query.provider, limit: pageSize, offset: (page - 1) * pageSize });
        response.successWithPagination(res, items.map(toView), total, page, pageSize);
      } catch (err) {
        log.error('ai-tasks list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    get(req, res) {
      const row = store.get(req.params.id);
      if (!row) return response.notFound(res, '任务不存在');
      response.success(res, toView(row));
    },
    retry(req, res) {
      try {
        const row = store.get(req.params.id);
        if (!row) return response.notFound(res, '任务不存在');
        if (row.state !== 'failed') return response.error(res, 409, 'CONFLICT', '只有失败的任务可以重试');
        if (isUncertain(row) && !(req.body && req.body.force === true)) {
          return response.error(res, 409, 'SUBMIT_UNCERTAIN', '提交结果不确定，重试可能重复扣费。请先到服务商控制台确认；确认无误后以 force=true 重试');
        }
        if (!store.retry(row.id)) return response.error(res, 409, 'CONFLICT', '任务状态已变化');
        if (worker) worker.wake();
        response.success(res, toView(store.get(row.id)));
      } catch (err) {
        log.error('ai-tasks retry', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    cancel(req, res) {
      try {
        const row = store.get(req.params.id);
        if (!row) return response.notFound(res, '任务不存在');
        if (!store.cancel(row.id)) return response.error(res, 409, 'CONFLICT', '任务已结束，无法取消');
        response.success(res, toView(store.get(row.id)));
      } catch (err) {
        log.error('ai-tasks cancel', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = aiTaskRoutes;
module.exports.validateSpec = validateSpec;
