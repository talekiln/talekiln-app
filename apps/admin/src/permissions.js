// 权限显示：纯函数。真正的鉴权在云端（每个接口按角色校验），这里只决定“显示/隐藏哪些入口与按钮”，
// 避免把用户引到必然 403 的页面。权限清单由 GET /admin/me 返回，前端不自己维护角色矩阵。

export const ROLE_LABEL = {
  ADMIN: { label: '管理员', type: 'danger', desc: '全部权限，含退款、改价、管理员与审计' },
  OPERATOR: { label: '运营', type: 'warning', desc: '日常运营写操作（邀请码、用户启停、公告、版本、目录、发票），不能退款、改价、管理管理员' },
  READONLY: { label: '只读', type: 'info', desc: '只能查看，不能修改任何数据' },
}
export const ROLE_OPTIONS = Object.entries(ROLE_LABEL).map(([value, v]) => ({ value, label: v.label, desc: v.desc }))

export const roleLabel = (role) => (ROLE_LABEL[role] ? ROLE_LABEL[role].label : role || '—')

/** me = GET /admin/me 的返回；perm 为空表示任何已登录管理员都可见。 */
export function can(me, perm) {
  if (!perm) return true
  return !!me && Array.isArray(me.permissions) && me.permissions.includes(perm)
}

/** 侧边菜单：每项可带 perm，过滤掉当前角色看不到的入口。 */
export function visibleMenu(menu, me) {
  return menu.filter((m) => can(me, m.perm))
}

/** 路由守卫用：返回无权限时应跳转的路径，有权限返回 null。 */
export function denyRedirect(me, routeMeta, fallback = '/overview') {
  return can(me, routeMeta && routeMeta.perm) ? null : fallback
}
