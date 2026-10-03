// 浏览器标题：优先用当前语言的 routes.title.<路由名>，没有登记时退回 meta.title（router/index.js 里写的是英文）。
export function routeTitle(route, t) {
  if (!route) return ''
  const key = `routes.title.${String(route.name || '')}`
  const own = t(key)
  const title = own !== key ? own : (route.meta && route.meta.title) || ''
  return title ? `${title} - ${t('routes.brand')}` : ''
}
