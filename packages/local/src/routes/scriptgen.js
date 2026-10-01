const response = require('../response');
const scriptgen = require('../scriptgen');
const svc = require('../services/scriptgenService');

function routes(db, log) {
  const fail = (res, name, err) => {
    if (err.status === 400) return response.badRequest(res, err.message);
    log.error('scriptgen ' + name, { error: err.message });
    return response.error(res, 502, err.code || 'SCRIPTGEN_FAILED', err.message, err.errors);
  };
  return {
    templates: (req, res) => response.success(res, { templates: scriptgen.listTemplates(), aspect_ratios: svc.ASPECT_RATIOS }),
    // POST /scriptgen/projects: create project + generate storyboard (synchronous; can take tens of seconds)
    createProject: async (req, res) => {
      try { response.created(res, await svc.createProjectFromStory(db, log, req.body)); } catch (err) { fail(res, 'create', err); }
    },
    // PUT /episodes/:episode_id/storyboards/order  { ids: [] }
    reorder: (req, res) => {
      try { svc.reorderStoryboards(db, req.params.episode_id, req.body && req.body.ids); response.success(res, { ok: true }); } catch (err) { fail(res, 'reorder', err); }
    },
  };
}

module.exports = routes;
