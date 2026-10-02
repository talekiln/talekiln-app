'use strict';
const response = require('../response');
const { validateSpec } = require('./aiTasks');

/** REST handlers for /api/v1/spend (D06). */
function spendRoutes(spend, log) {
  const guard = (name, fn) => (req, res) => {
    try { fn(req, res); } catch (err) {
      if (err instanceof RangeError) return response.badRequest(res, err.message);
      log.error(`spend ${name}`, { error: err.message });
      response.internalError(res, err.message);
    }
  };
  const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  return {
    summary: guard('summary', (req, res) => {
      if ((req.query.from && !day(req.query.from)) || (req.query.to && !day(req.query.to))) return response.badRequest(res, 'from/to 格式应为 YYYY-MM-DD');
      response.success(res, spend.summary({ from: day(req.query.from), to: day(req.query.to) }));
    }),
    /** GET /spend/tasks?from&to&project_id&limit&offset -> { items, total, ... } (per-task cost view) */
    tasks: guard('tasks', (req, res) => {
      if ((req.query.from && !day(req.query.from)) || (req.query.to && !day(req.query.to))) return response.badRequest(res, 'from/to 格式应为 YYYY-MM-DD');
      const { limit, offset, project_id: projectId } = req.query;
      response.success(res, spend.listTasks({ from: day(req.query.from), to: day(req.query.to), project_id: projectId, limit, offset }));
    }),
    /** GET /spend/export?from&to -> CSV attachment (all rows in range) */
    exportCsv: guard('export', (req, res) => {
      if ((req.query.from && !day(req.query.from)) || (req.query.to && !day(req.query.to))) return response.badRequest(res, 'from/to 格式应为 YYYY-MM-DD');
      const { items } = spend.listTasks({ from: day(req.query.from), to: day(req.query.to), project_id: req.query.project_id, limit: 100000 });
      const name = `spend-${day(req.query.from) || 'all'}_${day(req.query.to) || 'now'}.csv`;
      res.status(200);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${name}"`);
      res.send(spend.toCsv(items));
    }),
    getLimits: guard('limits', (req, res) => response.success(res, spend.getLimits())),
    putLimits: guard('limits', (req, res) => {
      const b = req.body || {};
      if (!('per_run_cap' in b) && !('monthly_cap' in b)) return response.badRequest(res, '需要 per_run_cap 或 monthly_cap（null 表示不限制）');
      response.success(res, spend.setLimits(b));
    }),
    /** POST /spend/estimate { provider, kind, params } -> { estimate, max, ..., allowed, limit_reason? } */
    estimate: guard('estimate', (req, res) => {
      const b = req.body || {};
      const err = validateSpec(b);
      if (err) return response.badRequest(res, err);
      const v = spend.check({ provider: b.provider, kind: b.kind, params: b.params });
      response.success(res, { ...v.est, allowed: v.ok, ...(v.ok ? {} : { error_code: 'SPEND_LIMIT', limit_reason: v.reason, message: v.message }) });
    }),
  };
}

module.exports = spendRoutes;
