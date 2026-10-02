// 路由元信息（纯数据，便于单测）：perm = 进入该页面所需的后台权限，与云端 @Require 保持一致；云端才是真正的鉴权。
export const ROUTE_META = {
  login: { public: true },
  overview: { title: '概览与推广漏斗', perm: 'read' },
  orders: { title: '订单', perm: 'read' },
  refunds: { title: '退款与发票', perm: 'read' },
  plans: { title: '套餐与价格版本', perm: 'read' },
  releases: { title: '版本灰度', perm: 'read' },
  announcements: { title: '公告', perm: 'read' },
  invites: { title: '邀请码', perm: 'read' },
  users: { title: '用户', perm: 'read' },
  content: { title: '模型目录', perm: 'read' },
  templates: { title: '模板市场', perm: 'read' },
  plugins: { title: '插件审核', perm: 'read' },
  admins: { title: '管理员与审计', perm: 'admins:manage' },
}
