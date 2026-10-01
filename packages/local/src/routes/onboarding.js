const path = require('path');
const response = require('../response');
const onboarding = require('../services/onboardingService');
const samples = require('../services/sampleProjectService');

function storageRootOf(cfg) {
  const p = cfg && cfg.storage && cfg.storage.local_path;
  if (!p) return path.join(process.cwd(), 'data', 'storage');
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function routes(db, log, cfg) {
  const fail = (res, name, err) => {
    if (err.status === 400) return response.badRequest(res, err.message);
    if (err.status === 404) return response.notFound(res, err.message);
    log.error('onboarding ' + name, { error: err.message });
    return response.internalError(res, '操作失败');
  };
  return {
    status: (req, res) => { try { response.success(res, onboarding.getStatus(db)); } catch (e) { fail(res, 'status', e); } },
    saveState: (req, res) => { try { response.success(res, onboarding.saveState(db, req.body)); } catch (e) { fail(res, 'state', e); } },
    test: async (req, res) => {
      try { response.success(res, await onboarding.testSavedConfig(db, req.body && req.body.config_id)); } catch (e) { fail(res, 'test', e); }
    },
    listSamples: (req, res) => { try { response.success(res, samples.listSamples(db)); } catch (e) { fail(res, 'samples', e); } },
    seedSample: async (req, res) => {
      try { response.success(res, await samples.seedSample(db, log, storageRootOf(cfg), req.params.id)); } catch (e) { fail(res, 'seed', e); }
    },
  };
}

module.exports = routes;
