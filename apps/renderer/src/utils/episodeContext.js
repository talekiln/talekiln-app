// 当前路由所在的剧集（命令面板、版本历史用）。不在任何剧集页面时返回 null。
//   /episodes/:id/...          取路由参数
//   分镜表 /project/:d/storyboard 取 ?episode=，再退回共享 store 已加载的剧集
export function episodeOfRoute(route, loadedEpisodeId = null) {
  if (!route) return null
  const name = String(route.name || '')
  if (name.startsWith('episode-')) {
    const n = Number(route.params?.id)
    return Number.isInteger(n) && n > 0 ? n : null
  }
  if (name === 'storyboard') {
    const n = Number(route.query?.episode) || Number(loadedEpisodeId)
    return Number.isInteger(n) && n > 0 ? n : null
  }
  return null
}
