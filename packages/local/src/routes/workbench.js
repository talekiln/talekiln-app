'use strict';
const response = require('../response');
const referenceLockService = require('../services/referenceLockService');
const videoService = require('../services/videoService');
const kernelInputs = require('../kernel/inputs');

/** P1-07 reference locks and P1-08 shot candidate/adopt endpoints. */
function routes(db, log) {
  const typeOf = (req) => String(req.params.type || '');
  const guard = (name, fn) => (req, res) => {
    try { fn(req, res); } catch (err) {
      log.error(name, { error: err.message });
      if (/must be|required/.test(err.message)) return response.badRequest(res, err.message);
      response.internalError(res, err.message);
    }
  };
  const syncRefs = () => {
    try { for (const r of kernelInputs.syncReferences(db)) if (r.error) log.error('reference-locks sync', { episode_id: r.episode_id, error: r.error }); } catch (e) { log.error('reference-locks sync', { error: e.message }); }
  };
  return {
    listLocks: guard('reference-locks list', (req, res) => {
      const ids = String(req.query.ids || '').split(',').filter(Boolean);
      response.success(res, referenceLockService.listLocks(db, String(req.query.type || ''), ids));
    }),
    // 锁定/解除参考图后，把各剧集镜头的参考图哈希同步进图（经内核事务）：受影响镜头的 image/video/合成立刻变“过期”
    setLock: guard('reference-locks set', (req, res) => {
      const lock = referenceLockService.setLock(db, typeOf(req), req.params.id, req.body || {});
      syncRefs();
      response.success(res, lock);
    }),
    clearLock: guard('reference-locks clear', (req, res) => {
      referenceLockService.clearLock(db, typeOf(req), req.params.id);
      syncRefs();
      response.success(res, { message: '已解除锁定' });
    }),
    candidates: guard('video-candidates', (req, res) => {
      const out = videoService.listCandidates(db, req.params.id);
      if (!out) return response.notFound(res, '分镜不存在');
      response.success(res, out);
    }),
    adopt: guard('adopt-video', (req, res) => {
      const out = videoService.adoptCandidate(db, req.params.id, (req.body || {}).video_id);
      if (!out.ok) return out.status === 404 ? response.notFound(res, out.error) : response.badRequest(res, out.error);
      response.success(res, { adopted_video_id: out.adopted_video_id, items: out.items });
    }),
  };
}

module.exports = routes;
