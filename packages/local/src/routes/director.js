'use strict';
// 导演模式 REST（P3-D；令牌校验由 app 级 localTokenGuard 统一处理）：
//   POST /episodes/:id/director/plan                 { message, provider? } -> 轮次记录（status planned | rejected；拒绝原因在 validation.errors）
//   GET  /episodes/:id/director/turns?limit=         轮次列表（新在前，带撤销栈里的实时状态 history_state）
//   POST /episodes/:id/director/turns/:turnId/apply  合成一个内核事务执行（tx_id director:<turnId>）
//   POST /episodes/:id/director/turns/:turnId/undo   只在该事务位于撤销栈顶时撤销，否则 409 DIRECTOR_NOT_ON_TOP
const kernel = require('@talekiln/kernel');
const response = require('../response');
const { DirectorError } = require('../director');

const KERNEL_STATUS = { NOT_FOUND: 404, GRAPH_NOT_FOUND: 404, NOTHING_TO_UNDO: 409, NOTHING_TO_REDO: 409 };

function routes(service, log) {
  function guard(name, fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof DirectorError) return response.error(res, err.status || 400, err.code, err.message, err.details);
        if (err instanceof kernel.KernelError) return response.error(res, KERNEL_STATUS[err.code] || 400, err.code, err.message);
        log.error('director ' + name, { error: err && err.message });
        response.internalError(res, err && err.message);
      }
    };
  }
  const ep = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new DirectorError('BAD_REQUEST', 'episode id must be a positive integer');
    return id;
  };
  const turnOf = (req, id) => {
    const t = Number(req.params.turnId);
    if (!Number.isInteger(t) || t <= 0) throw new DirectorError('BAD_REQUEST', 'turnId must be a positive integer');
    const turn = service.get(t, { raw: false });
    if (turn.episode_id !== id) throw new DirectorError('NOT_FOUND', `导演模式记录 ${t} 不属于分集 ${id}`, 404);
    return t;
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  return {
    plan: guard('plan', async (req, res) => {
      const id = ep(req);
      const b = body(req);
      const turn = await service.plan(id, b.message, { provider: typeof b.provider === 'string' ? b.provider : undefined });
      response.success(res, turn);
    }),
    turns: guard('turns', (req, res) => {
      const id = ep(req);
      response.success(res, { turns: service.list(id, { limit: req.query.limit }) });
    }),
    apply: guard('apply', (req, res) => {
      const id = ep(req);
      const r = service.apply(turnOf(req, id));
      response.success(res, { turn: r.turn, ...r.result });
    }),
    undo: guard('undo', (req, res) => {
      const id = ep(req);
      const r = service.undo(turnOf(req, id));
      response.success(res, { turn: r.turn, ...r.result });
    }),
  };
}

module.exports = routes;
