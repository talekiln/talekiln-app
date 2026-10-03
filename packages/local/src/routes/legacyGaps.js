'use strict';
// 四视图统一补的旧接口缺口：
//   GET  /dramas/:id/scenes                     项目场景列表（路由必须注册在 /dramas/:id 之前）
//   POST /characters/:id/add-to-team-library    把角色发布到团队（工作室）共享库，委托工作室服务 publishCharacter
const response = require('../response');
const sceneService = require('../services/sceneService');
const { StudioError } = require('../studio/errors');

function routes(db, log, studio) {
  return {
    dramaScenes: (req, res) => {
      try {
        const id = Number(req.params.id);
        const drama = Number.isInteger(id) && id > 0 ? db.prepare('SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(id) : null;
        if (!drama) return response.notFound(res, '项目不存在');
        response.success(res, sceneService.listByDramaId(db, id));
      } catch (err) {
        log.error('dramas scenes', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    addCharacterToTeamLibrary: async (req, res) => {
      if (!studio || typeof studio.publishCharacter !== 'function') {
        return response.error(res, 501, 'CAPABILITY_NOT_SUPPORTED', '当前版本没有团队共享库（工作室）服务');
      }
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return response.badRequest(res, '角色 id 不合法');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      try {
        response.success(res, await studio.publishCharacter(id, { studio_id: body.studio_id }));
      } catch (err) {
        if (err instanceof StudioError) return response.error(res, err.status || 500, err.code, err.message, err.details);
        log.error('characters add-to-team-library', { error: err && err.message });
        response.internalError(res, err && err.message);
      }
    },
  };
}

module.exports = routes;
