const response = require('../response');
const timeline = require('../timeline');
const compat = require('../kernel/compat');

/** 字幕/配音片段的 id 由图推导（sub_<镜头>），新增后返回的 clip_id 要换成时间线里真正存在的那个。 */
function fixSyntheticClipId(r, kind, data) {
  const track = r.timeline.tracks.find((t) => t.kind === kind);
  if (!track || track.clips.some((c) => c.id === r.clip_id)) return;
  const hit = track.clips.find((c) => c.storyboard_id != null && c.storyboard_id === data.storyboard_id);
  if (hit) r.clip_id = hit.id;
}

function routes(db, log) {
  function guard(name, fn) {
    return (req, res) => {
      try {
        fn(req, res);
      } catch (err) {
        if (compat.handleError(res, err)) return;
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
      const r = compat.assembleTimeline(db, req.params.episode_id, { replace: req.body?.replace === true });
      (r.created ? response.created : response.success)(res, r.timeline);
    }),
    save: guard('save', (req, res) => {
      response.success(res, compat.saveTimelineViaGraph(db, tid(req), req.body || {}));
    }),
    addClip: guard('addClip', (req, res) => {
      const { track, ...data } = req.body || {};
      const r = compat.editTimeline(db, tid(req), (tl) => timeline.transforms.addClip(tl, track, data));
      fixSyntheticClipId(r, track, data);
      response.created(res, r);
    }),
    patchClip: guard('patchClip', (req, res) => {
      const body = req.body || {};
      const id = tid(req);
      const clipId = req.params.clip_id;
      switch (body.op) {
        case 'move': return response.success(res, compat.editTimeline(db, id, (tl) => timeline.transforms.moveClip(tl, clipId, body)));
        case 'trim': return response.success(res, compat.editTimeline(db, id, (tl) => timeline.transforms.trimClip(tl, clipId, body)));
        case 'split': return response.success(res, compat.editTimeline(db, id, (tl) => timeline.transforms.splitClip(tl, clipId, body)));
        case 'delete': return response.success(res, compat.editTimeline(db, id, (tl) => timeline.transforms.deleteClip(tl, clipId)));
        default: return response.badRequest(res, 'op must be one of move, trim, split, delete');
      }
    }),
  };
}

module.exports = routes;
