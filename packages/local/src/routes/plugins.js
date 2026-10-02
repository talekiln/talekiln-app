'use strict';
/**
 * P3-P 插件页接口：
 *   GET    /plugins                    已安装插件（能力、权限/主机、签名状态与哈希、版本、开关、审核时间）+ 开发者模式
 *   GET    /plugins/:id
 *   POST   /plugins/install { dir }    把本机文件夹复制进插件目录并加载（未签名/无效签名需开发者模式）
 *   POST   /plugins/:id/enable | disable
 *   DELETE /plugins/:id
 *   GET/PUT /settings/developer-mode   { developer_mode: boolean }
 */
const response = require('../response');

function pluginRoutes(host, log = {}) {
  const fail = (res, name, e) => {
    if (e && e.name === 'PluginHostError') return response.error(res, e.status || 400, e.code, e.message);
    if (log.error) log.error(`plugins ${name}`, { error: e && e.message });
    return response.internalError(res, '插件操作失败');
  };
  const wrap = (name, fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, name, e); } };
  const summary = () => ({ items: host.list(), developer_mode: host.developerMode(), plugins_dir: host.pluginsDir });

  return {
    list: wrap('list', (req, res) => response.success(res, summary())),
    get: wrap('get', (req, res) => response.success(res, host.get(req.params.id))),
    enable: wrap('enable', (req, res) => response.success(res, host.setEnabled(req.params.id, true))),
    disable: wrap('disable', (req, res) => response.success(res, host.setEnabled(req.params.id, false))),
    install: wrap('install', (req, res) => {
      const dir = req.body && req.body.dir;
      if (typeof dir !== 'string' || !dir.trim()) return response.badRequest(res, 'dir 必填（插件文件夹的完整路径）');
      response.success(res, host.install(dir));
    }),
    remove: wrap('remove', (req, res) => response.success(res, host.remove(req.params.id))),
    getDeveloperMode: wrap('developerMode', (req, res) => response.success(res, { developer_mode: host.developerMode() })),
    putDeveloperMode: wrap('developerMode', (req, res) => {
      const v = req.body && req.body.developer_mode;
      if (typeof v !== 'boolean') return response.badRequest(res, 'developer_mode 必须是布尔值');
      host.setDeveloperMode(v);
      response.success(res, summary());
    }),
  };
}

module.exports = pluginRoutes;
