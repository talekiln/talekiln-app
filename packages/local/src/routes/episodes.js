'use strict';
// 剧集反查与角色提取：
//   GET  /episodes/:id                       -> { id, drama_id, episode_number, title }（只有剧集 id 时反查所属项目）
//   POST /episodes/:id/characters/extract    -> { task_id, status }，任务结果 { characters, count }（委托 characterGenerationService）
const response = require('../response');

function routes(db, cfg, log) {
  const findEpisode = (raw) => {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return null;
    return db.prepare(
      'SELECT id, drama_id, episode_number, title, script_content FROM episodes WHERE id = ? AND deleted_at IS NULL'
    ).get(id) || null;
  };

  return {
    getOne: (req, res) => {
      try {
        const ep = findEpisode(req.params.id);
        if (!ep) return response.notFound(res, '剧集不存在');
        response.success(res, { id: ep.id, drama_id: ep.drama_id, episode_number: ep.episode_number, title: ep.title });
      } catch (err) {
        log.error('episodes getOne', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    // 从本集剧本提取角色：用本集剧本当提示词里的大纲，提取到的角色按本集关联（再次提取会先清掉本集旧关联，由 characterGenerationService 处理）
    extractCharacters: (req, res) => {
      try {
        const ep = findEpisode(req.params.episode_id || req.params.id);
        if (!ep) return response.notFound(res, '剧集不存在');
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const characterGenerationService = require('../services/characterGenerationService');
        const taskId = characterGenerationService.generateCharacters(db, cfg, log, {
          drama_id: ep.drama_id,
          episode_id: ep.id,
          outline: body.outline || ep.script_content || undefined,
          temperature: body.temperature,
          model: body.model,
        });
        response.success(res, { task_id: taskId, status: 'pending' });
      } catch (err) {
        log.error('episodes extractCharacters', { error: err.message });
        response.internalError(res, err.message || '创建任务失败');
      }
    },
  };
}

module.exports = routes;
