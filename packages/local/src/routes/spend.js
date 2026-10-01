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
