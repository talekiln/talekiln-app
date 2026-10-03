'use strict';
// 本地快照：破坏性操作（重新生成分镜、质量档重跑、删除……）之前自动存一份完整项目备份（ZIP 1.5，和“备份整个项目”同一格式）。
//   位置   <应用数据目录>/snapshots/<dramaId>/<快照 id>.talekiln.zip + <快照 id>.json（原因、时间、标题、大小）
//   保留   最近 5 份；存第 6 份时删最旧的
//   恢复   和“从备份恢复”一样：永远新建一个项目，不碰当前项目
//   接线   install() 把处理函数挂到 hooks.setBeforeDestructive；钩子拿到的是集 id，这里换算成项目 id
const fs = require('fs');
const path = require('path');
const hooks = require('./hooks');
const dramaExportService = require('../services/dramaExportService');
const dramaImportService = require('../services/dramaImportService');

const KEEP = 5;
const ID_RE = /^s\d{13}_[0-9a-f]{4}$/;
const ZIP_EXT = '.talekiln.zip';

const notFound = (m) => Object.assign(new Error(m), { code: 'SNAPSHOT_NOT_FOUND' });

function storageRootOf(cfg) {
  const raw = cfg?.storage?.local_path || './data/storage';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

/** 应用数据目录：库文件所在目录；内存库退到存储目录的上一级。 */
function defaultDir(db, cfg) {
  const base = db && db.name && !db.memory && db.name !== ':memory:' ? path.dirname(path.resolve(db.name)) : path.dirname(storageRootOf(cfg));
  return path.join(base, 'snapshots');
}

function dramaKey(dramaId) {
  const s = String(dramaId);
  if (!/^[1-9]\d{0,17}$/.test(s)) throw notFound(`项目不存在：${s}`);
  return s;
}

function createLocalSnapshots({ db, cfg, log = {}, dir } = {}) {
  const root = dir || defaultDir(db, cfg);
  let lastMs = 0;

  const dramaDir = (key) => path.join(root, key);
  const warn = (msg, extra) => { try { log.warn && log.warn(msg, extra); } catch (_) {} };

  function listSnapshots(dramaId) {
    const key = dramaKey(dramaId);
    const d = dramaDir(key);
    if (!fs.existsSync(d)) return [];
    const out = [];
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith(ZIP_EXT)) continue;
      const id = f.slice(0, -ZIP_EXT.length);
      if (!ID_RE.test(id)) continue;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(d, `${id}.json`), 'utf8')); } catch (_) {}
      const file = path.join(d, f);
      let size = meta.size;
      if (size == null) { try { size = fs.statSync(file).size; } catch (_) { continue; } }
      out.push({
        id,
        reason: meta.reason || null,
        created_at: meta.created_at || new Date(Number(id.slice(1, 14))).toISOString(),
        title: meta.title || null,
        size,
        file,
      });
    }
    return out.sort((a, b) => (a.id < b.id ? 1 : -1)); // id 带毫秒时间戳：字典序即时间序，新的在前
  }

  function prune(key) {
    const all = listSnapshots(key);
    for (const old of all.slice(KEEP)) {
      for (const f of [old.file, path.join(dramaDir(key), `${old.id}.json`)]) { try { fs.unlinkSync(f); } catch (_) {} }
    }
  }

  /** 给项目存一份快照。同步执行：调用返回时状态已经落进文件，之后的破坏性操作不会混进来。 */
  function snapshotEpisode(dramaId, reason) {
    const key = dramaKey(dramaId);
    if (!db.prepare('SELECT 1 FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(key))) throw notFound(`项目不存在：${key}`);
    lastMs = Math.max(Date.now(), lastMs + 1);
    const id = `s${String(lastMs).padStart(13, '0')}_${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
    const d = dramaDir(key);
    const file = path.join(d, `${id}${ZIP_EXT}`);
    const part = path.join(d, `${id}.part`);
    fs.mkdirSync(d, { recursive: true });
    let exported;
    try {
      exported = dramaExportService.exportDrama(db, cfg, log, Number(key), { outFile: part });
      fs.renameSync(part, file);
    } catch (e) {
      try { fs.unlinkSync(part); } catch (_) {}
      throw e;
    }
    const created_at = new Date(lastMs).toISOString();
    try {
      fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify({ id, reason: reason || null, created_at, title: exported.title, size: exported.size }));
    } catch (e) { warn('snapshot sidecar not written', { error: e.message }); }
    prune(key);
    return { id, created_at, file };
  }

  /** 把快照恢复成一个新项目。返回 { drama_id, title }。 */
  function restoreSnapshot(dramaId, snapshotId) {
    const key = dramaKey(dramaId);
    if (typeof snapshotId !== 'string' || !ID_RE.test(snapshotId)) throw notFound('快照不存在');
    const file = path.join(dramaDir(key), `${snapshotId}${ZIP_EXT}`);
    if (!fs.existsSync(file)) throw notFound('快照不存在');
    return dramaImportService.importDrama(db, cfg, log, file);
  }

  /** 挂到“破坏性操作之前”的钩子上。钩子本身会吞掉异常，快照失败不会拦住用户的操作。 */
  function install() {
    hooks.setBeforeDestructive((episodeId, reason) => {
      const row = db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(Number(episodeId));
      if (!row) throw notFound(`集不存在：${episodeId}`);
      return snapshotEpisode(row.drama_id, reason);
    });
  }

  return { snapshotEpisode, listSnapshots, restoreSnapshot, install, dir: root };
}

module.exports = { createLocalSnapshots, KEEP };
