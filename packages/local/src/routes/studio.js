'use strict';
// P3-S 工作室 REST（令牌校验由 app 级 localTokenGuard 统一处理）。身份与成员管理转发云端；共享库读写对象存储。
//   GET    /studio/identity?sync=1                我所在的工作室（缓存 / 同步）、当前选择
//   PUT    /studio/current                        { studio_id } 切换当前工作室
//   POST   /studio/studios                        { name } 创建工作室（云端；席位数用云端默认值，定价待定）
//   GET    /studio/studios/:id                    详情：成员、席位、未处理邀请（owner / admin）
//   POST   /studio/studios/:id/invites            { email?, role?, expiresInDays? } -> 201 邀请码
//   DELETE /studio/studios/:id/invites/:inviteId  撤销邀请
//   POST   /studio/accept                         { code } 接受邀请
//   DELETE /studio/studios/:id/members/:accountId 移除成员 / 退出
//   PUT    /studio/studios/:id/members/:accountId/role  { role }
//   GET    /studio/shared/:kind?studio_id=        共享库列表（kind = characters | templates）
//   POST   /studio/shared/characters/publish      { character_id, studio_id? } -> 201
//   POST   /studio/shared/characters/pull         { shared_id, studio_id?, drama_id? } -> 201
//   POST   /studio/shared/templates/publish       { template_id, studio_id? } -> 201
//   POST   /studio/shared/templates/pull          { shared_id, studio_id? } -> 201
//   GET    /studio/records?studio_id=&kind=       本机发布 / 拉取记录
const response = require('../response');
const { StudioError } = require('../studio/errors');
const { BackupError } = require('../backup/service');
const { S3Error } = require('../backup/s3');

const KIND_OF = { characters: 'character', templates: 'template' };

function routes(studio, log) {
  const wrap = (name, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof StudioError || err instanceof BackupError || (err && err.name === 'TemplateError')) return response.error(res, err.status || 500, err.code, err.message, err.details);
      if (err instanceof S3Error) return response.error(res, err.status, err.code === 'NOT_FOUND' ? 'NOT_FOUND' : err.code, err.message);
      log && log.error && log.error('studio ' + name, { error: err && err.message });
      response.internalError(res, err && err.message);
    }
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const need = (v, what) => {
    if (v === undefined || v === null || v === '') throw new StudioError('BAD_REQUEST', `缺少 ${what}`, 400);
    return v;
  };
  const kindOf = (req) => {
    const k = KIND_OF[String(req.params.kind)];
    if (!k) throw new StudioError('BAD_REQUEST', 'kind 须为 characters 或 templates', 400);
    return k;
  };

  return {
    identity: wrap('identity', async (req, res) => response.success(res, await studio.identity({ sync: req.query.sync === '1' || req.query.sync === 'true' }))),
    setCurrent: wrap('setCurrent', async (req, res) => response.success(res, studio.setCurrent(need(body(req).studio_id, 'studio_id')))),
    createStudio: wrap('createStudio', async (req, res) => response.created(res, await studio.createStudio({ name: body(req).name }))),
    detail: wrap('detail', async (req, res) => response.success(res, await studio.detail(req.params.id))),
    invite: wrap('invite', async (req, res) => response.created(res, await studio.invite(req.params.id, body(req)))),
    revokeInvite: wrap('revokeInvite', async (req, res) => { await studio.revokeInvite(req.params.id, req.params.inviteId); response.success(res, { ok: true }); }),
    accept: wrap('accept', async (req, res) => response.success(res, await studio.accept({ code: need(body(req).code, 'code') }))),
    removeMember: wrap('removeMember', async (req, res) => { await studio.removeMember(req.params.id, req.params.accountId); response.success(res, { ok: true }); }),
    setRole: wrap('setRole', async (req, res) => response.success(res, await studio.setRole(req.params.id, req.params.accountId, { role: body(req).role }))),
    listShared: wrap('listShared', async (req, res) => response.success(res, await studio.listShared(req.query.studio_id, kindOf(req)))),
    publishCharacter: wrap('publishCharacter', async (req, res) => {
      const b = body(req);
      response.created(res, await studio.publishCharacter(need(b.character_id, 'character_id'), { studio_id: b.studio_id }));
    }),
    pullCharacter: wrap('pullCharacter', async (req, res) => {
      const b = body(req);
      response.created(res, await studio.pullCharacter(b.studio_id, need(b.shared_id, 'shared_id'), { drama_id: b.drama_id }));
    }),
    publishTemplate: wrap('publishTemplate', async (req, res) => {
      const b = body(req);
      response.created(res, await studio.publishTemplate(need(b.template_id, 'template_id'), { studio_id: b.studio_id }));
    }),
    pullTemplate: wrap('pullTemplate', async (req, res) => {
      const b = body(req);
      response.created(res, await studio.pullTemplate(b.studio_id, need(b.shared_id, 'shared_id')));
    }),
    records: wrap('records', async (req, res) => {
      const s = await studio.studioFor(req.query.studio_id);
      const kind = req.query.kind ? KIND_OF[String(req.query.kind)] || String(req.query.kind) : null;
      response.success(res, { studio_id: s.id, items: studio.records(s.id, kind) });
    }),
  };
}

module.exports = routes;
