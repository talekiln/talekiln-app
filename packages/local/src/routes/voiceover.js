'use strict';
// 旁白配音 REST（令牌由 app 级 localTokenGuard 统一校验）。配音走持久队列（任务中心可见），由 voiceover/queue.js 编排。
//   GET  /voiceover/voices                 音色清单
//   POST /episodes/:id/voiceover           { shots: [id...] | all: true, voice?, force?, confirm? }
//        all 模式跳过已有最新旁白的镜头，force: true 则全部重做
//        confirm 缺省/false：只估价，不建任务（返回 confirm_required: true）
//        confirm: true：先过花费上限（超限 402），再把音色写进节点、建 tts 任务；任务成功时经内核 recordGeneration 写回
//        返回 { ...估价, confirmed: true, tasks: [{ shot_id, legacy_id, outcome, task_id, state }], skipped }
//   GET  /episodes/:id/voiceover/status    每镜头旁白状态（none / queued / running / failed / stale / fresh）
const kernel = require('@talekiln/kernel');
const response = require('../response');
const svc = require('../voiceover/service');
const { VoiceoverError } = require('../voiceover/queue');

const { KernelError } = kernel;
const STATUS = { NOT_FOUND: 404, GRAPH_NOT_FOUND: 404 };

/** voiceover: voiceover/queue.js 的服务实例（preview / create / status）。 */
function routes(db, log, voiceover) {
  const ep = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new KernelError('INVALID_OP', 'episode id must be a positive integer');
    return id;
  };

  const fail = (res, name, err) => {
    if (err instanceof VoiceoverError) return response.error(res, err.status, err.code, err.message, err.details);
    if (err instanceof KernelError) return response.error(res, STATUS[err.code] || 400, err.code, err.message);
    log.error(name, { error: err.message });
    response.internalError(res, err.message);
  };

  return {
    voices: (req, res) => response.success(res, { voices: svc.VOICES, default: svc.DEFAULT_VOICE }),

    voiceover: (req, res) => {
      try {
        const episodeId = ep(req);
        const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        if (b.voice !== undefined && (typeof b.voice !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(b.voice))) return response.badRequest(res, 'voice 格式不正确');
        const all = b.all === true || b.shots === 'all';
        if (!all && !(Array.isArray(b.shots) && b.shots.length)) return response.badRequest(res, '需要 shots（镜头 id 数组）或 all: true');
        const args = { shots: b.shots, all, voice: b.voice, force: b.force === true, provider: typeof b.provider === 'string' ? b.provider : undefined };
        if (b.confirm !== true) return response.success(res, voiceover.preview(episodeId, args));
        response.success(res, voiceover.create(episodeId, args));
      } catch (err) { fail(res, 'voiceover', err); }
    },

    status: (req, res) => {
      try { response.success(res, voiceover.status(ep(req))); } catch (err) { fail(res, 'voiceover status', err); }
    },
  };
}

module.exports = routes;
