'use strict';
// P3-K 云备份 REST（令牌校验由 app 级 localTokenGuard 统一处理）：
//   GET    /backup/settings            设置（永远不含 Secret Key，只有 has_secret）
//   PUT    /backup/settings            保存设置；secret_key 只写：非空写入密钥存储，null 删除，缺省不动
//   POST   /backup/test                测试连接（可带表单里尚未保存的值）
//   POST   /backup/dramas/:id          立即备份一个项目 -> 201 { run, snapshot }
//   GET    /backup/snapshots?drama_id= 快照列表（离线回落本地记录，source: 'local'）
//   POST   /backup/restore             { key, mode: 'new' } -> 201 { drama_id, title, … }
//   DELETE /backup/snapshots           { key }（或 ?key=）
//   GET    /backup/status
//   GET    /backup/runs?drama_id=&limit=
const response = require('../response');
const { BackupError } = require('../backup/service');
const { S3Error } = require('../backup/s3');

function routes(backup, log) {
  const wrap = (name, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof BackupError) return response.error(res, err.status, err.code, err.message, err.details);
      if (err instanceof S3Error) return response.error(res, err.status, err.code === 'NOT_FOUND' ? 'NOT_FOUND' : err.code, err.message);
      if (err && err.code === 'SECRET_STORE_UNAVAILABLE') return response.error(res, 503, 'SECRET_STORE_UNAVAILABLE', '系统密钥加密不可用，无法保存 Secret Key');
      log && log.error && log.error('backup ' + name, { error: err && err.message });
      response.internalError(res, err && err.message);
    }
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const keyOf = (req) => {
    const k = body(req).key ?? req.query.key;
    if (typeof k !== 'string' || !k.trim()) throw new BackupError('BAD_REQUEST', '缺少快照 key', 400);
    return k.trim();
  };

  return {
    getSettings: wrap('getSettings', async (req, res) => response.success(res, backup.getSettings())),
    putSettings: wrap('putSettings', async (req, res) => response.success(res, backup.putSettings(body(req)))),
    test: wrap('test', async (req, res) => response.success(res, await backup.testConnection(body(req)))),
    backupDrama: wrap('backupDrama', async (req, res) => response.created(res, await backup.backupDrama(req.params.id, { trigger: 'manual' }))),
    snapshots: wrap('snapshots', async (req, res) => response.success(res, await backup.listSnapshots(req.query.drama_id))),
    restore: wrap('restore', async (req, res) => {
      const b = body(req);
      response.created(res, await backup.restore(keyOf(req), { mode: b.mode || 'new' }));
    }),
    deleteSnapshot: wrap('deleteSnapshot', async (req, res) => response.success(res, await backup.deleteSnapshot(keyOf(req)))),
    status: wrap('status', async (req, res) => response.success(res, backup.status())),
    runs: wrap('runs', async (req, res) => response.success(res, { items: backup.listRuns({ dramaId: req.query.drama_id, limit: req.query.limit }) })),
  };
}

module.exports = routes;
