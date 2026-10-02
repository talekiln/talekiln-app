'use strict';
// P3-R 选镜改片 REST（令牌校验由 app 级 localTokenGuard 统一处理）：
//   POST /shots/:id/edit-region   { t0_ms, t1_ms, rect?, prompt, mode?: 'region'|'segment', confirm?: bool, episode_id? }
//        confirm=false（默认）只返回估算（只重做那一段的价格 + 整镜重做的价格对比）与额度状态，不建任务；
//        confirm=true 通过额度检查后记录一次改片并建队列任务
//   GET  /shots/:id/edit-regions  ?episode_id=   该镜头的改片记录 + 视频节点的内核版本列表
//   POST /shots/:id/adopt-version { version_id, episode_id? }   采用某个视频版本（节点参数跟随版本配方）
// :id 为 storyboards.id（数字）或镜头节点 id（此时需给 episode_id）
const kernel = require('@talekiln/kernel');
const response = require('../response');
const { RegionEditError } = require('../regionEdit');

const KERNEL_STATUS = { NOT_FOUND: 404, GRAPH_NOT_FOUND: 404 };

function routes(service, log) {
  function guard(name, fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof RegionEditError) return response.error(res, err.status, err.code, err.message, err.details);
        if (err instanceof kernel.KernelError) return response.error(res, KERNEL_STATUS[err.code] || 400, err.code, err.message);
        log.error('region edit ' + name, { error: err.message });
        response.internalError(res, err.message);
      }
    };
  }
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const episodeOf = (req, b) => (b.episode_id !== undefined ? b.episode_id : req.query ? req.query.episode_id : undefined);
  // 毫秒允许传数字字符串 / 小数（四舍五入到整数）；其余交给内核校验
  const ms = (v) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v)) : v);

  return {
    editRegion: guard('edit', async (req, res) => {
      const b = body(req);
      const args = { t0_ms: ms(b.t0_ms), t1_ms: ms(b.t1_ms), rect: b.rect, prompt: b.prompt, mode: b.mode === undefined ? 'region' : b.mode, episode_id: episodeOf(req, b) };
      if (b.confirm === true) return response.success(res, await service.submit(req.params.id, args));
      response.success(res, service.estimate(req.params.id, args));
    }),
    listRegions: guard('list', (req, res) => {
      response.success(res, service.listRegions(req.params.id, { episode_id: req.query ? req.query.episode_id : undefined }));
    }),
    adoptVersion: guard('adopt', (req, res) => {
      const b = body(req);
      const args = { version_id: b.version_id, episode_id: episodeOf(req, b) };
      if (typeof b.tx_id === 'string' && b.tx_id) args.tx_id = b.tx_id;
      response.success(res, service.adoptVersion(req.params.id, args));
    }),
  };
}

module.exports = routes;
