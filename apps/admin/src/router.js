import { createRouter, createWebHashHistory } from 'vue-router'
import { auth } from './api.js'
import { denyRedirect } from './permissions.js'
import { ROUTE_META as M } from './route-meta.js'
import { ensureMe } from './session.js'
import Login from './views/Login.vue'
import Overview from './views/Overview.vue'
import Invites from './views/Invites.vue'
import Users from './views/Users.vue'
import Content from './views/Content.vue'
import Orders from './views/Orders.vue'
import Refunds from './views/Refunds.vue'
import Plans from './views/Plans.vue'
import Releases from './views/Releases.vue'
import Announcements from './views/Announcements.vue'
import Admins from './views/Admins.vue'
import Templates from './views/Templates.vue'
import Plugins from './views/Plugins.vue'
import Studios from './views/Studios.vue'

export const routes = [
  { path: '/login', name: 'login', component: Login, meta: M.login },
  { path: '/', redirect: '/overview' },
  { path: '/overview', name: 'overview', component: Overview, meta: M.overview },
  { path: '/orders', name: 'orders', component: Orders, meta: M.orders },
  { path: '/refunds', name: 'refunds', component: Refunds, meta: M.refunds },
  { path: '/plans', name: 'plans', component: Plans, meta: M.plans },
  { path: '/releases', name: 'releases', component: Releases, meta: M.releases },
  { path: '/announcements', name: 'announcements', component: Announcements, meta: M.announcements },
  { path: '/invites', name: 'invites', component: Invites, meta: M.invites },
  { path: '/users', name: 'users', component: Users, meta: M.users },
  { path: '/content', name: 'content', component: Content, meta: M.content },
  { path: '/templates', name: 'templates', component: Templates, meta: M.templates },
  { path: '/plugins', name: 'plugins', component: Plugins, meta: M.plugins },
  { path: '/studios', name: 'studios', component: Studios, meta: M.studios },
  { path: '/admins', name: 'admins', component: Admins, meta: M.admins },
  { path: '/:pathMatch(.*)*', redirect: '/overview' },
]

const router = createRouter({ history: createWebHashHistory(), routes })

router.beforeEach(async (to) => {
  if (to.meta.public) return to.name === 'login' && auth.get() ? { name: 'overview' } : true
  if (!auth.get()) return { name: 'login' }
  let me
  try {
    me = await ensureMe()
  } catch {
    return { name: 'login' }
  }
  const back = denyRedirect(me, to.meta)
  if (back && to.path !== back) return back
  return true
})

export default router
