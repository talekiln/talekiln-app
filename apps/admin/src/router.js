import { createRouter, createWebHashHistory } from 'vue-router'
import { auth } from './api.js'
import Login from './views/Login.vue'
import Overview from './views/Overview.vue'
import Invites from './views/Invites.vue'
import Users from './views/Users.vue'
import Content from './views/Content.vue'

export const routes = [
  { path: '/login', name: 'login', component: Login, meta: { public: true } },
  { path: '/', redirect: '/overview' },
  { path: '/overview', name: 'overview', component: Overview, meta: { title: '概览' } },
  { path: '/invites', name: 'invites', component: Invites, meta: { title: '邀请码' } },
  { path: '/users', name: 'users', component: Users, meta: { title: '用户' } },
  { path: '/content', name: 'content', component: Content, meta: { title: '公告与模型目录' } },
  { path: '/:pathMatch(.*)*', redirect: '/overview' },
]

const router = createRouter({ history: createWebHashHistory(), routes })

router.beforeEach((to) => {
  if (!to.meta.public && !auth.get()) return { name: 'login' }
  if (to.name === 'login' && auth.get()) return { name: 'overview' }
  return true
})

export default router
