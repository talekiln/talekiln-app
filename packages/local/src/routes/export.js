'use strict';
const response = require('../response');
const { ExportError } = require('../export/service');
const aigc = require('../export/aigc');
const { TimelineError } = require('../timeline');

/** REST handlers for /api/v1/export (G06) and /api/v1/settings/aigc (G04). `exporter` may be null when lycore is not wired. */
function exportRoutes(db, exporter, log) {
  const wrap = (name, fn) => async (req, res) => {
    try {
      if (!exporter) throw new ExportError('渲染核心未启动，无法导出。请重启应用后重试', 503, 'CORE_UNAVAILABLE');
      await fn(req, res);
    } catch (err) {
      if (err instanceof ExportError || err instanceof TimelineError) {
        return response.error(res, err.status, err.code, err.message, err.details);
      }
      log.error('export ' + name, { error: err && err.message });
      response.internalError(res, err && err.message);
    }
  };
  return {
    /** GET /export/options?episode_id= -> presets, default path, AIGC settings, detected encoders (when core is up) */
    options: wrap('options', async (req, res) => {
      const d = exporter.defaults(req.query.episode_id);
      let enc = null;
      try { enc = await exporter.detectEncoders({ refresh: req.query.refresh === '1' }); } catch (e) {
        if (!(e instanceof ExportError)) throw e;
        return response.error(res, e.status, e.code, e.message);
      }
      response.success(res, { ...d, encoders: enc.encoders || [], best_encoder: enc.best || null });
    }),
    start: wrap('start', async (req, res) => response.created(res, await exporter.start(req.body || {}))),
    status: wrap('status', async (req, res) => response.success(res, await exporter.status(req.params.id))),
    cancel: wrap('cancel', async (req, res) => response.success(res, await exporter.cancel(req.params.id))),
    openFolder: wrap('open', async (req, res) => response.success(res, exporter.openFolder(req.params.id))),

    getAigc: (req, res) => {
      try { response.success(res, aigc.getSettings(db)); } catch (e) { response.internalError(res, e.message); }
    },
    putAigc: (req, res) => {
      try { response.success(res, aigc.setSettings(db, req.body || {})); } catch (e) {
        if (e instanceof aigc.AigcError) return response.badRequest(res, e.message);
        log.error('aigc settings', { error: e.message });
        response.internalError(res, e.message);
      }
    },
  };
}

module.exports = exportRoutes;
