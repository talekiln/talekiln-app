'use strict';
// P3-C 角色一致性 REST：
//   GET  /episodes/:id/consistency                    每镜头最好 / 最差分、对应实体、建议、重做估价
//   POST /shots/:id/consistency/rescore               重评该镜头当前采用的首帧图与视频（:id = 旧表 storyboard id；节点 id 需带 episode_id）
//   POST /characters/:id/references/auto-pick         { lock?: boolean } 候选参考图排序；lock=true 锁定第一名
const kernel = require('@talekiln/kernel');
const response = require('../response');
const { ConsistencyError } = require('../consistency');

const KERNEL_STATUS = { NOT_FOUND: 404, GRAPH_NOT_FOUND: 404 };

function routes(service, log) {
  const guard = (name, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ConsistencyError) return response.error(res, err.status, err.code, err.message, err.details);
      if (err instanceof kernel.KernelError) return response.error(res, KERNEL_STATUS[err.code] || 400, err.code, err.message);
      log.error('consistency ' + name, { error: err.message });
      response.internalError(res, err.message);
    }
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  return {
    episodeReport: guard('report', async (req, res) => {
      response.success(res, await service.episodeReport(req.params.id));
    }),
    rescore: guard('rescore', async (req, res) => {
      const b = body(req);
      response.success(res, await service.rescoreShot({ id: req.params.id, episode_id: b.episode_id ?? req.query.episode_id }));
    }),
    autoPick: guard('auto-pick', async (req, res) => {
      response.success(res, await service.autoPickCharacter(req.params.id, { lock: body(req).lock === true }));
    }),
  };
}

module.exports = routes;
