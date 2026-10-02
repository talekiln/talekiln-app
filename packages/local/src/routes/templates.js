'use strict';
// P3-T 模板市场 REST（令牌校验由 app 级 localTokenGuard 统一处理）：
//   GET    /templates                 内置 + 已安装模板，附 pro_available / pro_reason
//   GET    /templates/cloud           云端目录（已签名清单，标注是否已安装）
//   POST   /templates/install         { path } 或 { manifest, source }
//   GET    /templates/:id             清单 + 「套用后会得到」
//   POST   /templates/:id/estimate    逐镜估价（图 + 视频）
//   POST   /templates/:id/apply       { mode:'new'|'episode', drama_id?, title?, character_map:{slot: characterId} }
//   DELETE /templates/:id
const kernel = require('@talekiln/kernel');
const response = require('../response');
const { TemplateError } = require('../templates/errors');
const { ID_RE } = require('../templates/schema');

const KERNEL_STATUS = { NOT_FOUND: 404, GRAPH_NOT_FOUND: 404 };

function routes(templates, log) {
  const wrap = (name, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof TemplateError) return response.error(res, err.status, err.code, err.message, err.details);
      if (err instanceof kernel.KernelError) return response.error(res, KERNEL_STATUS[err.code] || 400, err.code, err.message);
      if (err && err.name === 'CloudError') return response.error(res, 503, 'CLOUD_UNREACHABLE', '无法连接云端，请检查网络后重试');
      log && log.error && log.error('templates ' + name, { error: err && err.message });
      response.internalError(res, err && err.message);
    }
  };
  const idOf = (req) => {
    const id = String(req.params.id || '');
    if (!ID_RE.test(id)) throw new TemplateError('NOT_FOUND', `模板不存在：${id}`, 404);
    return id;
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  return {
    list: wrap('list', async (req, res) => response.success(res, await templates.list())),
    cloud: wrap('cloud', async (req, res) => response.success(res, await templates.cloudCatalog())),
    get: wrap('get', async (req, res) => response.success(res, templates.get(idOf(req)))),
    estimate: wrap('estimate', async (req, res) => response.success(res, templates.estimate(idOf(req)))),
    apply: wrap('apply', async (req, res) => {
      const b = body(req);
      const r = await templates.apply(idOf(req), {
        mode: b.mode || 'new', dramaId: b.drama_id ?? b.dramaId, title: b.title,
        characterMap: b.character_map ?? b.characterMap ?? {}, tx_id: typeof b.tx_id === 'string' && b.tx_id ? b.tx_id : undefined,
      });
      response.created(res, r);
    }),
    install: wrap('install', async (req, res) => {
      const b = body(req);
      response.created(res, await templates.install({ path: b.path, manifest: b.manifest, source: b.source }));
    }),
    remove: wrap('remove', async (req, res) => response.success(res, templates.remove(idOf(req)))),
  };
}

module.exports = routes;
