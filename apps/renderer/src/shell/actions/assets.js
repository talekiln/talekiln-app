// assets lane 的 action 表：{ 'action.id': (ctx) => void | Promise<void> }
// ctx = { router, route, dramaId, episodeId, openDialog, store }。由 actions/index.js 统一注册。
// 只有 assets lane 修改本文件。
export default {
  // 左栏“提取资产”：从当前分集剧本提取角色 / 场景 / 道具
  'assets.extract': ({ openDialog }) => openDialog('assets.extract', {}),
  // 左栏“从素材库导入”
  'assets.importFromGlobal': ({ openDialog }) => openDialog('assets.globalLibrary', {}),
  // 新建资产：params 里没有 kind 时从角色开始（action 没有参数，需要指定类别请直接 openDialog('assets.edit', { kind })）
  'assets.create': ({ openDialog }) => openDialog('assets.edit', { kind: 'characters' }),
}
