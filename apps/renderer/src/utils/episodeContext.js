// 当前路由所在的剧集（命令面板、版本历史用）。不在任何剧集页面时返回 null。
//   /p/:dramaId/e/:episodeId/...  取路由参数 episodeId
export function episodeOfRoute(route) {
  if (!route) return null
  const name = String(route.name || '')
  if (name.startsWith('episode-') || name === 'shot-workbench') {
    const n = Number(route.params?.episodeId)
    return Number.isInteger(n) && n > 0 ? n : null
  }
  return null
}
