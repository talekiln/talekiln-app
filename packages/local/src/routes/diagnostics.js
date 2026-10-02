'use strict';
const path = require('path');
const response = require('../response');
const { buildDiagnosticBundle, submitFeedback } = require('../diagnostics');

/** 默认日志位置：本地服务日志（LOG_FILE）与桌面主进程日志（位于 userData 根目录）。 */
function defaultLogFiles(env = process.env) {
  if (!env.LOG_FILE) return [];
  return [env.LOG_FILE, path.join(path.dirname(env.LOG_FILE), '..', '..', 'main.log')];
}

/**
 * /api/v1/diagnostics：
 *   GET  /diagnostics/bundle   导出已脱敏的诊断包 zip（用户自行保存/发给客服，不上传）
 *   POST /diagnostics/feedback { message, contact?, task_id?, include_bundle? } 用户点击“发送”后才上传到云端
 */
function diagnosticsRoutes({ store, log, logFiles = defaultLogFiles, versions = {}, env = process.env, fetchImpl, installId }) {
  const build = () => buildDiagnosticBundle({
    logFiles: logFiles(),
    versions,
    tasks: store ? store.list({ limit: 200 }).items : [],
  });
  return {
    exportBundle(req, res) {
      try {
        const { buffer } = build();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="talekiln-diagnostic-${stamp}.zip"` });
        res.send(buffer);
      } catch (e) {
        log.error('diagnostics export failed', { error: e.message });
        response.internalError(res, '导出诊断包失败');
      }
    },
    async sendFeedback(req, res) {
      const b = req.body || {};
      try {
        const bundle = b.include_bundle ? build().buffer : null;
        const r = await submitFeedback({
          baseUrl: env.TALEKILN_CLOUD_URL, message: b.message, contact: b.contact, taskId: b.task_id,
          bundle, appVersion: versions.app, installId: installId && installId(), fetchImpl,
        });
        response.success(res, r);
      } catch (e) {
        if (['EMPTY_MESSAGE', 'MESSAGE_TOO_LONG', 'BUNDLE_TOO_LARGE', 'NO_CLOUD_URL'].includes(e.code)) return response.badRequest(res, e.message);
        log.error('feedback send failed', { code: e.code, error: e.message });
        response.error(res, e.code === 'RATE_LIMITED' ? 429 : 502, e.code || 'UPSTREAM_ERROR', e.message);
      }
    },
  };
}

module.exports = diagnosticsRoutes;
module.exports.defaultLogFiles = defaultLogFiles;
