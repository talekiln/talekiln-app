'use strict';
const response = require('../response');
const { toView, isUncertain } = require('../queue/taskView');

/** REST handlers for /api/v1/ai-tasks. `worker` is optional (woken after retry). */
function aiTaskRoutes(store, log, worker) {
  return {
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
