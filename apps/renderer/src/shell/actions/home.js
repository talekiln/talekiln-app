// home lane 的 action 表：{ 'action.id': (ctx) => void | Promise<void> }
// ctx = { router, route, dramaId, episodeId, openDialog, store }。由 actions/index.js 统一注册。
// 只有 home lane 修改本文件。导出类 action（export.*）属于生成与导出 lane，不在这里。

// 对话框结束后跳到新项目：新建 / 导入剧本进第 1 集剧本，项目包按上次停留落点。
async function goAfter(ctx, result) {
  const [{ locationAfterDialog }, { dramaAPI }] = await Promise.all([
    import('@/components/home/homeNav.js'),
    import('@/api/drama'),
  ])
  const loc = await locationAfterDialog(result, {
    getDrama: (id) => dramaAPI.get(id),
    lastView: (id) => ctx.store?.lastView?.(id) ?? null,
  })
  if (loc) await ctx.router.push(loc)
}

export default {
  'home.newBlank': async (ctx) => goAfter(ctx, await ctx.openDialog('home.newBlank')),
  'home.importScript': async (ctx) => goAfter(ctx, await ctx.openDialog('home.importScript')),
  'home.importPackage': async (ctx) => goAfter(ctx, await ctx.openDialog('home.importPackage')),
  'home.oneLine': (ctx) => ctx.router.push({ name: 'new-project' }),
  // 顶栏“全局素材库”：和项目内“从素材库导入”是同一个对话框（assets.globalLibrary）。首页没有当前项目，
  // 所以只浏览（browseOnly）；增删改在对话框里的“管理素材库”进入 /media-library 的标签页（GlobalLibraryPanel）。
  'home.globalLibrary': (ctx) => ctx.openDialog('assets.globalLibrary', { kind: 'characters', scope: 'global', browseOnly: true }),
}
