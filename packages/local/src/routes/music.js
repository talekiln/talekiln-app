'use strict';
const multer = require('multer');
const response = require('../response');
const { MusicError, MAX_BYTES, attachMusic } = require('../music');
const { TimelineError } = require('../timeline');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

/** REST handlers for the music library (F05) and attaching a track to a timeline. */
function musicRoutes(db, library, log) {
  const fail = (res, name, err) => {
    if (err instanceof MusicError || err instanceof TimelineError) return response.error(res, err.status, err.code, err.message);
    if (err && err.code === 'LIMIT_FILE_SIZE') return response.error(res, 413, 'FILE_TOO_LARGE', '音乐文件不能超过 50MB');
    log.error('music ' + name, { error: err && err.message });
    return response.internalError(res, err && err.message);
  };
  return {
    multerSingle: (req, res, next) => upload.single('file')(req, res, (err) => (err ? fail(res, 'upload', err) : next())),
    list: (req, res) => {
      try { response.success(res, { items: library.list() }); } catch (e) { fail(res, 'list', e); }
    },
    import: async (req, res) => {
      try {
        if (!req.file) return response.badRequest(res, '请选择音乐文件');
        // multer decodes multipart file names as latin1
        const original = Buffer.from(req.file.originalname || '', 'latin1').toString('utf8');
        const hint = Number(req.body && req.body.duration_ms);
        const item = await library.importFile({
          buffer: req.file.buffer,
          originalName: original,
          name: req.body && req.body.name,
          durationHintMs: Number.isInteger(hint) ? hint : undefined,
        });
        response.created(res, item);
      } catch (e) { fail(res, 'import', e); }
    },
    remove: (req, res) => {
      try { response.success(res, library.remove(req.params.id)); } catch (e) { fail(res, 'remove', e); }
    },
    /** POST /timelines/:id/music { music_id, start_ms?, loop?, volume? } */
    attach: (req, res) => {
      try {
        const b = req.body || {};
        if (!b.music_id) return response.badRequest(res, '需要 music_id');
        response.created(res, attachMusic(db, library, Number(req.params.id), b.music_id, { start_ms: b.start_ms, loop: b.loop === true, volume: b.volume }));
      } catch (e) { fail(res, 'attach', e); }
    },
  };
}

module.exports = musicRoutes;
