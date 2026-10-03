// 生成菜单的 action 表（依赖注入版，便于 node --test）。shell/actions/generate.js 注入真实依赖后导出。
// ctx = { router, route, dramaId, episodeId, openDialog, store }；对话框 id 见 shell/dialogs/generate.js。
// 注意：所有“会花钱”的动作都只是打开对话框——真正提交由对话框里的确认按钮触发，这里不直接请求后端。

export function createGenerateActions({ notify, openDirector }) {
  const warn = (key) => notify('warning', key)

  /** 需要当前集的动作：没有集就提示，不做别的 */
  const needEpisode = (fn) => async (ctx) => {
    if (!ctx.episodeId) return warn('generate.noEpisode')
    return fn(ctx)
  }
  const dialogFor = (dialogId, extra = () => ({})) => needEpisode((ctx) =>
    ctx.openDialog(dialogId, { dramaId: ctx.dramaId, episodeId: ctx.episodeId, ...extra(ctx) }))
  const confirmFor = (action) => dialogFor('generate.confirm', () => ({ action }))

  return {
    'generate.pipeline': dialogFor('generate.pipeline', (ctx) => ({ artStyle: ctx.store?.style })),
    'generate.missing': confirmFor('generate.missing'),
    'generate.allFirstFrames': confirmFor('generate.allFirstFrames'),
    'generate.allVideos': confirmFor('generate.allVideos'),
    'generate.allVoice': dialogFor('generate.voice'),
    'generate.director': needEpisode((ctx) => openDirector(ctx.episodeId)),
    'generate.rerunDraft': dialogFor('generate.rerunDraft'),
    'generate.batchEpisodes': async (ctx) => {
      if (!ctx.dramaId) return warn('generate.noProject')
      return ctx.router.push({ name: 'batch', params: { dramaId: ctx.dramaId } })
    },
  }
}
