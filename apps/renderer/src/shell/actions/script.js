// script lane 的 action 表：{ 'action.id': (ctx) => void | Promise<void> }
// ctx = { router, route, dramaId, episodeId, openDialog, store }。由 actions/index.js 统一注册。
// 只有 script lane 修改本文件。
// 动态 import：保持本表可在 node --test 下加载（@ 别名只有 Vite 认识）。
const ops = () => import('@/components/script/episodeOps')

const currentEpisode = (ctx) => (ctx.store?.episodes || []).find((e) => Number(e.id) === Number(ctx.episodeId)) || null

export default {
  'script.addEpisode': async (ctx) => (await ops()).addEpisode({ dramaId: ctx.dramaId, router: ctx.router }),

  // 批量导入：打开导入对话框（粘贴 / TXT / 章节切分 / 剧本库）
  'script.importEpisodes': (ctx) => ctx.openDialog('script.importScript', { dramaId: ctx.dramaId, episodeId: ctx.episodeId }),

  'script.renameEpisode': async (ctx) => {
    const episode = currentEpisode(ctx)
    if (episode) await (await ops()).renameEpisode({ dramaId: ctx.dramaId, episode })
  },

  'script.deleteEpisode': async (ctx) => {
    const episode = currentEpisode(ctx)
    if (!episode) return
    const o = await ops()
    const r = await o.deleteEpisode({ dramaId: ctx.dramaId, episode })
    if (r && r.next) await o.gotoEpisode(ctx.router, ctx.dramaId, r.next.id, 'script', true)
  },

  // 排序：分集管理对话框（上移 / 下移 / 改名 / 删除 / 新增）
  'script.reorderEpisodes': (ctx) => ctx.openDialog('script.episodes', { dramaId: ctx.dramaId, episodeId: ctx.episodeId }),

  // 把当前集的剧本行写回正文（生成分镜读的是正文）；其它 lane 在触发生成前可调用
  'script.syncContent': async (ctx) => {
    if (!ctx.dramaId || !ctx.episodeId) return
    const { scriptSync } = await import('@/api/episodes')
    await scriptSync.pushContent(ctx.dramaId, ctx.episodeId)
  },
}
