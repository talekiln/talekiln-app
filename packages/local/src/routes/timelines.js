const response = require('../response');
const timeline = require('../timeline');

function routes(db, log) {
  function guard(name, fn) {
    return (req, res) => {
      try {
        fn(req, res);
      } catch (err) {
        if (err instanceof timeline.TimelineError) return response.error(res, err.status, err.code, err.message);
        log.error('timelines ' + name, { error: err.message });
        response.internalError(res, err.message);
      }
    };
  }
  const tid = (req) => Number(req.params.id);

  return {
    getByEpisode: guard('get', (req, res) => {
      const tl = timeline.loadTimelineByEpisode(db, req.params.episode_id);
      if (!tl) return response.notFound(res, '该剧集尚无时间线');
      response.success(res, tl);
    }),
    assemble: guard('assemble', (req, res) => {
      const existed = timeline.loadTimelineByEpisode(db, req.params.episode_id) != null;
      const tl = timeline.assembleFromStoryboard(db, req.params.episode_id, { replace: req.body?.replace === true });
      (existed ? response.success : response.created)(res, tl);
    }),
    save: guard('save', (req, res) => {
      response.success(res, timeline.saveTimeline(db, { ...(req.body || {}), id: tid(req) }));
    }),
    addClip: guard('addClip', (req, res) => {
      const { track, ...data } = req.body || {};
      response.created(res, timeline.addClip(db, tid(req), track, data));
    }),
    patchClip: guard('patchClip', (req, res) => {
      const body = req.body || {};
      const id = tid(req);
      const clipId = req.params.clip_id;
      switch (body.op) {
        case 'move': return response.success(res, timeline.moveClip(db, id, clipId, body));
        case 'trim': return response.success(res, timeline.trimClip(db, id, clipId, body));
        case 'split': return response.success(res, timeline.splitClip(db, id, clipId, body));
        case 'delete': return response.success(res, timeline.deleteClip(db, id, clipId));
        default: return response.badRequest(res, 'op must be one of move, trim, split, delete');
      }
    }),
  };
}

module.exports = routes;
