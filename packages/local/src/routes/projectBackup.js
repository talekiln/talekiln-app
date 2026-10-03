'use strict';
// 完整项目备份与本地快照（spec §10.3）
//   POST /dramas/:id/backup/full              流式下载 <项目名>.talekiln.zip（格式 1.5）
//   POST /dramas/restore                      上传 .talekiln.zip（multipart 字段 file）-> 新建项目，返回 { drama_id, title }
//   GET  /dramas/:id/snapshots                本地快照列表（新的在前）
//   POST /dramas/:id/snapshots/:sid/restore   把某份快照恢复成新项目
// 恢复永远新建项目，不碰原项目。包损坏 -> 400 BACKUP_CORRUPT；包来自更新版本 -> 400 BACKUP_VERSION_UNSUPPORTED。
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const response = require('../response');
const dramaExportService = require('../services/dramaExportService');
const dramaImportService = require('../services/dramaImportService');
const { createLocalSnapshots } = require('../backup/localSnapshot');

const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // 完整备份带全部媒体，比单集导入大得多

function safeName(title) {
  return String(title || 'project').replace(/[^\w一-鿿-]/g, '_').slice(0, 50) || 'project';
}

function restoreError(res, err, log) {
  if (err && err.code === 'BACKUP_CORRUPT') return response.error(res, 400, 'BACKUP_CORRUPT', err.message);
  if (err && err.code === 'BACKUP_VERSION_UNSUPPORTED') return response.error(res, 400, 'BACKUP_VERSION_UNSUPPORTED', err.message);
  if (err && err.code === 'SNAPSHOT_NOT_FOUND') return response.notFound(res, err.message);
  try { log.error('project restore failed', { error: err && err.message }); } catch (_) {}
  return response.internalError(res, (err && err.message) || '恢复失败');
}

/**
 * @param {import('express').Router} r
 * @param {{ db, cfg, log, extras? }} deps
 *   extras.localSnapshots === false  不挂“破坏性操作前自动快照”的钩子（测试用）
 *   extras.snapshotDir               快照目录（默认：库文件旁的 snapshots/）
 *   extras.backupTmpDir              完整备份的临时文件目录（默认系统临时目录）
 */
function register(r, { db, cfg, log, extras = {} }) {
  const snapshots = createLocalSnapshots({ db, cfg, log, dir: extras.snapshotDir });
  if (extras.localSnapshots !== false) snapshots.install();

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } }).single('file');
  const uploadFile = (req, res, next) => upload(req, res, (err) => {
    if (!err) return next();
    response.error(res, 400, 'BAD_REQUEST', err.code === 'LIMIT_FILE_SIZE' ? '备份文件过大' : `上传失败：${err.message}`);
  });

  r.post('/dramas/:id/backup/full', (req, res) => {
    const tmpDir = extras.backupTmpDir || os.tmpdir();
    const tmp = path.join(tmpDir, `talekiln-backup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.zip`);
    const cleanup = () => { try { fs.unlinkSync(tmp); } catch (_) {} };
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      const out = dramaExportService.exportDrama(db, cfg, log, req.params.id, { outFile: tmp });
      const name = `${safeName(out.title)}.talekiln.zip`;
      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(out.size));
      res.setHeader('Content-Disposition', `attachment; filename="backup.talekiln.zip"; filename*=UTF-8''${encodeURIComponent(name)}`);
      const stream = fs.createReadStream(tmp);
      stream.on('error', (e) => { cleanup(); try { log.error('backup stream failed', { error: e.message }); } catch (_) {} res.destroy(e); });
      res.on('close', cleanup);
      stream.pipe(res);
    } catch (err) {
      cleanup();
      if (err && err.message === '剧本不存在') return response.notFound(res, '项目不存在');
      try { log.error('full backup failed', { error: err && err.message }); } catch (_) {}
      response.internalError(res, (err && err.message) || '备份失败');
    }
  });

  r.post('/dramas/restore', uploadFile, (req, res) => {
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) return response.badRequest(res, '请上传 .talekiln.zip 备份文件');
    try {
      response.created(res, dramaImportService.importDrama(db, cfg, log, req.file.buffer));
    } catch (err) {
      restoreError(res, err, log);
    }
  });

  r.get('/dramas/:id/snapshots', (req, res) => {
    try {
      response.success(res, snapshots.listSnapshots(req.params.id).map(({ file, ...pub }) => pub));
    } catch (err) {
      restoreError(res, err, log);
    }
  });

  r.post('/dramas/:id/snapshots/:sid/restore', (req, res) => {
    try {
      response.created(res, snapshots.restoreSnapshot(req.params.id, req.params.sid));
    } catch (err) {
      restoreError(res, err, log);
    }
  });

  return snapshots;
}

module.exports = { register };
