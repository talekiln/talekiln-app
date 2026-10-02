'use strict';
// 生成 REST（令牌校验由 app 级 localTokenGuard 统一处理）：
//   POST /episodes/:id/generate           { shots: [id...] | 'all', kind: 'image'|'video'|'both', confirm: bool, regenerate?: bool }
//        confirm=false（默认）只返回估算与额度状态，不建任务；confirm=true 通过额度检查后才建任务
//   GET  /episodes/:id/generation/status  每镜头 none / queued / running / stale / fresh / failed
const kernel = require('@talekiln/kernel');
const response = require('../response');
const { GenerationError } = require('../generation');

const KERNEL_STATUS = { NOT_FOUND: 404, GRAPH_NOT_FOUND: 404 };

function routes(service, log, { legacyEnabled = false } = {}) {
  function guard(name, fn) {
    return (req, res) => {
      try {
        fn(req, res);
      } catch (err) {
        if (err instanceof GenerationError) {
          if (err.code === 'SPEND_LIMIT') return response.error(res, 402, 'SPEND_LIMIT', err.message, err.details);
          return response.error(res, err.status, err.code, err.message, err.details);
        }
        if (err instanceof kernel.KernelError) return response.error(res, KERNEL_STATUS[err.code] || 400, err.code, err.message);
        log.error('generation ' + name, { error: err.message });
        response.internalError(res, err.message);
      }
    };
  }
  const ep = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new GenerationError('BAD_REQUEST', 'episode id must be a positive integer');
    return id;
  };

  return {
    generate: guard('generate', (req, res) => {
      const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const id = ep(req);
      const args = { shots: b.shots === undefined ? 'all' : b.shots, kind: b.kind || 'both', regenerate: b.regenerate === true };
      if (typeof b.tx_id === 'string' && b.tx_id) args.tx_id = b.tx_id;
      if (b.confirm === true) return response.success(res, service.create(id, args));
      response.success(res, service.preview(id, args));
    }),
    status: guard('status', (req, res) => {
      response.success(res, { ...service.status(ep(req)), legacy_enabled: legacyEnabled });
    }),
  };
}

module.exports = routes;
