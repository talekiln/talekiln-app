// 当前路由所在的剧集（命令面板、版本历史用）。不在任何剧集页面时返回 null。
//   /p/:dramaId/e/:episodeId/...  取路由参数 episodeId（旧 /episodes/:id/... 取 id）
//   分镜表 /project/:d/storyboard 取 ?episode=，再退回共享 store 已加载的剧集
export function episodeOfRoute(route, loadedEpisodeId = null) {
  if (!route) return null
  const name = String(route.name || '')
  if (name.startsWith('episode-') || name === 'shot-workbench') {
    // 外壳路由 /p/:dramaId/e/:episodeId/...；旧路由 /episodes/:id/...
    const n = Number(route.params?.episodeId ?? route.params?.id)
    return Number.isInteger(n) && n > 0 ? n : null
  }
  if (name === 'storyboard') {
    const n = Number(route.query?.episode) || Number(loadedEpisodeId)
    return Number.isInteger(n) && n > 0 ? n : null
  }
  return null
}
